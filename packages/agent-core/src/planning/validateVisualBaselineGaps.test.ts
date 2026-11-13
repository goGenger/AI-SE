import { describe, expect, it } from "vitest";
import {
  MISSING_VISUAL_BASELINE_GAP_ERROR,
  mergeVisualBaselineGaps,
  validateVisualBaselineGaps
} from "./validateVisualBaselineGaps";

describe("validateVisualBaselineGaps", () => {
  it("does not require a gap record when the work is not UI-facing", () => {
    expect(
      validateVisualBaselineGaps({
        uiFacing: false,
        providedUiReferences: [],
        gaps: []
      })
    ).toEqual([]);
  });

  it("rejects a silent skip when UI work has no baselines and no gap record", () => {
    expect(
      validateVisualBaselineGaps({
        uiFacing: true,
        providedUiReferences: [],
        gaps: []
      })
    ).toEqual([MISSING_VISUAL_BASELINE_GAP_ERROR]);
    expect(
      validateVisualBaselineGaps({
        uiFacing: true
      })
    ).toEqual([MISSING_VISUAL_BASELINE_GAP_ERROR]);
  });

  it("accepts an explicit gap record when baselines are missing", () => {
    expect(
      validateVisualBaselineGaps({
        uiFacing: true,
        providedUiReferences: [],
        gaps: [
          { page: "Settings", state: "Empty", note: "No official visual baseline was provided." }
        ]
      })
    ).toEqual([]);
  });

  it("accepts UI work when official references are already attached", () => {
    expect(
      validateVisualBaselineGaps({
        uiFacing: true,
        providedUiReferences: [{ fileName: "settings.png" }],
        gaps: []
      })
    ).toEqual([]);
  });

  it("merges gap lists from analysis and the slice plan", () => {
    expect(
      mergeVisualBaselineGaps(
        { visualBaselineGaps: [{ page: "A", note: "Missing." }] },
        { visualBaselineGaps: [{ page: "B", state: "Empty", note: "Missing." }] },
        undefined
      )
    ).toEqual([
      { page: "A", note: "Missing." },
      { page: "B", state: "Empty", note: "Missing." }
    ]);
  });
});
