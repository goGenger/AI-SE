/**
 * E2E / Playwright browser environment preflight (docs/254).
 *
 * Missing Chromium under /opt/ms-playwright (or host cache) is an **ENV_GAP**,
 * not a FRONTEND product defect — probe early so autonomy does not burn FRONTEND REPLAN.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * docs/254/256：缺失二进制证据。刻意不含裸的 `chromium_headless_shell` /
 * `browserType.launch` / `/opt/ms-playwright`——这些也会出现在「二进制已在、进程被限额杀掉」的日志里。
 */
export const PLAYWRIGHT_MISSING_BINARY_PATTERNS: readonly RegExp[] = [
  /\bENV_GAP\b/,
  /\bPLAYWRIGHT_CONTRACT_MISMATCH\b/,
  /\bBROWSER_UNAVAILABLE\b/,
  /Executable doesn'?t exist/i,
  /browser\s+(?:binaries?|executable)s?\s+(?:are\s+)?(?:missing|absent|not found)/i,
  /(?:missing|absent|not found).*(?:browser\s+(?:binaries?|executable)|playwright\s+browser)/i,
  /Please\s+run\s+npx\s+playwright\s+install/i,
  /playwright.*(?:browser|chromium).*(?:missing|not installed)/i,
  /(?:missing|not installed).*playwright.*(?:browser|chromium)/i,
  /\bplaywright(?:\/chromium)?\b.*\bnot found\b/i,
  /\bnot found\b.*\bplaywright(?:\/chromium)?\b/i,
  /\bms-playwright\b.*(?:missing|not found|doesn'?t exist|not installed)/i,
  /(?:missing|not found|doesn'?t exist|not installed).*\bms-playwright\b/i
];

/**
 * docs/256：浏览器已启动，但被沙箱 pid/内存/线程限额杀掉。
 * 这类失败不得再开 BUILD 安装任务。
 */
export const PLAYWRIGHT_RESOURCE_ENV_GAP_PATTERNS: readonly RegExp[] = [
  /pthread_create/i,
  /Resource temporarily unavailable/i,
  /Target crashed/i,
  /(?:pids?-limit|pids\.max|pid(?:s)?\s+(?:limit|quota|exhaust))/i,
  /(?:killed|OOM|ENOMEM|out of memory).*(?:chrom|playwright|browser)/i,
  /(?:chrom|playwright|browser).*(?:killed|OOM|ENOMEM|out of memory)/i
];

/** 兼容旧名：缺失二进制或资源限额，都算 ENV_GAP（避免被当成 FRONTEND）。 */
export const PLAYWRIGHT_ENV_GAP_PATTERNS: readonly RegExp[] = [
  ...PLAYWRIGHT_MISSING_BINARY_PATTERNS,
  ...PLAYWRIGHT_RESOURCE_ENV_GAP_PATTERNS
];

/**
 * docs/257：「N BLOCKED / 0 BLOCKED / 不再 BLOCKED」与后文「Playwright 配置」
 * 不能跨整段证据误判成浏览器缺失。只认同一短窗口内、且不是 0 计数的 BLOCKED。
 *
 * docs/261：描述**过期报告**里的 `29 BLOCKED and browserType.launch`，
 * 或已经写明「ENV_GAP 已清除 / chromium 已安装 / smoke 通过」的叙述，
 * 不得再当成当前浏览器缺失。
 */
const STALE_ENV_GAP_WINDOW =
  /still declares|stale|historical|上一轮|历史(?:小节|事实|报告)?|pins that literal|residual honesty|过期报告|不再成立/i;

const ENV_GAP_CLEARED =
  /ENV_GAP[^\n]{0,80}(?:is\s+)?(?:cleared|cleared and|不再|已清除|已解除)|diagnosed ENV_GAP is cleared|(?:chromium|playwright)[^\n]{0,120}(?:已安装|可用|is\s+present|is\s+installed|is\s+working|present and working)|(?:已安装|可用|is\s+present|is\s+installed|is\s+working)[^\n]{0,80}(?:chromium|playwright)|smoke[^\n]{0,80}(?:2\s+passed|passes\s+2|exit\s*0)|E2E is not BLOCKED/i;

const CURRENT_MISSING_BINARY_PATTERNS: readonly RegExp[] = PLAYWRIGHT_MISSING_BINARY_PATTERNS.filter(
  (pattern) => pattern.source !== "\\bENV_GAP\\b"
);

export function isStaleOrClearedPlaywrightEnvGapNarrative(text: string): boolean {
  if (!text) return false;
  if (!ENV_GAP_CLEARED.test(text) && !STALE_ENV_GAP_WINDOW.test(text)) return false;
  // 同一证据里若仍有「可执行文件不存在 / 请安装」等当前缺失事实，则不能当已清除。
  return !CURRENT_MISSING_BINARY_PATTERNS.some((pattern) => pattern.test(text));
}

function matchesBlockedMissingBrowser(text: string): boolean {
  if (!text) return false;
  if (isStaleOrClearedPlaywrightEnvGapNarrative(text)) return false;
  const windows = [
    /(?:E2E[^\n]{0,80})?\bBLOCKED\b[^\n]{0,80}(?:browser|playwright|chromium|ms-playwright|browserType)/gi,
    /(?:browser|playwright|chromium|ms-playwright|browserType)[^\n]{0,80}\bBLOCKED\b/gi
  ];
  for (const pattern of windows) {
    for (const match of text.matchAll(pattern)) {
      const slice = match[0];
      if (/(?:^|[\s,;:\/])0\s+BLOCKED\b/i.test(slice)) continue;
      if (/(?:不再|未再|not(?:\s+longer)?)\s+BLOCKED\b/i.test(slice)) continue;
      const start = Math.max(0, (match.index ?? 0) - 120);
      const around = text.slice(start, (match.index ?? 0) + slice.length + 120);
      if (STALE_ENV_GAP_WINDOW.test(around)) continue;
      return true;
    }
  }
  return false;
}

export function matchesPlaywrightMissingBinaryEnvGap(text: string): boolean {
  if (!text) return false;
  if (isStaleOrClearedPlaywrightEnvGapNarrative(text)) {
    return CURRENT_MISSING_BINARY_PATTERNS.some((pattern) => pattern.test(text));
  }
  return (
    PLAYWRIGHT_MISSING_BINARY_PATTERNS.some((pattern) => pattern.test(text)) ||
    matchesBlockedMissingBrowser(text)
  );
}

export function matchesPlaywrightResourceEnvGap(text: string): boolean {
  if (!text) return false;
  return PLAYWRIGHT_RESOURCE_ENV_GAP_PATTERNS.some((pattern) => pattern.test(text));
}

export function matchesPlaywrightEnvGap(text: string): boolean {
  return matchesPlaywrightMissingBinaryEnvGap(text) || matchesPlaywrightResourceEnvGap(text);
}

function looksLikePlaywrightOrE2E(text: string): boolean {
  return /playwright|\be2e\b/i.test(text);
}

/**
 * 是否需要为「即将跑的这条命令」预检浏览器。
 *
 * docs/255：仓库里有 sibling `test:e2e` 或根目录 `playwright.config.*`，
 * 不能把官方 `npm run test` / vitest 单测门也 fail-closed。只看：
 * - 传入的 command（官方检查命令）；
 * - 否则官方 `scripts.test`；
 * - 两者都没有时，才回退到 config 文件（纯 e2e 项目）。
 */
export function workspaceLikelyNeedsPlaywrightBrowser(input: {
  scripts?: Record<string, unknown> | undefined;
  command?: string | undefined;
  workspaceRoot?: string | undefined;
  existsSyncFn?: ((path: string) => boolean) | undefined;
}): boolean {
  const exists = input.existsSyncFn ?? existsSync;
  if (input.command && input.command.trim()) {
    return looksLikePlaywrightOrE2E(input.command);
  }
  const officialTest =
    input.scripts && typeof input.scripts.test === "string" ? input.scripts.test : undefined;
  if (officialTest) return looksLikePlaywrightOrE2E(officialTest);

  const root = input.workspaceRoot;
  if (root) {
    for (const name of [
      "playwright.config.ts",
      "playwright.config.js",
      "playwright.config.mjs",
      "playwright.config.cjs"
    ]) {
      if (exists(join(root, name))) return true;
    }
  }
  return false;
}

export type PlaywrightBrowserProbeResult =
  | { ok: true; rootsChecked: string[] }
  | { ok: false; reason: string; rootsChecked: string[]; failureClass: "ENV_GAP" };

function defaultBrowserRoots(
  env: NodeJS.ProcessEnv,
  home: string,
  options: {
    sandboxPlatform?: string;
    hostPlatform?: string;
    linuxCacheDir?: string;
  } = {}
): string[] {
  const roots: string[] = [];
  const fromEnv = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (fromEnv) roots.push(fromEnv);
  roots.push("/opt/ms-playwright");
  if (options.linuxCacheDir) roots.push(options.linuxCacheDir);
  const host = options.hostPlatform ?? process.platform;
  const sandbox = options.sandboxPlatform ?? "linux";
  // 宿主 Darwin 缓存是 macOS 包，不能当成 Linux 沙箱已就绪（docs/255）。
  if (sandbox === host) {
    roots.push(join(home, "Library", "Caches", "ms-playwright"));
    roots.push(join(home, ".cache", "ms-playwright"));
  } else {
    // 跨平台时只认 Linux 持久缓存，不认宿主原生 cache。
    roots.push(join(home, ".cache", "ai-se", "ms-playwright"));
  }
  return [...new Set(roots)];
}

function rootHasChromium(
  root: string,
  exists: (path: string) => boolean,
  readDir: (path: string) => string[],
  requiredRevision?: string
): boolean {
  if (!exists(root)) return false;
  let entries: string[] = [];
  try {
    entries = readDir(root);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/chromium/i.test(entry)) continue;
    if (
      requiredRevision &&
      entry !== `chromium-${requiredRevision}` &&
      entry !== `chromium_headless_shell-${requiredRevision}`
    ) {
      continue;
    }
    const candidate = join(root, entry);
    // Directory named chromium* or a direct binary path — either counts as present.
    if (exists(candidate)) return true;
  }
  return false;
}

/**
 * Host/sandbox probe: do any known Playwright browser cache roots contain Chromium?
 * Injectable fs for unit tests. Does not download browsers.
 */
export function probePlaywrightBrowsers(input: {
  env?: NodeJS.ProcessEnv | undefined;
  homedirFn?: (() => string) | undefined;
  existsSyncFn?: ((path: string) => boolean) | undefined;
  readdirSyncFn?: ((path: string) => string[]) | undefined;
  /** 沙箱平台；缺省 linux（Docker 沙箱）。与宿主不同时不把宿主 cache 当已安装。 */
  sandboxPlatform?: string | undefined;
  hostPlatform?: string | undefined;
  linuxCacheDir?: string | undefined;
  /** 需要的 Chromium rev（如 1248）。缺省只要求存在任意 chromium* 目录。 */
  requiredRevision?: string | undefined;
} = {}): PlaywrightBrowserProbeResult {
  const env = input.env ?? process.env;
  const home = (input.homedirFn ?? homedir)();
  const exists = input.existsSyncFn ?? existsSync;
  const readDir =
    input.readdirSyncFn ??
    ((path: string) => readdirSync(path, { withFileTypes: false }).map(String));
  const roots = defaultBrowserRoots(env, home, {
    sandboxPlatform: input.sandboxPlatform,
    hostPlatform: input.hostPlatform,
    linuxCacheDir: input.linuxCacheDir
  });
  const revision = input.requiredRevision;
  for (const root of roots) {
    if (rootHasChromium(root, exists, readDir, revision)) {
      return { ok: true, rootsChecked: roots };
    }
  }
  return {
    ok: false,
    failureClass: "ENV_GAP",
    rootsChecked: roots,
    reason:
      "Playwright browser binaries missing (no chromium under PLAYWRIGHT_BROWSERS_PATH / " +
      "/opt/ms-playwright / ms-playwright cache). Install with `npx playwright install chromium` " +
      "(BUILD/infra) or mark E2E non-blocking with explicit ENV_GAP evidence — do not open FRONTEND REPLAN."
  };
}

/**
 * When the workspace likely needs Playwright browsers, probe caches.
 * Returns null when E2E is not indicated (skip preflight).
 */
export function e2eBrowserPreflight(input: {
  scripts?: Record<string, unknown> | undefined;
  command?: string | undefined;
  workspaceRoot?: string | undefined;
  force?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homedirFn?: (() => string) | undefined;
  existsSyncFn?: ((path: string) => boolean) | undefined;
  readdirSyncFn?: ((path: string) => string[]) | undefined;
  sandboxPlatform?: string | undefined;
  hostPlatform?: string | undefined;
  linuxCacheDir?: string | undefined;
  requiredRevision?: string | undefined;
}): PlaywrightBrowserProbeResult | null {
  const needs =
    input.force === true ||
    workspaceLikelyNeedsPlaywrightBrowser({
      scripts: input.scripts,
      command: input.command,
      workspaceRoot: input.workspaceRoot,
      existsSyncFn: input.existsSyncFn
    });
  if (!needs) return null;
  return probePlaywrightBrowsers({
    env: input.env,
    homedirFn: input.homedirFn,
    existsSyncFn: input.existsSyncFn,
    readdirSyncFn: input.readdirSyncFn,
    sandboxPlatform: input.sandboxPlatform,
    hostPlatform: input.hostPlatform,
    linuxCacheDir: input.linuxCacheDir,
    requiredRevision: input.requiredRevision
  });
}
