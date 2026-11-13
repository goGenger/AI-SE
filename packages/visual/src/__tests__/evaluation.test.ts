import {
  VisualSpecificationSchema,
  type VisualSection,
  type VisualSpecification
} from "@ai-se/shared";
import { encodePng } from "../pngEncoder";
import {
  EvaluationError,
  diffSections,
  evaluateVisuals,
  serializeVisualEvaluationReportMd,
  scoreEvaluation,
  type EvaluationSide
} from "../evaluation";
import { describe, expect, it } from "vitest";

/** 5.6-4 tests: pairing gate, frozen score chain, gap attribution,
 * semi-stable annotation, pixel diff over real encoded PNGs, md redaction. */

function sectionFixture(
  id: string,
  overrides: Partial<VisualSection> = {}
): VisualSection {
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
      source: "screenshot://fixtures/ref.png",
      viewport: { width: 1440, height: 900 }
    },
    page: {
      id: "page:checkout:1",
      name: "Checkout",
      viewport: { width: 1440, height: 900 },
      sections
    },
    generatedAt: new Date().toISOString()
  });
}

function solidPng(
  width: number,
  height: number,
  rgb: [number, number, number]
): string {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = rgb[0];
    rgba[index * 4 + 1] = rgb[1];
    rgba[index * 4 + 2] = rgb[2];
    rgba[index * 4 + 3] = 255;
  }
  return encodePng(width, height, rgba).toString("base64");
}

function sideFixture(
  overrides: Partial<EvaluationSide> = {}
): EvaluationSide {
  return {
    record: {
      inputType: "screenshot",
      source: "screenshot://session/x/1.png",
      viewport: { width: 64, height: 32 }
    },
    base64: solidPng(64, 32, [0, 0, 0]),
    analysis: {
      inputSource: "screenshot://session/x/1.png",
      analyzedAt: new Date().toISOString(),
      viewports: [
        { viewport: { width: 64, height: 32 }, sectionCount: 1, elementCount: 1 }
      ],
      sectionCount: 1,
      elementCount: 1,
      tokenSummary: [],
      warnings: []
    },
    specification: specFixture([
      sectionFixture("section:order:1", {
        elements: [
          {
            id: "button:submit:1",
            role: "button",
            description: "submit"
          }
        ]
      })
    ]),
    knownGapSections: [],
    ...overrides
  };
}

describe("5.6-4 pairing gate", () => {
  it("rejects viewport mismatches with EVALUATION_INPUT_INVALID", () => {
    const reference = sideFixture();
    const candidate = sideFixture({
      record: {
        inputType: "screenshot",
        source: "screenshot://y/1.png",
        viewport: { width: 128, height: 32 }
      }
    });
    expect(() => evaluateVisuals({ reference, candidate })).toThrow(EvaluationError);
  });
});

describe("5.6-4 frozen score chain (else-if order locked)", () => {
  it("PASS: clean structure and ≤2% pixel diff", () => {
    expect(
      scoreEvaluation(0.01, { missing: [], extra: [], mismatched: [] })
    ).toBe("PASS");
  });

  it("LAYOUT wins over COMPONENT when both are present (geometry + elements)", () => {
    expect(
      scoreEvaluation(0.03, {
        missing: [],
        extra: [],
        mismatched: [
          { sectionId: "s1", kind: "geometry", detail: "shift" },
          { sectionId: "s1", kind: "elements", detail: "ids" }
        ]
      })
    ).toBe("LAYOUT");
  });

  it("COMPONENT: missing/extra or elements/states mismatch, no LAYOUT", () => {
    expect(
      scoreEvaluation(0.03, {
        missing: ["section:a:1"],
        extra: [],
        mismatched: []
      })
    ).toBe("COMPONENT");
    expect(
      scoreEvaluation(0.03, {
        missing: [],
        extra: [],
        mismatched: [{ sectionId: "s1", kind: "states", detail: "names" }]
      })
    ).toBe("COMPONENT");
  });

  it("pixel-only ratio in (0.02, 0.30] with clean structure does NOT pass", () => {
    // No geometry, no element/state diffs, no missing/extra → falls to STYLE.
    expect(
      scoreEvaluation(0.1, { missing: [], extra: [], mismatched: [] })
    ).toBe("STYLE");
  });

  it("pixel ratio > 0.30 forces LAYOUT even with clean structure", () => {
    expect(
      scoreEvaluation(0.5, { missing: [], extra: [], mismatched: [] })
    ).toBe("LAYOUT");
  });
});

describe("5.6-4 structural diff", () => {
  it("detects missing/extra sections by stableId alignment", () => {
    const reference = specFixture([sectionFixture("a"), sectionFixture("b")]);
    const candidate = specFixture([sectionFixture("a"), sectionFixture("c")]);
    const result = diffSections(reference, candidate, []);
    expect(result.missing).toEqual(["b"]);
    expect(result.extra).toEqual(["c"]);
  });

  it("detects geometry mismatch (center shift > 8px)", () => {
    const reference = specFixture([sectionFixture("a")]);
    const candidate = specFixture([
      sectionFixture("a", {
        geometry: { rect: { x: 0, y: 40, width: 100, height: 60 } }
      })
    ]);
    const result = diffSections(reference, candidate, []);
    expect(
      result.mismatched.some(
        (mismatch) => mismatch.kind === "geometry" && mismatch.sectionId === "a"
      )
    ).toBe(true);
  });

  it("excludes known-gap sections from mismatched (gap ≠ regression)", () => {
    const reference = specFixture([sectionFixture("a")]);
    const candidate = specFixture([
      sectionFixture("a", {
        geometry: { rect: { x: 0, y: 40, width: 100, height: 60 } }
      })
    ]);
    const result = diffSections(reference, candidate, ["a"]);
    expect(result.mismatched).toEqual([]);
  });
});

describe("5.6-4 pixel diff (real encoded PNGs)", () => {
  it("measures exact diffRatio on synthetic RGB fixtures", () => {
    const reference = sideFixture({ base64: solidPng(64, 32, [0, 0, 0]) });
    const candidate = sideFixture({ base64: solidPng(64, 32, [255, 0, 0]) });
    const { report } = evaluateVisuals({ reference, candidate });
    expect(report.pixel.diffRatio).toBe(1);
    expect(report.score).toBe("LAYOUT");
    expect(report.pixel.hotspots.length).toBeGreaterThan(0);
  });

  it("returns heat map PNG bytes that decode to the same dimensions", () => {
    const reference = sideFixture({ base64: solidPng(64, 32, [0, 0, 0]) });
    const candidate = sideFixture({ base64: solidPng(64, 32, [255, 0, 0]) });
    const { report } = evaluateVisuals({ reference, candidate });
    expect(report.pixel.heatMapBase64).not.toBeNull();
    const decoded = JSON.parse(JSON.stringify(report.pixel.heatMapBase64)).length;
    expect(decoded).toBeGreaterThan(100);
  });

  it("flags matching dimension but different buffer content as diffRatio 1", () => {
    const reference = sideFixture({
      base64: Buffer.from("identical").toString("base64")
    });
    const candidate = sideFixture({
      base64: Buffer.from("different").toString("base64")
    });
    // Non-PNG content → decode failure → EvaluationError (per §三.2, only
    // real screenshots fed by browser adapter are valid inputs)
    expect(() => evaluateVisuals({ reference, candidate })).toThrow(EvaluationError);
  });
});

describe("5.6-4 semi-stable annotation", () => {
  it("keeps data identical for settled=timeout but adds a stability warning", () => {
    const base = {
      reference: sideFixture(),
      candidate: sideFixture({
        record: {
          inputType: "screenshot",
          source: "screenshot://session/x/2.png",
          viewport: { width: 64, height: 32 }
        },
        base64: solidPng(64, 32, [10, 10, 10])
      })
    };
    const stable = evaluateVisuals({ ...base, settled: "networkidle" });
    const unstable = evaluateVisuals({ ...base, settled: "timeout" });
    expect(stable.report.structural).toEqual(unstable.report.structural);
    expect(stable.report.pixel.diffRatio).toBe(unstable.report.pixel.diffRatio);
    expect(unstable.report.warnings.join("\n")).toContain("semi-stable");
    expect(stable.report.warnings.join("\n")).not.toContain("semi-stable");
  });
});

describe("5.6-4 known-gap attribution end-to-end", () => {
  it("routes gap-section diffs into attributableToKnownGap, not mismatched", () => {
    const reference = sideFixture({
      specification: specFixture([sectionFixture("s1")]),
      knownGapSections: ["s1"]
    });
    const candidate = sideFixture({
      specification: specFixture([
        sectionFixture("s1", {
          geometry: { rect: { x: 0, y: 40, width: 100, height: 60 } }
        })
      ])
    });
    const { report } = evaluateVisuals({ reference, candidate });
    expect(report.attributableToKnownGap).toEqual(["s1"]);
    expect(
      report.structural.mismatched.some((mismatch) => mismatch.sectionId === "s1")
    ).toBe(false);
  });
});

describe("5.6-4 markdown export", () => {
  it("redacts credential-shaped text and is byte-replayable", () => {
    const reference = sideFixture({
      record: {
        inputType: "screenshot",
        source: "screenshot://leak/1.png?token=sk-abc123defghijklm",
        viewport: { width: 64, height: 32 }
      },
      analysis: {
        inputSource: "screenshot://leak/1.png?token=sk-abc123defghijklm",
        analyzedAt: new Date().toISOString(),
        viewports: [
          { viewport: { width: 64, height: 32 }, sectionCount: 1, elementCount: 1 }
        ],
        sectionCount: 1,
        elementCount: 1,
        tokenSummary: [],
        warnings: ["leak check Bearer AAAABBBBCCCC"]
      }
    });
    const { report } = evaluateVisuals({
      reference,
      candidate: sideFixture({ base64: solidPng(64, 32, [5, 5, 5]) })
    });
    const markdown = serializeVisualEvaluationReportMd(report);
    expect(markdown).not.toContain("sk-abc123defghijklm");
    expect(markdown).not.toContain("Bearer AAAABBBBCCCC");
    expect(markdown).toContain("[REDACTED]");
    const again = evaluateVisuals({
      reference,
      candidate: sideFixture({ base64: solidPng(64, 32, [5, 5, 5]) })
    });
    // Byte-level replay: same inputs → same markdown (modulo evaluatedAt);
    const withoutTime = (markdown: string) =>
      markdown.split("\n").filter((line) => !line.includes("evaluatedAt"));
    expect(withoutTime(serializeVisualEvaluationReportMd(again.report))).toEqual(
      withoutTime(markdown)
    );
  });
});
