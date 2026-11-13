import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE, SlicePlan } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { validateSlicePlan } from "./validateSlicePlan";

function plan(
  slices: Array<{
    id: string;
    frKeys: string[];
    order: number;
    dependsOn?: string[];
  }>
): SlicePlan {
  return {
    slices: slices.map((slice) => ({
      id: slice.id,
      title: `${slice.id} title`,
      goal: `${slice.id} goal`,
      frKeys: slice.frKeys,
      dependsOn: slice.dependsOn ?? [],
      order: slice.order,
      involvesUi: true,
      acceptanceCriteria: []
    })),
    milestones: []
  };
}

const functionalRequirements = [{ id: "FR-001" }, { id: "FR-002" }, { id: "FR-003" }];

describe("validateSlicePlan", () => {
  it("全覆盖且无虚构引用时通过", () => {
    const errors = validateSlicePlan({
      slicePlan: plan([
        { id: "SLICE-1", frKeys: ["FR-001", "FR-002"], order: 1 },
        { id: "SLICE-2", frKeys: ["FR-003"], order: 2, dependsOn: ["SLICE-1"] }
      ]),
      functionalRequirements
    });

    expect(errors).toEqual([]);
  });

  it("漏 FR 反例必红（每个 FR 至少被一个切片涵盖）", () => {
    const errors = validateSlicePlan({
      slicePlan: plan([{ id: "SLICE-1", frKeys: ["FR-001"], order: 1 }]),
      functionalRequirements
    });

    expect(errors).toContain("FR not covered by any slice: FR-002");
    expect(errors).toContain("FR not covered by any slice: FR-003");
  });

  it("虚构 FR 反例必红（切片不得引用 FR 集之外的编号）", () => {
    const errors = validateSlicePlan({
      slicePlan: plan([
        { id: "SLICE-1", frKeys: ["FR-001", "FR-999"], order: 1 },
        { id: "SLICE-2", frKeys: ["FR-002", "FR-003"], order: 2 }
      ]),
      functionalRequirements
    });

    expect(errors).toContain("Slice SLICE-1 references unknown FR: FR-999");
  });

  it("空 FR 集、重复 id/顺序、未知依赖、自依赖均报错", () => {
    const errors = validateSlicePlan({
      slicePlan: plan([
        { id: "SLICE-1", frKeys: ["FR-001"], order: 1, dependsOn: ["SLICE-9"] },
        { id: "SLICE-1", frKeys: ["FR-002"], order: 1, dependsOn: ["SLICE-1"] }
      ]),
      functionalRequirements: []
    });

    expect(errors).toContain("Requirement analysis did not provide functionalRequirements");
    expect(errors).toContain("Duplicate slice id: SLICE-1");
    expect(errors).toContain("Duplicate slice order: 1");
    expect(errors).toContain("Slice SLICE-1 depends on unknown slice: SLICE-9");
    expect(errors).toContain("Slice SLICE-1 depends on itself");
  });
});

describe("docs/268：能力面 / 命名检查 / 视觉基线缺口", () => {
  const covered = plan([
    { id: "SLICE-1", frKeys: ["FR-001", "FR-002"], order: 1 },
    { id: "SLICE-2", frKeys: ["FR-003"], order: 2, dependsOn: ["SLICE-1"] }
  ]);

  it("frontend-vue 拒绝 involvesData=true 或省略，接受显式 false", () => {
    expect(
      validateSlicePlan({
        slicePlan: covered,
        functionalRequirements,
        profile: FRONTEND_VUE_PROFILE
      })
    ).toEqual(
      expect.arrayContaining([
        "Slice SLICE-1 omits involvesData, which would open database_spec; capability profile frontend-vue does not enable database or backend work.",
        "Slice SLICE-2 omits involvesData, which would open database_spec; capability profile frontend-vue does not enable database or backend work."
      ])
    );

    const withData = {
      ...covered,
      slices: covered.slices.map((slice) => ({ ...slice, involvesData: true }))
    };
    expect(
      validateSlicePlan({
        slicePlan: withData,
        functionalRequirements,
        profile: FRONTEND_VUE_PROFILE
      })
    ).toEqual(
      expect.arrayContaining([
        "Slice SLICE-1 sets involvesData=true which is not enabled under capability profile frontend-vue."
      ])
    );

    const ready = {
      ...covered,
      visualBaselineGaps: [
        { page: "Todo List", state: "Empty", note: "No official visual baseline was provided." }
      ],
      slices: covered.slices.map((slice) => ({
        ...slice,
        involvesData: false,
        acceptanceCriteria: ["The slice flows can be verified by a named acceptance check."]
      }))
    };
    expect(
      validateSlicePlan({
        slicePlan: ready,
        functionalRequirements,
        profile: FRONTEND_VUE_PROFILE
      })
    ).toEqual([]);
  });

  it("backend-node 仍允许涉及数据层的切片（省略 involvesData）", () => {
    const withChecks = {
      ...covered,
      visualBaselineGaps: [
        { page: "Todo List", note: "No official visual baseline was provided." }
      ],
      slices: covered.slices.map((slice) => ({
        ...slice,
        acceptanceCriteria: ["A named check proves this slice is done."]
      }))
    };
    expect(
      validateSlicePlan({
        slicePlan: withChecks,
        functionalRequirements,
        profile: BACKEND_NODE_PROFILE
      })
    ).toEqual([]);
  });

  it("缺命名检查时拒绝，补上验收条目后通过", () => {
    const withDataAndGaps = {
      ...covered,
      visualBaselineGaps: [
        { page: "Todo List", note: "No official visual baseline was provided." }
      ],
      slices: covered.slices.map((slice) => ({ ...slice, involvesData: false }))
    };
    expect(
      validateSlicePlan({
        slicePlan: withDataAndGaps,
        functionalRequirements,
        profile: FRONTEND_VUE_PROFILE
      })
    ).toEqual(
      expect.arrayContaining([
        "Slice SLICE-1 has no named verification check (acceptanceCriteria is empty)."
      ])
    );
  });

  it("UI 切片在无参照图且未点明缺口时拒绝，显式缺口或已有参照图时通过", () => {
    const readySlices = {
      slices: covered.slices.map((slice) => ({
        ...slice,
        involvesData: false,
        acceptanceCriteria: ["A named check proves this slice is done."]
      })),
      milestones: []
    };
    expect(
      validateSlicePlan({
        slicePlan: readySlices,
        functionalRequirements,
        profile: FRONTEND_VUE_PROFILE
      })
    ).toContain(
      "UI-facing plan is missing official visual baselines and does not record visualBaselineGaps."
    );

    expect(
      validateSlicePlan({
        slicePlan: {
          ...readySlices,
          visualBaselineGaps: [
            { page: "Todo List", state: "Empty", note: "No official visual baseline was provided." }
          ]
        },
        functionalRequirements,
        profile: FRONTEND_VUE_PROFILE
      })
    ).toEqual([]);

    expect(
      validateSlicePlan({
        slicePlan: readySlices,
        functionalRequirements,
        profile: FRONTEND_VUE_PROFILE,
        providedUiReferences: [{ fileName: "todo-list.png" }]
      })
    ).toEqual([]);
  });

  it("全部 involvesUi=false 的切片不要求视觉基线缺口", () => {
    const backendOnly = {
      slices: covered.slices.map((slice) => ({
        ...slice,
        involvesUi: false,
        involvesData: true,
        acceptanceCriteria: ["Service endpoints return the specified records."]
      })),
      milestones: []
    };
    expect(
      validateSlicePlan({
        slicePlan: backendOnly,
        functionalRequirements,
        profile: BACKEND_NODE_PROFILE
      })
    ).toEqual([]);
  });
});
