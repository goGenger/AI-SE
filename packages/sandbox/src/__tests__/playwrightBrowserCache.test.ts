import { describe, expect, it } from "vitest";
import {
  defaultLinuxPlaywrightCacheDir,
  ENV_GAP_INSTALL_TIMEOUT_MS,
  playwrightCacheHasChromium,
  playwrightCacheVolumeArgs,
  SANDBOX_PLAYWRIGHT_BROWSERS_PATH,
  SANDBOX_PLAYWRIGHT_PRODUCT_REVISION
} from "../playwrightBrowserCache";

describe("docs/255：Linux Playwright 缓存助手", () => {
  it("default cache is under ~/.cache/ai-se, not the host macOS Playwright cache", () => {
    expect(defaultLinuxPlaywrightCacheDir("/Users/you")).toBe(
      "/Users/you/.cache/ai-se/ms-playwright"
    );
    expect(defaultLinuxPlaywrightCacheDir("/Users/you")).not.toContain("Library/Caches");
  });

  it("volume args mount the host dir at /opt/ms-playwright", () => {
    expect(playwrightCacheVolumeArgs("/var/cache/pw")).toEqual([
      "--volume",
      `/var/cache/pw:${SANDBOX_PLAYWRIGHT_BROWSERS_PATH}`
    ]);
  });

  it("detects chromium directories and can require revision 1248", () => {
    const exists = () => true;
    expect(
      playwrightCacheHasChromium("/opt/ms-playwright", undefined, () => ["chromium-1228"], exists)
    ).toBe(true);
    expect(
      playwrightCacheHasChromium(
        "/opt/ms-playwright",
        SANDBOX_PLAYWRIGHT_PRODUCT_REVISION,
        () => ["chromium-1228"],
        exists
      )
    ).toBe(false);
    expect(
      playwrightCacheHasChromium(
        "/opt/ms-playwright",
        "1248",
        () => ["chromium_headless_shell-1248"],
        exists
      )
    ).toBe(true);
  });

  it("install timeout budget exceeds the generic 120s tool cap", () => {
    expect(ENV_GAP_INSTALL_TIMEOUT_MS).toBeGreaterThan(120_000);
    expect(ENV_GAP_INSTALL_TIMEOUT_MS).toBe(900_000);
  });
});
