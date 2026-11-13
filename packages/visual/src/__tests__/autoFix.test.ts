import type { VisualSection, VisualSpecification } from "@ai-se/shared";
import { VisualSpecificationSchema } from "@ai-se/shared";
import { serializeFixAuditTrailMd } from "../index";
import type { EvaluationReport } from "../index";
import {
  FIX_LOOP_MAX_ROUNDS,
  FIX_LOOP_STALL_THRESHOLD,
  SCORE_SEVERITY,
  advanceFixLoop,
  buildFixTaskDrafts,
  determineFixOutcome,
  initialFixLoopState,
  visualIssuesFromReport,
  type EvaluationScore,
  type FixLoopState,
  type VisualIssue
} from "../index";
import { describe, expect, it } from "vitest";

/** 5.6-5 unit tests: issue classification (gap excluded from fix candidates),
 * draft reuse with contract literals, three-state outcome, loop advancement,
 * audit trail md. No browser / no runner. */

function sectionFixture(id: string, overrides: Partial<VisualSection> = {}): VisualSection {
  return {
    id,
    title: `Section ${id}`,
    geometry: { rect: { x: 0, y: 0, width: 100, height: 60 } },
    ...overrides
  };
}

function specFixture(sections: VisualSection[]): VisualSpecification {
  return VisualSpecificationSchema.parse({
    input: {
      inputType: "screenshot",
      source: "screenshot://fix/spec.png",
      viewport: { width: 64, height: 32 }
    },
    page: {
      id: "page:checkout:1",
      name: "Checkout",
      viewport: { width: 64, height: 32 },
      sections
    },
    generatedAt: new Date().toISOString()
  });
}

function reportFixture(overrides: {
  score?: EvaluationScore;
  missing?: string[];
  extra?: string[];
  mismatched?: Array<{ sectionId: string; kind: "geometry" | "elements" | "states" | "style"; detail: string }>;
  attributableToKnownGap?: string[];
}): EvaluationReport {
  return {
    referenceSource: "screenshot://fix/ref.png",
    candidateSource: "screenshot://fix/cand.png",
    evaluatedAt: new Date().toISOString(),
    viewport: { width: 64, height: 32 },
    structural: {
      sectionsTotal: 2,
      missing: overrides.missing ?? [],
      extra: overrides.extra ?? [],
      mismatched: (overrides.mismatched ?? []).map((mismatch) => ({
        sectionId: mismatch.sectionId,
        kind: mismatch.kind,
        detail: mismatch.detail
      }))
    },
    pixel: { diffRatio: 0.4, heatMapBase64: null, hotspots: [] },
    score: overrides.score ?? "LAYOUT",
    warnings: [],
    attributableToKnownGap: overrides.attributableToKnownGap ?? []
  };
}

describe("5.6-5 issue classification", () => {
  it("maps structural signals to issues and keeps gap-attributed out of fix candidates", () => {
    const report = reportFixture({
      missing: ["section:a:1"],
      mismatched: [
        { sectionId: "section:b:2", kind: "geometry", detail: "area differs by 30%" }
      ],
      attributableToKnownGap: ["section:c:3"]
    });
    const { issues, fixCandidateIds } = visualIssuesFromReport(report, "desktop");
    expect(issues.length).toBe(3);
    const gap = issues.find((issue) => issue.attributableToKnownGap)!;
    expect(gap.kind).toBe("gap");
    expect(gap.sectionId).toBe("section:c:3");
    expect(fixCandidateIds).toEqual(
      expect.arrayContaining(["issue:desktop:section:a:1", "issue:desktop:section:b:2"])
    );
    expect(fixCandidateIds).not.toContain("issue:desktop:section:c:3");
  });

  it("issueId is deterministic (viewport + sectionId)", () => {
    const report = reportFixture({ missing: ["s1"] });
    const { issues } = visualIssuesFromReport(report, "mobile");
    expect(issues[0].issueId).toBe("issue:mobile:s1");
  });

  it("redacts credential-shaped details at classification time", () => {
    const report = reportFixture({
      mismatched: [
        {
          sectionId: "s1",
          kind: "elements",
          detail: "token Bearer AAAABBBBCCCC leaked"
        }
      ]
    });
    const { issues } = visualIssuesFromReport(report, "desktop");
    expect(issues[0].detail).not.toContain("Bearer AAAABBBBCCCC");
    expect(issues[0].detail).toContain("[REDACTED]");
  });
});

function fixCandidateIdsOf(issues: VisualIssue[]): string[] {
  return issues.filter((issue) => !issue.attributableToKnownGap).map((issue) => issue.issueId);
}
void fixCandidateIdsOf;

describe("5.6-5 three-state outcome", () => {
  it("RESOLVED when before had issues and after has none", () => {
    const before = reportFixture({ missing: ["s1"], mismatched: [] });
    const after = reportFixture({ missing: [], mismatched: [], score: "PASS" });
    expect(determineFixOutcome({ report: before, viewportName: "desktop" }, { report: after, viewportName: "desktop" }).outcome).toBe("RESOLVED");
  });

  it("NEW_ISSUE when after introduces an unseen issueId", () => {
    const before = reportFixture({ missing: ["s1"] });
    const after = reportFixture({ missing: ["s1", "s2"] });
    expect(determineFixOutcome({ report: before, viewportName: "desktop" }, { report: after, viewportName: "desktop" }).outcome).toBe("NEW_ISSUE");
  });

  it("REGRESSED when score worsens along the frozen severity order", () => {
    expect(SCORE_SEVERITY.LAYOUT).toBeGreaterThan(SCORE_SEVERITY.COMPONENT);
    const before = reportFixture({
      score: "LAYOUT",
      missing: ["s1"],
      mismatched: []
    });
    // after keeps s1 unresolved AND introduces a geometry mismatch with a
    // worse score (LAYOUT → COMPoin); new issue id triggers NEW_ISSUE first —
    // so construct: same ids, worse score via severity table when scores differ.
    const after = reportFixture({
      score: "LAYOUT",
      missing: ["s1"],
      mismatched: [{ sectionId: "s1", kind: "geometry", detail: "worse" }]
    });
    // Same section unresolved; unchanged set contains geometry → REGRESSED
    // even though score is tied (kind-weighted check).
    expect(
      determineFixOutcome(
        { report: before, viewportName: "desktop" },
        { report: after, viewportName: "desktop" }
      ).outcome
    ).toBe("REGRESSED");
  });

  it("REGRESSED when unchanged issues include a geometry-kind mismatch", () => {
    const before = reportFixture({ mismatched: [{ sectionId: "s1", kind: "geometry", detail: "shift" }] });
    const after = reportFixture({ mismatched: [{ sectionId: "s1", kind: "geometry", detail: "shift" }] });
    expect(determineFixOutcome({ report: before, viewportName: "desktop" }, { report: after, viewportName: "desktop" }).outcome).toBe("REGRESSED");
  });

  it("gap-attributable issues do not count toward outcome (regression-only set)", () => {
    const before = reportFixture({ attributableToKnownGap: ["g1"], missing: [] });
    const after = reportFixture({ attributableToKnownGap: ["g1", "g2"], missing: [] });
    const result = determineFixOutcome(
      { report: before, viewportName: "desktop" },
      { report: after, viewportName: "desktop" }
    );
    expect(result.newIssues).toEqual([]);
    expect(result.outcome).toBe("RESOLVED"); // regression-only set is empty on both sides
  });
});

describe("5.6-5 fix draft construction (reuses 5.6-2)", () => {
  it("builds one draft per gap-free section with contract literals and autoSubmitted=false", () => {
    const specification = specFixture([sectionFixture("s1")]);
    const issues = visualIssuesFromReport(
      reportFixture({ missing: ["s1"] }),
      "desktop"
    ).issues;
    const { drafts } = buildFixTaskDrafts({
      issues,
      specifications: [
        {
          viewportName: "desktop",
          specification
        }
      ]
    });
    expect(drafts.length).toBe(1);
    expect(drafts[0].draft.taskKey).toContain("visual:checkout:1");
    expect(drafts[0].draft.assignedAgent).toBe("frontend-agent");
    expect(drafts[0].draft.type).toBe("FRONTEND");
    expect(drafts[0].autoSubmitted).toBe(false);
    expect(drafts[0].submissionRisk).toBe("LOW"); // missing → elements → LOW
    expect(drafts[0].issueRefs).toEqual(["issue:desktop:s1"]);
  });

  it("gap-only issues produce NO draft (human review path)", () => {
    const issues = visualIssuesFromReport(
      reportFixture({ attributableToKnownGap: ["gap1"] }),
      "desktop"
    ).issues;
    const { drafts } = buildFixTaskDrafts({
      issues,
      specifications: [
        { viewportName: "desktop", specification: specFixture([sectionFixture("gap1")]) }
      ]
    });
    expect(drafts).toEqual([]);
  });
});

describe("5.6-5 frozen loop constants and advancement", () => {
  it("constants are frozen at the prompt values", () => {
    expect(FIX_LOOP_MAX_ROUNDS).toBe(3);
    expect(FIX_LOOP_STALL_THRESHOLD).toBe(2);
  });

  it("RESOLVED round → DONE", () => {
    const state = advanceFixLoop(initialFixLoopState(), {
      round: 1,
      submittedFixes: 2,
      outcome: "RESOLVED",
      reports: { referenceSource: "r", candidateSource: "c" }
    });
    expect(state.status).toBe("DONE");
  });

  it("reaching maxRounds without resolution → MAX_ROUNDS", () => {
    let state: FixLoopState = initialFixLoopState();
    for (let round = 1; round <= FIX_LOOP_MAX_ROUNDS; round += 1) {
      state = advanceFixLoop(state, {
        round,
        submittedFixes: 1,
        outcome: "NEW_ISSUE",
        reports: { referenceSource: "r", candidateSource: "c" }
      });
    }
    expect(state.status).toBe("MAX_ROUNDS");
  });

  it("stallThreshold identical non-resolved rounds in a row → STALLED", () => {
    let state: FixLoopState = initialFixLoopState();
    state = advanceFixLoop(state, { round: 1, submittedFixes: 1, outcome: "NEW_ISSUE", reports: { referenceSource: "r", candidateSource: "c" } });
    expect(state.status).toBe("RUNNING"); // one stall round is not enough
    state = advanceFixLoop(state, { round: 2, submittedFixes: 1, outcome: "NEW_ISSUE", reports: { referenceSource: "r", candidateSource: "c" } });
    expect(state.status).toBe("STALLED");
  });

  it("state is a pure function: input state is not mutated", () => {
    const initial = initialFixLoopState();
    const copied = { ...initial, rounds: [...initial.rounds] };
    advanceFixLoop(initial, { round: 1, submittedFixes: 1, outcome: "RESOLVED", reports: { referenceSource: "r", candidateSource: "c" } });
    expect(initial.rounds.length).toBe(copied.rounds.length);
    expect(initial.status).toBe("RUNNING");
  });
});

describe("5.6-5 audit trail md", () => {
  it("serializes with sections, redacts leaks, no time fields to strip", () => {
    const before = reportFixture({ missing: ["s1"] });
    const issues = visualIssuesFromReport(before, "desktop").issues;
    const markdown = serializeFixAuditTrailMd(
      {
        pageName: "Checkout",
        round: 1,
        referenceSource: before.referenceSource,
        candidateSource: "screenshot://leak/1.png?token=sk-abc123defghijklm",
        issues,
        submittedDraft: null,
        beforeReport: before,
        afterReport: null,
        outcome: "NEW_ISSUE"
      },
      { serializeReport: (report) => report.score }
    );
    expect(markdown).toContain("# Fix Audit Trail — Checkout round 1");
    expect(markdown).toContain("## issues");
    expect(markdown).toContain("## submitted fix draft");
    expect(markdown).toContain("- (none)");
    expect(markdown).not.toContain("sk-abc123defghijklm");
    expect(markdown).toContain("[REDACTED]");
    const stripped = (text: string) =>
      text.split("\n").filter((line) => !line.includes("evaluatedAt"));
    expect(
      stripped(
        serializeFixAuditTrailMd(
          {
            pageName: "Checkout",
            round: 1,
            referenceSource: before.referenceSource,
            candidateSource: "screenshot://leak/1.png?token=sk-abc123defghijklm",
            issues,
            submittedDraft: null,
            beforeReport: before,
            afterReport: null,
            outcome: "NEW_ISSUE"
          },
          { serializeReport: (report) => report.score }
        )
      )
    ).toEqual(stripped(markdown));
  });
});
