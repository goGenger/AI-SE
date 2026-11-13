import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { validatePlannableTaskTypes } from "./validatePlannableTaskTypes";

describe("validatePlannableTaskTypes", () => {
  it("accepts backend-node Todo-shaped plan types when profile is explicit", () => {
    expect(
      validatePlannableTaskTypes({
        profile: BACKEND_NODE_PROFILE,
        tasks: [
          { id: "T1", type: "DESIGN" },
          { id: "T2", type: "DATABASE" },
          { id: "T3", type: "BACKEND" },
          { id: "T4", type: "FRONTEND" },
          { id: "T5", type: "TEST" },
          { id: "T6", type: "REVIEW" }
        ]
      })
    ).toEqual([]);
  });

  it("rejects DATABASE / BACKEND under frontend-vue (l1-rv1 failure class)", () => {
    const errors = validatePlannableTaskTypes({
      profile: FRONTEND_VUE_PROFILE,
      tasks: [
        { id: "T1", type: "DESIGN" },
        { id: "T2", type: "DATABASE" },
        { id: "T3", type: "BACKEND" },
        { id: "T4", type: "FRONTEND" }
      ]
    });
    expect(errors).toEqual([
      "Task T2 has type DATABASE which is not plannable under capability profile frontend-vue.",
      "Task T3 has type BACKEND which is not plannable under capability profile frontend-vue."
    ]);
  });

  it("defaults to frontend-vue when profile omitted (BACKEND/DATABASE not plannable)", () => {
    expect(
      validatePlannableTaskTypes({
        tasks: [
          { id: "T1", type: "FRONTEND" },
          { id: "T2", type: "DATABASE" },
          { id: "T3", type: "BACKEND" }
        ]
      })
    ).toEqual([
      "Task T2 has type DATABASE which is not plannable under capability profile frontend-vue.",
      "Task T3 has type BACKEND which is not plannable under capability profile frontend-vue."
    ]);
  });
});
