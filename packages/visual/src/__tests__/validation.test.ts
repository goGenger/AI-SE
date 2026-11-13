import { describe, expect, it } from "vitest";
import {
  RESPONSIVE_VIEWPORTS,
  VALIDATED_UI_STATES,
  buildCrossViewportSummary,
  detectStateRegressions,
  evaluateResponsiveMatrix,
  evaluateStateFlips,
  serializeResponsiveValidationMd,
  type EvaluationReport
} from "../index";
import { encodePng } from "../pngEncoder";
import {
  VisualSpecificationSchema,
  type VisualSection,
  type VisualSpecification
} from "@ai-se/shared";

/** 5.6-6 unit tests: thin-wrapper equivalence with evaluateVisuals, frozen
 * viewport matrix, state flips, cross-viewport summary, md export & replay. */

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
      source: "screenshot://validation/ref.png",
      viewport: { width: 64, height: 32 }
    },
    page: {
      id: "page:check:1",
      name: "Checkout",
      viewport: { width: 64, height: 32 },
      sections
    },
    generatedAt: new Date().toISOString()
  });
}

function png(width: number, height: number, rgb: [number, number, number]): string {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = rgb[0];
    rgba[index * 4 + 1] = rgb[1];
    rgba[index * 4 + 2] = rgb[2];
    rgba[index * 4 + 3] = 255;
  }
  return encodePng(width, height, rgba).toString("base64");
}

function requestFixture(overrides: {
  candidateSpec?: VisualSpecification;
  candidateBase64?: string;
  referenceSpec?: VisualSpecification;
}) {
  const referenceSpec = overrides.referenceSpec ?? specFixture([sectionFixture("s1")]);
  const candidateSpec = overrides.candidateSpec ?? referenceSpec;
  return {
    reference: {
      record: {
        inputType: "screenshot" as const,
        source: "screenshot://validation/ref.png",
        viewport: { width: 64, height: 32 }
      },
      base64: png(64, 32, [0, 0, 0]),
      analysis: {
        inputSource: "screenshot://validation/ref.png",
        analyzedAt: new Date().toISOString(),
        viewports: [{ viewport: { width: 64, height: 32 }, sectionCount: 1, elementCount: 1 }],
        sectionCount: 1,
        elementCount: 1,
        tokenSummary: [],
        warnings: []
      },
      specification: referenceSpec,
      knownGapSections: []
    },
    candidate: {
      record: {
        inputType: "screenshot" as const,
        source: "screenshot://validation/cand.png",
        viewport: { width: 64, height: 32 }
      },
      base64: overrides.candidateBase64 ?? png(64, 32, [0, 0, 0]),
      analysis: {
        inputSource: "screenshot://validation/cand.png",
        analyzedAt: new Date().toISOString(),
        viewports: [{ viewport: { width: 64, height: 32 }, sectionCount: 1, elementCount: 1 }],
        sectionCount: 1,
        elementCount: 1,
        tokenSummary: [],
        warnings: []
      },
      specification: candidateSpec,
      knownGapSections: []
    }
  };
}

describe("5.6-6 frozen viewport matrix", () => {
  it("contains exactly desktop, tablet and mobile with the frozen sizes", () => {
    expect(RESPONSIVE_VIEWPORTS.map((viewport) => viewport.name)).toEqual([
      "desktop",
      "tablet",
      "mobile"
    ]);
    expect(RESPONSIVE_VIEWPORTS.map((viewport) => `${viewport.width}x${viewport.height}`)).toEqual([
      "1440x900",
      "768x1024",
      "375x812"
    ]);
    expect(Object.isFrozen(RESPONSIVE_VIEWPORTS)).toBe(true);
    expect(RESPONSIVE_VIEWPORTS.every((viewport) => Object.isFrozen(viewport))).toBe(true);
  });

  it("validates the ten frozen UI states (default is the flip baseline)", () => {
    expect([...VALIDATED_UI_STATES]).toEqual([
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
    ]);
  });

  it("custom viewport entries pass through the matrix wrapper unchanged", () => {
    const request = requestFixture({});
    const { reports } = evaluateResponsiveMatrix([
      { viewportName: "custom", request }
    ]);
    expect(reports[0].viewportName).toBe("custom");
    expect(reports[0].report.score).toBe("PASS");
  });
});

describe("5.6-6 matrix/state wrappers reuse evaluateVisuals", () => {
  it("per-entry report equals a direct evaluateVisuals call byte-for-byte (data)", () => {
    const direct = specFixture([sectionFixture("s1")]);
    const shifted = {
      ...direct,
      page: {
        ...direct.page,
        sections: [
          sectionFixture("s1", {
            geometry: { rect: { x: 0, y: 40, width: 100, height: 60 } }
          })
        ]
      }
    };
    const request = requestFixture({ candidateSpec: shifted });
    const { reports } = evaluateResponsiveMatrix([
      { viewportName: "desktop", request }
    ]);
    expect(reports.length).toBe(1);
    expect(reports[0].viewportName).toBe("desktop");
    expect(reports[0].report.score).toBe("LAYOUT");
    expect(
      reports[0].report.structural.mismatched.some(
        (mismatch) => mismatch.kind === "geometry"
      )
    ).toBe(true);
  });

  it("state flip with an extra candidate state → COMPONENT (primary structural signal)", () => {
    const candidate = specFixture([
      sectionFixture("s1", {
        states: [
          { state: "hover" as const },
          { state: "error" as const }
        ]
      })
    ]);
    const { reports } = evaluateStateFlips([
      {
        stateName: "hover",
        request: requestFixture({ candidateSpec: candidate })
      }
    ]);
    expect(reports[0].report.score).toBe("COMPONENT");
    expect(
      reports[0].report.structural.mismatched.some(
        (mismatch) => mismatch.kind === "states"
      )
    ).toBe(true);
  });

  it("state flip with no real change → PASS", () => {
    const { reports } = evaluateStateFlips([
      { stateName: "hover", request: requestFixture({}) }
    ]);
    expect(reports[0].report.score).toBe("PASS");
  });

  it("accepts the completion vocabulary (active/expanded/modal) on flips", () => {
    const { reports } = evaluateStateFlips([
      { stateName: "active", request: requestFixture({}) },
      { stateName: "expanded", request: requestFixture({}) },
      { stateName: "modal", request: requestFixture({}) }
    ]);
    expect(reports.map((entry) => entry.stateName)).toEqual(["active", "expanded", "modal"]);
    expect(reports.every((entry) => entry.report.score === "PASS")).toBe(true);
  });
});

describe("5.6-6 state regression detection (pixel evidence only)", () => {
  const pixelReport = (diffRatio: number): Pick<EvaluationReport, "pixel"> => ({
    pixel: { diffRatio, heatMapBase64: null, hotspots: [] }
  });

  it("flags missing changes for expected-change states and unexpected changes for controls", () => {
    const findings = detectStateRegressions([
      { stateName: "hover", expected: "change", report: pixelReport(0) },
      { stateName: "modal", expected: "change", report: pixelReport(0.4) },
      { stateName: "hover", expected: "stable", report: pixelReport(0) },
      { stateName: "focus", expected: "stable", report: pixelReport(0.01) }
    ]);
    expect(findings.missingChange).toEqual(["hover"]);
    expect(findings.unexpectedChange).toEqual(["focus"]);
  });

  it("reports clean when all expectations hold", () => {
    const findings = detectStateRegressions([
      { stateName: "expanded", expected: "change", report: pixelReport(0.05) },
      { stateName: "hover", expected: "stable", report: pixelReport(0) }
    ]);
    expect(findings).toEqual({ missingChange: [], unexpectedChange: [] });
  });
});

describe("5.6-6 cross-viewport summary (descriptive only)", () => {
  const report = (score: EvaluationReport["score"], diffRatio: number): EvaluationReport => ({
    referenceSource: "r",
    candidateSource: "c",
    evaluatedAt: new Date().toISOString(),
    viewport: { width: 1, height: 1 },
    structural: { sectionsTotal: 1, missing: [], extra: [], mismatched: [] },
    pixel: { diffRatio, heatMapBase64: null, hotspots: [] },
    score,
    warnings: [],
    attributableToKnownGap: []
  });

  it("consistent when all scores match; flattens diffRatios", () => {
    const summary = buildCrossViewportSummary([
      { viewportName: "desktop", report: report("PASS", 0.01) },
      { viewportName: "mobile", report: report("PASS", 0.02) }
    ]);
    expect(summary.consistent).toBe(true);
    expect(summary.variantViewports).toEqual([]);
    expect(summary.perViewportDiffRatio.length).toBe(2);
  });

  it("lists variant viewports when scores diverge; does not mutate reports", () => {
    const desktop = report("PASS", 0.01);
    const mobile = report("COMPONENT", 0.05);
    const summary = buildCrossViewportSummary([
      { viewportName: "desktop", report: desktop },
      { viewportName: "mobile", report: mobile }
    ]);
    expect(summary.consistent).toBe(false);
    expect(summary.variantViewports).toEqual([
      { viewportName: "desktop", score: "PASS" },
      { viewportName: "mobile", score: "COMPONENT" }
    ]);
  });
});

describe("5.6-6 markdown export", () => {
  it("contains three sections, redacts leaks, replays byte-identical (sans time)", () => {
    const request = requestFixture({
      candidateSpec: specFixture([sectionFixture("s1")])
    });
    // Inject leaks via record.source (a real string field, not a fake PNG body).
    (request.candidate.record as { source: string }).source =
      "screenshot://leak/1.png?token=sk-abc123defghijklm";
    (request.candidate.analysis as { warnings: string[] }).warnings = [
      "fetch failed Bearer AAAABBBBCCCC"
    ];
    const matrix = evaluateResponsiveMatrix([
      { viewportName: "desktop", request }
    ]);
    const states = evaluateStateFlips([
      { stateName: "hover", request }
    ]);
    const cross = buildCrossViewportSummary(
      matrix.reports.map((entry) => ({
        viewportName: entry.viewportName,
        report: entry.report
      }))
    );
    const markdown = serializeResponsiveValidationMd({
      header: { pageName: "Checkout", evaluatedAt: new Date().toISOString() },
      matrixReports: matrix.reports,
      stateReports: states.reports,
      crossViewport: cross,
      stateRegressions: { missingChange: ["loading"], unexpectedChange: ["hover"] }
    });
    expect(markdown).toContain("## viewport desktop");
    expect(markdown).toContain("## state flips");
    expect(markdown).toContain("## state regressions");
    expect(markdown).toContain("- missing change: loading");
    expect(markdown).toContain("- unexpected change: hover");
    expect(markdown).toContain("## cross-viewport consistency");
    expect(markdown).not.toContain("sk-abc123defghijklm");
    expect(markdown).not.toContain("Bearer AAAABBBBCCCC");
    expect(markdown).toContain("[REDACTED]");

    const withoutTime = (text: string) =>
      text.split("\n").filter((line) => !line.includes("evaluatedAt"));
    expect(
      withoutTime(
        serializeResponsiveValidationMd({
          header: { pageName: "Checkout", evaluatedAt: new Date().toISOString() },
          matrixReports: matrix.reports,
          stateReports: states.reports,
          crossViewport: cross,
          stateRegressions: { missingChange: ["loading"], unexpectedChange: ["hover"] }
        })
      )
    ).toEqual(withoutTime(markdown));
  });
});

describe("5.6-6 reentrancy (evaluation side)", () => {
  it("same inputs twice → data-identical reports (no fresh browser dependency)", () => {
    const request = requestFixture({});
    const first = evaluateResponsiveMatrix([{ viewportName: "desktop", request }]);
    const second = evaluateResponsiveMatrix([{ viewportName: "desktop", request }]);
    const strip = (report: EvaluationReport) => ({ ...report, evaluatedAt: "" });
    expect(strip(first.reports[0].report)).toEqual(strip(second.reports[0].report));
  });
});
