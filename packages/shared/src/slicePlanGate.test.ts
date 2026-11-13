import { describe, expect, it } from "vitest";
import {
  evaluateSlicePlanGate,
  SLICE_PLAN_GATE_MAX_FINAL_SLICE_TASKS,
  SLICE_PLAN_GATE_MAX_FR_PER_SLICE,
  SLICE_PLAN_GATE_MAX_SLICES,
  type SlicePlan,
  type SlicePlanGateInput,
  type SlicePlanItem
} from "./index";

/**
 * 自治 L2（`docs/227` §2 判据 B）：关口 1 的确定性判据。
 *
 * 这个函数决定「切片计划能不能自动批准」。它的价值全部来自**保守**——
 * 任何一条判据不满足都必须落进 `unmet`，让计划回到人工手里。
 * 因此每个用例都同时钉住「该拒的拒」与「不该拒的别拒」。
 */

function slice(
  overrides: Partial<SlicePlanItem> & Pick<SlicePlanItem, "id" | "order">
): SlicePlanItem {
  const { id, order, ...rest } = overrides;
  return {
    id,
    order,
    ...rest,
    title: rest.title ?? `slice ${id}`,
    goal: rest.goal ?? `deliver ${id}`,
    frKeys: rest.frKeys ?? [`FR-${order}`],
    dependsOn: rest.dependsOn ?? [],
    involvesUi: rest.involvesUi ?? true,
    acceptanceCriteria: rest.acceptanceCriteria ?? []
  };
}

function plan(slices: SlicePlanItem[]): SlicePlan {
  return { slices, milestones: [] };
}

/** 一份四条判据全部满足的计划：两片、FR 全覆盖、依赖向后、最终切片规模小。 */
function healthyInput(overrides: Partial<SlicePlanGateInput> = {}): SlicePlanGateInput {
  return {
    plan: plan([
      slice({ id: "s1", order: 1, frKeys: ["FR-1", "FR-2"] }),
      slice({ id: "s2", order: 2, frKeys: ["FR-3"], dependsOn: ["s1"] })
    ]),
    functionalRequirementKeys: ["FR-1", "FR-2", "FR-3"],
    estimatedFinalSliceTasks: 4,
    ...overrides
  };
}

describe("evaluateSlicePlanGate (autonomy L2)", () => {
  it("passes when every criterion is satisfied", () => {
    expect(evaluateSlicePlanGate(healthyInput())).toEqual({ satisfied: true, unmet: [] });
  });

  it("criterion 1: rejects a plan that misses a functional requirement", () => {
    const result = evaluateSlicePlanGate(
      healthyInput({ functionalRequirementKeys: ["FR-1", "FR-2", "FR-3", "FR-4"] })
    );
    expect(result.satisfied).toBe(false);
    expect(result.unmet).toContain("fr-coverage");
  });

  it("criterion 1: rejects a plan that covers a functional requirement nobody declared", () => {
    const result = evaluateSlicePlanGate(
      healthyInput({ functionalRequirementKeys: ["FR-1", "FR-2"] })
    );
    expect(result.satisfied).toBe(false);
    expect(result.unmet).toContain("fr-coverage");
  });

  it("criterion 1: an empty canonical FR set is undecidable, not vacuously satisfied", () => {
    const result = evaluateSlicePlanGate(healthyInput({ functionalRequirementKeys: [] }));
    expect(result.satisfied).toBe(false);
    expect(result.unmet).toContain("fr-coverage");
  });

  it("criterion 2: rejects too many slices and oversized per-slice FR sets", () => {
    const many = plan(
      Array.from({ length: SLICE_PLAN_GATE_MAX_SLICES + 1 }, (_, index) =>
        slice({ id: `s${index + 1}`, order: index + 1, frKeys: ["FR-1"] })
      )
    );
    expect(evaluateSlicePlanGate(healthyInput({ plan: many })).unmet).toContain("slice-scope");

    const wide = plan([
      slice({
        id: "s1",
        order: 1,
        frKeys: Array.from(
          { length: SLICE_PLAN_GATE_MAX_FR_PER_SLICE + 1 },
          (_, i) => `FR-${i + 1}`
        )
      })
    ]);
    expect(
      evaluateSlicePlanGate(
        healthyInput({
          plan: wide,
          functionalRequirementKeys: Array.from(
            { length: SLICE_PLAN_GATE_MAX_FR_PER_SLICE + 1 },
            (_, i) => `FR-${i + 1}`
          )
        })
      ).unmet
    ).toContain("slice-scope");
  });

  it("criterion 3: rejects forward and dangling dependencies", () => {
    const forward = plan([
      slice({ id: "s1", order: 1, frKeys: ["FR-1"], dependsOn: ["s2"] }),
      slice({ id: "s2", order: 2, frKeys: ["FR-2", "FR-3"] })
    ]);
    expect(evaluateSlicePlanGate(healthyInput({ plan: forward })).unmet).toContain(
      "slice-dependencies"
    );

    const dangling = plan([
      slice({ id: "s1", order: 1, frKeys: ["FR-1"] }),
      slice({ id: "s2", order: 2, frKeys: ["FR-2", "FR-3"], dependsOn: ["ghost"] })
    ]);
    expect(evaluateSlicePlanGate(healthyInput({ plan: dangling })).unmet).toContain(
      "slice-dependencies"
    );

    const sameOrder = plan([
      slice({ id: "s1", order: 1, frKeys: ["FR-1"], dependsOn: ["s2"] }),
      slice({ id: "s2", order: 1, frKeys: ["FR-2", "FR-3"] })
    ]);
    expect(evaluateSlicePlanGate(healthyInput({ plan: sameOrder })).unmet).toContain(
      "slice-dependencies"
    );
  });

  it("criterion 4: rejects an oversized final slice, and honours an explicit threshold", () => {
    const tooBig = healthyInput({
      estimatedFinalSliceTasks: SLICE_PLAN_GATE_MAX_FINAL_SLICE_TASKS + 1
    });
    expect(evaluateSlicePlanGate(tooBig).unmet).toContain("final-slice-scale");

    const relaxed = evaluateSlicePlanGate({
      ...tooBig,
      maxFinalSliceTasks: SLICE_PLAN_GATE_MAX_FINAL_SLICE_TASKS + 1
    });
    expect(relaxed).toEqual({ satisfied: true, unmet: [] });
  });

  it("reports every unmet criterion at once instead of stopping at the first", () => {
    const result = evaluateSlicePlanGate({
      plan: plan([slice({ id: "s1", order: 1, frKeys: ["FR-1"], dependsOn: ["ghost"] })]),
      functionalRequirementKeys: ["FR-1", "FR-2"],
      estimatedFinalSliceTasks: SLICE_PLAN_GATE_MAX_FINAL_SLICE_TASKS + 5
    });
    expect(result.satisfied).toBe(false);
    expect(new Set(result.unmet)).toEqual(
      new Set(["fr-coverage", "slice-dependencies", "final-slice-scale"])
    );
  });
});
