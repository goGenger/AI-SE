import { describe, expect, it } from "vitest";
import { validateAcceptanceCoverage } from "./validateAcceptanceCoverage";

const criteria = [
  {
    acKey: "AC-01",
    text: "a",
    priority: "Must" as const,
    verification: null,
    smoke: false,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-02",
    text: "b",
    priority: "Must" as const,
    verification: null,
    smoke: false,
    frKeys: ["FR-1"]
  },
  {
    acKey: "AC-09",
    text: "c",
    priority: "Must" as const,
    verification: null,
    smoke: false,
    frKeys: ["FR-2"]
  }
];

describe("validateAcceptanceCoverage（N3 确定性映射覆盖检查）", () => {
  it("每个 AC 至少一个任务映射 → 通过", () => {
    expect(
      validateAcceptanceCoverage({
        criteria,
        tasks: [
          { id: "T1", acKeys: ["AC-01", "AC-02"] },
          { id: "T2", acKeys: ["AC-09"] }
        ]
      })
    ).toEqual([]);
  });

  it("漏映射一条 AC → 必红（反例）", () => {
    const errors = validateAcceptanceCoverage({
      criteria,
      tasks: [
        { id: "T1", acKeys: ["AC-01"] },
        { id: "T2", acKeys: ["AC-09"] }
      ]
    });

    expect(errors).toEqual(["AC not covered by any task: AC-02"]);
  });

  it("任务引用不存在的 AC 编号 → 报错（无虚构）", () => {
    const errors = validateAcceptanceCoverage({
      criteria,
      tasks: [{ id: "T1", acKeys: ["AC-01", "AC-02", "AC-09", "AC-99"] }]
    });

    expect(errors).toContain("Task T1 references unknown AC: AC-99");
  });

  it("按切片 FR 范围收窄覆盖要求", () => {
    expect(
      validateAcceptanceCoverage({
        criteria,
        frKeys: ["FR-1"],
        tasks: [{ id: "T1", acKeys: ["AC-01", "AC-02"] }]
      })
    ).toEqual([]);
  });

  it("无 AC 记录（无编号 PRD）→ 跳过检查", () => {
    expect(
      validateAcceptanceCoverage({
        criteria: [],
        tasks: [{ id: "T1" }]
      })
    ).toEqual([]);
  });
});
