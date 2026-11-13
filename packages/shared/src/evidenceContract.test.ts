import { describe, expect, it } from "vitest";
import {
  ActionResultSchema,
  EvidenceExpectationSchema,
  EvidenceRecordDraftSchema,
  EvidenceRecordSchema,
  EvidenceSnapshotSchema,
  EvidenceVerificationSchema,
  ObservationSchema
} from "./index";

/** Phase 5.7-4: Evidence contract tests (pure schema level). */

const observation = ObservationSchema.parse({
  observationId: "obs-1",
  actionRef: {
    source: "browser",
    sessionId: "browser:1",
    toolName: "browser.observe",
    target: "http://x"
  },
  dom: { nodes: [{ ref: "r1", role: "button", name: "go", clickable: true, text: "go" }] },
  takenAt: "2026-09-13T10:00:00.000Z"
});

const actionRef = {
  source: "browser",
  sessionId: "browser:1",
  toolName: "browser.action.click",
  target: "#go"
};

const result = ActionResultSchema.parse({
  resultId: "res-1",
  actionRef,
  status: "success",
  durationMs: 5,
  occurredAt: "2026-09-13T10:00:01.000Z"
});

const verification = EvidenceVerificationSchema.parse({
  status: "VERIFIED",
  findings: [
    { expectation: { kind: "action-succeeded" }, ok: true, detail: "status success" },
    { expectation: { kind: "contains", value: "count: 1" }, ok: true, detail: "found" }
  ],
  verifiedAt: "2026-09-13T10:00:02.000Z"
});

function draft() {
  return {
    projectId: "00000000-0000-4000-8000-000000000001",
    workflowRunId: "00000000-0000-4000-8000-000000000002",
    taskId: "00000000-0000-4000-8000-000000000003",
    toolCallId: "call-1",
    actionRef,
    externalId: "ISS-101",
    before: { observation, capturedAt: "2026-09-13T10:00:00.000Z" },
    after: { observation, capturedAt: "2026-09-13T10:00:01.000Z" },
    result,
    screenshotRef: "screenshot://browser:1/3.png",
    verification
  };
}

describe("5.7-4 evidence contract", () => {
  it("parses a full evidence draft and a persisted record", () => {
    const parsed = EvidenceRecordDraftSchema.parse(draft());
    expect(parsed.actionRef).toEqual(actionRef);
    const record = EvidenceRecordSchema.parse({
      ...draft(),
      id: "00000000-0000-4000-8000-00000000000a",
      createdAt: "2026-09-13T10:00:03.000Z",
      updatedAt: "2026-09-13T10:00:03.000Z"
    });
    expect(record.before.observation?.observationId).toBe("obs-1");
  });

  it("reuses the 5.7-0 shapes: actionRef arms and screenshotRef prefix lock", () => {
    const mcp = EvidenceRecordDraftSchema.parse({
      ...draft(),
      actionRef: {
        source: "mcp",
        serverName: "github",
        toolName: "issues.create",
        callId: "call-9"
      },
      screenshotRef: undefined
    });
    expect(mcp.actionRef.source).toBe("mcp");
    const bad = { ...draft(), screenshotRef: "https://example.test/shot.png" };
    expect(EvidenceRecordDraftSchema.safeParse(bad).success).toBe(false);
  });

  it("evidence snapshots require a real observation or result (never empty)", () => {
    expect(
      EvidenceSnapshotSchema.safeParse({ capturedAt: "2026-09-13T10:00:00.000Z" }).success
    ).toBe(false);
    expect(
      EvidenceSnapshotSchema.safeParse({
        result: { issues: [] },
        capturedAt: "2026-09-13T10:00:00.000Z"
      }).success
    ).toBe(true);
    expect(
      EvidenceSnapshotSchema.safeParse({
        observation,
        result: { issues: [] }, // both is fine (browser + data)
        capturedAt: "2026-09-13T10:00:00.000Z"
      }).success
    ).toBe(true);
  });

  it("expectations are a strict frozen vocabulary", () => {
    expect(EvidenceExpectationSchema.safeParse({ kind: "action-succeeded" }).success).toBe(true);
    expect(EvidenceExpectationSchema.safeParse({ kind: "changed" }).success).toBe(true);
    expect(EvidenceExpectationSchema.safeParse({ kind: "contains", value: "x" }).success).toBe(
      true
    );
    // Unknown kinds / stray fields / empty values are rejected.
    expect(EvidenceExpectationSchema.safeParse({ kind: "score" }).success).toBe(false);
    expect(
      EvidenceExpectationSchema.safeParse({ kind: "contains", value: "x", weight: 2 }).success
    ).toBe(false);
    expect(EvidenceExpectationSchema.safeParse({ kind: "contains", value: "" }).success).toBe(
      false
    );
  });

  it("verification implies the findings: VERIFIED ⇔ all ok, FAILED ⇔ some failing", () => {
    const ok = [{ expectation: { kind: "action-succeeded" }, ok: true, detail: "ok" }];
    const bad = [{ expectation: { kind: "action-succeeded" }, ok: false, detail: "failed" }];
    expect(
      EvidenceVerificationSchema.safeParse({
        status: "VERIFIED",
        findings: ok,
        verifiedAt: "2026-09-13T10:00:00.000Z"
      }).success
    ).toBe(true);
    expect(
      EvidenceVerificationSchema.safeParse({
        status: "VERIFIED",
        findings: bad,
        verifiedAt: "2026-09-13T10:00:00.000Z"
      }).success
    ).toBe(false);
    expect(
      EvidenceVerificationSchema.safeParse({
        status: "FAILED",
        findings: ok,
        verifiedAt: "2026-09-13T10:00:00.000Z"
      }).success
    ).toBe(false);
    expect(
      EvidenceVerificationSchema.safeParse({
        status: "FAILED",
        findings: bad,
        verifiedAt: "2026-09-13T10:00:00.000Z"
      }).success
    ).toBe(true);
    // Empty findings never parse (nothing to verify).
    expect(
      EvidenceVerificationSchema.safeParse({
        status: "VERIFIED",
        findings: [],
        verifiedAt: "2026-09-13T10:00:00.000Z"
      }).success
    ).toBe(false);
  });

  it("records are strict: unknown fields and inline screenshot bytes are rejected", () => {
    const withStray = { ...draft(), confidence: 0.9 };
    expect(EvidenceRecordDraftSchema.safeParse(withStray).success).toBe(false);
    const withBase64 = { ...draft(), screenshotBase64: "AAAA" };
    expect(EvidenceRecordDraftSchema.safeParse(withBase64).success).toBe(false);
  });

  it("draft vs record: id/timestamps belong to persistence only", () => {
    const parsed = EvidenceRecordDraftSchema.parse(draft()) as Record<string, unknown>;
    expect(parsed.id).toBeUndefined();
    expect(parsed.createdAt).toBeUndefined();
    expect(EvidenceRecordSchema.safeParse(draft()).success).toBe(false); // draft is not a record
  });
});
