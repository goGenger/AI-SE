/**
 * docs/256：沙箱资源默认值，以及 Playwright 测试命令的 worker 封顶。
 *
 * `--cpus 1` 只限制 CFS 配额，`os.cpus()` 仍能看到宿主核数，Playwright 会按约一半核数开 worker。
 * 平台在执行 `playwright test` / `test:e2e` 时把 `--workers` 封顶为 2，已更小的值不抬高。
 * 不改产品 `playwright.config.*`。
 */

export const DEFAULT_SANDBOX_PIDS_LIMIT = 1024;
export const DEFAULT_SANDBOX_MEMORY = "512m";
export const E2E_SANDBOX_MEMORY = "2g";
export const E2E_HARDENED_TMPFS_SIZE = "1g";
export const SANDBOX_PLAYWRIGHT_MAX_WORKERS = 2;
/** Playwright 测试（非 install）的沙箱超时。install 仍走 ENV_GAP_INSTALL_TIMEOUT_MS。 */
export const E2E_TEST_TIMEOUT_MS = 600_000;

export function isPlaywrightBrowserInstallInvocation(command: string): boolean {
  return /\bplaywright\s+install\b/i.test(command) || /\btest:e2e:install\b/i.test(command);
}

export function isPlaywrightTestCommand(command: string): boolean {
  if (!command.trim()) return false;
  if (isPlaywrightBrowserInstallInvocation(command)) return false;
  if (/\bplaywright\s+test\b/i.test(command)) return true;
  if (/\btest:e2e\b/i.test(command)) return true;
  if (/\be2e:test\b/i.test(command)) return true;
  if (/(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+e2e(?:\s|$)/i.test(command)) return true;
  return false;
}

function needsPackageScriptPassthrough(command: string): boolean {
  return /(?:npm|pnpm|yarn|bun)\s+run\s+\S+/i.test(command) || /(?:npm|yarn)\s+(?:test:e2e|e2e)\b/i.test(command);
}

/**
 * 把 Playwright 测试命令的 `--workers` 封顶为 `maxWorkers`。已有更小的值（如 1）不抬高。
 * 对 `npm run test:e2e` 这类脚本，若还没有 `--`，先补 `--` 再追加参数。
 */
export function capPlaywrightWorkers(
  command: string,
  maxWorkers: number = SANDBOX_PLAYWRIGHT_MAX_WORKERS
): string {
  if (!isPlaywrightTestCommand(command) || maxWorkers < 1) return command;
  const existing = command.match(/--workers(?:=|\s+)(\d+)/i);
  if (existing) {
    const current = Number(existing[1]);
    if (!Number.isFinite(current) || current <= maxWorkers) return command;
    return command.replace(/--workers(?:=|\s+)\d+/i, `--workers=${maxWorkers}`);
  }
  if (needsPackageScriptPassthrough(command) && !/(?:^|\s)--(?:\s|$)/.test(command)) {
    return `${command} -- --workers=${maxWorkers}`;
  }
  return `${command} --workers=${maxWorkers}`;
}

/** Playwright 测试命令的命令级资源覆盖（默认任务仍是 512m）。 */
export function e2eSandboxCommandLimits(command: string): {
  memory?: string;
  tmpfsSize?: string;
} {
  if (!isPlaywrightTestCommand(command)) return {};
  return { memory: E2E_SANDBOX_MEMORY, tmpfsSize: E2E_HARDENED_TMPFS_SIZE };
}
