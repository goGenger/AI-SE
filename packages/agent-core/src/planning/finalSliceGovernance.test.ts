import { AcceptanceCriterion, TaskPlan, TaskPlanItem } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  isGlobalAcceptanceCriterion,
  selectAcceptanceCriteriaForSlice
} from "./acceptanceCriteria";
import { finalSliceOverloadError, measureFinalSliceScale } from "./finalSliceScale";
import { taskPlanningPrompt } from "./prompts/task-planning.prompt";
import { validateTaskGraph } from "./validateTaskGraph";

/**
 * F1-4（发现⑤）：全局性 AC 归属规则的单元面。
 * - FX-13(a)：非最终切片挂全局性 AC → GLOBAL_AC_OUTSIDE_FINAL_SLICE（代码校验）；
 * - FX-14a：旧计划回放——E1 形态的 slice-1 计划（工程任务携带 AC-30）被校验器拒绝（只证拒绝）；
 * - FX-15(a)/(c)：最终切片规模度量与 enforce 超限错误（阈值缺省 = observe 不判失败）；
 * - 提示词变体：非最终切片不得以交付链收尾。
 */

const e1StyleCriteria: AcceptanceCriterion[] = [
  {
    acKey: "AC-04",
    text: "注册后扫描 DATA_DIR 数据文件，不含测试用明文密码",
    priority: "Must",
    verification: "文件扫描",
    smoke: false,
    frKeys: ["FR-7"]
  },
  {
    acKey: "AC-24",
    text: "docker build 成功；docker run 后健康端点可达",
    priority: "Must",
    verification: "容器运行",
    smoke: false,
    frKeys: ["FR-8"]
  },
  {
    acKey: "AC-30",
    text: "README 命令可执行；pnpm test 全绿；测试名含 AC 编号",
    priority: "Must",
    verification: "命令执行 + 测试名解析",
    smoke: false,
    frKeys: ["FR-9"]
  },
  {
    acKey: "AC-21",
    text: "首页返回 200 HTML 且包含 4 个约定 data-testid",
    priority: "Must",
    verification: "HTML 断言",
    smoke: true,
    frKeys: ["FR-8"]
  }
];

function task(partial: Partial<TaskPlanItem> & Pick<TaskPlanItem, "id" | "type">): TaskPlanItem {
  return {
    title: `Task ${partial.id}`,
    description: `Description for ${partial.id}`,
    priority: "MEDIUM",
    dependencies: [],
    estimatedComplexity: 2,
    acceptanceCriteria: [`${partial.id} acceptance`],
    sourceSpecTypes: ["FUNCTIONAL"],
    ...partial
  } as TaskPlanItem;
}

describe("F1-4 全局性 AC 判定（isGlobalAcceptanceCriterion）", () => {
  it("E1 实例：容器运行/容器检查/日志扫描/命令执行+测试名解析 → 全局性；HTTP/文件扫描/HTML/浏览器 → 非全局", () => {
    const global = ["容器运行", "容器检查", "日志扫描", "命令执行 + 测试名解析", "Deploy", "DOC"];
    const nonGlobal = [
      "HTTP 断言",
      "并发 HTTP 断言",
      "边界断言",
      "文件扫描",
      "HTML 断言",
      "浏览器（可选）",
      null,
      ""
    ];
    for (const verification of global) {
      expect(isGlobalAcceptanceCriterion({ verification })).toBe(true);
    }
    for (const verification of nonGlobal) {
      expect(isGlobalAcceptanceCriterion({ verification })).toBe(false);
    }
  });
});

describe("F1-4 切片范围选择（selectAcceptanceCriteriaForSlice）", () => {
  it("非最终切片剔除全局性 AC；最终切片并入全部全局性 AC；undefined 维持既有行为", () => {
    const nonFinal = selectAcceptanceCriteriaForSlice(e1StyleCriteria, ["FR-8"], {
      isFinalSlice: false
    });
    expect(nonFinal.map((ac) => ac.acKey)).toEqual(["AC-21"]);

    const final = selectAcceptanceCriteriaForSlice(e1StyleCriteria, ["FR-1"], {
      isFinalSlice: true
    });
    expect(final.map((ac) => ac.acKey)).toEqual(["AC-24", "AC-30"]);

    const legacy = selectAcceptanceCriteriaForSlice(e1StyleCriteria, ["FR-8"]);
    expect(legacy.map((ac) => ac.acKey)).toEqual(["AC-24", "AC-21"]);

    const emptyFrKeysFinal = selectAcceptanceCriteriaForSlice(e1StyleCriteria, [], {
      isFinalSlice: true
    });
    expect(emptyFrKeysFinal.map((ac) => ac.acKey)).toEqual(["AC-04", "AC-24", "AC-30", "AC-21"]);
  });
});

describe("F1-4 FX-13(a)：非最终切片携带全局性 AC → GLOBAL_AC_OUTSIDE_FINAL_SLICE", () => {
  it("命中错误（含规范键归一）；最终切片同计划放行；undefined 不校验", () => {
    const plan: TaskPlan = {
      summary: "slice plan with global AC misplacement",
      tasks: [
        task({ id: "T-001", type: "TEST", acKeys: ["AC-04"], dependencies: [] }),
        task({ id: "T-002", type: "BACKEND", acKeys: ["ac-4", "AC-30"], dependencies: ["T-001"] })
      ]
    };
    const globalAcKeys = ["AC-24", "AC-30"];
    const options = { isFinalSlice: false, globalAcKeys, deliveryConfigured: true };

    const nonFinal = validateTaskGraph(plan, options);
    expect(nonFinal.valid).toBe(false);
    expect(nonFinal.errors).toEqual([
      "Task T-002 carries global acceptance criteria (AC-30) that must be delivered by the final slice (GLOBAL_AC_OUTSIDE_FINAL_SLICE); remove them here — deployment/documentation acceptance is verified once the whole system exists"
    ]);

    expect(validateTaskGraph(plan, { ...options, isFinalSlice: true }).errors).toEqual([]);
    expect(validateTaskGraph(plan, { globalAcKeys, deliveryConfigured: true }).errors).toEqual([]);
    expect(
      validateTaskGraph(plan, { isFinalSlice: false, deliveryConfigured: true }).errors
    ).toEqual([]);
  });
});

describe("F1-4 FX-14a：旧计划回放——E1 形态 slice-1 计划被拒绝（只证拒绝）", () => {
  it("工程任务（T-08）携带 AC-30 的 slice-1 旧计划 → 校验失败并给出归属错误码", () => {
    // 复刻证据：E-1 run-1 slice-1 曾出现 AC-30 工程任务（f0-inputs §②：T-08 AC-30 两次 agent run）；
    // 此处只证明「既有计划被新规则拒绝」，不涉修复后形态。
    const legacySlice1Plan: TaskPlan = {
      summary: "E1 slice-1 工程基线旧计划（全局性 AC 被挂到非最终切片）",
      tasks: [
        task({ id: "T-01", type: "BACKEND", acKeys: ["AC-21"], dependencies: [] }),
        task({ id: "T-08", type: "BUILD", acKeys: ["AC-30"], dependencies: ["T-01"] })
      ]
    };

    const result = validateTaskGraph(legacySlice1Plan, {
      isFinalSlice: false,
      globalAcKeys: ["AC-24", "AC-30"],
      deliveryConfigured: true
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("GLOBAL_AC_OUTSIDE_FINAL_SLICE"))).toBe(
      true
    );
    expect(result.errors.some((error) => error.includes("T-08") && error.includes("AC-30"))).toBe(
      true
    );
  });
});

describe("F1-4 FX-15(a)/(c)：最终切片规模度量与 enforce 超限错误", () => {
  it("度量四指标（任务数/交付链任务数/FR 数/全局性 AC 数）", () => {
    const plan: TaskPlan = {
      summary: "final slice plan",
      tasks: [
        task({ id: "T-101", type: "TEST" }),
        task({ id: "T-102", type: "BACKEND" }),
        task({
          id: "T-103",
          type: "BUILD",
          delivery: { action: "CI", ref: "main", workflowFile: "ci.yml" }
        }),
        task({
          id: "T-104",
          type: "DEPLOY",
          delivery: { action: "DEPLOY", environment: "staging" }
        }),
        task({ id: "T-105", type: "TEST", delivery: { action: "VERIFY", environment: "staging" } })
      ]
    };
    const scale = measureFinalSliceScale({
      tasks: plan.tasks,
      globalAcKeys: ["AC-24", "AC-30"],
      frCount: 2
    });
    expect(scale).toEqual({ taskCount: 5, deliveryTaskCount: 3, frCount: 2, globalAcCount: 2 });
  });

  it("阈值缺省 = observe（不判失败）；开启后仅超限报 FINAL_SLICE_OVERLOAD（口径：不低于 18）", () => {
    const scale = { taskCount: 17, deliveryTaskCount: 4, frCount: 2, globalAcCount: 5 };
    expect(finalSliceOverloadError(scale, undefined)).toBeNull();
    expect(finalSliceOverloadError(scale, 18)).toBeNull();
    expect(finalSliceOverloadError(scale, 17)).toBeNull();
    const message = finalSliceOverloadError(scale, 16);
    expect(message).toContain("FINAL_SLICE_OVERLOAD");
    expect(message).toContain("do NOT add or drop AC mappings");
  });
});

describe("F1-4 提示词变体：非最终切片不得以交付链收尾", () => {
  it("isFinalSlice=false 走非交付链变体；true/undefined 维持交付就绪；无仓库变体优先", () => {
    const nonFinal = taskPlanningPrompt({ deliveryConfigured: true, isFinalSlice: false });
    expect(nonFinal).toContain("NOT the final slice");
    expect(nonFinal).toContain("do not include any delivery tasks");
    expect(nonFinal).not.toContain("End delivery-ready plans");

    const final = taskPlanningPrompt({ deliveryConfigured: true, isFinalSlice: true });
    expect(final).toContain("End delivery-ready plans");

    const legacy = taskPlanningPrompt({ deliveryConfigured: true });
    expect(legacy).toContain("End delivery-ready plans");

    const noRepo = taskPlanningPrompt({ deliveryConfigured: false, isFinalSlice: false });
    expect(noRepo).toContain("NO Git repository bound");
  });
});
