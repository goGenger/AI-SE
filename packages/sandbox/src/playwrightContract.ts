/**
 * docs/264：Playwright / 浏览器是平台契约，而不是跟每个产品升级走的镜像消防。
 *
 * 镜像 `ai-se-sandbox:22-pnpm9` 已预置的 Chromium 已核实：
 *   - 平台全局 playwright@1.61.0 → chromium-1228（uiSmoke）
 *   - 产品契约 playwright / @playwright/test@1.64.1 → chromium-1248
 *     （v10 官方 E2E 已在 1248 上通过；Dockerfile ARG PLAYWRIGHT_PRODUCT_VERSION）
 * 1.65.0 需要 chromium-1254，镜像里没有，沙箱也没有外网安装。
 *
 * 新产品模板与官方 E2E 必须钉死 PLATFORM_PLAYWRIGHT_VERSION。
 * 智能体不得把 Playwright 当普通依赖升级；版本不一致时对齐到本契约或立刻失败，
 * 禁止在沙箱里执行 `playwright install`，也不得因此空烧 BUILD。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 产品官方 E2E 必须使用的 Playwright / @playwright/test 精确版本。 */
export const PLATFORM_PLAYWRIGHT_VERSION = "1.64.1";

/** 与 PLATFORM_PLAYWRIGHT_VERSION 对应、已在镜像核实的 Chromium revision。 */
export const PLATFORM_CHROMIUM_REVISION = "1248";

/** 平台全局 playwright（uiSmoke），对应 chromium-1228。 */
export const PLATFORM_BASE_PLAYWRIGHT_VERSION = "1.61.0";
export const PLATFORM_BASE_CHROMIUM_REVISION = "1228";

export const PLATFORM_PLAYWRIGHT_PACKAGES = [
  "playwright",
  "playwright-core",
  "@playwright/test"
] as const;

/**
 * 已在镜像或产品树里核实过的 version → Chromium revision。
 * 未列出的版本不得臆测；见 resolveChromiumRevision。
 */
export const VERIFIED_PLAYWRIGHT_CHROMIUM_REVISIONS: Readonly<Record<string, string>> = {
  "1.61.0": "1228",
  "1.64.1": "1248",
  "1.65.0": "1254"
};

/** 镜像 ai-se-sandbox:22-pnpm9 已预置、经 docker 核实的 Chromium 目录。 */
export const PLATFORM_BAKED_CHROMIUM_REVISIONS: readonly string[] = ["1228", "1248"];

export type PlaywrightPackageName = (typeof PLATFORM_PLAYWRIGHT_PACKAGES)[number];

export type WorkspacePlaywrightInspection = {
  declared: Partial<Record<PlaywrightPackageName, string>>;
  locked: Partial<Record<PlaywrightPackageName, string>>;
  installed: Partial<Record<PlaywrightPackageName, string>>;
  installedRevision?: string;
  resolvedVersion?: string;
  requiredRevision?: string;
  contractMismatch: boolean;
  safeToRealign: boolean;
  reason: string;
};

function readText(path: string, readFile: (path: string) => string): string | undefined {
  try {
    return readFile(path);
  } catch {
    return undefined;
  }
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function normalizePlaywrightVersion(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  const match = spec.trim().match(/(\d+\.\d+\.\d+)/);
  return match?.[1];
}

export function compareSemver(left: string, right: string): number {
  const parts = (value: string): number[] =>
    value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

/**
 * 声明是否包含平台钉（精确版本、或 ^/~/>= 范围下界不高于 1.64.1 且能取到该版本）。
 * 不引入 semver 依赖：覆盖本仓库实际出现的 npm 范围写法。
 */
export function rangeIncludesPlatformPin(
  spec: string | undefined,
  pin: string = PLATFORM_PLAYWRIGHT_VERSION
): boolean {
  if (!spec) return true;
  const trimmed = spec.trim();
  if (trimmed === "*" || trimmed === "latest" || trimmed === "x") return true;
  if (trimmed === pin || trimmed === `=${pin}`) return true;
  const exact = normalizePlaywrightVersion(trimmed);
  const op = trimmed.match(/^(>=|>|<=|<|=|~|\^)?\s*v?(\d+\.\d+\.\d+)/);
  if (!op || !exact) return false;
  const kind = op[1] ?? "=";
  if (kind === "=" || kind === "") return exact === pin;
  if (kind === ">=") return compareSemver(pin, exact) >= 0;
  if (kind === ">") return compareSemver(pin, exact) > 0;
  if (kind === "<=") return compareSemver(pin, exact) <= 0;
  if (kind === "<") return compareSemver(pin, exact) < 0;
  if (kind === "^") {
    // ^1.51.0 includes 1.64.1; ^1.65.0 does not.
    if (compareSemver(pin, exact) < 0) return false;
    const [maj] = exact.split(".");
    const [pinMaj] = pin.split(".");
    return maj === pinMaj;
  }
  if (kind === "~") {
    if (compareSemver(pin, exact) < 0) return false;
    const [maj, min] = exact.split(".");
    const [pinMaj, pinMin] = pin.split(".");
    return maj === pinMaj && min === pinMin;
  }
  return false;
}

export function resolveChromiumRevision(
  version: string | undefined,
  installedRevision?: string
): string | undefined {
  if (installedRevision && /^\d+$/.test(installedRevision)) return installedRevision;
  if (!version) return undefined;
  return VERIFIED_PLAYWRIGHT_CHROMIUM_REVISIONS[version];
}

export function isBakedChromiumRevision(
  revision: string | undefined,
  baked: readonly string[] = PLATFORM_BAKED_CHROMIUM_REVISIONS
): boolean {
  return Boolean(revision && baked.includes(revision));
}

function declaredSpecsFromPackageJson(
  pkg: Record<string, unknown> | undefined
): Partial<Record<PlaywrightPackageName, string>> {
  const declared: Partial<Record<PlaywrightPackageName, string>> = {};
  if (!pkg) return declared;
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;
    for (const name of PLATFORM_PLAYWRIGHT_PACKAGES) {
      const spec = (deps as Record<string, unknown>)[name];
      if (typeof spec === "string" && spec.trim()) declared[name] = spec.trim();
    }
  }
  return declared;
}

function lockedVersionsFromPackageLock(
  lock: Record<string, unknown> | undefined
): Partial<Record<PlaywrightPackageName, string>> {
  const locked: Partial<Record<PlaywrightPackageName, string>> = {};
  if (!lock) return locked;
  const packages = lock.packages;
  if (packages && typeof packages === "object") {
    for (const name of PLATFORM_PLAYWRIGHT_PACKAGES) {
      const entry = (packages as Record<string, unknown>)[`node_modules/${name}`];
      if (entry && typeof entry === "object") {
        const version = (entry as { version?: unknown }).version;
        if (typeof version === "string") locked[name] = version;
      }
    }
  }
  return locked;
}

function firstVersion(
  record: Partial<Record<PlaywrightPackageName, string>>
): string | undefined {
  return (
    record["@playwright/test"] ??
    record.playwright ??
    record["playwright-core"]
  );
}

export function inspectWorkspacePlaywright(input: {
  workspaceRoot: string;
  existsSyncFn?: ((path: string) => boolean) | undefined;
  readFileSyncFn?: ((path: string) => string) | undefined;
  bakedRevisions?: readonly string[] | undefined;
}): WorkspacePlaywrightInspection {
  const exists = input.existsSyncFn ?? existsSync;
  const readFile =
    input.readFileSyncFn ?? ((path: string) => readFileSync(path, "utf8"));
  const root = input.workspaceRoot;
  const baked = input.bakedRevisions ?? PLATFORM_BAKED_CHROMIUM_REVISIONS;

  const declared = declaredSpecsFromPackageJson(
    exists(join(root, "package.json"))
      ? parseJson(readText(join(root, "package.json"), readFile))
      : undefined
  );
  const locked = lockedVersionsFromPackageLock(
    exists(join(root, "package-lock.json"))
      ? parseJson(readText(join(root, "package-lock.json"), readFile))
      : undefined
  );

  const installed: Partial<Record<PlaywrightPackageName, string>> = {};
  let installedRevision: string | undefined;
  for (const name of PLATFORM_PLAYWRIGHT_PACKAGES) {
    const pkgPath = join(root, "node_modules", name, "package.json");
    if (!exists(pkgPath)) continue;
    const pkg = parseJson(readText(pkgPath, readFile));
    if (typeof pkg?.version === "string") installed[name] = pkg.version;
  }
  const browsersPath = join(root, "node_modules", "playwright-core", "browsers.json");
  const browsers = exists(browsersPath) ? parseJson(readText(browsersPath, readFile)) : undefined;
  const browserList = browsers && Array.isArray(browsers.browsers) ? browsers.browsers : [];
  for (const entry of browserList) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as { name?: unknown; revision?: unknown };
    if (rec.name === "chromium-headless-shell" || rec.name === "chromium") {
      if (typeof rec.revision === "string" && /^\d+$/.test(rec.revision)) {
        installedRevision = rec.revision;
        if (rec.name === "chromium-headless-shell") break;
      }
    }
  }

  const resolvedVersion =
    firstVersion(installed) ?? firstVersion(locked) ?? normalizePlaywrightVersion(firstVersion(declared));
  const requiredRevision = resolveChromiumRevision(resolvedVersion, installedRevision);
  const safeToRealign = PLATFORM_PLAYWRIGHT_PACKAGES.every((name) =>
    rangeIncludesPlatformPin(declared[name])
  );
  const pinLocked = Object.values(locked).every(
    (version) => !version || version === PLATFORM_PLAYWRIGHT_VERSION
  );
  const matchesPin =
    (resolvedVersion === PLATFORM_PLAYWRIGHT_VERSION || resolvedVersion === PLATFORM_BASE_PLAYWRIGHT_VERSION) &&
    isBakedChromiumRevision(requiredRevision ?? resolveChromiumRevision(resolvedVersion), baked);
  const bakedOk = isBakedChromiumRevision(requiredRevision, baked);
  const contractMismatch = Boolean(
    resolvedVersion &&
      !matchesPin &&
      (requiredRevision ? !bakedOk : compareSemver(resolvedVersion, PLATFORM_PLAYWRIGHT_VERSION) > 0)
  );

  let reason: string;
  if (!resolvedVersion) {
    reason = "No Playwright package declared, locked, or installed in the workspace.";
  } else if (contractMismatch) {
    reason =
      `PLAYWRIGHT_CONTRACT_MISMATCH: product Playwright ${resolvedVersion}` +
      (requiredRevision ? ` requires chromium-${requiredRevision}` : " has no verified baked Chromium revision") +
      `; platform contract is ${PLATFORM_PLAYWRIGHT_VERSION} / chromium-${PLATFORM_CHROMIUM_REVISION} ` +
      `(image ai-se-sandbox:22-pnpm9 bakes ${baked.join(", ")}). ` +
      (safeToRealign || pinLocked
        ? `Safe to realign to ${PLATFORM_PLAYWRIGHT_VERSION}; do not run playwright install in the sandbox.`
        : `Not safe to auto-realign (declared range excludes ${PLATFORM_PLAYWRIGHT_VERSION}); fail fast. Do not run playwright install or open a BUILD install loop.`);
  } else {
    reason =
      `Playwright ${resolvedVersion} matches the platform browser contract ` +
      `(chromium-${requiredRevision ?? PLATFORM_CHROMIUM_REVISION} is baked).`;
  }

  return {
    declared,
    locked,
    installed,
    ...(installedRevision ? { installedRevision } : {}),
    ...(resolvedVersion ? { resolvedVersion } : {}),
    ...(requiredRevision ? { requiredRevision } : {}),
    contractMismatch,
    safeToRealign: safeToRealign || pinLocked,
    reason
  };
}

export function playwrightContractMismatchReason(inspection: WorkspacePlaywrightInspection): string {
  return (
    inspection.reason +
    " ENV_GAP: treat this as a platform contract mismatch, not a FRONTEND defect, and never install browsers in the sandbox."
  );
}

export function assertPlaywrightManifestContent(
  content: string,
  pathHint = "package.json"
): { ok: true } | { ok: false; reason: string } {
  if (!/(^|\/)package\.json$/i.test(pathHint.replace(/\\/g, "/"))) {
    return { ok: true };
  }
  const pkg = parseJson(content);
  if (!pkg) return { ok: true };
  const declared = declaredSpecsFromPackageJson(pkg);
  const offenders: string[] = [];
  for (const name of PLATFORM_PLAYWRIGHT_PACKAGES) {
    const spec = declared[name];
    if (!spec) continue;
    if (spec === PLATFORM_PLAYWRIGHT_VERSION || spec === `=${PLATFORM_PLAYWRIGHT_VERSION}`) continue;
    if (!rangeIncludesPlatformPin(spec)) {
      offenders.push(`${name}@${spec}`);
    } else if (spec !== PLATFORM_PLAYWRIGHT_VERSION) {
      // 浮动范围（如 ^1.51.0）会把新产品再次升到 1254。清单写入必须钉死精确版本。
      offenders.push(`${name}@${spec}`);
    }
  }
  if (offenders.length === 0) return { ok: true };
  return {
    ok: false,
    reason:
      `PLAYWRIGHT_CONTRACT_MISMATCH: ${pathHint} must pin ${PLATFORM_PLAYWRIGHT_PACKAGES.join(", ")} ` +
      `to exactly ${PLATFORM_PLAYWRIGHT_VERSION} (chromium-${PLATFORM_CHROMIUM_REVISION}). ` +
      `Refusing ${offenders.join(", ")}.`
  };
}

export function commandAttemptsPlaywrightBump(command: string): boolean {
  if (!command.trim()) return false;
  // `@` 不是单词字符，不能用 \b 去贴 `@playwright/test`。
  const install = /(?:npm|pnpm|yarn|bun)(?:\s+exec)?\s+(?:install|i|add|update|upgrade|up)\b/i;
  if (!install.test(command)) return false;
  const mention =
    /(?:^|[\s,=])(@playwright\/test|playwright-core|(?<!@)playwright)(?:@([^\s;|&]+))?/gi;
  const pin = PLATFORM_PLAYWRIGHT_VERSION;
  let matched = false;
  for (const match of command.matchAll(mention)) {
    matched = true;
    const spec = match[2] ?? "";
    if (spec === pin || spec === `=${pin}`) continue;
    return true;
  }
  return false;
}

export function commandIsSandboxPlaywrightBrowserInstall(command: string): boolean {
  if (!command.trim()) return false;
  if (/\btest:e2e:install\b/i.test(command)) return true;
  return (
    /(?:^|\s)(?:npx|pnpm\s+exec|npm\s+exec|yarn\s+exec)\s+playwright(?:@[\w.-]+)?\s+install(?:\s|$)/i.test(
      command
    ) || /(?:^|\s)playwright(?:@[\w.-]+)?\s+install(?:\s|$)/i.test(command)
  );
}

/**
 * 在声明范围已包含平台钉时，把 package.json 里的 Playwright 字段改成精确版本。
 * 不跑 npm install（无网沙箱里装不上）；调用方在宿主刷新 lockfile。
 */
export function realignPackageJsonToPlatformPin(content: string): {
  changed: boolean;
  content: string;
  safe: boolean;
  reason: string;
} {
  const pkg = parseJson(content);
  if (!pkg) {
    return { changed: false, content, safe: false, reason: "package.json is not valid JSON" };
  }
  const declared = declaredSpecsFromPackageJson(pkg);
  if (Object.keys(declared).length === 0) {
    return {
      changed: false,
      content,
      safe: true,
      reason: "No Playwright packages declared"
    };
  }
  const safe = PLATFORM_PLAYWRIGHT_PACKAGES.every((name) => rangeIncludesPlatformPin(declared[name]));
  if (!safe) {
    return {
      changed: false,
      content,
      safe: false,
      reason: `Declared Playwright range excludes ${PLATFORM_PLAYWRIGHT_VERSION}`
    };
  }
  let changed = false;
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;
    const rec = deps as Record<string, unknown>;
    for (const name of PLATFORM_PLAYWRIGHT_PACKAGES) {
      if (typeof rec[name] === "string" && rec[name] !== PLATFORM_PLAYWRIGHT_VERSION) {
        rec[name] = PLATFORM_PLAYWRIGHT_VERSION;
        changed = true;
      }
    }
  }
  return {
    changed,
    content: changed ? `${JSON.stringify(pkg, null, 2)}\n` : content,
    safe: true,
    reason: changed
      ? `Realigned Playwright packages to ${PLATFORM_PLAYWRIGHT_VERSION}`
      : `Playwright packages already pinned to ${PLATFORM_PLAYWRIGHT_VERSION}`
  };
}
