import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { BrowserSession, createRealPlaywright, toVisualInputRecord } from "../index";
import type { NavigateAllowlist } from "../index";

/**
 * 5.6-3 Repair REAL e2e: launches actual Chromium against a loopback HTTP
 * fixture server (prompt: real requestfailed / 4xx / 5xx capture — no mocked
 * Playwright API, zero external network traffic). Skips (DEGRADED) when the
 * Chromium asset is missing, mirroring the other browser e2e files.
 */

const ALLOW_HTTP: NavigateAllowlist = { allowedProtocols: ["http"] };

function chromiumAvailable(): boolean {
  const cacheRoot = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(cacheRoot)) return false;
  return (
    existsSync(`${cacheRoot}/chromium_headless_shell-1228`) ||
    existsSync(`${cacheRoot}/chromium-1228`)
  );
}

const BROWSER_AVAILABLE = chromiumAvailable();

const GOOD_PAGE = `<html><body><h1>good</h1><img src="/ok.png"><script src="/ok.js"></script></body></html>`;

/**
 * A loopback port that was bound and then released (connection refused).
 * Port 1 is Chrome-restricted (ERR_UNSAFE_PORT), so the fixture probes a
 * port the OS actually had free a moment ago.
 */
function closedPort(): Promise<number> {
  const probe = createServer();
  return new Promise((resolve, reject) => {
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

// Mix of healthy and broken subresources:
//  - /ok.png            200   (must NOT be reported)
//  - /missing.png       404   (http_4xx)
//  - /missing/sk-…png   404   (http_4xx + credential-shaped path redaction)
//  - /boom.js           500   (http_5xx)
//  - http://127.0.0.1:<dead>/dead.png  (requestfailed, connection refused)
function mixedPage(deadPort: number): string {
  return `<html><body>
  <img src="/ok.png">
  <img src="/missing.png">
  <img src="/missing/sk-LEAK1234567890abc.png">
  <script src="/boom.js"></script>
  <img src="http://127.0.0.1:${deadPort}/dead.png">
</body></html>`;
}

function startFixtureServer(deadPort: number): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/good.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(GOOD_PAGE);
      return;
    }
    if (url === "/mixed.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(mixedPage(deadPort));
      return;
    }
    if (url === "/ok.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
      return;
    }
    if (url === "/favicon.ico") {
      response.writeHead(200, { "content-type": "image/x-icon" });
      response.end("");
      return;
    }
    if (url === "/ok.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("window.__ok = true;");
      return;
    }
    if (url === "/boom.js") {
      response.writeHead(500, { "content-type": "text/javascript" });
      response.end("boom");
      return;
    }
    if (url === "/missing.html") {
      response.writeHead(404, { "content-type": "text/html" });
      response.end("gone");
      return;
    }
    if (url === "/boom.html") {
      response.writeHead(500, { "content-type": "text/html" });
      response.end("boom");
      return;
    }
    if (url === "/slow.html") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("slow");
      }, 2_000);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe.skipIf(!BROWSER_AVAILABLE)("5.6-3 Repair REAL Chromium network e2e", () => {
  it("captures requestfailed / 4xx / 5xx from a real browser, distinguishes success, redacts", async () => {
    const deadPort = await closedPort();
    const { server, base } = await startFixtureServer(deadPort);
    const session = new BrowserSession({
      playwright: createRealPlaywright(),
      navigateAllowlist: ALLOW_HTTP,
      sessionId: "browser:net-e2e:1"
    });
    try {
      await session.launch({ headless: true });
      await session.setViewport(1280, 720);

      // ── Healthy page: zero false positives ────────────────────────────────
      const goodNav = await session.goto(`${base}/good.html`);
      expect(goodNav.status).toBe(200);
      await session.waitForRender();
      expect(session.getErrors(0).network).toEqual([]);
      const shotGood = await session.screenshot();
      expect(shotGood.networkErrorCountSinceLast).toBe(0);

      // ── Mixed page: real failures are detected and distinguished ──────────
      const mixedNav = await session.goto(`${base}/mixed.html`);
      expect(mixedNav.status).toBe(200);
      await session.waitForRender();

      const { network } = session.getErrors(0);
      const byUrl = (fragment: string) =>
        network.find((entry) => entry.url.includes(fragment) && !entry.url.includes("sk-"));
      const missing = byUrl("/missing.png");
      const boom = byUrl("/boom.js");
      const dead = byUrl("/dead.png");
      expect(missing).toMatchObject({ kind: "http_4xx", status: 404, method: "GET" });
      expect(boom).toMatchObject({ kind: "http_5xx", status: 500 });
      expect(dead?.kind).toBe("requestfailed");
      expect(dead?.status).toBeNull();
      expect(dead?.reason).toMatch(/ERR_CONNECTION_REFUSED|ERR_CONNECTION/i);

      // Healthy subresource is never reported.
      expect(network.some((entry) => entry.url.endsWith("/ok.png"))).toBe(false);
      // The three failure classes are distinguishable within one session.
      expect(new Set(network.map((entry) => entry.kind))).toEqual(
        new Set(["http_4xx", "http_5xx", "requestfailed"])
      );

      // Credential-shaped URL parts are redacted at the network sink.
      const redacted = network.find((entry) => entry.url.includes("[REDACTED]"));
      expect(redacted?.url).toContain("/missing/[REDACTED].png");
      expect(redacted?.url).not.toContain("LEAK1234567890abc");

      // Screenshot ↔ network evidence association (4 failures since the
      // previous shot: 2×4xx + 1×5xx + 1×requestfailed).
      const shotMixed = await session.screenshot();
      expect(shotMixed.networkErrorCountSinceLast).toBe(4);
      // Chromium logs one console error per failed resource load, so the
      // console anchor reflects the same four failures (cross-channel).
      expect(shotMixed.consoleErrorCountSinceLast).toBe(4);
      const shotAgain = await session.screenshot();
      expect(shotAgain.networkErrorCountSinceLast).toBe(0);
      const record = toVisualInputRecord(session.assetRefFor(shotMixed), {
        width: 1280,
        height: 720
      });
      expect(record.inputType).toBe("screenshot");

      // ── Navigation-level 4xx / 5xx (main document response) ──────────────
      const boundarySeq = network.at(-1)?.seq ?? 0;
      const nav404 = await session.goto(`${base}/missing.html`);
      expect(nav404.status).toBe(404);
      const nav500 = await session.goto(`${base}/boom.html`);
      expect(nav500.status).toBe(500);
      await session.waitForRender();
      const navErrors = session.getErrors(boundarySeq).network;
      expect(navErrors.map((entry) => entry.kind)).toEqual(
        expect.arrayContaining(["http_4xx", "http_5xx"])
      );
      expect(navErrors.some((entry) => entry.url.endsWith("/missing.html"))).toBe(true);
      expect(navErrors.some((entry) => entry.url.endsWith("/boom.html"))).toBe(true);

      // ── Timeout semantics untouched (nav timeout still NAV_FAILED) ───────
      await expect(session.goto(`${base}/slow.html`, { timeoutMs: 300 })).rejects.toMatchObject({
        code: "BROWSER_NAV_FAILED",
        name: "BrowserError"
      });
    } finally {
      await session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);
});
