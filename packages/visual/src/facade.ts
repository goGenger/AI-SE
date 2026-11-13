import type { VisualInputAllowlist, VisualInputRecord } from "@ai-se/shared";
import { VisualAnalyzer, type AnalyzeOptions, type DesignTokenFinding } from "./analyzer";
import { buildAnalysisReport } from "./report";
import type { VisualAnalysisResult } from "./report";

/**
 * Phase 5.6-1: one-call facade. analyze(provider) → specification + report.
 *
 * Warning vocabulary (frozen for 5.6-1; deterministic, deduplicated, sorted):
 *  - "Section \"<title>\" has no identified elements" (element-less section);
 *  - provider warnings flow through unmodified (redacted at serialization).
 */

export interface AnalyzeWithReportOptions extends AnalyzeOptions {
  allowlist?: VisualInputAllowlist;
}

export async function analyzeWithReport(
  analyzer: VisualAnalyzer,
  record: VisualInputRecord,
  options: AnalyzeWithReportOptions = {}
): Promise<VisualAnalysisResult> {
  const { specification, tokenFindings, providerWarnings } = await analyzer.analyzeFull(
    record,
    options
  );

  const warnings = collectWarnings(specification, providerWarnings);
  const report = buildReport(specification, tokenFindings, warnings);
  return { specification, report };
}

/** Frozen rule set: element-less sections warn; then dedupe + sort. */
export function collectWarnings(
  specification: Parameters<typeof buildReport>[0],
  providerWarnings: string[]
): string[] {
  const warnings = new Set<string>(providerWarnings);
  for (const section of specification.page.sections) {
    if ((section.elements?.length ?? 0) === 0) {
      warnings.add(`Section "${section.title}" has no identified elements`);
    }
  }
  return [...warnings].sort();
}

function buildReport(
  specification: import("@ai-se/shared").VisualSpecification,
  tokenFindings: DesignTokenFinding[],
  warnings: string[]
): import("@ai-se/shared").VisualAnalysisReport {
  return buildAnalysisReport(
    specification,
    tokenFindings.map((token) => ({ namespace: token.namespace, name: token.name })),
    warnings,
    new Date().toISOString()
  );
}
