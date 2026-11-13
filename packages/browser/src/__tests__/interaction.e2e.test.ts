import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { BrowserSession, createRealPlaywright, type NavigateAllowlist } from "../index";

/**
 * Phase 5.6-6 REAL e2e: the controlled interaction triggers (hover / focus /
 * press-and-hold) against real Chromium — headless captures CSS :hover,
 * :focus and :active, and the base render restores pixel-exactly when the
 * pointer moves away. This file pins the equality that 5.6-6 regression
 * detection relies on (identical render ⇔ identical pixels). Zero external
 * network (data: URL fixture). Skips (DEGRADED) when Chromium is missing.
 */

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
     .btn { width: 200px; height: 60px; background: #2196f3; }
     .btn:hover { background: #ff0000; }
     .btn:active { background: #000000; }
     .input { width: 300px; height: 40px; border: 2px solid #111111; outline: none; }
     .input:focus { border-color: #00ff00; background: #ffffcc; }
     .plain { width: 120px; height: 40px; background: #eeeeee; }
   </style></head>
   <body><button class="btn" id="b">go</button><input class="input" id="i"><div class="plain" id="p"></div></body></html>`
)}`;

describe.skipIf(!BROWSER_AVAILABLE)("5.6-6 REAL interaction e2e (hover / focus / active)", () => {
  it("captures :hover, :focus and held :active; releasing restores the base render", async () => {
    const session = new BrowserSession({
      playwright: createRealPlaywright(),
      navigateAllowlist: ALLOW_DATA
    });
    try {
      await session.launch({ headless: true });
      await session.setViewport(600, 400);
      await session.goto(FIXTURE);
      await session.waitForRender();

      const base = (await session.screenshot()).base64;

      // :hover — real pointer move.
      await session.hover("#b");
      const hovered = (await session.screenshot()).base64;
      expect(hovered).not.toEqual(base);

      // Pointer away → base render restores pixel-exactly.
      await session.hover("#p");
      const reverted = (await session.screenshot()).base64;
      expect(reverted).toEqual(base);

      // :focus — DOM focus ring.
      await session.focus("#i");
      const focused = (await session.screenshot()).base64;
      expect(focused).not.toEqual(base);

      // :active — press and hold over the button (hover positions the pointer).
      await session.mouseDown("#b");
      const active = (await session.screenshot()).base64;
      expect(active).not.toEqual(base);
      expect(active).not.toEqual(hovered);

      // Release while still over the element → hover render (not base)…
      await session.mouseUp();
      const releasedOverElement = (await session.screenshot()).base64;
      expect(releasedOverElement).toEqual(hovered);

      // …and moving away restores the base render again.
      await session.hover("#p");
      const baseAgain = (await session.screenshot()).base64;
      expect(baseAgain).toEqual(base);
    } finally {
      await session.close();
    }
  });
});
