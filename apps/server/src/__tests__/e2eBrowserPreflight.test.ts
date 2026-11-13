import { describe, expect, it } from "vitest";
import {
  e2eBrowserPreflight,
  isStaleOrClearedPlaywrightEnvGapNarrative,
  matchesPlaywrightEnvGap,
  matchesPlaywrightMissingBinaryEnvGap,
  matchesPlaywrightResourceEnvGap,
  probePlaywrightBrowsers,
  workspaceLikelyNeedsPlaywrightBrowser
} from "../services/e2eBrowserPreflight";

describe("matchesPlaywrightEnvGap", () => {
  it("detects /opt/ms-playwright + Executable doesn't exist", () => {
    expect(
      matchesPlaywrightEnvGap(
        "browserType.launch: Executable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1200/chrome-linux/headless_shell"
      )
    ).toBe(true);
  });

  it("detects E2E BLOCKED with playwright", () => {
    expect(
      matchesPlaywrightEnvGap("11 e2e cases BLOCKED — playwright chromium missing")
    ).toBe(true);
  });

  it("ignores unrelated pinia fixture text", () => {
    expect(matchesPlaywrightEnvGap("getActivePinia was called with no active Pinia")).toBe(false);
  });
});

describe("workspaceLikelyNeedsPlaywrightBrowser", () => {
  it("true when test script mentions playwright", () => {
    expect(
      workspaceLikelyNeedsPlaywrightBrowser({
        scripts: { test: "playwright test" }
      })
    ).toBe(true);
  });

  it("true when playwright.config.ts exists", () => {
    expect(
      workspaceLikelyNeedsPlaywrightBrowser({
        workspaceRoot: "/ws",
        existsSyncFn: (p) => p.endsWith("playwright.config.ts")
      })
    ).toBe(true);
  });

  it("false for plain vitest unit script without config", () => {
    expect(
      workspaceLikelyNeedsPlaywrightBrowser({
        scripts: { test: "vitest run" },
        workspaceRoot: "/ws",
        existsSyncFn: () => false
      })
    ).toBe(false);
  });
});

describe("probePlaywrightBrowsers / e2eBrowserPreflight", () => {
  it("ok when chromium dir present under /opt/ms-playwright", () => {
    const result = probePlaywrightBrowsers({
      env: {},
      homedirFn: () => "/home/x",
      existsSyncFn: (p) =>
        p === "/opt/ms-playwright" || p === "/opt/ms-playwright/chromium-1200",
      readdirSyncFn: (p) => (p === "/opt/ms-playwright" ? ["chromium-1200"] : [])
    });
    expect(result.ok).toBe(true);
  });

  it("ENV_GAP when no chromium in any root", () => {
    const result = probePlaywrightBrowsers({
      env: {},
      homedirFn: () => "/home/x",
      existsSyncFn: () => false,
      readdirSyncFn: () => []
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureClass).toBe("ENV_GAP");
      expect(result.reason).toMatch(/Playwright browser binaries missing/i);
    }
  });

  it("skips when workspace does not need playwright", () => {
    expect(
      e2eBrowserPreflight({
        scripts: { test: "vitest run" },
        workspaceRoot: "/ws",
        existsSyncFn: () => false
      })
    ).toBeNull();
  });

  it("fail-closed ENV_GAP when e2e script and browsers missing", () => {
    const result = e2eBrowserPreflight({
      scripts: { test: "playwright test" },
      env: {},
      homedirFn: () => "/home/x",
      existsSyncFn: () => false,
      readdirSyncFn: () => []
    });
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.failureClass).toBe("ENV_GAP");
  });
});


describe("docs/255：预检不把宿主 macOS 缓存和 sibling e2e 脚本当成已就绪", () => {
  it("official vitest command is not preflighted just because test:e2e exists", () => {
    expect(
      workspaceLikelyNeedsPlaywrightBrowser({
        scripts: { test: "vitest run", "test:e2e": "playwright test" },
        command: "npm run test -- --reporter=verbose"
      })
    ).toBe(false);
    expect(
      e2eBrowserPreflight({
        scripts: { test: "vitest run", "test:e2e": "playwright test" },
        command: "npm run test -- --reporter=verbose",
        workspaceRoot: "/ws",
        existsSyncFn: (path) => path.endsWith("playwright.config.ts")
      })
    ).toBeNull();
  });

  it("does not treat Darwin host cache as satisfying a Linux sandbox", () => {
    const result = probePlaywrightBrowsers({
      env: {},
      homedirFn: () => "/Users/you",
      hostPlatform: "darwin",
      sandboxPlatform: "linux",
      existsSyncFn: (p) =>
        p === "/Users/you/Library/Caches/ms-playwright" ||
        p === "/Users/you/Library/Caches/ms-playwright/chromium-1228",
      readdirSyncFn: (p) =>
        p === "/Users/you/Library/Caches/ms-playwright" ? ["chromium-1228"] : []
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureClass).toBe("ENV_GAP");
  });

  it("required revision 1248 is not satisfied by chromium-1228", () => {
    const result = probePlaywrightBrowsers({
      env: {},
      homedirFn: () => "/home/x",
      sandboxPlatform: "linux",
      hostPlatform: "linux",
      requiredRevision: "1248",
      existsSyncFn: (p) => p === "/opt/ms-playwright" || p === "/opt/ms-playwright/chromium-1228",
      readdirSyncFn: (p) => (p === "/opt/ms-playwright" ? ["chromium-1228"] : [])
    });
    expect(result.ok).toBe(false);
  });
});

describe("docs/256：缺失二进制 vs 资源限额", () => {
  const crash =
    "Error: pthread_create: Resource temporarily unavailable (11)\nTarget crashed";

  it("classifies Chromium crash / pthread EAGAIN as resource ENV_GAP", () => {
    expect(matchesPlaywrightResourceEnvGap(crash)).toBe(true);
    expect(matchesPlaywrightEnvGap(crash)).toBe(true);
    expect(matchesPlaywrightMissingBinaryEnvGap(crash)).toBe(false);
  });

  it("does not treat a bare chromium_headless_shell path as missing binaries", () => {
    const pathOnly =
      "launching /opt/ms-playwright/chromium_headless_shell-1248/chrome-linux/headless_shell";
    expect(matchesPlaywrightMissingBinaryEnvGap(pathOnly)).toBe(false);
    expect(matchesPlaywrightEnvGap(pathOnly)).toBe(false);
  });

  it("still treats Executable doesn't exist as missing binaries", () => {
    expect(
      matchesPlaywrightMissingBinaryEnvGap(
        "browserType.launch: Executable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1248/chrome-linux/headless_shell"
      )
    ).toBe(true);
  });
});

describe("docs/257：0 BLOCKED / 不再 BLOCKED 不误判缺失浏览器", () => {
  it("does not treat 0 BLOCKED plus a later Playwright config mention as ENV_GAP", () => {
    const report =
      "E2E 31 tests: 24 passed, 7 failed, 0 BLOCKED. Official build passed. Write scope includes Playwright 配置 and playwright.config.ts.";
    expect(matchesPlaywrightMissingBinaryEnvGap(report)).toBe(false);
    expect(matchesPlaywrightEnvGap(report)).toBe(false);
  });

  it("does not treat 不再 BLOCKED plus playwright as a missing binary", () => {
    expect(
      matchesPlaywrightMissingBinaryEnvGap(
        "浏览器已安装，E2E 不再 BLOCKED。见 Playwright 配置 playwright.config.ts。"
      )
    ).toBe(false);
  });

  it("still treats N BLOCKED with nearby missing chromium as ENV_GAP", () => {
    expect(
      matchesPlaywrightEnvGap("11 e2e cases BLOCKED — playwright chromium missing")
    ).toBe(true);
  });
});

describe("docs/261：过期报告与已清除 ENV_GAP 叙述", () => {
  const staleT10 =
    "AC-16 residual honesty: the execution report still declares 31 E2E cases with 29 BLOCKED and browserType.launch in an earlier section. The diagnosed ENV_GAP is cleared — chromium is present and working, smoke 2 passed exit 0, E2E is not BLOCKED. Remaining failures are missing .prettierignore and 156 vs 167 file counts.";

  it("does not treat a stale 29 BLOCKED / browserType.launch description as a current missing binary", () => {
    expect(isStaleOrClearedPlaywrightEnvGapNarrative(staleT10)).toBe(true);
    expect(matchesPlaywrightMissingBinaryEnvGap(staleT10)).toBe(false);
    expect(matchesPlaywrightEnvGap(staleT10)).toBe(false);
  });

  it("does not treat ENV_GAP is cleared / chromium installed / smoke passed as ENV_GAP", () => {
    expect(
      matchesPlaywrightEnvGap(
        "diagnosed ENV_GAP is cleared; chromium is installed; smoke passes 2, exit 0"
      )
    ).toBe(false);
  });

  it("still treats a genuine Executable doesn't exist as ENV_GAP even if a report is mentioned", () => {
    expect(
      matchesPlaywrightMissingBinaryEnvGap(
        "browserType.launch: Executable doesn't exist at /opt/ms-playwright/chromium-1200/chrome-linux/chrome"
      )
    ).toBe(true);
  });
});
