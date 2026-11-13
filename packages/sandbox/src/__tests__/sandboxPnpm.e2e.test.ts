import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerSandbox } from "../index";

/**
 * F1-7（FX-24）沙箱 pnpm 验收（真实 Docker）：
 * (a) 镜像构建期预置真实 pnpm 二进制（直达 PATH、不经 corepack），离线（network: none 默认）执行
 *     `pnpm install --frozen-lockfile` exit 0 —— 对 E1 工件（零第三方依赖 + 空 lockfile）实测；
 * (b) 版本边界：项目声明的 packageManager 版本与预置不一致时**忽略该字段、使用预置版本**，
 *     探针记录该事实、不阻断安装（两组：8.15.0 / 11.7.0）；
 * (c) **PL-M6（`docs/158` §3）**：预热清单**内**的第三方依赖，离线安装 exit 0；
 * (d) **PL-M6**：预热清单**外**的第三方依赖，离线安装仍失败——证明是 store 生效，
 *     **不是把沙箱的网络打开了**。
 *
 * 前置：`pnpm --filter @ai-se/sandbox run build:image`（镜像 ai-se-sandbox:22-pnpm9）。
 * 若预热清单被改（`PREWARM_PACKAGES`），(c) 的用例需同步——这是刻意的耦合。
 */

const runDockerTests = process.env.AI_SE_SKIP_DOCKER_TESTS !== "1";

/** E1 工件（run-1）的 lockfile 逐字节复刻（零依赖空 lockfile，v9）。 */
const E1_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}
`;

/**
 * PL-M6 正向：(c) 的夹具——预热清单内的 `lodash@4.18.1`
 * （宿主 pnpm@9.15 生成，v9；与 `packages/sandbox/Dockerfile` 的 `PREWARM_PACKAGES` 一致）。
 */
const PREWARMED_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.18.1

packages:

  lodash@4.18.1:
    resolution: {integrity: sha512-dMInicTPVE8d1e5otfwmmjlxkZoUpiVLwyeTdUsi/Caj/gfzzblBcCE5sRHV/AsjuCmxWrte2TNGSYuCeCq+0Q==}

snapshots:

  lodash@4.18.1: {}
`;

/**
 * PL-M6 反向：(d) 的夹具——预热清单**外**的 `chalk@5.3.0`
 * （镜像内 pnpm@9.15 联网生成，v9）。它必须仍然装不上。
 */
const UNPREWARMED_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      chalk:
        specifier: 5.3.0
        version: 5.3.0

packages:

  chalk@5.3.0:
    resolution: {integrity: sha512-dLitG79d+GV1Nb/VYcCDFivJeK1hiukt9QjRNVOsUtTy1rR1YJsmpGGTZ3qJos+uw7WmWF4wUwBd9jxjocFC2w==}
    engines: {node: ^12.17.0 || ^14.13 || >=16.0.0}

snapshots:

  chalk@5.3.0: {}
`;

function e1PackageJson(packageManager?: string): string {
  return JSON.stringify(
    {
      name: "taskboard",
      version: "1.0.0",
      private: true,
      type: "module",
      ...(packageManager ? { packageManager } : {}),
      scripts: { start: "node src/server.js", test: "node --test" },
      dependencies: {}
    },
    null,
    2
  );
}

function lodashPackageJson(): string {
  return JSON.stringify(
    {
      name: "prewarmed-fixture",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
      dependencies: { lodash: "^4.17.21" }
    },
    null,
    2
  );
}

function chalkPackageJson(): string {
  return JSON.stringify(
    {
      name: "unprewarmed-fixture",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
      dependencies: { chalk: "5.3.0" }
    },
    null,
    2
  );
}

async function writeFixture(
  root: string,
  name: string,
  packageJson: string,
  lockfile: string
): Promise<string> {
  const workspace = path.join(root, name);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), packageJson);
  await writeFile(path.join(workspace, "pnpm-lock.yaml"), lockfile);
  return workspace;
}

describe.skipIf(!runDockerTests)("sandbox pnpm acceptance（F1-7 / FX-24 · PL-M6）", () => {
  let workspaceRoot: string;
  let sandbox: DockerSandbox;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "ai-se-pnpm-"));
    sandbox = new DockerSandbox({ allowedWorkspaceRoot: workspaceRoot });
  }, 30_000);

  afterAll(async () => {
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("(a) E1 工件：离线 `pnpm install --frozen-lockfile` exit 0（预置二进制直达 PATH）", async () => {
    const workspace = await writeFixture(
      workspaceRoot,
      "e1-artifact",
      e1PackageJson(),
      E1_LOCKFILE
    );

    const install = await sandbox.runCommand(workspace, {
      command: "pnpm install --frozen-lockfile",
      timeoutMs: 120_000
    });

    expect(install.exitCode).toBe(0);
    expect(install.timedOut).toBe(false);

    const version = await sandbox.runCommand(workspace, { command: "pnpm --version" });
    expect(version.stdout.trim()).toBe("9.15.0");
    const which = await sandbox.runCommand(workspace, { command: "which pnpm" });
    // 真实二进制预置到 PATH（/usr/local/bin/pnpm 由镜像构建期 npm -g 安装；非 corepack shim）。
    expect(which.stdout.trim()).toBe("/usr/local/bin/pnpm");
  }, 180_000);

  it("(b) 版本边界：packageManager 声明 8.15.0 / 11.7.0 均被忽略——记录事实、不阻断安装", async () => {
    for (const declared of ["8.15.0", "11.7.0"]) {
      const workspace = await writeFixture(
        workspaceRoot,
        `e1-artifact-pm-${declared.replace(/\./g, "-")}`,
        e1PackageJson(`pnpm@${declared}`),
        E1_LOCKFILE
      );

      const install = await sandbox.runCommand(workspace, {
        command: "pnpm install --frozen-lockfile",
        timeoutMs: 120_000
      });
      expect(install.exitCode).toBe(0);

      const preset = await sandbox.runCommand(workspace, { command: "pnpm --version" });
      const presetVersion = preset.stdout.trim();
      // 探针记录版本不一致事实（不阻断）：声明 ≠ 预置 → 使用预置版本。
      expect(presetVersion).toBe("9.15.0");
      expect(presetVersion).not.toBe(declared);
    }
  }, 300_000);

  it("(c) PL-M6 正向：预热清单内的依赖，离线安装 exit 0 且落到 node_modules", async () => {
    const workspace = await writeFixture(
      workspaceRoot,
      "prewarmed-dep",
      lodashPackageJson(),
      PREWARMED_LOCKFILE
    );

    const install = await sandbox.runCommand(workspace, {
      command: "pnpm install --frozen-lockfile",
      timeoutMs: 120_000
    });

    expect(install.exitCode).toBe(0);
    expect(install.timedOut).toBe(false);
    // `--network none` 下从镜像内预热好的 store 取包：downloaded 应为 0。
    expect(`${install.stdout}\n${install.stderr}`).toMatch(/downloaded 0|reused 1/);

    const listing = await sandbox.runCommand(workspace, { command: "ls node_modules" });
    expect(listing.stdout).toContain("lodash");
  }, 180_000);

  it("(d) PL-M6 反向：预热清单外的依赖仍失败——边界还在，不是把网络打开了", async () => {
    const workspace = await writeFixture(
      workspaceRoot,
      "unprewarmed-dep",
      chalkPackageJson(),
      UNPREWARMED_LOCKFILE
    );

    const install = await sandbox.runCommand(workspace, {
      command: "pnpm install --frozen-lockfile",
      timeoutMs: 120_000
    });

    expect(install.exitCode).not.toBe(0);
    const output = `${install.stdout}\n${install.stderr}`;
    // 实测样张关键词：联网尝试 → ERR_PNPM_META_FETCH_FAIL / ECONNREFUSED；离线模式 → ERR_PNPM_NO_OFFLINE_META。
    expect(output).toMatch(
      /ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_NO_OFFLINE_META|ECONNREFUSED|ENOTFOUND|getaddrinfo|offline/i
    );
  }, 180_000);
});

/**
 * `docs/236` §10 第 2 步：**registry 拓扑**。
 *
 * 验收原话是「探针在 `network: registry` 下装任意依赖成功；同时**证明**打 `1.1.1.1` 与元数据
 * 地址失败」。两半缺一不可——只证前一半，等于给自己开了一条通往互联网的路。
 *
 * 前置（测试自己建拓扑，不依赖生产容器）：
 *   docker network create --internal ai-se-egress-test
 *   docker run -d --name ai-se-registry-test --network ai-se-registry-test --network-alias registry verdaccio/verdaccio:6
 *
 * 环境变量 `AI_SE_TEST_REGISTRY` 提供 `host:port` 与网络名；不设则整组跳过。
 */
const REGISTRY =
  process.env.AI_SE_TEST_REGISTRY_NETWORK && process.env.AI_SE_TEST_REGISTRY_ADDRESS
    ? {
        network: process.env.AI_SE_TEST_REGISTRY_NETWORK,
        registry: process.env.AI_SE_TEST_REGISTRY_ADDRESS
      }
    : null;
const runRegistryTests = runDockerTests && REGISTRY !== null;

describe.skipIf(!runRegistryTests)("sandbox registry egress（docs/236 §3 · 第 2 步）", () => {
  let workspaceRoot: string;

  /** 一个**不在**预热清单里、也不在 seed lockfile 里的包：只能来自 registry。 */
  const REGISTRY_ONLY_PACKAGE = JSON.stringify(
    {
      name: "registry-only",
      private: true,
      version: "1.0.0",
      type: "module",
      dependencies: { chalk: "5.3.0", nanoid: "5.1.6" }
    },
    null,
    2
  );

  /**
   * `docs/236` §4.2：**未指定的命令默认无网**（`resolveNetwork` 不继承构造级）。
   * 所以这组用例里每条命令都**显式**带 `network`——真实链路里这是工具层按命令分类做的
   * （`packages/tool-runtime` 的 `isDependencyInstallCommand`）。
   */
  function sandbox(network: "none" | "registry"): DockerSandbox {
    return new DockerSandbox({
      allowedWorkspaceRoot: workspaceRoot,
      limits: { network, timeoutMs: 120_000 },
      egress: REGISTRY ?? undefined
    });
  }

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "ai-se-registry-"));
  }, 30_000);

  afterAll(async () => {
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("装有依赖时从 registry 取包成功——即使该包既没预热也不在 seed lockfile 里", async () => {
    const workspace = path.join(workspaceRoot, "install");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "package.json"), REGISTRY_ONLY_PACKAGE);

    const install = await sandbox("registry").runCommand(workspace, {
      network: "registry",
      command: "pnpm install --no-frozen-lockfile",
      timeoutMs: 120_000
    });

    expect(install.exitCode, `${install.stdout}\n${install.stderr}`).toBe(0);
    const listing = await sandbox("registry").runCommand(workspace, {
      network: "registry",
      command: "ls node_modules"
    });
    expect(listing.stdout).toContain("chalk");
    expect(listing.stdout).toContain("nanoid");
  }, 180_000);

  it("同样的工作区在 network: none 下装不上——证明网络是按需授予的，不是默认打开", async () => {
    const workspace = path.join(workspaceRoot, "offline");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "package.json"), REGISTRY_ONLY_PACKAGE);

    const install = await sandbox("none").runCommand(workspace, {
      command: "pnpm install --no-frozen-lockfile",
      timeoutMs: 120_000
    });

    expect(install.exitCode).not.toBe(0);
  }, 180_000);

  /**
   * 这一条是整组里最重要的：**registry 模式不是互联网**。
   * `--internal` 网络没有默认路由，沙箱只解析得到 registry 服务名。
   */
  it("registry 模式下仍打不通 1.1.1.1、云元数据地址与外部域名", async () => {
    const workspace = path.join(workspaceRoot, "egress");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "package.json"), '{"name":"egress","private":true}');

    // 0 = 可达（测试失败）；3 = 网络错误；4 = 悬挂后自退。后两者都意味着被阻断。
    const probe = (url: string) =>
      `node -e "const t=setTimeout(()=>process.exit(4),5000);` +
      `fetch('${url}').then(()=>{clearTimeout(t);process.exit(0)},()=>{clearTimeout(t);process.exit(3)})"`;

    const targets = [
      "http://1.1.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "https://registry.npmjs.org/zod"
    ];
    for (const url of targets) {
      const result = await sandbox("registry").runCommand(workspace, {
        // 显式带 registry：要证明的是「**有出口路径时**仍打不通互联网」，
        // 不带就成了在测 none 模式，证明力为零。
        network: "registry",
        command: probe(url),
        timeoutMs: 30_000
      });
      expect([3, 4], `${url} 应当不可达，实际 exit=${result.exitCode}`).toContain(result.exitCode);
    }
  }, 180_000);

  /**
   * 出口是拓扑保证，不是 DNS 巧合：外部域名必须**解析失败**（`EAI_AGAIN`），而不是
   * 「解析到了但连不上」。前者说明连 DNS 都没有出口，后者只说明路由被挡了一层。
   */
  it("外部域名在 registry 模式下解析失败（拓扑保证，不是防火墙约定）", async () => {
    const workspace = path.join(workspaceRoot, "dns");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "package.json"), '{"name":"dns","private":true}');

    const result = await sandbox("registry").runCommand(workspace, {
      network: "registry",
      command:
        'node -e "require(\'dns\').promises.lookup(\'registry.npmjs.org\')' +
        '.then(r=>{console.log(\'RESOLVED\',r.address);process.exit(0)},e=>{console.log(\'FAIL\',e.code);process.exit(3)})"'
    });

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("EAI_AGAIN");
  }, 60_000);

  it("registry 自己可达——否则上面几条失败证明不了任何事", async () => {
    const workspace = path.join(workspaceRoot, "ping");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "package.json"), '{"name":"ping","private":true}');

    const result = await sandbox("registry").runCommand(workspace, {
      network: "registry",
      command: `node -e "fetch('http://${REGISTRY?.registry}/-/ping')` +
        `.then(r=>{console.log('STATUS',r.status);process.exit(r.ok?0:1)},()=>process.exit(3))"`
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("200");
  }, 60_000);
});
