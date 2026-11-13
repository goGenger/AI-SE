/**
 * Phase 5.6-6: Responsive & Interaction Validation. Thin wrappers over the
 * frozen 5.6-4 evaluation entry — every comparison routes through
 * evaluateVisuals; no second scoring/color system. Browser lifecycle reuse
 * is a caller concern (5.6-3): this file is evaluation-side, pure functions.
 *
 * 5.6-6 completion (this pass): tablet joins the frozen viewport presets and
 * "custom" entries carry their own size in the request record; the validated
 * UI-state vocabulary covers the ten states (active/expanded/modal are
 * validation labels — the frozen 5.6-0 annotation enum is unchanged);
 * detectStateRegressions reads the frozen pixel evidence only.
 */
import {
  evaluateVisuals,
  serializeVisualEvaluationReportMd,
  type EvaluationReport,
  type EvaluationScore,
  type EvaluateRequest
} from "./evaluation";
import type { VisualStateName } from "@ai-se/shared";
import { redactCredentialShapedText } from "@ai-se/observability";

export type ViewportName = "desktop" | "tablet" | "mobile" | "custom";

/** Frozen viewport matrix (prompt §三.1; completion adds tablet). Custom
 * sizes go through MatrixEntry with name "custom" — the preset list only
 * captures named presets. Extend only by editing this const through review,
 * never via runtime parameters. */
export const RESPONSIVE_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 }
] as const satisfies ReadonlyArray<{ name: ViewportName; width: number; height: number }>;

// ponytail: deep-freeze via two lines, no util import.
for (const viewport of RESPONSIVE_VIEWPORTS) {
  Object.freeze(viewport);
}
Object.freeze(RESPONSIVE_VIEWPORTS);

// ── Validated UI-state vocabulary (ten states; default = flip baseline) ─────

/** The ten UI states Phase 5.6-6 validates end-to-end. "default" is the
 * comparison baseline — every flip is default → state. */
export const VALIDATED_UI_STATES = [
  "default",
  "hover",
  "focus",
  "active",
  "disabled",
  "loading",
  "empty",
  "error",
  "expanded",
  "modal"
] as const;
export type ValidatedUiState = (typeof VALIDATED_UI_STATES)[number];

/** Flip labels: every validated state except the "default" baseline. */
export type ValidatedStateName = Exclude<ValidatedUiState, "default">;

/** Compile-time relation (no runtime cost): the six shared 5.6-0 annotation
 * states are all validated states. The shared enum stays FROZEN —
 * active/expanded/modal are validation-scenario labels and are never written
 * into VisualSpecification annotations. */
export type EverySharedAnnotationStateIsValidated = Exclude<
  VisualStateName,
  "default"
> extends ValidatedStateName
  ? true
  : never;

/** A matrix entry is just a 5.6-4 request + label (reuse, not reshaping). */
export interface MatrixEntry {
  viewportName: ViewportName;
  request: EvaluateRequest;
}

/** UI state flip: which state, and the base-vs-flipped evaluation inputs.
 * stateName uses the 5.6-6 validation vocabulary (VALIDATED_UI_STATES minus
 * "default" — default is the comparison baseline, not a flip). */
export interface StateFlip {
  stateName: ValidatedStateName;
  request: EvaluateRequest;
}

/** Evaluate each viewport entry through the frozen 5.6-4 entry. Order is
 * preserved; no merging, no re-scoring — per-entry output is replayable. */
export function evaluateResponsiveMatrix(
  entries: MatrixEntry[]
): { reports: Array<{ viewportName: ViewportName; report: EvaluationReport }> } {
  return {
    reports: entries.map((entry) => ({
      viewportName: entry.viewportName,
      report: evaluateVisuals(entry.request).report
    }))
  };
}

/** State flips: structural states-kind mismatch is the primary signal,
 * pixel diff auxiliary — both already decided by evaluateVisuals. */
export type StateFlipReport = {
  stateName: StateFlip["stateName"];
  report: EvaluationReport;
};

export function evaluateStateFlips(
  flips: Array<{ stateName: ValidatedStateName; request: EvaluateRequest }>
): { reports: StateFlipReport[] } {
  return {
    reports: flips.map((flip) => ({
      stateName: flip.stateName satisfies ValidatedStateName,
      report: evaluateVisuals(flip.request).report
    }))
  };
}

// ── State regression detection (expected-change verdicts; no new scoring) ──

/** One flip expectation: "change" states must alter the rendered pixels,
 * "stable" controls must not. */
export interface StateFlipExpectation {
  stateName: ValidatedStateName;
  expected: "change" | "stable";
  report: Pick<EvaluationReport, "pixel">;
}

export interface StateRegressionFindings {
  /** Expected a visual change, pixels were identical. */
  missingChange: ValidatedStateName[];
  /** Control expected stable, pixels changed. */
  unexpectedChange: ValidatedStateName[];
}

/** Reads the frozen 5.6-4 pixel evidence only — diffRatio === 0 ⇔ identical
 * render (the real-browser e2e pins that equality); no second comparison. */
export function detectStateRegressions(flips: StateFlipExpectation[]): StateRegressionFindings {
  const missingChange: ValidatedStateName[] = [];
  const unexpectedChange: ValidatedStateName[] = [];
  for (const flip of flips) {
    const changed = flip.report.pixel.diffRatio > 0;
    if (flip.expected === "change" && !changed) missingChange.push(flip.stateName);
    if (flip.expected === "stable" && changed) unexpectedChange.push(flip.stateName);
  }
  return { missingChange, unexpectedChange };
}

// ── Cross-viewport consistency summary (descriptive; NOT a new score) ───────

export interface CrossViewportSummary {
  /** True when every entry report shares the same score. */
  consistent: boolean;
  /** Only when inconsistent: one row per viewport with its score. */
  variantViewports: Array<{ viewportName: ViewportName; score: EvaluationScore }>;
  perViewportDiffRatio: Array<{ viewportName: ViewportName; diffRatio: number }>;
}

export function buildCrossViewportSummary(
  reports: Array<{
    viewportName: ViewportName;
    report: Pick<EvaluationReport, "score" | "pixel">;
  }>
): CrossViewportSummary {
  const scores = new Set(reports.map((entry) => entry.report.score));
  const consistent = scores.size <= 1;
  return {
    consistent,
    variantViewports: consistent
      ? []
      : reports.map((entry) => ({
          viewportName: entry.viewportName,
          score: entry.report.score
        })),
    perViewportDiffRatio: reports.map((entry) => ({
      viewportName: entry.viewportName,
      diffRatio: entry.report.pixel.diffRatio
    }))
  };
}

// ── Markdown export (reuses 5.6-4 serialize; no new report type) ────────────

export interface ResponsiveValidationInput {
  header: { pageName: string; evaluatedAt: string };
  matrixReports: Array<{ viewportName: ViewportName; report: EvaluationReport }>;
  stateReports: Array<{ stateName: string; report: EvaluationReport }>;
  crossViewport: CrossViewportSummary;
  /** Optional: when present, renders the regression findings section. */
  stateRegressions?: StateRegressionFindings;
}

export function serializeResponsiveValidationMd(input: ResponsiveValidationInput): string {
  const lines: string[] = [];
  lines.push(`# Responsive & Interaction Validation — ${input.header.pageName}`);
  lines.push("");
  for (const entry of input.matrixReports) {
    lines.push(`## viewport ${entry.viewportName}`);
    lines.push("");
    lines.push(serializeVisualEvaluationReportMd(entry.report));
    lines.push("");
  }
  lines.push("## state flips");
  for (const entry of input.stateReports) {
    lines.push(
      `- ${entry.stateName} → ${entry.report.score} (${(entry.report.pixel.diffRatio * 100).toFixed(2)}%)`
    );
  }
  lines.push("");
  if (input.stateRegressions) {
    lines.push("## state regressions");
    const { missingChange, unexpectedChange } = input.stateRegressions;
    lines.push(`- missing change: ${missingChange.length > 0 ? missingChange.join(", ") : "none"}`);
    lines.push(
      `- unexpected change: ${unexpectedChange.length > 0 ? unexpectedChange.join(", ") : "none"}`
    );
    lines.push("");
  }
  lines.push("## cross-viewport consistency");
  lines.push(`- consistent: ${input.crossViewport.consistent}`);
  for (const row of input.crossViewport.perViewportDiffRatio) {
    lines.push(`- ${row.viewportName}: pattern diff ${(row.diffRatio * 100).toFixed(2)}%`);
  }
  if (input.crossViewport.variantViewports.length > 0) {
    lines.push("- variant viewports:");
    for (const variant of input.crossViewport.variantViewports) {
      lines.push(`  - ${variant.viewportName}: ${variant.score}`);
    }
  }
  return lines.map((line) => redactCredentialShapedText(line)).join("\n");
}
