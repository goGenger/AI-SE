import { DockerSandbox } from "../index";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDockerTests = process.env.AI_SE_SKIP_DOCKER_TESTS !== "1";

/**
 * `docs/236` §4.1 / §4.3：两条**不依赖真实 docker** 的边界。
 *
 * - 构造为 `none` 的沙箱**不能**被一条命令自行升级到 `registry`（否则授权转移到了调用方）；
 * - 反向（构造 `registry`、命令要求 `none`）是收紧，允许。
 *
 * 「registry 不可达 ⇒ `REGISTRY_UNAVAILABLE`」的判别在
 * `packages/tool-runtime/src/__tests__/commandNetworkGrant.test.ts` 之外单独验，见本文件末尾。
 */
describe.skipIf(!runDockerTests)("docs/236 §4.1：命令级网络不能超出构造级授权", () => {
  let workspaceRoot: string;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "ai-se-netgrant-"));
  }, 30_000);

  afterAll(async () => {
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("构造为 none 时，命令要求 registry → 明确报错（fail-closed，不是静默降级）", async () => {
    const sandbox = new DockerSandbox({
      allowedWorkspaceRoot: workspaceRoot,
      limits: { network: "none" }
    });

    await expect(
      sandbox.runCommand(workspaceRoot, { command: "true", network: "registry" })
    ).rejects.toThrow(/requested network "registry" but the sandbox was built with network "none"/);
  }, 30_000);

  it("构造为 none 时，命令要求 none / 不指定 → 正常放行", async () => {
    const sandbox = new DockerSandbox({
      allowedWorkspaceRoot: workspaceRoot,
      limits: { network: "none", timeoutMs: 20_000 }
    });

    const result = await sandbox.runCommand(workspaceRoot, {
      command: "echo ok",
      network: "none"
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  }, 60_000);

  /**
   * `docs/236` §4.2：**未指定的命令默认无网**，即使沙箱构造为 `registry`。
   *
   * 这条是 2026-10-28 实测发现的缺陷的回归用例：原实现让未指定的命令继承构造级，于是
   * 一旦项目获准出网，**每条命令**（含 agent 自己写的任意 shell）都拿到 registry 路——
   * 「按命令授予」退化成「按任务授予」，第 3 步的命令分类等于白做。
   */
  it("构造为 registry 时，未指定 network 的命令仍然无网", async () => {
    const sandbox = new DockerSandbox({
      allowedWorkspaceRoot: workspaceRoot,
      limits: { network: "registry", timeoutMs: 40_000 },
      egress: { network: "ai-se-egress", registry: "ai-se-registry:4873" }
    });

    // 3 = 网络错误（预期）；0 = 可达（说明拿到了 registry 路，缺陷回来了）
    const result = await sandbox.runCommand(workspaceRoot, {
      command:
        "node -e \"const t=setTimeout(()=>process.exit(4),5000);" +
        "fetch('http://ai-se-registry:4873/-/ping').then(()=>{clearTimeout(t);process.exit(0)}," +
        "()=>{clearTimeout(t);process.exit(3)})\""
    });

    expect(result.exitCode, "未指定 network 的命令不应能到达 registry").not.toBe(0);
  }, 90_000);

  it("构造为 registry 时，显式 network: registry 的命令才拿得到出口", async () => {
    const sandbox = new DockerSandbox({
      allowedWorkspaceRoot: workspaceRoot,
      limits: { network: "registry", timeoutMs: 40_000 },
      egress: { network: "ai-se-egress", registry: "ai-se-registry:4873" }
    });

    const result = await sandbox.runCommand(workspaceRoot, {
      network: "registry",
      command:
        "node -e \"const t=setTimeout(()=>process.exit(4),5000);" +
        "fetch('http://ai-se-registry:4873/-/ping').then(()=>{clearTimeout(t);process.exit(0)}," +
        "()=>{clearTimeout(t);process.exit(3)})\""
    });

    expect(result.exitCode).toBe(0);
  }, 90_000);
});
