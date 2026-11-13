import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  BROWSER_CONSOLE_ERRORS_TOOL,
  BrowserSession,
  createRealPlaywright,
  toVisualInputRecord
} from "../index";
import type { NavigateAllowlist } from "../index";

/**
 * 5.6-3 REAL e2e: launches actual Chromium (prompt §四.e2e — real browser,
 * no mocks). Fixture = data: URL page, ZERO external network. Skips as
 * DEGRADED when the Chromium asset is missing (mirrors 5.5-6 convention:
 * environment unavailable ≠ test failure, but must be visible in the report).
 */

const ALLOW_DATA: NavigateAllowlist = { allowedProtocols: ["data"] };

function chromiumAvailable(): boolean {
  // Cheap filesystem probe: playwright caches Chromium under ms-playwright.
  const cacheRoot = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(cacheRoot)) return false;
  return existsSync(`${cacheRoot}/chromium_headless_shell-1228`) || existsSync(`${cacheRoot}/chromium-1228`);
}

const BROWSER_AVAILABLE = chromiumAvailable();

describe.skipIf(!BROWSER_AVAILABLE)("5.6-3 REAL Chromium e2e", () => {
  it("launches, navigates a data: fixture, waits for render, screenshots base64", async () => {
    const session = new BrowserSession({
      playwright: createRealPlaywright(),
      navigateAllowlist: ALLOW_DATA
    });
    try {
      const launch = await session.launch({ headless: true });
      expect(launch.headless).toBe(true);

      await session.setViewport(1280, 720);
      const nav = await session.goto(
        "data:text/html,<html><body><h1>AI-SE fixture</h1><button id='b1'>hit me</button><input id='in1'/></body></html>"
      );
      // data: URLs are opaque navigations: no HTTP status object exists.
      expect(nav.status).toBeNull();

      const settled = await session.waitForRender();
      expect(["networkidle", "timeout"]).toContain(settled.settled);

      const shot = await session.screenshot();
      expect(shot.base64.length).toBeGreaterThan(100);
      expect(shot.mimeType).toBe("image/png");

      const record = toVisualInputRecord(
        session.assetRefFor(shot),
        { width: 1280, height: 720 }
      );
      expect(record.inputType).toBe("screenshot");

      // Real interaction changes the buffer (click + type → different frame)
      await session.click("#b1");
      await session.type("#in1", "hello ai-se");
      const shot2 = await session.screenshot();
      expect(shot2.base64).not.toEqual(shot.base64);

      // Console error injection is captured + redacted through the tool
      await session.goto(
        "data:text/html,<html><body><script>console.error('bad token Bearer AAAABBBBCCCC');</script></body></html>"
      );
      await session.waitForRender();
      const errors = await BROWSER_CONSOLE_ERRORS_TOOL.execute(
        { sinceSeq: 0 },
        { session } as never
      );
      const errorText = errors.console.map((entry) => entry.text).join("\n");
      expect(errorText).toContain("[REDACTED]");
      expect(errorText).not.toContain("Bearer AAAABBBBCCCC");

      // Viewport change alters the screenshot size (visual reaction)
      await session.setViewport(800, 600);
      const shot3 = await session.screenshot();
      expect(shot3.buffer.length).not.toEqual(shot2.buffer.length);
    } finally {
      await session.close();
    }
  });
});

describe("5.6-3 boundary: agent code never imports playwright directly", () => {
  it("only the adapter file holds the playwright import", () => {
    // Real grep against package sources. Exit code 1 = no match, which is the
    // failure we assert; stdout lists matching files.
    const grep = spawnSync("grep", ["-rl", "playwright", "src", "--include=*.ts"], {
      cwd: __dirname + "/..",
      encoding: "utf8"
    });
    const files = (grep.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    // Adapter may hold the import (it IS the playwright seam); test fixtures
    // may reference the word; nothing else may.
    const offenders = files.filter(
      (file) =>
        file !== "src/playwrightAdapter.ts" &&
        !file.includes("__tests__")
    );
    expect(offenders).toEqual([]);
  });
});
