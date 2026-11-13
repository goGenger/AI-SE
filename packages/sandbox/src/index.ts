import { sanitizeLogData } from "@ai-se/observability";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Logger } from "pino";
import {
  defaultLinuxPlaywrightCacheDir,
  ensurePlaywrightBrowserCache,
  playwrightCacheVolumeArgs
} from "./playwrightBrowserCache";
import { DEFAULT_SANDBOX_MEMORY, DEFAULT_SANDBOX_PIDS_LIMIT } from "./playwrightLimits";

export interface SandboxLimits {
  cpus: number;
  memory: string;
  pidsLimit: number;
  timeoutMs: number;
  /**
   * `docs/236` §3：**没有 `"bridge"`**。`bridge` 是裸出网——只要这个选项存在，任何一次配置
   * 失误都会让生成物拿到完整互联网。两个合法值：
   *
   * - `"none"`：无网络（默认）。
   * - `"registry"`：接到 `ai-se-egress`（`--internal`，Docker 不为其配置默认路由），容器
   *   只能解析并访问该网络上的 registry 服务名，**打不到任何外部地址**。
   */
  network: SandboxNetwork;
  /**
   * `docs/236` §5（第 1 步）：容器加固。默认开启。
   *
   * 开启后追加：`--read-only` + `--tmpfs /tmp`、`--user <工作区属主>`、
   * `HOME=/tmp`、`npm_config_ignore_scripts=true`、显式 `store-dir`。
   *
   * 关掉即回到加固前的行为（`docs/236` §10 的回滚列）。
   */
  harden: boolean;
}

/** `docs/236` §3：见 `SandboxLimits.network` —— 刻意不含 `"bridge"`。 */
export type SandboxNetwork = "none" | "registry";

export interface SandboxCommand {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /**
   * `docs/236` §4.1：网络从**构造级**改为**命令级**。
   *
   * 未指定时取 `SandboxLimits.network`（默认 `"none"`）。工具层只对 `install` 类命令传
   * `"registry"`——build / test / preview / 任意 shell 仍是 `none`。
   *
   * **agent 看不到这个开关**：`run_command` 等工具的入参 schema 没有网络字段，值是平台
   * 按命令内容判定的（`docs/236` §4.2）。
   */
  network?: SandboxNetwork;
  /**
   * docs/256：命令级内存覆盖（切片末 E2E 用 2g）。未指定时取构造默认值（512m）。
   */
  memory?: string;
  /** docs/256：命令级 pids 覆盖。未指定时取构造默认值。 */
  pidsLimit?: number;
  /** docs/256：加固 tmpfs 大小覆盖。E2E 用 1g；未指定时 512m。 */
  tmpfsSize?: string;
}

export interface SandboxResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
}

export interface Sandbox {
  runCommand(
    workspacePath: string,
    command: SandboxCommand,
    signal?: AbortSignal
  ): Promise<SandboxResult>;
}

export interface DockerSandboxOptions {
  image?: string;
  dockerCommand?: string;
  allowedWorkspaceRoot: string;
  limits?: Partial<SandboxLimits>;
  maxOutputBytes?: number;
  /**
   * 镜像内 pnpm store 的绝对路径。加固后以 env 显式传入，因为非 root 用户读不到
   * `/root/.config/pnpm/rc`（`docs/236` §5 实测）。默认值与镜像一致。
   */
  storeDir?: string;
  /**
   * `docs/236` §3：`network: "registry"` 时接的 docker 网络名与 registry 地址。
   * 分开放是为了让测试能起自己的拓扑，而不是只能连生产那一个。
   */
  egress?: Partial<EgressTarget>;
  logger?: Logger;
  /**
   * docs/255：宿主侧 Playwright Linux 缓存目录，挂到容器 `/opt/ms-playwright`。
   * `false` 关闭挂载（只用镜像内预置）。未指定时用 `~/.cache/ai-se/ms-playwright`，
   * 且仅在目录里已经有 chromium*（种源成功）时才挂，避免空目录盖住镜像浏览器。
   */
  playwrightBrowsersHostDir?: string | false;
}

/** `docs/236` §3：出口收敛的拓扑参数。 */
export interface EgressTarget {
  /** `docker network create --internal` 建的网络。 */
  network: string;
  /** 沙箱在同网络内可见的 registry 地址（`host:port`）。 */
  registry: string;
}

export const DEFAULT_EGRESS: EgressTarget = {
  network: "ai-se-egress",
  registry: "ai-se-registry:4873"
};

const DEFAULT_LIMITS: SandboxLimits = {
  cpus: 1,
  memory: DEFAULT_SANDBOX_MEMORY,
  pidsLimit: DEFAULT_SANDBOX_PIDS_LIMIT,
  timeoutMs: 30_000,
  network: "none",
  harden: true
};

export const DEFAULT_STORE_DIR = "/opt/pnpm-store";

/**
 * 加固后根文件系统只读，容器内唯一可写处是 tmpfs `/tmp`；`HOME` 指向那里，
 * 否则 pnpm / git / Chromium 都会尝试写各自的 `$HOME`（`docs/236` §5）。
 */
const HARDENED_HOME = "/tmp";

/** tmpfs 大小：实测完整探针（装→构建→Chromium）峰值 2.8MB，给足两个数量级。 */
const HARDENED_TMPFS_SIZE = "512m";

/**
 * `docs/236` §3：`registry` 模式下的 pnpm store。必须在容器内可写（镜像里的
 * `/opt/pnpm-store` 只读），且跨命令不需要复用——verdaccio 自己缓存。
 * 实测两个包 124KB；512MB 足够一个中型前端项目的完整依赖树。
 */
const REGISTRY_STORE_DIR = "/tmp/pnpm-store";
const REGISTRY_STORE_SIZE = "512m";

/**
 * F1-7（FX-24a）：默认沙箱镜像 = 本地构建的预置 pnpm 镜像（`packages/sandbox/Dockerfile`，
 * 构建：`pnpm --filter @ai-se/sandbox run build:image`）。旧行为（裸 `node:22-bookworm`）可用
 * `image` 选项或 `SANDBOX_IMAGE` 环境变量覆盖。
 */
export const DEFAULT_SANDBOX_IMAGE = "ai-se-sandbox:22-pnpm9";

export {
  defaultLinuxPlaywrightCacheDir,
  ensurePlaywrightBrowserCache,
  ENV_GAP_INSTALL_TIMEOUT_MS,
  playwrightCacheHasChromium,
  playwrightCacheVolumeArgs,
  provisionPlaywrightBrowsers,
  SANDBOX_PLAYWRIGHT_BASE_VERSION,
  SANDBOX_PLAYWRIGHT_BROWSERS_PATH,
  SANDBOX_PLAYWRIGHT_PRODUCT_REVISION,
  SANDBOX_PLAYWRIGHT_PRODUCT_VERSION,
  seedPlaywrightCacheFromImage
} from "./playwrightBrowserCache";

export {
  capPlaywrightWorkers,
  DEFAULT_SANDBOX_MEMORY,
  DEFAULT_SANDBOX_PIDS_LIMIT,
  E2E_HARDENED_TMPFS_SIZE,
  E2E_SANDBOX_MEMORY,
  E2E_TEST_TIMEOUT_MS,
  e2eSandboxCommandLimits,
  isPlaywrightTestCommand,
  SANDBOX_PLAYWRIGHT_MAX_WORKERS
} from "./playwrightLimits";

export {
  PLATFORM_BAKED_CHROMIUM_REVISIONS,
  PLATFORM_BASE_CHROMIUM_REVISION,
  PLATFORM_BASE_PLAYWRIGHT_VERSION,
  PLATFORM_CHROMIUM_REVISION,
  PLATFORM_PLAYWRIGHT_PACKAGES,
  PLATFORM_PLAYWRIGHT_VERSION,
  VERIFIED_PLAYWRIGHT_CHROMIUM_REVISIONS,
  assertPlaywrightManifestContent,
  commandAttemptsPlaywrightBump,
  commandIsSandboxPlaywrightBrowserInstall,
  inspectWorkspacePlaywright,
  isBakedChromiumRevision,
  playwrightContractMismatchReason,
  rangeIncludesPlatformPin,
  realignPackageJsonToPlatformPin,
  resolveChromiumRevision
} from "./playwrightContract";
export type { PlaywrightPackageName, WorkspacePlaywrightInspection } from "./playwrightContract";

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function appendLimited(current: string, chunk: Buffer, maxBytes: number): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next) <= maxBytes) {
    return next;
  }

  return next.slice(Math.max(0, next.length - maxBytes));
}

async function forceRemoveContainer(dockerCommand: string, containerName: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(dockerCommand, ["rm", "-f", containerName], { stdio: "ignore" });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

export class DockerSandbox implements Sandbox {
  private readonly image: string;
  private readonly dockerCommand: string;
  private readonly limits: SandboxLimits;
  private readonly maxOutputBytes: number;
  private readonly storeDir: string;
  private readonly egress: EgressTarget;
  private readonly logger?: Logger;
  private readonly playwrightBrowsersHostDir: string | false;
  private playwrightCacheDir?: string;
  private playwrightCacheReady?: Promise<string | undefined>;

  constructor(private readonly options: DockerSandboxOptions) {
    this.image = options.image ?? DEFAULT_SANDBOX_IMAGE;
    this.dockerCommand = options.dockerCommand ?? "docker";
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.maxOutputBytes = options.maxOutputBytes ?? 96_000;
    this.storeDir = options.storeDir ?? DEFAULT_STORE_DIR;
    this.egress = { ...DEFAULT_EGRESS, ...options.egress };
    this.logger = options.logger;
    this.playwrightBrowsersHostDir =
      options.playwrightBrowsersHostDir === false
        ? false
        : (options.playwrightBrowsersHostDir ?? defaultLinuxPlaywrightCacheDir());
  }

  /**
   * 种源（必要时）后返回可挂载的宿主缓存目录；种源失败则 undefined，使用镜像内浏览器。
   */
  private async resolvePlaywrightCacheDir(): Promise<string | undefined> {
    if (this.playwrightBrowsersHostDir === false) return undefined;
    if (this.playwrightCacheDir) return this.playwrightCacheDir;
    if (!this.playwrightCacheReady) {
      this.playwrightCacheReady = ensurePlaywrightBrowserCache({
        hostDir: this.playwrightBrowsersHostDir,
        dockerCommand: this.dockerCommand,
        image: this.image,
        provision: false
      })
        .then((result) => {
          if (result.mounted) {
            this.playwrightCacheDir = result.hostDir;
            return result.hostDir;
          }
          this.logger?.info(
            sanitizeLogData({ reason: result.reason, hostDir: result.hostDir }),
            "playwright cache not mounted; using image /opt/ms-playwright"
          );
          return undefined;
        })
        .catch((error: unknown) => {
          this.logger?.info(
            sanitizeLogData({
              error: error instanceof Error ? error.message : String(error)
            }),
            "playwright cache seed failed; using image /opt/ms-playwright"
          );
          return undefined;
        });
    }
    return this.playwrightCacheReady;
  }

  async runCommand(
    workspacePath: string,
    command: SandboxCommand,
    signal?: AbortSignal
  ): Promise<SandboxResult> {
    const started = Date.now();
    const workspace = await this.resolveWorkspace(workspacePath);
    const cwd = this.resolveCwd(command.cwd);
    const timeoutMs = command.timeoutMs ?? this.limits.timeoutMs;
    const network = this.resolveNetwork(command.network);
    const containerName = `ai-se-sandbox-${randomUUID()}`;
    // 加固后容器以**工作区属主**身份运行：`--read-only` + `--user` 之下，写权限只来自
    // bind mount 的属主，用一个凭空指定的 uid 会让 `pnpm install` / `git commit` 全部 EACCES。
    const owner = this.limits.harden ? await workspaceOwner(workspace) : undefined;
    const playwrightCacheDir = await this.resolvePlaywrightCacheDir();
    const args = this.createDockerArgs(
      containerName,
      workspace,
      cwd,
      command,
      network,
      owner,
      playwrightCacheDir
    );

    this.logger?.info(
      sanitizeLogData({ containerName, workspace, cwd, timeoutMs, network }),
      "sandbox command started"
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    return await new Promise<SandboxResult>((resolve, reject) => {
      const child = spawn(this.dockerCommand, args, { stdio: ["ignore", "pipe", "pipe"] });

      const finish = (exitCode: number | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortListener);
        const result: SandboxResult = {
          command: command.command,
          exitCode,
          stdout,
          stderr,
          duration: Date.now() - started,
          timedOut
        };
        this.logger?.info(
          sanitizeLogData({
            containerName,
            exitCode,
            duration: result.duration,
            timedOut
          }),
          "sandbox command finished"
        );
        resolve(result);
      };

      const stop = () => {
        timedOut = true;
        child.kill("SIGKILL");
        void forceRemoveContainer(this.dockerCommand, containerName);
      };

      const timer = setTimeout(stop, timeoutMs);
      const abortListener = () => stop();

      signal?.addEventListener("abort", abortListener, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendLimited(stdout, chunk, this.maxOutputBytes);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendLimited(stderr, chunk, this.maxOutputBytes);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortListener);
        reject(error);
      });
      child.on("close", (exitCode) => finish(exitCode));

      if (signal?.aborted) {
        stop();
      }
    });
  }

  private async resolveWorkspace(workspacePath: string): Promise<string> {
    const [root, workspace] = await Promise.all([
      realpath(this.options.allowedWorkspaceRoot),
      realpath(workspacePath)
    ]);

    if (!isInside(root, workspace)) {
      throw new Error("Workspace path is outside the sandbox allowlist");
    }

    return workspace;
  }

  private resolveCwd(cwd?: string): string {
    if (!cwd) {
      return "/workspace";
    }

    const normalized = path.posix.normalize(cwd);
    if (path.posix.isAbsolute(normalized) || normalized.startsWith("..")) {
      throw new Error("Sandbox cwd must be a workspace-relative path");
    }

    return path.posix.join("/workspace", normalized);
  }

  private createDockerArgs(
    containerName: string,
    workspace: string,
    cwd: string,
    command: SandboxCommand,
    network: SandboxNetwork,
    owner?: { uid: number; gid: number },
    playwrightCacheDir?: string
  ): string[] {
    const memory = command.memory ?? this.limits.memory;
    const pidsLimit = command.pidsLimit ?? this.limits.pidsLimit;
    const tmpfsSize = command.tmpfsSize ?? HARDENED_TMPFS_SIZE;
    const hardening = this.limits.harden ? this.hardeningArgs(owner, tmpfsSize) : [];
    const envArgs = Object.entries({
      ...(this.limits.harden ? this.hardeningEnv(network) : {}),
      // 未加固时 store 也要指对：否则非 root 依旧读不到镜像里的全局 rc。
      ...(this.limits.harden ? {} : { npm_config_store_dir: storeDirFor(network, this.storeDir) }),
      ...networkEnv(network, this.egress),
      ...(command.env ?? {})
    }).flatMap(([key, value]) => ["--env", `${key}=${value}`]);

    return [
      "run",
      "--rm",
      "--name",
      containerName,
      "--network",
      dockerNetwork(network, this.egress),
      "--cpus",
      String(this.limits.cpus),
      "--memory",
      memory,
      "--pids-limit",
      String(pidsLimit),
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      ...hardening,
      ...registryStoreArgs(network),
      ...(playwrightCacheDir ? playwrightCacheVolumeArgs(playwrightCacheDir) : []),
      "--volume",
      `${workspace}:/workspace`,
      "--workdir",
      cwd,
      ...envArgs,
      this.image,
      "sh",
      "-lc",
      command.command
    ];
  }

  /**
   * `docs/236` §4.1：命令级网络。未指定取构造默认值；`"registry"` 需要构造侧也允许
   * （`SandboxLimits.network`），否则一条命令就能自行升级到出网——那等于把授权交给调用方。
   *
   * 反向不需要限制：命令可以比构造更严（构造为 `registry` 时传 `"none"` 是收紧）。
   */
  /**
   * `docs/236` §4.1 / §4.2：命令级网络。
   *
   * **未指定 = `"none"`，不是构造默认值。** 这是 `docs/236` §4.2 的原文要求：
   * 「只有 **install** 类命令拿 `registry` 网络；`build` / `test` / `preview` / 任意 shell
   * 仍 `none`」。如果让未指定的命令继承构造级的 `registry`，那么一旦项目获准出网，**下一条
   * 任意命令**（含 agent 自己写的 shell）都会带上 registry 路——出网就从「按命令授予」
   * 退化成「按任务授予」，第 3 步做的分类等于白做。
   *
   * 因此构造级 `network` 是**能力上限**（决定本沙箱能否被授予 `registry`），不是默认值：
   * - 显式 `"registry"` 且构造允许 ⇒ 走出口；
   * - 显式 `"registry"` 但构造是 `none` ⇒ **抛错**（不能自行升级授权）；
   * - 其余一切（不指定 / 显式 `"none"`）⇒ `none`。
   */
  private resolveNetwork(requested?: SandboxNetwork): SandboxNetwork {
    if (requested === "registry") {
      if (this.limits.network !== "registry") {
        throw new Error(
          'Sandbox command requested network "registry" but the sandbox was built with network ' +
            `"${this.limits.network}". Enable it on the sandbox (docs/236 §4.1).`
        );
      }
      return "registry";
    }
    return "none";
  }

  /**
   * `docs/236` §5：容器加固基线。三项都要，缺一项就还留着一条写路径：
   *
   * - `--read-only` + `--tmpfs /tmp`：镜像与 `/workspace` 之外的路径不可写。`/workspace`
   *   是 bind mount，本来就是可写的，不受影响。
   * - `--user <工作区属主>`：容器内不再是 root。**必须取工作区属主**，不能写死 1000 ——
   *   bind mount 的属主是宿主 uid，写死会让所有写入 EACCES（实测：`pnpm install` 在
   *   `--user 1000:1000` 下对着 501 的挂载直接失败）。
   * - `noexec` 不加：实测 Chromium 在 `--tmpfs /tmp:noexec` 下仍能启动（它不执行 /tmp 里的
   *   东西），但 pnpm 在 /tmp 下解包后要执行 lifecycle 脚本，加了会把这条路堵死。
   */
  private hardeningArgs(
    owner?: { uid: number; gid: number },
    tmpfsSize: string = HARDENED_TMPFS_SIZE
  ): string[] {
    return [
      "--read-only",
      "--tmpfs",
      `/tmp:rw,size=${tmpfsSize}`,
      ...(owner ? ["--user", `${owner.uid}:${owner.gid}`] : [])
    ];
  }

  /**
   * 加固后的环境变量。三条都是实测得来，不是推测：
   *
   * - `HOME=/tmp`：根文件系统只读，`$HOME` 默认是 `/`（非 root 且无 passwd 条目时），
   *   任何 `mkdir ~/.npm` 都会失败。指向唯一的可写处。
   * - `npm_config_store_dir`：镜像把 store 配置写在 `/root/.config/pnpm/rc`，**非 root 用户
   *   读不到**——实测 `pnpm config get store-dir` 在 uid 1000 下返回 undefined，于是 pnpm
   *   转而去联网下载（`EAI_AGAIN`），离线预热整个失效。用 env 显式覆盖。
   *   `registry` 模式下改指 tmpfs 里的**空** store（见 `storeDirFor`）。
   * - `npm_config_ignore_scripts`：依赖的 lifecycle 脚本不跑。实测对 esbuild 无影响（它的
   *   二进制来自 `@esbuild/linux-*` 平台包，不是 postinstall 下载），对项目自己的
   *   `pre*`/`post*` 脚本也无影响（那是 `pnpm run` 的路径，不受此变量管）。
   */
  private hardeningEnv(network: SandboxNetwork): Record<string, string> {
    return {
      HOME: HARDENED_HOME,
      npm_config_store_dir: storeDirFor(network, this.storeDir),
      npm_config_ignore_scripts: "true"
    };
  }
}

/**
 * `docs/236` §3：`"registry"` 模式下 pnpm **必须**写 store，而镜像里的 `/opt/pnpm-store`
 * 是 root 所有且只读的（第 1 步的已知限制）。
 *
 * 两个选项都比过：
 * - 让镜内 store 可写 ⇒ 等于允许任意代码往共享缓存里塞包，且容器间互相污染；
 * - 把预热 store 复制进 tmpfs 再用 ⇒ F1 实测 217MB，每次命令多一次 217MB 拷贝，且
 *   预热的意义消失了（既然有 registry，就不需要预热）。
 *
 * 所以 registry 模式下用一个**空的** tmpfs store：包全部从 registry 拉（verdaccio 自己
 * 有磁盘缓存，跨命令复用）。实测两个包的 store 只有 124KB。
 */
function storeDirFor(network: SandboxNetwork, defaultStoreDir: string): string {
  return network === "registry" ? REGISTRY_STORE_DIR : defaultStoreDir;
}

/** `docs/236` §3：`"registry"` 接的是 internal 网络本身，不是 `bridge`。 */
function dockerNetwork(network: SandboxNetwork, egress: EgressTarget): string {
  return network === "registry" ? egress.network : "none";
}

/**
 * `docs/236` §3：`registry` 模式下把 pnpm 指向出口。走 env 而不是写 `.npmrc` 文件：
 * 工作区是被测项目的，平台不该往里塞配置文件（那也会被 diff 审计算成生成物的改动）。
 */
function networkEnv(network: SandboxNetwork, egress: EgressTarget): Record<string, string> {
  if (network !== "registry") return {};
  return { npm_config_registry: `http://${egress.registry}/` };
}

/**
 * `registry` 模式额外要可写的 store 目录。`/tmp` 在加固下已是 tmpfs；未加固时它也落在
 * 容器内可写层，`--rm` 后一起消失，不会跨命令泄漏。
 */
function registryStoreArgs(network: SandboxNetwork): string[] {
  if (network !== "registry") return [];
  return ["--tmpfs", `${REGISTRY_STORE_DIR}:rw,size=${REGISTRY_STORE_SIZE}`];
}

/**
 * 工作区的宿主属主。`--user` 取它，容器内写权限与挂载属主一致。
 *
 * 容器以 uid 0 运行时 bind mount 里写出来的是 root 文件，宿主上删不掉——这正是加固要
 * 顺带解决的那个问题。
 */
async function workspaceOwner(workspace: string): Promise<{ uid: number; gid: number }> {
  const stats = await stat(workspace);
  return { uid: stats.uid, gid: stats.gid };
}
