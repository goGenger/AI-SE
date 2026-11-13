import { describe, expect, it } from "vitest";
import {
  PLATFORM_CHROMIUM_REVISION,
  PLATFORM_PLAYWRIGHT_VERSION,
  assertPlaywrightManifestContent,
  commandAttemptsPlaywrightBump,
  commandIsSandboxPlaywrightBrowserInstall,
  inspectWorkspacePlaywright,
  rangeIncludesPlatformPin,
  realignPackageJsonToPlatformPin,
  resolveChromiumRevision
} from "../playwrightContract";

describe("docs/264：平台 Playwright 契约", () => {
  it("declares the verified product pin that matches baked Chromium 1248", () => {
    expect(PLATFORM_PLAYWRIGHT_VERSION).toBe("1.64.1");
    expect(PLATFORM_CHROMIUM_REVISION).toBe("1248");
    expect(resolveChromiumRevision("1.64.1")).toBe("1248");
    expect(resolveChromiumRevision("1.61.0")).toBe("1228");
    expect(resolveChromiumRevision("1.65.0")).toBe("1254");
    expect(resolveChromiumRevision("1.70.0")).toBeUndefined();
  });

  it("treats ^1.51.0 as including the pin and ^1.65.0 as a bump", () => {
    expect(rangeIncludesPlatformPin("^1.51.0")).toBe(true);
    expect(rangeIncludesPlatformPin("1.64.1")).toBe(true);
    expect(rangeIncludesPlatformPin("^1.65.0")).toBe(false);
    expect(rangeIncludesPlatformPin("1.65.0")).toBe(false);
  });

  it("detects a workspace that resolved to 1.65.0 / chromium-1254 as a contract mismatch", () => {
    const files: Record<string, string> = {
      "/ws/package.json": JSON.stringify({
        devDependencies: { playwright: "^1.51.0", "@playwright/test": "^1.51.0" }
      }),
      "/ws/package-lock.json": JSON.stringify({
        packages: {
          "node_modules/playwright": { version: "1.64.1" },
          "node_modules/@playwright/test": { version: "1.64.1" },
          "node_modules/playwright-core": { version: "1.64.1" }
        }
      }),
      "/ws/node_modules/@playwright/test/package.json": JSON.stringify({ version: "1.65.0" }),
      "/ws/node_modules/playwright/package.json": JSON.stringify({ version: "1.65.0" }),
      "/ws/node_modules/playwright-core/package.json": JSON.stringify({ version: "1.65.0" }),
      "/ws/node_modules/playwright-core/browsers.json": JSON.stringify({
        browsers: [
          { name: "chromium", revision: "1254" },
          { name: "chromium-headless-shell", revision: "1254" }
        ]
      })
    };
    const inspection = inspectWorkspacePlaywright({
      workspaceRoot: "/ws",
      existsSyncFn: (path) => path in files,
      readFileSyncFn: (path) => files[path] ?? ""
    });
    expect(inspection.resolvedVersion).toBe("1.65.0");
    expect(inspection.requiredRevision).toBe("1254");
    expect(inspection.contractMismatch).toBe(true);
    expect(inspection.safeToRealign).toBe(true);
    expect(inspection.reason).toMatch(/PLAYWRIGHT_CONTRACT_MISMATCH/);
    expect(inspection.reason).toMatch(/1254/);
    expect(inspection.reason).toMatch(/1\.64\.1/);
  });

  it("accepts a workspace pinned and locked to 1.64.1 / 1248", () => {
    const files: Record<string, string> = {
      "/ws/package.json": JSON.stringify({
        devDependencies: { playwright: "1.64.1", "@playwright/test": "1.64.1" }
      }),
      "/ws/package-lock.json": JSON.stringify({
        packages: {
          "node_modules/playwright": { version: "1.64.1" },
          "node_modules/@playwright/test": { version: "1.64.1" },
          "node_modules/playwright-core": { version: "1.64.1" }
        }
      }),
      "/ws/node_modules/playwright-core/package.json": JSON.stringify({ version: "1.64.1" }),
      "/ws/node_modules/playwright-core/browsers.json": JSON.stringify({
        browsers: [{ name: "chromium-headless-shell", revision: "1248" }]
      })
    };
    const inspection = inspectWorkspacePlaywright({
      workspaceRoot: "/ws",
      existsSyncFn: (path) => path in files,
      readFileSyncFn: (path) => files[path] ?? ""
    });
    expect(inspection.contractMismatch).toBe(false);
    expect(inspection.requiredRevision).toBe("1248");
  });

  it("realigns a caret range to the exact platform pin when that is safe", () => {
    const original = JSON.stringify(
      { devDependencies: { playwright: "^1.51.0", "@playwright/test": "^1.51.0", vitest: "^3.2.4" } },
      null,
      2
    );
    const result = realignPackageJsonToPlatformPin(original);
    expect(result.safe).toBe(true);
    expect(result.changed).toBe(true);
    const pkg = JSON.parse(result.content) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies.playwright).toBe("1.64.1");
    expect(pkg.devDependencies["@playwright/test"]).toBe("1.64.1");
    expect(pkg.devDependencies.vitest).toBe("^3.2.4");
  });

  it("does not realign an exact newer pin", () => {
    const original = JSON.stringify({ devDependencies: { playwright: "1.65.0" } });
    const result = realignPackageJsonToPlatformPin(original);
    expect(result.safe).toBe(false);
    expect(result.changed).toBe(false);
  });

  it("rejects package.json writes that bump Playwright off the pin", () => {
    expect(
      assertPlaywrightManifestContent(
        JSON.stringify({ devDependencies: { playwright: "^1.51.0" } }),
        "package.json"
      ).ok
    ).toBe(false);
    expect(
      assertPlaywrightManifestContent(
        JSON.stringify({ devDependencies: { playwright: "1.65.0" } }),
        "package.json"
      ).ok
    ).toBe(false);
    expect(
      assertPlaywrightManifestContent(
        JSON.stringify({ devDependencies: { playwright: "1.64.1", "@playwright/test": "1.64.1" } }),
        "package.json"
      ).ok
    ).toBe(true);
    expect(assertPlaywrightManifestContent("{not json", "README.md").ok).toBe(true);
  });

  it("blocks ordinary Playwright bumps and sandbox browser installs, but allows the pinned install and official e2e", () => {
    expect(commandAttemptsPlaywrightBump("npm install -D playwright@1.65.0")).toBe(true);
    expect(commandAttemptsPlaywrightBump("pnpm add @playwright/test@latest")).toBe(true);
    expect(commandAttemptsPlaywrightBump("npm install -D playwright@1.64.1 @playwright/test@1.64.1")).toBe(
      false
    );
    expect(commandAttemptsPlaywrightBump("npm install --no-audit --no-fund")).toBe(false);
    expect(commandAttemptsPlaywrightBump("npm run test:e2e -- --workers=2")).toBe(false);
    expect(commandIsSandboxPlaywrightBrowserInstall("npx playwright install chromium")).toBe(true);
    expect(commandIsSandboxPlaywrightBrowserInstall("npm run test:e2e:install")).toBe(true);
    expect(commandIsSandboxPlaywrightBrowserInstall("npm run test:e2e -- --workers=2")).toBe(false);
  });
});
