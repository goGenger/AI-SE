import { ActionResultSchema, ObservationSchema } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { BrowserError } from "../errors";
import type { BrowserSession } from "../browserSession";
import {
  BROWSER_ACTION_CLICK_TOOL,
  BROWSER_ACTION_NAVIGATE_TOOL,
  BROWSER_ACTION_SCREENSHOT_TOOL,
  BROWSER_ACTION_TYPE_TOOL,
  BROWSER_OBSERVE_TOOL
} from "../computerUseTools";

/** 5.7-1 unit tests: the adapter layer against a scripted session double —
 * real 5.7-0 schema validation, no Playwright binary. The real-Chromium e2e
 * lives in computerUse.e2e.test.ts. */

function fakeSession(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const session = {
    sessionId: "browser:test:1",
    currentUrl: () => "http://fixture.test/current",
    click: async (selector: string) => {
      if (selector === "#boom") throw new BrowserError("BROWSER_NAV_FAILED", "click failed on #boom");
      calls.push(`click:${selector}`);
    },
    type: async (selector: string, text: string) => {
      calls.push(`type:${selector}:${text}`);
    },
    goto: async (url: string) => {
      calls.push(`goto:${url}`);
      return { finalUrl: url, status: 200 };
    },
    waitForRender: async () => ({ settled: "networkidle", elapsedMs: 1 }),
    screenshot: async () => ({
      buffer: Buffer.from("fake-png"),
      base64: "ZmFrZS1wbmc=",
      mimeType: "image/png" as const,
      takenAt: new Date().toISOString(),
      consoleErrorCountSinceLast: 0,
      networkErrorCountSinceLast: 0,
      fullPage: false,
      seq: 1
    }),
    assetRefFor: (asset: { seq: number; fullPage: boolean }) =>
      `screenshot://browser:test:1/${asset.seq}${asset.fullPage ? "-fullpage" : ""}.png`,
    observe: async () => ({
      url: "http://fixture.test/current",
      dom: {
        nodes: [
          { ref: '[data-ai-se-ref="r1"]', role: "button", name: "Save", clickable: true, text: "Save" }
        ]
      },
      accessibility: { tree: '- button "Save"', interactiveCount: 1 }
    }),
    ...overrides
  };
  return { session: session as unknown as BrowserSession, calls };
}

describe("5.7-1 browser.observe", () => {
  it("produces a strict 5.7-0 Observation (dom + accessibility) with a browser actionRef", async () => {
    const { session } = fakeSession();
    const observation = await BROWSER_OBSERVE_TOOL.execute({}, { session } as never);
    expect(ObservationSchema.parse(observation)).toMatchObject({
      actionRef: {
        source: "browser",
        sessionId: "browser:test:1",
        toolName: "browser.observe",
        target: "http://fixture.test/current"
      }
    });
    expect(observation.dom?.nodes[0]).toMatchObject({ role: "button", clickable: true });
    expect(observation.accessibility?.interactiveCount).toBe(1);
  });

  it("rejects inputs that would yield an empty observation (schema-level)", () => {
    expect(
      BROWSER_OBSERVE_TOOL.inputSchema.safeParse({
        includeDom: false,
        includeAccessibility: false
      }).success
    ).toBe(false);
    expect(BROWSER_OBSERVE_TOOL.inputSchema.safeParse({ maxNodes: 2001 }).success).toBe(false);
  });
});

describe("5.7-1 browser actions → ActionResult", () => {
  it("click success: executed action yields status success + post-action observation", async () => {
    const { session, calls } = fakeSession();
    const result = await BROWSER_ACTION_CLICK_TOOL.execute({ selector: "#save" }, { session } as never);
    expect(calls).toEqual(["click:#save"]);
    expect(ActionResultSchema.parse(result)).toMatchObject({
      status: "success",
      actionRef: { source: "browser", toolName: "browser.action.click", target: "#save" }
    });
    expect(result.observation?.dom?.nodes.length).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("click failure: browser error normalizes into status failed with the browser code", async () => {
    const { session } = fakeSession();
    const result = await BROWSER_ACTION_CLICK_TOOL.execute({ selector: "#boom" }, { session } as never);
    expect(ActionResultSchema.parse(result).status).toBe("failed");
    expect(result.error).toEqual({ code: "BROWSER_NAV_FAILED", message: "click failed on #boom" });
  });

  it("type forwards selector + text and returns ActionResult success", async () => {
    const { session, calls } = fakeSession();
    const result = await BROWSER_ACTION_TYPE_TOOL.execute(
      { selector: "#name", text: "hello" },
      { session } as never
    );
    expect(calls).toEqual(["type:#name:hello"]);
    expect(result.status).toBe("success");
  });

  it("navigate returns ActionResult success with a dom + accessibility post-observation", async () => {
    const { session, calls } = fakeSession();
    const result = await BROWSER_ACTION_NAVIGATE_TOOL.execute(
      { url: "http://fixture.test/next" },
      { session } as never
    );
    expect(calls).toEqual(["goto:http://fixture.test/next"]);
    expect(result.status).toBe("success");
    expect(result.actionRef).toMatchObject({ target: "http://fixture.test/next" });
    expect(result.observation?.accessibility).toBeDefined();
  });

  it("screenshot reuses the 5.6-3 asset pipeline: screenshot:// ref, never base64", async () => {
    const { session } = fakeSession();
    const result = await BROWSER_ACTION_SCREENSHOT_TOOL.execute({}, { session } as never);
    expect(result.status).toBe("success");
    expect(result.observation?.screenshotRef).toBe("screenshot://browser:test:1/1.png");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ZmFrZS1wbmc=");
    expect(serialized).not.toContain("base64");
  });

  it("pre-aborted signal → status cancelled with cancelledAt (contract invariant)", async () => {
    const { session } = fakeSession();
    const controller = new AbortController();
    controller.abort();
    const result = await BROWSER_ACTION_CLICK_TOOL.execute({ selector: "#save" }, {
      session,
      signal: controller.signal
    } as never);
    expect(ActionResultSchema.parse(result).status).toBe("cancelled");
    expect(result.cancelledAt).toBeDefined();
  });

  it("scheme-shaped selectors are rejected by the input schema", () => {
    expect(
      BROWSER_ACTION_CLICK_TOOL.inputSchema.safeParse({ selector: "javascript:alert(1)" }).success
    ).toBe(false);
    expect(
      BROWSER_ACTION_NAVIGATE_TOOL.inputSchema.safeParse({ url: "http://ok.test" }).success
    ).toBe(true);
  });
});
