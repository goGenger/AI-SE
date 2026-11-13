import { describe, expect, it } from "vitest";
import {
  MISSING_VISUAL_BASELINES_CLAUSE,
  PROVIDED_UI_REFERENCES_CLAUSE
} from "./provided-documents.prompt";

describe("PROVIDED_UI_REFERENCES_CLAUSE (docs/265)", () => {
  it("treats attached UI images as official design-intent baselines, not optional rough mockups or pixel specs", () => {
    expect(PROVIDED_UI_REFERENCES_CLAUSE).toMatch(/official visual baselines/i);
    expect(PROVIDED_UI_REFERENCES_CLAUSE).toMatch(/design-intent/i);
    expect(PROVIDED_UI_REFERENCES_CLAUSE).toMatch(/not pixel-perfect/i);
    expect(PROVIDED_UI_REFERENCES_CLAUSE).not.toMatch(/rough mockups/i);
  });
});

describe("MISSING_VISUAL_BASELINES_CLAUSE (docs/268)", () => {
  it("requires recording visualBaselineGaps when official baselines are missing, without refusing to plan", () => {
    expect(MISSING_VISUAL_BASELINES_CLAUSE).toContain("visualBaselineGaps");
    expect(MISSING_VISUAL_BASELINES_CLAUSE).toMatch(/recording the gap is valid and required/i);
    expect(MISSING_VISUAL_BASELINES_CLAUSE).toMatch(/do not refuse to produce the plan/i);
    expect(MISSING_VISUAL_BASELINES_CLAUSE).toMatch(
      /do not plan as if those baselines already exist/i
    );
  });
});
