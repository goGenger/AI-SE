/**
 * docs/255：Linux 沙箱的 Playwright 浏览器持久缓存。
 *
 * 默认沙箱是加固的 Linux 容器（`--read-only`、`network: none` 或仅能打到
 * 内网 registry）。宿主 Darwin 上的 `~/Library/Caches/ms-playwright` **不能**
 * 拿来满足沙箱里的 linux-arm64 二进制；agent 在沙箱内跑 `playwright install`
 * 也打不到 Playwright CDN。因此：
 *
 * 1. 镜像构建期预置 Chromium（见 `packages/sandbox/Dockerfile`，1.61.0 的 1228
 *    与产品锁 1.64.1 的 1248 并存于 `/opt/ms-playwright`）；
 * 2. 把宿主侧持久目录（默认 `~/.cache/ai-se/ms-playwright`）在可种源时挂到
 *    容器的 `/opt/ms-playwright`，避免每个容器丢缓存；
 * 3. 平台侧（非 agent 沙箱）可用 `provisionPlaywrightBrowsers` 在有网的辅助
 *    容器里补装缺失版本——这不是「registry 出网」，agent 命令仍无 CDN。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  PLATFORM_BASE_PLAYWRIGHT_VERSION,
  PLATFORM_CHROMIUM_REVISION,
  PLATFORM_PLAYWRIGHT_VERSION
} from "./playwrightContract";

/** 容器内 Playwright 浏览器目录（与镜像 ENV 一致）。 */
export const SANDBOX_PLAYWRIGHT_BROWSERS_PATH = "/opt/ms-playwright";

/** 镜像全局 playwright（uiSmoke / 平台探针），对应 chromium-1228。 */
export const SANDBOX_PLAYWRIGHT_BASE_VERSION = PLATFORM_BASE_PLAYWRIGHT_VERSION;

/**
 * docs/264：产品官方 E2E 跟随平台契约，而不是相反。
 * 镜像预置该版本的 Chromium（rev 1248）。升级须走正式的镜像与模板发布。
 */
export const SANDBOX_PLAYWRIGHT_PRODUCT_VERSION = PLATFORM_PLAYWRIGHT_VERSION;
export const SANDBOX_PLAYWRIGHT_PRODUCT_REVISION = PLATFORM_CHROMIUM_REVISION;

/**
 * ENV_GAP 浏览器/运行时安装预算。必须明显长于验证门通用的 120s
 * （`DEFAULT_CHECK_TIMEOUT_MS`），否则 `playwright install chromium` 还没出
 * 下载进度就被工具层掐死。工作流任务预算约 30 分钟，这里取 15 分钟。
 */
export const ENV_GAP_INSTALL_TIMEOUT_MS = 900_000;

export function defaultLinuxPlaywrightCacheDir(home: string = homedir()): string {
  return path.join(home, ".cache", "ai-se", "ms-playwright");
}

export function playwrightCacheHasChromium(
  dir: string,
  revision?: string,
  readDir: (path: string) => string[] = (p) => readdirSync(p),
  exists: (path: string) => boolean = existsSync
): boolean {
  if (!exists(dir)) return false;
  let entries: string[] = [];
  try {
    entries = readDir(dir);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (!/chromium/i.test(entry)) return false;
    if (!revision) return true;
    return entry === `chromium-${revision}` || entry === `chromium_headless_shell-${revision}`;
  });
}

export function playwrightCacheVolumeArgs(hostDir: string): string[] {
  return ["--volume", `${hostDir}:${SANDBOX_PLAYWRIGHT_BROWSERS_PATH}`];
}

async function runDocker(
  dockerCommand: string,
  args: string[],
  timeoutMs: number
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(dockerCommand, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => finish(exitCode));
  });
}

/**
 * 用一次性容器 + `docker cp` 把镜像里的 `/opt/ms-playwright` 拷到宿主缓存。
 * 失败时返回 ok:false，调用方不得把空目录挂到容器上（会盖住镜像里已有的浏览器）。
 */
export async function seedPlaywrightCacheFromImage(input: {
  hostDir: string;
  dockerCommand?: string;
  image?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; reason?: string }> {
  const hostDir = input.hostDir;
  mkdirSync(hostDir, { recursive: true });
  if (playwrightCacheHasChromium(hostDir)) return { ok: true };
  const dockerCommand = input.dockerCommand ?? "docker";
  const image = input.image ?? "ai-se-sandbox:22-pnpm9";
  const timeoutMs = input.timeoutMs ?? 180_000;
  const name = `ai-se-pw-seed-${Date.now()}`;
  try {
    const created = await runDocker(
      dockerCommand,
      ["create", "--name", name, image, "true"],
      Math.min(timeoutMs, 60_000)
    );
    if (created.exitCode !== 0) {
      return { ok: false, reason: `docker create failed: ${created.stderr.trim()}` };
    }
    const copied = await runDocker(
      dockerCommand,
      ["cp", `${name}:${SANDBOX_PLAYWRIGHT_BROWSERS_PATH}/.`, hostDir],
      timeoutMs
    );
    await runDocker(dockerCommand, ["rm", "-f", name], 30_000);
    if (copied.exitCode !== 0) {
      return { ok: false, reason: `docker cp failed: ${copied.stderr.trim()}` };
    }
    return playwrightCacheHasChromium(hostDir)
      ? { ok: true }
      : { ok: false, reason: "image copy completed but no chromium directory was found" };
  } catch (error) {
    await runDocker(dockerCommand, ["rm", "-f", name], 30_000).catch(() => undefined);
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 平台侧（有网的辅助容器，不是 agent 沙箱）安装指定 Playwright 版本的 Chromium
 * 到宿主持久缓存。默认沙箱 `network: none` / `registry` 打不到 CDN，所以这是
 * 运行时能真正补齐 rev 的路径。
 */
export async function provisionPlaywrightBrowsers(input: {
  hostDir: string;
  dockerCommand?: string;
  image?: string;
  playwrightVersion?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; reason?: string; timedOut?: boolean }> {
  const hostDir = input.hostDir;
  mkdirSync(hostDir, { recursive: true });
  const version = input.playwrightVersion ?? SANDBOX_PLAYWRIGHT_PRODUCT_VERSION;
  const revision =
    version === SANDBOX_PLAYWRIGHT_PRODUCT_VERSION
      ? SANDBOX_PLAYWRIGHT_PRODUCT_REVISION
      : undefined;
  if (revision && playwrightCacheHasChromium(hostDir, revision)) return { ok: true };
  const dockerCommand = input.dockerCommand ?? "docker";
  const image = input.image ?? "ai-se-sandbox:22-pnpm9";
  const timeoutMs = input.timeoutMs ?? ENV_GAP_INSTALL_TIMEOUT_MS;
  try {
    const result = await runDocker(
      dockerCommand,
      [
        "run",
        "--rm",
        // 平台基建出网（默认 bridge），不是 agent 沙箱的 registry 出口。
        "-v",
        `${hostDir}:${SANDBOX_PLAYWRIGHT_BROWSERS_PATH}`,
        "-e",
        `PLAYWRIGHT_BROWSERS_PATH=${SANDBOX_PLAYWRIGHT_BROWSERS_PATH}`,
        "--entrypoint",
        "bash",
        image,
        "-lc",
        `npx --yes playwright@${version} install chromium`
      ],
      timeoutMs
    );
    if (result.timedOut) {
      return { ok: false, timedOut: true, reason: "privileged playwright install timed out" };
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        reason: `privileged playwright install exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`
      };
    }
    const ok = revision
      ? playwrightCacheHasChromium(hostDir, revision)
      : playwrightCacheHasChromium(hostDir);
    return ok
      ? { ok: true }
      : { ok: false, reason: "install finished but required chromium revision is still missing" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 准备可挂载的宿主缓存：优先从镜像种源，可选再补装产品锁版本。
 * 若最终缓存里没有 Chromium，返回 ok:false——调用方不得挂载空目录。
 */
export async function ensurePlaywrightBrowserCache(input: {
  hostDir?: string;
  dockerCommand?: string;
  image?: string;
  provision?: boolean;
  timeoutMs?: number;
} = {}): Promise<{ ok: boolean; hostDir: string; reason?: string; mounted: boolean }> {
  const hostDir = input.hostDir ?? defaultLinuxPlaywrightCacheDir();
  mkdirSync(hostDir, { recursive: true });
  if (!playwrightCacheHasChromium(hostDir)) {
    const seeded = await seedPlaywrightCacheFromImage({
      hostDir,
      dockerCommand: input.dockerCommand,
      image: input.image
    });
    if (!seeded.ok && !input.provision) {
      return { ok: false, hostDir, mounted: false, reason: seeded.reason };
    }
  }
  if (
    input.provision &&
    !playwrightCacheHasChromium(hostDir, SANDBOX_PLAYWRIGHT_PRODUCT_REVISION)
  ) {
    const provisioned = await provisionPlaywrightBrowsers({
      hostDir,
      dockerCommand: input.dockerCommand,
      image: input.image,
      timeoutMs: input.timeoutMs ?? ENV_GAP_INSTALL_TIMEOUT_MS
    });
    if (!provisioned.ok && !playwrightCacheHasChromium(hostDir)) {
      return { ok: false, hostDir, mounted: false, reason: provisioned.reason };
    }
    if (!provisioned.ok) {
      // 有 1228 等旧 rev 仍可挂，但产品 1248 缺失——调用方按 ENV_GAP 处理。
      return {
        ok: playwrightCacheHasChromium(hostDir, SANDBOX_PLAYWRIGHT_PRODUCT_REVISION),
        hostDir,
        mounted: playwrightCacheHasChromium(hostDir),
        reason: provisioned.reason
      };
    }
  }
  const hasAny = playwrightCacheHasChromium(hostDir);
  return {
    ok: hasAny,
    hostDir,
    mounted: hasAny,
    ...(hasAny ? {} : { reason: "no chromium in playwright cache after seed/provision" })
  };
}
