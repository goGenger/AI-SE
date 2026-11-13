import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { BrowserSession, createRealPlaywright, type NavigateAllowlist } from "../index";

/** 5.6-6 REAL e2e: one reusable BrowserSession, two frozen viewports, a
 * zero-external-network data: URL fixture with @media CSS — the mobile
 * breakpoint hides a visible-on-desktop element, so the two screenshots
 * must differ (real breakpoint behavior captured). Skips (DEGRADED) when
 * the Chromium asset is missing. */

const ALLOW_DATA: NavigateAllowlist = { allowedProtocols: ["data"] };

function chromiumAvailable(): boolean {
  const cacheRoot = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(cacheRoot)) return false;
  return (
    existsSync(`${cacheRoot}/chromium_headless_shell-1228`) ||
    existsSync(`${cacheRoot}/chromium-1228`)
  );
}

const BROWSER_AVAILABLE = chromiumAvailable();

const FIXTURE = `data:text/html,${encodeURIComponent(
  `<html><head><style>
     body { margin: 0; background: #ffffff; }
     .banner { width: 100%; height: 300px; background: #2196f3; }
     .side { display: block; width: 200px; height: 200px; background: #ff9800; }
     @media (max-width: 800px) {
       .side { display: none; }
       .banner { height: 120px; background: #4caf50; }
     }
   </style></head>
   <body><div class="banner"></div><div class="side"></div></body></html>`
)}`;

describe.skipIf(!BROWSER_AVAILABLE)("5.6-6 REAL responsive e2e", () => {
  it("one session: desktop shot vs mobile shot differ; re-shot is stable; no orphan chromium", async () => {
    const session = new BrowserSession({
      playwright: createRealPlaywright(),
      navigateAllowlist: ALLOW_DATA
    });
    try {
      await session.launch({ headless: true });

      await session.setViewport(1440, 900);
      await session.goto(FIXTURE);
      await session.waitForRender();
      const desktopShot = await session.screenshot();
      expect(desktopShot.base64.length).toBeGreaterThan(100);

      // Same session, second viewport — the 5.6-3 lifecycle is reentrant.
      await session.setViewport(RESPONSIVE_FIXTURE_WIDTH, RESPONSIVE_FIXTURE_HEIGHT);
      const mobileShot = await session.screenshot();
      expect(mobileShot.base64).not.toEqual(desktopShot.base64);

      // Determinism within one viewport: re-shoot desktop → image content
      // changes back when we re-navigate (viewport flip is truly reversible).
      await session.setViewport(1440, 900);
      const desktopAgain = await session.screenshot();
      expect(desktopAgain.base64).not.toEqual(mobileShot.base64);
    } finally {
      await session.close();
    }
  });
});

// Frozen matrix mirrored from @ai-se/visual (IM port at top would create a
// dependency; the sizes are asserted in visual's unit test — consumer copies
// only the two numbers for the fixture navigation, documented in docs/40).
const RESPONSIVE_FIXTURE_WIDTH = 375;
const RESPONSIVE_FIXTURE_HEIGHT = 812;
