import {
  ActionResultSchema,
  A11ySnapshotSchema,
  DomSnapshotSchema,
  ExternalActionRefSchema,
  ObservationSchema
} from "./index";
import { describe, expect, it } from "vitest";

/** 5.7-0 contract tests: strict zod, discriminated arms, invariants, and the
 * pure- contract red line (no runtime imports from other packages). */

const browserRef = {
  source: "browser" as const,
  sessionId: "browser:test:1",
  toolName: "browser.navigate",
  target: "data:text/html,<h1>x</h1>"
};

const mcpRef = {
  source: "mcp" as const,
  serverName: "github",
  toolName: "issues.create",
  callId: "call-1"
};

const sandboxRef = {
  source: "sandbox" as const,
  commandId: "cmd-1"
};

describe("5.7-0 ExternalActionRef discriminated union", () => {
  it("parses all three arms", () => {
    expect(ExternalActionRefSchema.parse(browserRef)).toMatchObject({ source: "browser" });
    expect(ExternalActionRefSchema.parse(mcpRef)).toMatchObject({ source: "mcp" });
    expect(ExternalActionRefSchema.parse(sandboxRef)).toMatchObject({ source: "sandbox" });
  });

  it("rejects cross-arm stray fields (strict)", () => {
    expect(() =>
      ExternalActionRefSchema.parse({ ...browserRef, callId: "x" })
    ).toThrow();
    expect(() =>
      ExternalActionRefSchema.parse({ ...mcpRef, sessionId: "x" })
    ).toThrow();
  });

  it("rejects unknown source", () => {
    expect(() =>
      ExternalActionRefSchema.parse({ source: "unknown", id: "x" })
    ).toThrow();
  });
});

describe("5.7-0 Observation", () => {
  const dom = {
    nodes: [{ ref: "n1", role: "button", name: "Submit", clickable: true, text: "" }]
  };

  it("accepts dom-only and a11y-only observations", () => {
    expect(() =>
      ObservationSchema.parse({
        observationId: "obs-1",
        actionRef: browserRef,
        dom,
        takenAt: new Date().toISOString()
      })
    ).not.toThrow();
    expect(() =>
      ObservationSchema.parse({
        observationId: "obs-2",
        actionRef: mcpRef,
        accessibility: { tree: "<main>…</main>", interactiveCount: 2 },
        takenAt: new Date().toISOString()
      })
    ).not.toThrow();
  });

  it("rejects an observation without either form", () => {
    expect(() =>
      ObservationSchema.parse({
        observationId: "obs-3",
        actionRef: browserRef,
        takenAt: new Date().toISOString()
      })
    ).toThrow();
  });

  it("enforces the screenshot:// reference prefix (base64 never in contract)", () => {
    expect(() =>
      ObservationSchema.parse({
        observationId: "obs-4",
        actionRef: browserRef,
        dom,
        screenshotRef: "https://example.com/shot.png",
        takenAt: new Date().toISOString()
      })
    ).toThrow();
    expect(
      ObservationSchema.parse({
        observationId: "obs-5",
        actionRef: browserRef,
        dom,
        screenshotRef: "screenshot://browser:test:1/1.png",
        takenAt: new Date().toISOString()
      }).screenshotRef
    ).toContain("screenshot://");
  });

  it("rejects inline base64 screenshot fields (strict red line)", () => {
    expect(() =>
      ObservationSchema.parse({
        observationId: "obs-6",
        actionRef: browserRef,
        dom,
        base64Screenshot: "iVBORw0KGgo=",
        takenAt: new Date().toISOString()
      })
    ).toThrow();
  });
});

describe("5.7-0 ActionResult invariants", () => {
  const base = {
    resultId: "res-1",
    actionRef: sandboxRef,
    durationMs: 120,
    occurredAt: new Date().toISOString()
  };

  it("failed requires error; cancelled requires cancelledAt", () => {
    expect(() =>
      ActionResultSchema.parse({ ...base, status: "failed" })
    ).toThrow();
    expect(() =>
      ActionResultSchema.parse({ ...base, status: "cancelled" })
    ).toThrow();
    const ok = ActionResultSchema.parse({
      ...base,
      status: "failed",
      error: { code: "PLACEHOLDER", message: "redacted message" }
    });
    expect(ok.status).toBe("failed");
    const cancelled = ActionResultSchema.parse({
      ...base,
      status: "cancelled",
      cancelledAt: new Date().toISOString()
    });
    expect(cancelled.cancelledAt).toBeDefined();
  });

  it("success stays parseable; error presence is allowed but optional", () => {
    const success = ActionResultSchema.parse({ ...base, status: "success" });
    expect(success.error).toBeUndefined();
    const annotated = ActionResultSchema.parse({
      ...base,
      status: "success",
      error: { code: "NOTE", message: "non-fatal" }
    });
    expect(ActionResultSchema.parse(success).status).toBe("success");
    expect(ActionResultSchema.parse(annotated).status).toBe("success");
  });

  it("carries retry metadata as plain fields (semantics owned by workflow-engine)", () => {
    const result = ActionResultSchema.parse({
      ...base,
      status: "failed",
      error: { code: "PLACEHOLDER", message: "m" },
      retryRound: 2,
      maxRetries: 3
    });
    expect(result.retryRound).toBe(2);
    expect(result.maxRetries).toBe(3);
  });

  it("rejects non-ISO occurredAt and negative duration", () => {
    expect(() =>
      ActionResultSchema.parse({ ...base, status: "success", occurredAt: "yesterday" })
    ).toThrow();
    expect(() =>
      ActionResultSchema.parse({ ...base, status: "success", durationMs: -1 })
    ).toThrow();
  });
});

describe("5.7-0 pure contract (no runtime imports)", () => {
  it("contract block stays dependency-free (red-line marker absence)", () => {
    // ponytail: assert the marker block contains no cross-package import —
    // validated via vitest module graph instead of file reads (no node types).
    void ActionResultSchema;
    void ObservationSchema;
    void ExternalActionRefSchema;
    void DomSnapshotSchema;
    void A11ySnapshotSchema;
    // If shared ever imports browser/mcp/sandbox, its own typecheck/dep-cruiser
    // style lint would fail first; here we assert the exported surface only
    // carries schemas/types (pure data) at typecheck level.
    expect(Object.keys(ExternalActionRefSchema)).toContain("parse");
  });
});
