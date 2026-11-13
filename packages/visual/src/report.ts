import { redactCredentialShapedText } from "@ai-se/observability";
import type { VisualAnalysisReport, VisualSpecification } from "@ai-se/shared";

/**
 * Phase 5.6-1: markdown export (pure, replayable — same input yields the same
 * markdown apart from timestamps). Every emitted line passes the platform-wide
 * credential-shaped redaction, so no token/secret reaches the artifact even
 * when provider output contains one.
 */

export interface VisualAnalysisResult {
  specification: VisualSpecification;
  report: VisualAnalysisReport;
}

export function serializeVisualAnalysisReportMd(result: VisualAnalysisResult): string {
  const { specification, report } = result;
  const lines: string[] = [];
  const line = (text: string): void => {
    lines.push(redactCredentialShapedText(text));
  };

  line("# Visual Analysis Report");
  lines.push("");
  line(`- Input: ${report.inputSource}`);
  line(`- Viewport: ${specification.page.viewport.width}x${specification.page.viewport.height}`);
  line(`- Generated at: ${specification.generatedAt}`);
  line(`- Analyzed at: ${report.analyzedAt}`);
  line(
    `- Sections: ${report.sectionCount} / Elements: ${report.elementCount} / Viewports: ${report.viewports.length}`
  );
  lines.push("");

  lines.push("## Page structure");
  lines.push("");
  for (const section of specification.page.sections) {
    const rect = section.geometry.rect;
    line(
      `- **${section.id}** — ${section.title} (${rect.x},${rect.y} ${rect.width}x${rect.height})`
    );
    for (const element of section.elements ?? []) {
      const eRect = element.geometry?.rect;
      const dimensions = eRect ? ` (${eRect.x},${eRect.y} ${eRect.width}x${eRect.height})` : "";
      line(`  - ${element.id} — ${element.description}${dimensions}`);
    }
    for (const state of section.states ?? []) {
      line(`  - state: ${state.state}`);
    }
  }
  lines.push("");

  if (report.tokenSummary.length > 0) {
    lines.push("## Design tokens");
    lines.push("");
    for (const token of report.tokenSummary) {
      line(`- ${token}`);
    }
    lines.push("");
  }

  if (report.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const warning of report.warnings) {
      line(`- ${warning}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Builds the report summary from one specification + token findings. */
export function buildAnalysisReport(
  specification: VisualSpecification,
  tokenFindings: Array<{ namespace: string; name: string }>,
  warnings: string[],
  analyzedAt: string
): VisualAnalysisReport {
  const sectionCount = specification.page.sections.length;
  const elementCount = specification.page.sections.reduce(
    (total, section) => total + (section.elements?.length ?? 0),
    0
  );
  return {
    inputSource: specification.input.source,
    analyzedAt,
    viewports: [
      {
        viewport: specification.page.viewport,
        sectionCount,
        elementCount
      }
    ],
    sectionCount,
    elementCount,
    tokenSummary: [
      ...new Set(tokenFindings.map((token) => `${token.namespace}.${token.name}`))
    ].sort(),
    warnings
  };
}
