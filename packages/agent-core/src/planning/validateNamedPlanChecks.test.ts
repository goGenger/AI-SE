import { describe, expect, it } from "vitest";
import { validateNamedPlanChecks } from "./validateNamedPlanChecks";

describe("validateNamedPlanChecks", () => {
  it("rejects slices or tasks that have no named verification check", () => {
    expect(
      validateNamedPlanChecks({
        items: [
          { id: "SLICE-1", acceptanceCriteria: [] },
          { id: "SLICE-2" },
          { id: "SLICE-3", acceptanceCriteria: ["   "] }
        ],
        kind: "slice"
      })
    ).toEqual([
      "Slice SLICE-1 has no named verification check (acceptanceCriteria is empty).",
      "Slice SLICE-2 has no named verification check (acceptanceCriteria is empty).",
      "Slice SLICE-3 has no named verification check (acceptanceCriteria is empty)."
    ]);

    expect(
      validateNamedPlanChecks({
        items: [{ id: "T1", acceptanceCriteria: [] }],
        kind: "task"
      })
    ).toEqual(["Task T1 has no named verification check (acceptanceCriteria is empty)."]);
  });

  it("accepts items that name a check", () => {
    expect(
      validateNamedPlanChecks({
        items: [
          { id: "SLICE-1", acceptanceCriteria: ["The list page renders the empty and ready states."] },
          { id: "T1", acceptanceCriteria: ["Official slice-end E2E covers AC-01."] }
        ],
        kind: "task"
      })
    ).toEqual([]);
  });
});
