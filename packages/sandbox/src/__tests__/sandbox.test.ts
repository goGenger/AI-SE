import { createLogger } from "@ai-se/observability";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DockerSandbox } from "../index";

const runDockerTests = process.env.AI_SE_SKIP_DOCKER_TESTS !== "1";

describe.skipIf(!runDockerTests)("DockerSandbox", () => {
  it("runs a command in a network-disabled docker sandbox", async () => {
    const sandbox = new DockerSandbox({
      allowedWorkspaceRoot: process.cwd(),
      limits: { timeoutMs: 10_000 }
    });

    const result = await sandbox.runCommand(process.cwd(), {
      command: "node -e \"console.log('sandbox-ok')\""
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sandbox-ok");
  }, 20_000);

  it("returns exit information when a sandbox command fails", async () => {
    const sandbox = new DockerSandbox({
      allowedWorkspaceRoot: process.cwd(),
      limits: { timeoutMs: 10_000 }
    });

    const result = await sandbox.runCommand(process.cwd(), {
      command: 'node -e "process.exit(7)"'
    });

    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  }, 20_000);

  // 主动出站探针：0 = 可达（未阻断，测试失败）；3 = 网络错误（network:"none" 下的预期）；
  // 4 = 连接悬挂 5s 后自退（同样意味着被阻断）。
  const EGRESS_PROBE =
    "node -e \"const t=setTimeout(()=>process.exit(4),5000);fetch('http://1.1.1.1/').then(()=>{clearTimeout(t);process.exit(0)},()=>{clearTimeout(t);process.exit(3)})\"";

  it("blocks outbound network access with default limits (network: none)", async () => {
    // 与服务端装配同形：仅 allowedWorkspaceRoot + logger，不传 limits。
    const sandbox = new DockerSandbox({
      allowedWorkspaceRoot: process.cwd(),
      logger: createLogger({ enabled: false })
    });

    const result = await sandbox.runCommand(process.cwd(), { command: EGRESS_PROBE });

    expect([3, 4]).toContain(result.exitCode);
    expect(result.timedOut).toBe(false);
  }, 30_000);

  it("keeps outbound blocked when only unrelated limits are overridden", async () => {
    const sandbox = new DockerSandbox({
      allowedWorkspaceRoot: process.cwd(),
      limits: { timeoutMs: 10_000 }
    });

    const result = await sandbox.runCommand(process.cwd(), { command: EGRESS_PROBE });

    expect([3, 4]).toContain(result.exitCode);
    expect(result.timedOut).toBe(false);
  }, 30_000);
});

/**
 * `docs/236` §5 第 1 步：容器加固（不含联网）。
 *
 * 每条用例都对着一条**实测过的**失败模式，不是对着参数名：加固参数里最容易写错的两处
 * 是「`--user` 取值」与「根文件系统只读后 `$HOME` 指向哪里」，两者写错都会让写操作 EACCES，
 * 而 docker 本身的 exit code 仍然可能是 0。
 */
describe.skipIf(!runDockerTests)("DockerSandbox hardening（docs/236 §5）", () => {
  const limits = { timeoutMs: 20_000 };

  async function stagingWorkspace(): Promise<{ root: string; workspace: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "ai-se-harden-"));
    const workspace = path.join(root, "ws");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "package.json"), '{"name":"w","private":true}\n');
    return { root, workspace };
  }

  it("是以工作区属主身份运行的，不是 root，也不是写死的 uid", async () => {
    const { root, workspace } = await stagingWorkspace();
    try {
      const sandbox = new DockerSandbox({ allowedWorkspaceRoot: root, limits });
      const result = await sandbox.runCommand(workspace, {
        command: "id -u; id -g; touch /workspace/probe.txt && echo WRITE_OK"
      });

      const [uid, gid] = result.stdout.trim().split("\n");
      // 宿主 uid/gid —— 写死 1000 在这里就会露馅（Linux 宿主上通常不是 1000，macOS 上是 501）。
      expect(Number(uid)).toBe(statSync(workspace).uid);
      expect(Number(gid)).toBe(statSync(workspace).gid);
      expect(uid).not.toBe("0");
      expect(result.stdout).toContain("WRITE_OK");
      expect(statSync(path.join(workspace, "probe.txt")).uid).toBe(statSync(workspace).uid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("根文件系统只读：镜像路径写不进去，/workspace 与 /tmp 可以", async () => {
    const { root, workspace } = await stagingWorkspace();
    try {
      const sandbox = new DockerSandbox({ allowedWorkspaceRoot: root, limits });
      const result = await sandbox.runCommand(workspace, {
        command:
          "touch /opt/nope 2>/dev/null && echo ROOT_WRITABLE || echo ROOT_READONLY; " +
          "touch /workspace/ok && echo WS_WRITABLE; " +
          "touch \"$HOME/ok\" && echo HOME_WRITABLE; echo HOME=$HOME"
      });

      expect(result.stdout).toContain("ROOT_READONLY");
      expect(result.stdout).toContain("WS_WRITABLE");
      expect(result.stdout).toContain("HOME_WRITABLE");
      // $HOME 必须落在 tmpfs 上——指向 `/` 或 `/root` 都会让 pnpm / git / Chromium 写不进去。
      expect(result.stdout).toContain("HOME=/tmp");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * 非 root 读不到 `/root/.config/pnpm/rc`：不加这条 env，pnpm 会认为 store 是默认路径，
   * 离线预热整个失效（实测表现是转去联网然后 EAI_AGAIN，而不是 ENOTCACHED）。
   */
  it("把 store 目录显式传给容器，非 root 也能取到预热好的 store", async () => {
    const { root, workspace } = await stagingWorkspace();
    try {
      const sandbox = new DockerSandbox({ allowedWorkspaceRoot: root, limits });
      const result = await sandbox.runCommand(workspace, {
        command: "pnpm config get store-dir"
      });
      expect(result.stdout.trim()).toBe("/opt/pnpm-store");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("关掉加固即回到加固前的行为（docs/236 §10 的回滚列）", async () => {
    const { root, workspace } = await stagingWorkspace();
    try {
      const sandbox = new DockerSandbox({
        allowedWorkspaceRoot: root,
        limits: { ...limits, harden: false }
      });
      const result = await sandbox.runCommand(workspace, {
        command: "id -u; touch /opt/ok && echo ROOT_WRITABLE"
      });
      expect(result.stdout).toContain("0");
      expect(result.stdout).toContain("ROOT_WRITABLE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
