/**
 * Phase 5.6-5: Auto Fix / Re-plan. Issue classification + fix draft
 * construction + three-state outcome + loop advancement + audit trail, all
 * pure functions. The real execution loop (Fix Task → Frontend Agent →
 * ToolRuntime/Sandbox → code → Browser → Screenshot → Visual Evaluation)
 * lives in the composition root (apps/server services) — this module stays
 * data-only. `autoSubmitted` is false on produced drafts and flipped true on
 * the submitted copy by that runner.
 */
import type { VisualSpecification } from "@ai-se/shared";
import { redactCredentialShapedText } from "@ai-se/observability";
import {
  buildFrontendTasks,
  FrontendTaskDraftSchema,
  type FrontendTaskDraft,
  type MatchOptions
} from "./converter";
import type {
  EvaluationReport,
  EvaluationScore
} from "./evaluation";
import type { ViewportName } from "./validation";

// ── Frozen loop constants (prompt §三.4; tests lock these) ───────────────────

export const FIX_LOOP_MAX_ROUNDS = 3;
export const FIX_LOOP_STALL_THRESHOLD = 2;

export type IssueKind = "geometry" | "elements" | "states" | "style" | "gap";

export interface VisualIssue {
  issueId: string;
  sectionId: string;
  viewportName: ViewportName;
  kind: IssueKind;
  detail: string;
  attributableToKnownGap: boolean;
}

export interface FixTaskDraft {
  draft: FrontendTaskDraft;
  issueRefs: string[];
  submissionRisk: "LOW" | "MEDIUM" | "HIGH";
  /**
   * Whether a loop runner has actually submitted this draft to a Frontend
   * Agent. Drafts produced by `buildFixTaskDrafts` default to false; the
   * Phase 5.6-5 Repair runner marks the submitted copy true and records the
   * submission in its round evidence.
   */
  autoSubmitted: boolean;
}

// ── Issue classification (§三.1) ─────────────────────────────────────────────

/** Issues derived from ONE evaluation report. Gap-attributed entries are
 * emitted as issues (for human review) but are NOT fix candidates. */
export function visualIssuesFromReport(
  report: EvaluationReport,
  viewportName: ViewportName
): { issues: VisualIssue[]; fixCandidateIds: string[] } {
  const issues: VisualIssue[] = [];
  const emit = (
    sectionId: string,
    kind: IssueKind,
    detail: string,
    attributableToKnownGap: boolean
  ): void => {
    issues.push({
      issueId: `issue:${viewportName}:${sectionId}`,
      sectionId,
      viewportName,
      kind,
      detail: redactCredentialShapedText(detail).slice(0, 200),
      attributableToKnownGap
    });
  };
  for (const missing of report.structural.missing) {
    emit(missing, "elements", `missing section ${missing}`, false);
  }
  for (const extra of report.structural.extra) {
    emit(extra, "elements", `extra section ${extra}`, false);
  }
  for (const mismatch of report.structural.mismatched) {
    emit(mismatch.sectionId, mismatch.kind, mismatch.detail, false);
  }
  for (const sectionId of report.attributableToKnownGap) {
    emit(
      sectionId,
      "gap",
      `known component gap explains diffs in ${sectionId}`,
      true
    );
  }
  return {
    issues,
    fixCandidateIds: issues
      .filter((issue) => !issue.attributableToKnownGap)
      .map((issue) => issue.issueId)
  };
}

// ── Fix draft construction (reuses the 5.6-2 converter verbatim) ────────────

const RISK_RANK: Record<"LOW" | "MEDIUM" | "HIGH", number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const KIND_RISK: Record<IssueKind, "LOW" | "MEDIUM" | "HIGH"> = {
  gap: "HIGH",
  geometry: "MEDIUM",
  elements: "LOW",
  states: "LOW",
  style: "LOW"
};

/** Build fix drafts: for the referenced section's candidate spec run the
 * 5.6-2 converter and attach the grouped issues. Done-per-section keeps the
 * draft independently executable (same as 5.6-2's grouping rule).
 * worst-risk derivation is frozen: gap→HIGH, geometry→MEDIUM, else LOW. */
export function buildFixTaskDrafts(params: {
  issues: VisualIssue[];
  specifications: Array<{
    viewportName: ViewportName;
    specification: VisualSpecification;
  }>;
  matchOptions?: MatchOptions;
}): { drafts: FixTaskDraft[] } {
  const candidates = params.issues.filter(
    (issue) => !issue.attributableToKnownGap
  );
  if (candidates.length === 0) return { drafts: [] };
  const bySection = new Map<string, VisualIssue[]>();
  for (const issue of candidates) {
    bySection.set(issue.sectionId, [
      ...(bySection.get(issue.sectionId) ?? []),
      issue
    ]);
  }
  const drafts: FixTaskDraft[] = [];
  for (const source of params.specifications) {
    const { tasks } = buildFrontendTasks(
      source.specification,
      params.matchOptions
    );
    for (const [sectionId, sectionIssues] of bySection) {
      const sectionIndex = source.specification.page.sections.findIndex(
        (section) => section.id === sectionId
      );
      if (sectionIndex < 0) continue;
      const draft = tasks[sectionIndex];
      if (!draft) continue;
      drafts.push({
        draft: FrontendTaskDraftSchema.parse(draft),
        issueRefs: sectionIssues.map((issue) => issue.issueId),
        submissionRisk: sectionIssues.reduce<"LOW" | "MEDIUM" | "HIGH">(
          (worst, issue) =>
            RISK_RANK[KIND_RISK[issue.kind]] > RISK_RANK[worst]
              ? KIND_RISK[issue.kind]
              : worst,
          "LOW" as const
        ),
        autoSubmitted: false
      });
    }
  }
  return { drafts };
}

// ── Three-state outcome (§三.3) — issue-set comparison, not score comparison ─

export type FixOutcome = "RESOLVED" | "NEW_ISSUE" | "REGRESSED";
/** Severity order for the "worse score" check (frozen; tests lock). */
export const SCORE_SEVERITY: Record<EvaluationScore, number> = {
  PASS: 0,
  STYLE: 1,
  COMPONENT: 2,
  LAYOUT: 3
};

export interface FixOutcomeResult {
  outcome: FixOutcome;
  unchangedIssues: string[];
  resolvedIssues: string[];
  newIssues: string[];
}

export function determineFixOutcome(
  before: { report: EvaluationReport; viewportName: ViewportName },
  after: { report: EvaluationReport; viewportName: ViewportName }
): FixOutcomeResult {
  const beforeSet = visualIssuesFromReport(
    before.report,
    before.viewportName
  );
  const afterSet = visualIssuesFromReport(after.report, after.viewportName);
  const beforeCandidates = beforeSet.fixCandidateIds;
  const afterCandidates = afterSet.fixCandidateIds;
  const unresolved = afterCandidates.filter((id) =>
    beforeCandidates.includes(id)
  );
  const resolvedIssues = beforeCandidates.filter(
    (id) => !afterCandidates.includes(id)
  );
  const newIssues = afterCandidates.filter(
    (id) => !beforeCandidates.includes(id)
  );

  let outcome: FixOutcome;
  if (afterCandidates.length === 0) {
    // Regression-only set empty → nothing to fix; RESOLVED (also when both
    // sides were already clean).
    outcome = "RESOLVED";
  } else if (newIssues.length > 0) {
    outcome = "NEW_ISSUE";
  } else if (
    SCORE_SEVERITY[after.report.score] > SCORE_SEVERITY[before.report.score] ||
    unresolved.some((id) =>
      afterSet.issues.find(
        (issue) => issue.issueId === id && issue.kind === "geometry"
      )
    )
  ) {
    outcome = "REGRESSED";
  } else if (resolvedIssues.length > 0) {
    // Progress without full resolution counts as improvement, not regression.
    outcome = "NEW_ISSUE";
  } else {
    outcome = "NEW_ISSUE"; // unchanged non-progressing state
  }
  return { outcome, unchangedIssues: unresolved, resolvedIssues, newIssues };
}

// ── Loop state (§三.4) — pure data + pure advancement ────────────────────────

export type LoopOutcome = "RESOLVED" | "NEW_ISSUE" | "REGRESSED" | "PENDING";
export type LoopStatus = "RUNNING" | "STALLED" | "MAX_ROUNDS" | "DONE";

export interface FixLoopState {
  round: number;
  maxRounds: number;
  stallThreshold: number;
  rounds: Array<{
    round: number;
    submittedFixes: number;
    outcome: LoopOutcome;
    reports: { referenceSource: string; candidateSource: string };
  }>;
  status: LoopStatus;
}

export function initialFixLoopState(): FixLoopState {
  return {
    round: 0,
    maxRounds: FIX_LOOP_MAX_ROUNDS,
    stallThreshold: FIX_LOOP_STALL_THRESHOLD,
    rounds: [],
    status: "RUNNING"
  };
}

/** Advance the loop by appending a finished round + deciding the next status.
 * Pure function: never calls evaluate/tasks; semantics mirror workflow-engine
 * retry (max rounds, no-progress → human hand-off via STALLED status). */
export function advanceFixLoop(
  state: FixLoopState,
  round: {
    round: number;
    submittedFixes: number;
    outcome: LoopOutcome;
    reports: { referenceSource: string; candidateSource: string };
  }
): FixLoopState {
  const rounds = [...state.rounds, round];
  const currentRound = Math.max(state.round, round.round);
  let status: LoopStatus;
  if (round.outcome === "RESOLVED") {
    status = "DONE";
  } else if (currentRound >= state.maxRounds) {
    status = "MAX_ROUNDS";
  } else {
    const last = rounds.slice(-state.stallThreshold);
    const stalled =
      last.length === state.stallThreshold &&
      last.every((entry) => entry.outcome !== "RESOLVED") &&
      new Set(last.map((entry) => entry.outcome)).size === 1;
    status = stalled ? "STALLED" : "RUNNING";
  }
  return { ...state, round: currentRound, rounds, status };
}

// ── Audit trail (§三.5) — concatenation of existing serializers ─────────────

export interface FixAuditTrail {
  pageName: string;
  round: number;
  referenceSource: string;
  candidateSource: string;
  issues: VisualIssue[];
  submittedDraft: FixTaskDraft | null;
  beforeReport: EvaluationReport;
  afterReport: EvaluationReport | null;
  outcome: LoopOutcome;
}

export function serializeFixAuditTrailMd(
  trail: FixAuditTrail,
  _helpers: {
    serializeReport: (report: EvaluationReport) => string;
  }
): string {
  const lines: string[] = [];
  lines.push(`# Fix Audit Trail — ${trail.pageName} round ${trail.round}`);
  lines.push("");
  lines.push(`- reference: ${trail.referenceSource}`);
  lines.push(`- candidate: ${trail.candidateSource}`);
  lines.push(`- outcome: ${trail.outcome}`);
  lines.push("");
  lines.push("## issues");
  for (const issue of trail.issues) {
    lines.push(
      `- ${issue.issueId} [${issue.kind}]${issue.attributableToKnownGap ? " (known-gap)" : ""}: ${issue.detail}`
    );
  }
  lines.push("");
  lines.push("## submitted fix draft");
  if (trail.submittedDraft) {
    lines.push(`- taskKey: ${trail.submittedDraft.draft.taskKey}`);
    lines.push(`- title: ${trail.submittedDraft.draft.title}`);
    lines.push(`- submissionRisk: ${trail.submittedDraft.submissionRisk}`);
    lines.push(`- autoSubmitted: ${trail.submittedDraft.autoSubmitted}`);
  } else {
    lines.push("- (none)");
  }
  lines.push("");
  lines.push("## evaluation before");
  lines.push(trail.beforeReport ? trail.beforeReport.score : "n/a");
  if (trail.afterReport) {
    lines.push("");
    lines.push("## evaluation after");
    lines.push(trail.afterReport ? trail.afterReport.score : "n/a");
  }
  return lines.map((line) => redactCredentialShapedText(line)).join("\n");
}

