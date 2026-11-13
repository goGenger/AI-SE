import type { ActionResult, EvidenceSnapshot, Observation } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  buildEvidenceDraft,
  captureActionEvidence,
  redactEvidenceContent,
  verifyActionEvidence
} from "../index";

/** Phase 5.7-4: evidence verification + capture + redaction unit coverage. */

function observation(overrides: { text?: string; tree?: string } = {}): Observation {
  return {
    observationId: "obs-1",
    actionRef: {
      source: "browser",
      sessionId: "browser:1",
      toolName: "browser.observe",
      target: "#go"
    },
    dom: {
      nodes: [
        {
          ref: "r1",
          role: "generic",
          name: overrides.text ?? "0",
          clickable: false,
          text: overrides.text ?? "0"
        }
      ]
    },
    accessibility: { tree: overrides.tree ?? '- generic "0"', interactiveCount: 0 },
    takenAt: "2026-09-13T10:00:00.000Z"
  };
}

function snapshot(input: { text?: string; tree?: string; result?: unknown }): EvidenceSnapshot {
  return {
    ...(input.result !== undefined ? {} : { observation: observation(input) }),
    ...(input.result !== undefined ? { result: input.result } : {}),
    capturedAt: "2026-09-13T10:00:00.000Z"
  } as EvidenceSnapshot;
}

function actionResult(status: "success" | "failed", code?: string): ActionResult {
  return {
    resultId: "res-1",
    actionRef: {
      source: "browser",
      sessionId: "browser:1",
      toolName: "browser.action.click",
      target: "#go"
    },
    status,
    ...(status === "failed"
      ? { error: { code: code ?? "BROWSER_ACTION_FAILED", message: "boom" } }
      : {}),
    durationMs: 3,
    occurredAt: "2026-09-13T10:00:01.000Z"
  };
}

describe("5.7-4 verification reads real evidence only", () => {
  it("action-succeeded follows the ActionResult, not a report", () => {
    const verified = verifyActionEvidence({
      before: snapshot({ text: "0" }),
      after: snapshot({ text: "1" }),
      result: actionResult("success"),
      expectations: [{ kind: "action-succeeded" }]
    });
    expect(verified.status).toBe("VERIFIED");
    const failed = verifyActionEvidence({
      before: snapshot({ text: "0" }),
      after: snapshot({ text: "0" }),
      result: actionResult("failed", "BROWSER_NAV_FAILED"),
      expectations: [{ kind: "action-succeeded" }]
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.findings[0]?.detail).toContain("BROWSER_NAV_FAILED");
  });

  it("contains searches the AFTER snapshot (dom, a11y tree, external result data)", () => {
    const viaDom = verifyActionEvidence({
      before: snapshot({ text: "0" }),
      after: snapshot({ text: "count: 1" }),
      result: actionResult("success"),
      expectations: [{ kind: "contains", value: "count: 1" }]
    });
    expect(viaDom.status).toBe("VERIFIED");
    const viaTree = verifyActionEvidence({
      before: snapshot({ text: "0" }),
      after: snapshot({ text: "0", tree: '- alert "saved"' }),
      result: actionResult("success"),
      expectations: [{ kind: "contains", value: "saved" }]
    });
    expect(viaTree.status).toBe("VERIFIED");
    const viaResult = verifyActionEvidence({
      before: snapshot({ result: { issues: [{ id: "ISS-1" }] } }),
      after: snapshot({ result: { issues: [{ id: "ISS-1" }, { id: "ISS-101" }] } }),
      result: actionResult("success"),
      expectations: [{ kind: "contains", value: "ISS-101" }]
    });
    expect(viaResult.status).toBe("VERIFIED");
    const missing = verifyActionEvidence({
      before: snapshot({ text: "0" }),
      after: snapshot({ text: "1" }),
      result: actionResult("success"),
      expectations: [{ kind: "contains", value: "count: 99" }]
    });
    expect(missing.status).toBe("FAILED");
  });

  it("changed compares snapshot content and ignores volatile identity/timestamps", () => {
    const same = verifyActionEvidence({
      before: snapshot({ text: "0" }),
      after: snapshot({ text: "0" }), // different observationId/takenAt — content identical
      result: actionResult("success"),
      expectations: [{ kind: "changed" }]
    });
    expect(same.status).toBe("FAILED");
    expect(same.findings[0]?.detail).toContain("identical");
    const different = verifyActionEvidence({
      before: snapshot({ text: "0" }),
      after: snapshot({ text: "1" }),
      result: actionResult("success"),
      expectations: [{ kind: "changed" }]
    });
    expect(different.status).toBe("VERIFIED");
  });

  it("the verdict is the aggregate of the findings; failure facts are kept", () => {
    const mixed = verifyActionEvidence({
      before: snapshot({ text: "0" }),
      after: snapshot({ text: "2" }),
      result: actionResult("failed"),
      expectations: [{ kind: "action-succeeded" }, { kind: "changed" }]
    });
    expect(mixed.status).toBe("FAILED");
    expect(mixed.findings.map((finding) => finding.ok)).toEqual([false, true]);
  });
});

describe("5.7-4 redaction sink", () => {
  it("credential-shaped content is redacted in every nested string", () => {
    const redacted = redactEvidenceContent({
      externalId: "sk-live1234567890abcdefghij",
      nested: [
        { note: "token=abcdef123 ok" },
        "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJldmlsIn0.abc"
      ]
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("sk-live1234567890abcdefghij");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).toContain("[REDACTED]");
  });

  it("drafts are redacted end-to-end before validation", () => {
    const draft = buildEvidenceDraft({
      identity: {
        projectId: "00000000-0000-4000-8000-000000000001",
        actionRef: {
          source: "mcp",
          serverName: "github",
          toolName: "issues.list",
          callId: "call-1"
        }
      },
      expectations: [{ kind: "action-succeeded" }],
      before: snapshot({ result: { ok: true } }),
      after: snapshot({ result: { leaked: "sk-live1234567890abcdefghij" } }),
      result: actionResult("success")
    });
    expect(JSON.stringify(draft)).not.toContain("sk-live1234567890abcdefghij");
    expect(JSON.stringify(draft)).toContain("[REDACTED]");
  });
});

describe("5.7-4 capture orchestration", () => {
  it("runs before → act → after → screenshot in order and carries the identity", async () => {
    const order: string[] = [];
    const draft = await captureActionEvidence({
      identity: {
        projectId: "00000000-0000-4000-8000-000000000001",
        workflowRunId: "00000000-0000-4000-8000-000000000002",
        taskId: "00000000-0000-4000-8000-000000000003",
        toolCallId: "call-7",
        actionRef: {
          source: "browser",
          sessionId: "browser:1",
          toolName: "browser.action.click",
          target: "#go"
        }
      },
      expectations: [{ kind: "action-succeeded" }, { kind: "contains", value: "count: 1" }],
      before: async () => {
        order.push("before");
        return snapshot({ text: "count: 0" });
      },
      act: async () => {
        order.push("act");
        return { result: actionResult("success") };
      },
      after: async () => {
        order.push("after");
        return snapshot({ text: "count: 1" });
      },
      screenshot: async () => {
        order.push("screenshot");
        return "screenshot://browser:1/5.png";
      }
    });
    expect(order).toEqual(["before", "act", "after", "screenshot"]);
    expect(draft.verification.status).toBe("VERIFIED");
    expect(draft.screenshotRef).toBe("screenshot://browser:1/5.png");
    expect(draft.workflowRunId).toBe("00000000-0000-4000-8000-000000000002");
    expect(draft.toolCallId).toBe("call-7");
  });

  it("failed actions still produce evidence (failure facts preserved) and external ids ride along", async () => {
    const draft = await captureActionEvidence({
      identity: {
        projectId: "00000000-0000-4000-8000-000000000001",
        actionRef: {
          source: "mcp",
          serverName: "github",
          toolName: "issues.create",
          callId: "call-8"
        }
      },
      expectations: [{ kind: "action-succeeded" }, { kind: "contains", value: "ISS-101" }],
      before: async () => snapshot({ result: { issues: [] } }),
      act: async () => ({
        result: actionResult("failed", "MCP_REMOTE_TOOL"),
        externalId: "ISS-101"
      }),
      after: async () => snapshot({ result: { issues: [] } })
    });
    expect(draft.verification.status).toBe("FAILED");
    expect(draft.verification.findings.map((finding) => finding.ok)).toEqual([false, false]);
    expect(draft.result.status).toBe("failed");
    expect(draft.externalId).toBe("ISS-101");
  });

  it("an empty expectation list never parses (fail closed at build)", () => {
    expect(() =>
      buildEvidenceDraft({
        identity: {
          projectId: "00000000-0000-4000-8000-000000000001",
          actionRef: {
            source: "browser",
            sessionId: "b",
            toolName: "browser.observe",
            target: "#x"
          }
        },
        expectations: [],
        before: snapshot({ text: "0" }),
        after: snapshot({ text: "1" }),
        result: actionResult("success")
      })
    ).toThrow();
  });
});
