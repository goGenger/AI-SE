/**
 * Phase 5.6-4: Visual Evaluation — pair reference vs candidate, diff
 * structurally (UI Spec aligned), pixel-diff as auxiliary only, graded by a
 * frozen else-if chain. PNG encode/decode lives in ./pngEncoder.ts
 * (stdlib zlib + CRC32; zero extra dependencies — the approved §二.1 path).
 */
import {
  type VisualAnalysisReport,
  type VisualInputRecord,
  type VisualSection,
  type VisualSpecification
} from "@ai-se/shared";
import { redactCredentialShapedText } from "@ai-se/observability";
import { VisualAnalyzerError } from "./errors";
import { decodeMinimalPng, encodePng } from "./pngEncoder";

// ── Frozen thresholds (prompt §三.1; tests lock these) ────────────────────────

export const PASS_DIFF_RATIO_MAX = 0.02;
export const PIXEL_ONLY_BAND_MAX = 0.3;
export const GEOMETRY_AREA_RATIO_MAX = 0.02;
export const GEOMETRY_SHIFT_PX_MAX = 8;
export const HOTSPOT_MAX = 20;
export const DIFF_CHANNEL_THRESHOLD = 24;
export const HEAT_GREEN_MAX = 0.01;
export const HEAT_YELLOW_MAX = 0.02;
export const HEAT_RED_MAX = 0.05;

export type EvaluationScore = "PASS" | "LAYOUT" | "COMPONENT" | "STYLE";
export type MismatchKind = "geometry" | "elements" | "style" | "states";

export class EvaluationError extends VisualAnalyzerError {
  constructor(message: string) {
    super("INPUT_INVALID", message);
    this.name = "EvaluationError";
  }
}

export interface SectionMismatch {
  sectionId: string;
  kind: MismatchKind;
  detail: string;
}

export interface PixelDiff {
  diffRatio: number;
  heatMapBase64: string | null;
  hotspots: Array<{ x: number; y: number; width: number; height: number }>;
}

export interface EvaluationReport {
  referenceSource: string;
  candidateSource: string;
  evaluatedAt: string;
  viewport: { width: number; height: number };
  structural: {
    sectionsTotal: number;
    missing: string[];
    extra: string[];
    mismatched: SectionMismatch[];
  };
  pixel: PixelDiff;
  score: EvaluationScore;
  warnings: string[];
  attributableToKnownGap: string[];
}

export interface EvaluationSide {
  record: VisualInputRecord;
  base64: string;
  analysis: VisualAnalysisReport;
  specification: VisualSpecification;
  /** Section ids whose elements contain a known component gap (5.6-2). */
  knownGapSections: string[];
}

export interface EvaluateRequest {
  reference: EvaluationSide;
  candidate: EvaluationSide;
  settled?: "networkidle" | "timeout";
}

// ── Structural diff (stableId alignment) ─────────────────────────────────────

function rectArea(rect: { width: number; height: number }): number {
  return Math.max(rect.width, 1) * Math.max(rect.height, 1);
}

export function geometryDetail(
  reference: VisualSection,
  candidate: VisualSection
): string | null {
  const areaRatio =
    Math.abs(rectArea(reference.geometry.rect) - rectArea(candidate.geometry.rect)) /
    Math.max(rectArea(reference.geometry.rect), rectArea(candidate.geometry.rect));
  if (areaRatio > GEOMETRY_AREA_RATIO_MAX) {
    return `area differs by ${(areaRatio * 100).toFixed(1)}%`;
  }
  const referenceCenter = {
    x: reference.geometry.rect.x + reference.geometry.rect.width / 2,
    y: reference.geometry.rect.y + reference.geometry.rect.height / 2
  };
  const candidateCenter = {
    x: candidate.geometry.rect.x + candidate.geometry.rect.width / 2,
    y: candidate.geometry.rect.y + candidate.geometry.rect.height / 2
  };
  const shift = Math.max(
    Math.abs(referenceCenter.x - candidateCenter.x),
    Math.abs(referenceCenter.y - candidateCenter.y)
  );
  if (shift > GEOMETRY_SHIFT_PX_MAX) {
    return `center shifts ${shift.toFixed(1)}px`;
  }
  return null;
}

function idSet(values: Array<{ id: string }>): Set<string> {
  return new Set(values.map((value) => value.id));
}

/**
 * Structural diff via stableId alignment. Sections listed in
 * knownGapSections are EXCLUDED from mismatched (they surface through
 * attributableToKnownGap) — 5.6-2 gap semantics downstream.
 */
export function diffSections(
  reference: VisualSpecification,
  candidate: VisualSpecification,
  knownGapSections: string[]
): {
  missing: string[];
  extra: string[];
  mismatched: SectionMismatch[];
  /** Sections whose diffs are explained by known gaps (excluded from mismatched). */
  gapAttributed: string[];
} {
  const referenceSections = reference.page.sections;
  const candidateById = new Map(candidate.page.sections.map((section) => [section.id, section]));
  const missing: string[] = [];
  const extra: string[] = [];
  const mismatched: SectionMismatch[] = [];
  const gapAttributed: string[] = [];

  for (const section of referenceSections) {
    const counterpart = candidateById.get(section.id);
    if (!counterpart) {
      missing.push(section.id);
      continue;
    }

    const geometry = geometryDetail(section, counterpart);
    const idsDiffer = (() => {
      const referenceIds = idSet(section.elements ?? []);
      const candidateIds = idSet(counterpart.elements ?? []);
      return (
        referenceIds.size !== candidateIds.size ||
        [...referenceIds].some((id) => !candidateIds.has(id))
      );
    })();
    const statesDiffer = (() => {
      const referenceStates = new Set((section.states ?? []).map((state) => state.state));
      const candidateStates = new Set(
        (counterpart.states ?? []).map((state) => state.state)
      );
      return (
        referenceStates.size !== candidateStates.size ||
        [...referenceStates].some((state) => !candidateStates.has(state))
      );
    })();
    const hasDiff = geometry !== null || idsDiffer || statesDiffer;
    if (!hasDiff) continue;

    // Known-gap sections: diff is real but attributed, not a regression.
    if (knownGapSections.includes(section.id)) {
      gapAttributed.push(section.id);
      continue;
    }
    if (geometry) {
      mismatched.push({ sectionId: section.id, kind: "geometry", detail: geometry });
    }
    if (idsDiffer) {
      const referenceIds = idSet(section.elements ?? []);
      const candidateIds = idSet(counterpart.elements ?? []);
      mismatched.push({
        sectionId: section.id,
        kind: "elements",
        detail: `element id set differs (${referenceIds.size} vs ${candidateIds.size})`
      });
    }
    if (statesDiffer) {
      const referenceStates = [...new Set((section.states ?? []).map((state) => state.state))];
      const candidateStates = [
        ...new Set((counterpart.states ?? []).map((state) => state.state))
      ];
      mismatched.push({
        sectionId: section.id,
        kind: "states",
        detail: `state names differ ([${referenceStates.join(",")}] vs [${candidateStates.join(",")}])`
      });
    }
  }
  const referenceIds = new Set(referenceSections.map((section) => section.id));
  for (const section of candidate.page.sections) {
    const id = section.id;
    if (referenceIds.has(id)) continue;
    if (knownGapSections.includes(id)) {
      gapAttributed.push(id);
    } else {
      extra.push(id);
    }
  }
  return { missing, extra, mismatched, gapAttributed };
}

// ── Pixel diff (auxiliary; decodes via pngEncoder) ───────────────────────────

function pixelDiff(
  referenceBase64: string,
  candidateBase64: string
): PixelDiff {
  let reference: { width: number; height: number; rgba: Uint8Array };
  let candidate: { width: number; height: number; rgba: Uint8Array };
  try {
    reference = decodeMinimalPng(Buffer.from(referenceBase64, "base64"));
    candidate = decodeMinimalPng(Buffer.from(candidateBase64, "base64"));
  } catch (error) {
    throw new EvaluationError(
      `screenshot decode failed: ${error instanceof Error ? error.message : "unknown"}`
    );
  }
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    return {
      diffRatio: 1,
      heatMapBase64: null,
      hotspots: []
    };
  }
  const total = reference.width * reference.height;
  const height = reference.height;
  const width = reference.width;
  /** Change density per 8x8 cell → heat color bucket. */
  const cellSize = 8;
  const cellsX = Math.ceil(width / cellSize);
  const cellsY = Math.ceil(height / cellSize);
  const cellChanges = new Float64Array(cellsX * cellsY);
  let changed = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const delta =
        Math.abs(reference.rgba[index] - candidate.rgba[index]) +
        Math.abs(reference.rgba[index + 1] - candidate.rgba[index + 1]) +
        Math.abs(reference.rgba[index + 2] - candidate.rgba[index + 2]);
      if (delta / 3 > DIFF_CHANNEL_THRESHOLD) {
        changed += 1;
        const cell = Math.floor(y / cellSize) * cellsX + Math.floor(x / cellSize);
        cellChanges[cell] += 1;
      }
    }
  }
  const diffRatio = changed / total;

  // Heat map color assignment at cell grain
  const heatRgba = new Uint8Array(total * 4);
  // Default: fully transparent
  for (let index = 3; index < heatRgba.length; index += 4) heatRgba[index] = 0;
  const hotspots: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (let cellY = 0; cellY < cellsY; cellY += 1) {
    for (let cellX = 0; cellX < cellsX; cellX += 1) {
      const cell = cellY * cellsX + cellX;
      const density = cellChanges[cell] / (cellSize * cellSize);
      if (density === 0) continue;
      let rgb: [number, number, number];
      if (density <= HEAT_GREEN_MAX) {
        rgb = [0, 200, 0];
      } else if (density <= HEAT_YELLOW_MAX) {
        rgb = [230, 200, 0];
      } else if (density > HEAT_RED_MAX) {
        rgb = [220, 0, 0];
      } else {
        continue; // between yellow and red: transparent (below report threshold)
      }
      const [r, g, b] = rgb;
      const a = 255;
      for (let dy = 0; dy < cellSize; dy += 1) {
        for (let dx = 0; dx < cellSize; dx += 1) {
          const pixelY = cellY * cellSize + dy;
          const pixelX = cellX * cellSize + dx;
          if (pixelY >= height || pixelX >= width) continue;
          const target = (pixelY * width + pixelX) * 4;
          heatRgba[target] = r;
          heatRgba[target + 1] = g;
          heatRgba[target + 2] = b;
          heatRgba[target + 3] = a;
        }
      }
      if (density > HEAT_RED_MAX) {
        hotspots.push({
          x: cellX * cellSize,
          y: cellY * cellSize,
          width: cellSize,
          height: cellSize
        });
      }
    }
  }
  const trimmed = hotspots.slice(0, HOTSPOT_MAX);
  const heatMapBase64 = encodePng(width, height, heatRgba).toString("base64");
  return { diffRatio, heatMapBase64, hotspots: trimmed };
}

// ── Scoring (frozen else-if chain) ───────────────────────────────────────────

export function scoreEvaluation(
  pixelDiffRatio: number,
  structural: { missing: string[]; extra: string[]; mismatched: SectionMismatch[] }
): EvaluationScore {
  if (
    pixelDiffRatio <= PASS_DIFF_RATIO_MAX &&
    structural.mismatched.length === 0 &&
    structural.missing.length === 0 &&
    structural.extra.length === 0
  ) {
    return "PASS";
  }
  if (
    structural.mismatched.some((mismatch) => mismatch.kind === "geometry") ||
    pixelDiffRatio > PIXEL_ONLY_BAND_MAX
  ) {
    return "LAYOUT";
  }
  if (
    structural.missing.length > 0 ||
    structural.extra.length > 0 ||
    structural.mismatched.some(
      (mismatch) => mismatch.kind === "elements" || mismatch.kind === "states"
    )
  ) {
    return "COMPONENT";
  }
  return "STYLE";
}

// ── Entry ────────────────────────────────────────────────────────────────────

export function evaluateVisuals(request: EvaluateRequest): { report: EvaluationReport } {
  const { reference, candidate, settled } = request;

  if (
    reference.record.viewport.width !== candidate.record.viewport.width ||
    reference.record.viewport.height !== candidate.record.viewport.height
  ) {
    throw new EvaluationError("viewport mismatch between reference and candidate");
  }
  if (
    reference.analysis.inputSource.trim().length === 0 ||
    candidate.analysis.inputSource.trim().length === 0
  ) {
    throw new EvaluationError("analysis.inputSource must be non-empty on both sides");
  }

  const warnings: string[] = [];
  if (settled === "timeout") {
    warnings.push(
      "candidate screenshot may be semi-stable (settled=timeout); diff annotated, not reshot"
    );
  }
  warnings.push(...reference.analysis.warnings, ...candidate.analysis.warnings);

  const structural = diffSections(
    reference.specification,
    candidate.specification,
    reference.knownGapSections
  );
  const pixel = pixelDiff(reference.base64, candidate.base64);

  // The structural diff already routes known-gap sections into gapAttributed
  // (NOT into mismatched/missing/extra) — those ids are the report's
  // attributableToKnownGap list, and scoring runs on the regression-only set.
  const knownGapHits = structural.gapAttributed;
  if (knownGapHits.length > 0) {
    warnings.push(
      `known component gaps explained diffs in ${knownGapHits.length} section(s)`
    );
  }

  const score = scoreEvaluation(pixel.diffRatio, structural);

  const heatMapBase64 = pixel.heatMapBase64
    ? redactCredentialShapedText(pixel.heatMapBase64)
    : null;

  return {
    report: {
      referenceSource: reference.record.source,
      candidateSource: candidate.record.source,
      evaluatedAt: new Date().toISOString(),
      viewport: {
        width: reference.record.viewport.width,
        height: reference.record.viewport.height
      },
      structural: {
        sectionsTotal: reference.specification.page.sections.length,
        missing: structural.missing,
        extra: structural.extra,
        mismatched: structural.mismatched
      },
      pixel: { ...pixel, heatMapBase64 },
      score,
      warnings: warnings.map((warning) => redactCredentialShapedText(warning)),
      attributableToKnownGap: knownGapHits
    }
  };
}

// ── Markdown export (5.6-1 conventions) ──────────────────────────────────────

/** Pure markdown serialization; deterministic; every line redacted. */
export function serializeVisualEvaluationReportMd(report: EvaluationReport): string {
  const lines: string[] = [];
  lines.push("# Visual Evaluation Report");
  lines.push("");
  lines.push(`- reference: ${report.referenceSource}`);
  lines.push(`- candidate: ${report.candidateSource}`);
  lines.push(`- evaluatedAt: ${report.evaluatedAt}`);
  lines.push(
    `- viewport: ${report.viewport.width}x${report.viewport.height}`
  );
  lines.push(`- score: **${report.score}**`);
  lines.push(
    `- structural: ${report.structural.sectionsTotal} sections, ${report.structural.missing.length} missing, ${report.structural.extra.length} extra, ${report.structural.mismatched.length} mismatched`
  );
  lines.push(
    `- pixel diffRatio: ${(report.pixel.diffRatio * 100).toFixed(2)}% (hotspots: ${report.pixel.hotspots.length})`
  );
  if (report.attributableToKnownGap.length > 0) {
    lines.push(
      `- attributable to known gaps: ${report.attributableToKnownGap.join(", ")}`
    );
  }
  if (report.warnings.length > 0) {
    lines.push("- warnings:");
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return lines
    .map((line) => redactCredentialShapedText(line))
    .join("\n");
}
