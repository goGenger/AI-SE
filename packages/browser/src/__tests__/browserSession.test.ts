import { VisualInputRecordSchema } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  BrowserError,
  BrowserSession,
  isNavigationAllowed,
  toVisualInputRecord,
  type ConsoleMessageLike,
  type ContextLike,
  type NavigateAllowlist,
  type PageLike,
  type PlaywrightLike,
  type RequestLike,
  type ResponseLike
} from "../index";

/**
 * 5.6-3 unit tests: BrowserSession against a scripted harness (real logic,
 * no Playwright binary). Real-Chromium e2e lives in browser.e2e.test.ts and
 * skips (DEGRADED) when assets are missing. The fixture page is a bare
 * HTML data URL — zero external network.
 */

const ALLOW_ALL_HTTP: NavigateAllowlist = { allowedProtocols: ["http", "https", "data"] };

function harnessPage(): { page: PageLike; listeners: Record<string, unknown>; calls: string[] } {
  const listeners: Record<string, unknown> = {};
  const calls: string[] = [];
  const page: PageLike = {
    async goto(url, options) {
      void options;
      if (url === "http://fail.test/") throw new Error("nav boom");
      return { url: () => url, status: () => 200 };
    },
    async waitForLoadState(state, options) {
      void state; void options;
    },
    async setViewportSize(size) {
      (page as unknown as { vp: unknown }).vp = size;
    },
    async screenshot(options) {
      void options;
      return Buffer.from("fake-png-bytes");
    },
    async click() {},
    async fill() {},
    async hover(selector) {
      if (selector === "#boom") throw new Error("hover boom");
      calls.push(`hover:${selector}`);
    },
    async focus(selector) {
      if (selector === "#boom") throw new Error("focus boom");
      calls.push(`focus:${selector}`);
    },
    mouse: {
      async down() {
        calls.push("mouse:down");
      },
      async up() {
        calls.push("mouse:up");
      }
    },
    url() {
      return "http://fixture.test/current";
    },
    async evaluate<R>(_pageFunction: () => R): Promise<R> {
      calls.push("evaluate");
      return [] as unknown as R;
    },
    on(event, listener) {
      listeners[event] = listener;
    },
    async close() {}
  };
  return { page, listeners, calls };
}

function harnessPlaywright(
  page: PageLike,
  onNewContext?: (args: unknown[]) => void
): PlaywrightLike {
  return {
    chromium: {
      async launch() {
        const context: ContextLike = {
          async newPage() {
            return page;
          },
          async close() {}
        };
        return {
          async newContext(...args: unknown[]) {
            onNewContext?.(args);
            return context;
          },
          async close() {}
        };
      }
    }
  };
}

describe("5.6-3 navigation allowlist (5.6-0 aligned)", () => {
  it("denies empty allowlist by default and gates by protocol", () => {
    expect(isNavigationAllowed("https://example.com", { allowedProtocols: [] })).toBe(false);
    expect(isNavigationAllowed("https://example.com", ALLOW_ALL_HTTP)).toBe(true);
    expect(isNavigationAllowed("ftp://example.com", ALLOW_ALL_HTTP)).toBe(false);
    expect(isNavigationAllowed("data:text/html,<h1>x</h1>", ALLOW_ALL_HTTP)).toBe(true);
    expect(isNavigationAllowed("not-a-url", ALLOW_ALL_HTTP)).toBe(false);
  });

  it("rejects disallowed navigation with BROWSER_INPUT_INVALID, no playwright call", async () => {
    const { page } = harnessPage();
    const session = new BrowserSession({
      playwright: harnessPlaywright(page),
      navigateAllowlist: { allowedProtocols: [] }
    });
    await session.launch();
    await expect(session.goto("https://evil.example/")).rejects.toMatchObject({
      code: "BROWSER_INPUT_INVALID"
    });
    await session.close();
  });
});

describe("5.6-3 lifecycle", () => {
  it("double close is idempotent; ops after close raise BROWSER_CLOSED", async () => {
    const { page } = harnessPage();
    const session = new BrowserSession({
      playwright: harnessPlaywright(page),
      navigateAllowlist: ALLOW_ALL_HTTP
    });
    await session.launch();
    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.goto("data:text/html,x")).rejects.toMatchObject({ code: "BROWSER_CLOSED" });
    await expect(session.screenshot()).rejects.toMatchObject({ code: "BROWSER_CLOSED" });
  });

  it("viewport validation rejects out-of-range before touching the browser", async () => {
    const { page } = harnessPage();
    const session = new BrowserSession({
      playwright: harnessPlaywright(page),
      navigateAllowlist: ALLOW_ALL_HTTP
    });
    await session.launch();
    await expect(session.setViewport(0, 100)).rejects.toMatchObject({ code: "BROWSER_INPUT_INVALID" });
    await expect(session.setViewport(20_001, 100)).rejects.toMatchObject({ code: "BROWSER_INPUT_INVALID" });
    await expect(session.setViewport(1440, 900)).resolves.toEqual({ applied: true });
    await session.close();
  });

  it("nav failure surfaces BROWSER_NAV_FAILED without raw Playwright error", async () => {
    const { page } = harnessPage();
    const session = new BrowserSession({
      playwright: harnessPlaywright(page),
      navigateAllowlist: ALLOW_ALL_HTTP
    });
    await session.launch();
    await expect(session.goto("http://fail.test/")).rejects.toMatchObject({
      code: "BROWSER_NAV_FAILED",
      name: "BrowserError"
    });
    await session.close();
  });
});

describe("5.6-3 console capture + redaction", () => {
  it("redacts token-shaped console text and counts errors since last screenshot", async () => {
    const harness = harnessPage();
    const session = new BrowserSession({
      playwright: harnessPlaywright(harness.page),
      navigateAllowlist: ALLOW_ALL_HTTP,
      sessionId: "browser:test-fix:1"
    });
    await session.launch();
    const listener = harness.listeners.console as (message: ConsoleMessageLike) => void;
    listener({
      type: () => "error",
      text: () => "fetch failed with Bearer AAAABBBBCCCC",
      location: () => ({ url: "https://app.test/path?token=sk-abc123defghijklm" })
    });
    listener({ type: () => "log", text: () => "ignored (not error/warning)", location: () => ({}) });

    const errors = session.getErrors(0);
    expect(errors.console.length).toBe(1);
    expect(errors.console[0].level).toBe("error");
    expect(errors.console[0].text).not.toContain("Bearer AAAABBBBCCCC");
    expect(errors.console[0].text).toContain("[REDACTED]");
    expect(errors.console[0].url).not.toContain("sk-abc123defghijklm");

    const shot = await session.screenshot();
    expect(shot.consoleErrorCountSinceLast).toBe(1);
    const shot2 = await session.screenshot();
    expect(shot2.consoleErrorCountSinceLast).toBe(0);
    await session.close();
  });
});

describe("5.6-3 repair: network error capture (session-scoped, redacted)", () => {
  async function startedSession() {
    const harness = harnessPage();
    const session = new BrowserSession({
      playwright: harnessPlaywright(harness.page),
      navigateAllowlist: ALLOW_ALL_HTTP,
      sessionId: "browser:net-fix:1"
    });
    await session.launch();
    return {
      session,
      emitFailed: harness.listeners.requestfailed as (request: RequestLike) => void,
      emitResponse: harness.listeners.response as (response: ResponseLike) => void,
      emitConsole: harness.listeners.console as (message: ConsoleMessageLike) => void
    };
  }

  function fakeResponse(url: string, status: number): ResponseLike {
    return {
      url: () => url,
      status: () => status,
      request: () => ({ url: () => url, failure: () => null, method: () => "GET" })
    };
  }

  it("records requestfailed with redacted URL and the transport reason", async () => {
    const { session, emitFailed } = await startedSession();
    emitFailed({
      url: () => "https://app.test/api?token=Bearer AAAABBBBCCCC",
      failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
      method: () => "GET",
      resourceType: () => "image"
    });
    const { network } = session.getErrors(0);
    expect(network).toHaveLength(1);
    expect(network[0]).toMatchObject({
      kind: "requestfailed",
      status: null,
      method: "GET",
      reason: "net::ERR_CONNECTION_REFUSED"
    });
    expect(network[0].url).toContain("[REDACTED]");
    expect(network[0].url).not.toContain("Bearer AAAABBBBCCCC");
    await session.close();
  });

  it("records 4xx/5xx, ignores <400, and distinguishes the classes", async () => {
    const { session, emitResponse } = await startedSession();
    emitResponse(fakeResponse("https://app.test/ok.js", 200));
    emitResponse(fakeResponse("https://app.test/moved", 302));
    emitResponse(fakeResponse("https://app.test/missing.png", 404));
    emitResponse(fakeResponse("https://app.test/no-auth", 401));
    emitResponse(fakeResponse("https://app.test/boom.js", 500));
    emitResponse(fakeResponse("https://app.test/down", 503));

    const { network } = session.getErrors(0);
    expect(network.map((entry) => [entry.kind, entry.status])).toEqual([
      ["http_4xx", 404],
      ["http_4xx", 401],
      ["http_5xx", 500],
      ["http_5xx", 503]
    ]);
    expect(network.map((entry) => entry.url)).not.toContain("https://app.test/ok.js");
    // seq + kind ordering is deterministic (arrival order).
    expect(network.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    await session.close();
  });

  it("anchors network errors to the screenshot boundary with its own counter", async () => {
    const { session, emitResponse, emitFailed } = await startedSession();
    emitResponse(fakeResponse("https://app.test/missing.png", 404));
    emitFailed({
      url: () => "https://app.test/dead.png",
      failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
      method: () => "GET"
    });

    const shot = await session.screenshot();
    expect(shot.networkErrorCountSinceLast).toBe(2);
    expect(shot.consoleErrorCountSinceLast).toBe(0);
    const shot2 = await session.screenshot();
    expect(shot2.networkErrorCountSinceLast).toBe(0);

    emitResponse(fakeResponse("https://app.test/boom.js", 500));
    const shot3 = await session.screenshot();
    expect(shot3.networkErrorCountSinceLast).toBe(1);
    await session.close();
  });

  it("ignores net::ERR_ABORTED client cancellations (no double counting)", async () => {
    const { session, emitFailed, emitResponse } = await startedSession();
    // Real Chromium pattern observed in the e2e: a 5xx response is followed
    // by an ERR_ABORTED requestfailed for the same request.
    emitResponse(fakeResponse("https://app.test/boom.js", 500));
    emitFailed({
      url: () => "https://app.test/boom.js",
      failure: () => ({ errorText: "net::ERR_ABORTED" }),
      method: () => "GET"
    });
    const { network } = session.getErrors(0);
    expect(network).toHaveLength(1);
    expect(network[0]).toMatchObject({ kind: "http_5xx", status: 500 });
    await session.close();
  });

  it("shares one sequence space with console entries and honors sinceSeq", async () => {
    const { session, emitConsole, emitResponse } = await startedSession();
    emitConsole({ type: () => "error", text: () => "boom", location: () => ({}) });
    emitResponse(fakeResponse("https://app.test/missing.png", 404));

    const all = session.getErrors(0);
    expect(all.console.map((entry) => entry.seq)).toEqual([1]);
    expect(all.network.map((entry) => entry.seq)).toEqual([2]);

    const afterFirst = session.getErrors(1);
    expect(afterFirst.console).toHaveLength(0);
    expect(afterFirst.network.map((entry) => entry.seq)).toEqual([2]);
    await session.close();
  });
});

describe("5.6-3 screenshot → VisualInputRecord seam", () => {
  it("builds a strict record from assetRef + viewport", () => {
    const record = toVisualInputRecord("screenshot://browser:test-fix:1/1.png", {
      width: 1440,
      height: 900
    });
    expect(VisualInputRecordSchema.parse(record)).toMatchObject({
      inputType: "screenshot",
      source: "screenshot://browser:test-fix:1/1.png"
    });
  });

  it("assetRef naming is deterministic (sessionId + seq + fullpage suffix)", async () => {
    const { page } = harnessPage();
    const session = new BrowserSession({
      playwright: harnessPlaywright(page),
      navigateAllowlist: ALLOW_ALL_HTTP,
      sessionId: "browser:det:1"
    });
    await session.launch();
    const first = await session.screenshot();
    const second = await session.screenshot({ fullPage: true });
    expect(session.assetRefFor(first)).toBe("screenshot://browser:det:1/1.png");
    expect(session.assetRefFor(second)).toBe("screenshot://browser:det:1/2-fullpage.png");
    await session.close();
  });
});

describe("5.7-1 browser context credential isolation", () => {
  it("launches the context without credential/storage injection (zero args)", async () => {
    const { page } = harnessPage();
    const contextArgs: unknown[][] = [];
    const session = new BrowserSession({
      playwright: harnessPlaywright(page, (args) => contextArgs.push(args)),
      navigateAllowlist: ALLOW_ALL_HTTP
    });
    await session.launch();
    expect(contextArgs).toEqual([[]]);
    await session.close();
  });
});

describe("5.6-6 controlled interaction triggers", () => {
  it("hover/focus/mouseDown/mouseUp reach the page in order (mouseDown = hover then down)", async () => {
    const { page, calls } = harnessPage();
    const session = new BrowserSession({
      playwright: harnessPlaywright(page),
      navigateAllowlist: ALLOW_ALL_HTTP
    });
    await session.launch();
    await session.hover("#card-1");
    await session.focus("#query");
    await session.mouseDown("#submit");
    await session.mouseUp();
    expect(calls).toEqual(["hover:#card-1", "focus:#query", "hover:#submit", "mouse:down", "mouse:up"]);
    await session.close();
  });

  it("interaction failures normalize to BROWSER_NAV_FAILED; closed session → BROWSER_CLOSED", async () => {
    const { page } = harnessPage();
    const session = new BrowserSession({
      playwright: harnessPlaywright(page),
      navigateAllowlist: ALLOW_ALL_HTTP
    });
    await session.launch();
    await expect(session.hover("#boom")).rejects.toMatchObject({ code: "BROWSER_NAV_FAILED" });
    await expect(session.focus("#boom")).rejects.toMatchObject({ code: "BROWSER_NAV_FAILED" });
    await expect(session.mouseDown("#boom")).rejects.toMatchObject({ code: "BROWSER_NAV_FAILED" });
    await session.close();
    await expect(session.hover("#card-1")).rejects.toMatchObject({ code: "BROWSER_CLOSED" });
    await expect(session.mouseUp()).rejects.toMatchObject({ code: "BROWSER_CLOSED" });
  });
});

describe("5.6-3 BrowserError taxonomy", () => {
  it("exposes self-contained codes; never wraps Playwright error objects", () => {
    const error = new BrowserError("BROWSER_TIMEOUT", "op timed out");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("BROWSER_TIMEOUT");
    expect(error.name).toBe("BrowserError");
    expect(error.message).not.toMatch(/playwright/i);
  });
});
