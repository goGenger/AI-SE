import { describe, expect, it } from "vitest";
import {
  classifyFailureLayer,
  collectChainMetrics,
  collectFailureLayers,
  collectPlanningMetrics,
  collectScopeViolation,
  collectTaskMetrics,
  collectVerificationMetrics,
  extractRunUsage,
  filterPlanningRunsInWindow,
  selectUncollectedWorkflows
} from "../harness";
import { noiseLine, summarize } from "../metrics";
import { EvalRunRecord } from "../types";

function record(overrides: Partial<EvalRunRecord> = {}): EvalRunRecord {
  return {
    fixtureId: "S1",
    tier: "S",
    runIndex: 1,
    workflowId: "wf-1",
    workspacePath: "/tmp/ws",
    taskCount: 1,
    runCount: 1,
    taskStatuses: { SUCCESS: 1 },
    reportedSuccess: true,
    oraclePassed: true,
    falsePositive: false,
    parseRecoveryRuns: 0,
    humanInterventions: 0,
    tokenUsage: { input: 100, output: 10 },
    estimatedCostUsd: 0.01,
    durationMs: 1000,
    errorTypes: {},
    failureSummary: null,
    ...overrides
  };
}

describe("summarize", () => {
  it("计算真成功率 / 自报成功率 / 假阳性率 / 降级率", () => {
    const records = [
      record(),
      record({
        runIndex: 2,
        reportedSuccess: true,
        oraclePassed: false,
        falsePositive: true,
        parseRecoveryRuns: 1
      }),
      record({
        runIndex: 3,
        reportedSuccess: false,
        oraclePassed: false,
        taskCount: 2,
        errorTypes: { TIMEOUT: 1 }
      })
    ];

    const summary = summarize(records);

    expect(summary.runs).toBe(3);
    expect(summary.trueSuccessRate).toBeCloseTo(1 / 3);
    expect(summary.reportedSuccessRate).toBeCloseTo(2 / 3);
    expect(summary.falsePositiveRate).toBeCloseTo(1 / 3);
    expect(summary.parseRecoveryRate).toBeCloseTo(1 / 3);
    expect(summary.tokenUsage).toEqual({ input: 300, output: 30 });
    expect(summary.estimatedCostUsd).toBeCloseTo(0.03);
    expect(summary.errorTypes).toEqual({ TIMEOUT: 1 });
    expect(summary.byTier.S.runs).toBe(3);
    expect(summary.byTier.M.runs).toBe(0);
  });

  it("空输入不产生 NaN", () => {
    const summary = summarize([]);
    expect(summary.trueSuccessRate).toBe(0);
    expect(summary.falsePositiveRate).toBe(0);
    expect(summary.parseRecoveryRate).toBe(0);
  });

  it("E1 档仅在出现 E1 记录时动态追加进 byTier", () => {
    const without = summarize([record()]);
    expect("E1" in without.byTier).toBe(false);

    const withE1 = summarize([record(), record({ fixtureId: "E1", tier: "E1", runIndex: 2 })]);
    expect(withE1.byTier.E1.runs).toBe(1);
    expect("E1" in withE1.byTier).toBe(true);
  });
});

describe("noiseLine", () => {
  it("给出两次评测的指标差值", () => {
    const previous = summarize([record()]);
    const next = summarize([record(), record({ runIndex: 2, oraclePassed: false })]);

    const noise = noiseLine(previous, next);

    expect(noise.trueSuccessRate).toBeCloseTo(-0.5);
    expect(noise.falsePositiveRate).toBeCloseTo(0);
    expect(noise.estimatedCostUsd).toBeCloseTo(0.01);
  });
});

describe("extractRunUsage", () => {
  it("读取平台真实字段 input_tokens / output_tokens，并抽出降级标记", () => {
    const usage = extractRunUsage({
      id: "run-1",
      tokenUsage: { input_tokens: 6928, output_tokens: 2076 },
      estimatedCost: 0.02,
      output: { parseRecovery: "salvage", errorType: "TIMEOUT" }
    });

    expect(usage).toEqual({
      inputTokens: 6928,
      outputTokens: 2076,
      costUsd: 0.02,
      parseRecovery: true
    });
  });

  it("缺字段时给零值/null，不产生 NaN", () => {
    const usage = extractRunUsage({ id: "run-2" });
    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      parseRecovery: false
    });
  });

  // 反向断言（防回潮）：run 级 `errorType` 一旦重新暴露，调用点就会再叠一次 run 级计数，
  // 把失败原因分布重新翻倍。见 harness.ts 中 `errorTypes` 处的注释。
  it("不再暴露 run 级 errorType（失败原因分布只按任务级统计）", () => {
    const usage = extractRunUsage({
      id: "run-3",
      output: { errorType: "TIMEOUT" }
    });
    expect(usage).not.toHaveProperty("errorType");
  });
});

describe("collectTaskMetrics", () => {
  it("只有全部任务 SUCCESS 才算自报成功（RUNNING/FAILED 一律不算）", () => {
    const partial = collectTaskMetrics([{ status: "SUCCESS" }, { status: "RUNNING" }]);
    expect(partial.reportedSuccess).toBe(false);
    expect(partial.taskStatuses).toEqual({ SUCCESS: 1, RUNNING: 1 });

    const complete = collectTaskMetrics([{ status: "SUCCESS" }, { status: "SUCCESS" }]);
    expect(complete.reportedSuccess).toBe(true);

    const failed = collectTaskMetrics([{ status: "SUCCESS" }, { status: "FAILED" }]);
    expect(failed.reportedSuccess).toBe(false);

    expect(collectTaskMetrics([]).reportedSuccess).toBe(false);
  });

  it("N-56：被后继成功任务解决掉的失败祖先不计入自报失败", () => {
    // 第十二次回归的真实形状：T-001 / T4-readme-contract-test / T6 三行 FAILED，
    // 各自的 *-REPLAN-1 成功；五个切片全 DONE、交付链 100%，旧口径却报「自报成功率 0%」。
    const metrics = collectTaskMetrics([
      { id: "t1", status: "FAILED", resolvedByTaskId: "t1-replan" },
      { id: "t1-replan", status: "SUCCESS" },
      { id: "t2", status: "SUCCESS" }
    ]);
    expect(metrics.reportedSuccess).toBe(true);
    // 普查口径不变：祖先行仍出现在 taskStatuses 里。
    expect(metrics.taskStatuses).toEqual({ FAILED: 1, SUCCESS: 2 });
  });

  it("N-56：未解决的失败、或解决者尚未成功，仍算自报失败", () => {
    expect(collectTaskMetrics([{ id: "a", status: "FAILED" }]).reportedSuccess).toBe(false);
    expect(
      collectTaskMetrics([
        { id: "a", status: "FAILED", resolvedByTaskId: "a-replan" },
        { id: "a-replan", status: "RUNNING" }
      ]).reportedSuccess
    ).toBe(false);
    // 解决者在列表里不存在 ⇒ 不算已解决（fail-closed）。
    expect(
      collectTaskMetrics([{ id: "a", status: "FAILED", resolvedByTaskId: "missing" }]).reportedSuccess
    ).toBe(false);
  });

  it("N-56：多跳自愈链走到成功即算解决", () => {
    const metrics = collectTaskMetrics([
      { id: "a", status: "FAILED", resolvedByTaskId: "b" },
      { id: "b", status: "FAILED", resolvedByTaskId: "c" },
      { id: "c", status: "SUCCESS" }
    ]);
    expect(metrics.reportedSuccess).toBe(true);
  });

  it("抽取降级与错误类型计数", () => {
    const metrics = collectTaskMetrics([
      { status: "SUCCESS", output: { parseRecovery: "salvage", errorType: "TIMEOUT" } },
      { status: "SUCCESS", output: {} }
    ]);
    expect(metrics.parseRecoveryRuns).toBe(1);
    expect(metrics.errorTypes).toEqual({ TIMEOUT: 1 });
  });
});

describe("FX-26 冻结口径（链完成 / 验证分歧 / 失败分层 / 规划修复）", () => {
  it("collectChainMetrics：两级看全切片 DONE；单级看全工作流 SUCCESS", () => {
    const twoLevel = collectChainMetrics(
      [
        { sliceKey: "s1", status: "DONE" },
        { sliceKey: "s2", status: "RUNNING" },
        { sliceKey: "s3", status: "PENDING" }
      ],
      ["SUCCESS"]
    );
    expect(twoLevel.chainCompleted).toBe(false);
    expect(twoLevel.sliceReached).toBe("s2");

    const completeChain = collectChainMetrics(
      [
        { sliceKey: "s1", status: "DONE" },
        { sliceKey: "s2", status: "DONE" }
      ],
      ["SUCCESS", "SUCCESS"]
    );
    expect(completeChain.chainCompleted).toBe(true);
    expect(completeChain.sliceReached).toBe("s2");

    const singleLevel = collectChainMetrics([], ["SUCCESS", "SUCCESS"]);
    expect(singleLevel.chainCompleted).toBe(true);
    expect(singleLevel.sliceReached).toBeNull();
    expect(collectChainMetrics([], ["SUCCESS", "FAILED"]).chainCompleted).toBe(false);
  });

  it("collectVerificationMetrics：统计验证分歧与失败码分布（记录级与检查级都取）", () => {
    const metrics = collectVerificationMetrics([
      {
        status: "FAILED",
        output: {
          verification: {
            verdict: "failed",
            failureCode: "VACUOUS_TEST",
            checks: [{ failureCode: "EVIDENCE_MISSING" }, { name: "test" }]
          }
        }
      },
      { status: "SUCCESS", output: { verification: { verdict: "verified" } } },
      { status: "SUCCESS", output: {} }
    ]);
    expect(metrics.taskVerificationDivergence).toBe(1);
    expect(metrics.verificationFailureCodes).toEqual({ VACUOUS_TEST: 1, EVIDENCE_MISSING: 1 });
  });

  it("PL-M9 9a：collectVerificationMetrics 统计「检查不可判定」任务数并按类型分列", () => {
    const metrics = collectVerificationMetrics([
      {
        status: "SUCCESS",
        output: {
          verification: { verdict: "unavailable", taskType: "TEST", missingChecks: ["test"] }
        }
      },
      {
        status: "SUCCESS",
        output: {
          verification: {
            verdict: "unavailable",
            taskType: "BACKEND",
            missingChecks: ["build", "test"]
          }
        }
      },
      // 本类型没有客观检查 → 不计入（与「缺 script」分开）。
      {
        status: "SUCCESS",
        output: { verification: { verdict: "unavailable", taskType: "DESIGN" } }
      },
      { status: "SUCCESS", output: { verification: { verdict: "verified" } } }
    ]);
    expect(metrics.verificationUnavailable).toBe(2);
    expect(metrics.verificationUnavailableByType).toEqual({ TEST: 1, BACKEND: 1 });
    // 不可判定不是失败：不污染验证分歧与失败码。
    expect(metrics.taskVerificationDivergence).toBe(0);
    expect(metrics.verificationFailureCodes).toEqual({});
  });

  it("classifyFailureLayer / collectFailureLayers：规划 / 验证门 / agent 分层", () => {
    expect(classifyFailureLayer("VERIFICATION_FAILED")).toBe("verification");
    expect(classifyFailureLayer("VACUOUS_TEST")).toBe("verification");
    expect(classifyFailureLayer("PLANNING_ERROR")).toBe("planning");
    expect(classifyFailureLayer("GLOBAL_AC_OUTSIDE_FINAL_SLICE")).toBe("planning");
    expect(classifyFailureLayer("DELIVERY_ENVIRONMENT_MISSING")).toBe("planning");
    expect(classifyFailureLayer("EMPTY_FINAL_ANSWER")).toBe("agent");

    const layers = collectFailureLayers(
      { VERIFICATION_FAILED: 2, EMPTY_FINAL_ANSWER: 1, TIMEOUT: 3 },
      { PLANNING_ERROR: 4 }
    );
    expect(layers).toEqual({ planning: 4, verification: 2, agent: 4 });
  });

  it("collectPlanningMetrics：修复轮数 / 首轮通过 / 收敛 / 错误码", () => {
    const metrics = collectPlanningMetrics([
      { eventType: "PLAN_AUTOFIXED", payload: {} },
      { eventType: "PLAN_AUTOFIXED", payload: {} },
      { eventType: "PLANNING_REPAIR_REQUESTED", payload: { stage: "task_plan" } },
      { eventType: "SLICE_PLAN_VALIDATION_FAILED", payload: { attempt: 1 } },
      { eventType: "SLICE_PLANNING_FAILED", payload: { errorCode: "PLANNING_ERROR" } },
      { eventType: "FINAL_SLICE_SCALE_OBSERVED", payload: {} }
    ]);
    expect(metrics.autoFixRounds).toBe(2);
    expect(metrics.llmRepairRounds).toBe(1);
    expect(metrics.sliceValidationFailureRounds).toBe(1);
    expect(metrics.firstPass).toBe(false);
    expect(metrics.converged).toBe(false);
    expect(metrics.failureCodes).toEqual({ PLANNING_ERROR: 1 });

    const clean = collectPlanningMetrics([{ eventType: "PLAN_AUTOFIXED" }]);
    expect(clean.firstPass).toBe(true);
    expect(clean.converged).toBe(true);
  });

  it("collectScopeViolation：SCOPE_VIOLATION 事件面标注（无事件 = false）", () => {
    expect(collectScopeViolation([{ eventType: "TASK_COMPLETED" }])).toBe(false);
    expect(collectScopeViolation([{ eventType: "SCOPE_VIOLATION" }])).toBe(true);
  });

  it("filterPlanningRunsInWindow：只计本轮窗口内的规划 run（跨批次累计污染修复）", () => {
    const start = Date.parse("2026-10-13T09:00:00Z");
    const runs = [
      { id: "old", createdAt: "2026-10-09T02:00:00Z", input: { runtime: "planning-agent", requirementId: "req-1" } },
      { id: "fresh", createdAt: "2026-10-13T09:05:00Z", input: { runtime: "planning-agent", requirementId: "req-1" } },
      { id: "other-req", createdAt: "2026-10-13T09:05:00Z", input: { runtime: "planning-agent", requirementId: "req-2" } },
      { id: "exec", createdAt: "2026-10-13T09:05:00Z", input: { runtime: "deep-agent", requirementId: "req-1" } },
      { id: "no-created", input: { runtime: "planning-agent", requirementId: "req-1" } }
    ];
    expect(filterPlanningRunsInWindow(runs, "req-1", start).map((run) => run.id)).toEqual([
      "fresh"
    ]);
  });

  it("selectUncollectedWorkflows：补采本轮窗口内未收录的同需求工作流（sv 采集面）", () => {
    const start = Date.parse("2026-10-13T09:00:00Z");
    const workflows = [
      { id: "wf-exec", requirementId: "req-1", createdAt: "2026-10-13T09:05:00Z" },
      { id: "wf-retry", requirementId: "req-1", createdAt: "2026-10-13T09:30:00Z" },
      { id: "wf-old", requirementId: "req-1", createdAt: "2026-10-09T02:00:00Z" },
      { id: "wf-other", requirementId: "req-2", createdAt: "2026-10-13T09:30:00Z" },
      { requirementId: "req-1", createdAt: "2026-10-13T09:30:00Z" }
    ];
    expect(
      selectUncollectedWorkflows(workflows, {
        requirementId: "req-1",
        runStartedAt: start,
        collectedIds: ["wf-exec"]
      })
    ).toEqual(["wf-retry"]);
  });

  it("summarize：新增聚合（交付成功 / 假阴性 / 分层 / 修复轮数 / 切片分布）", () => {
    const records = [
      record({
        chainCompleted: true,
        deliveredSuccess: true,
        falseNegative: false,
        sliceReached: "s2",
        taskVerificationDivergence: 1,
        verificationFailureCodes: { VACUOUS_TEST: 1 },
        failureLayers: { planning: 0, verification: 1, agent: 0 },
        planningMetrics: {
          autoFixRounds: 2,
          llmRepairRounds: 1,
          sliceValidationFailureRounds: 0,
          firstPass: false,
          converged: true,
          failureCodes: {}
        }
      }),
      record({
        runIndex: 2,
        oraclePassed: true,
        chainCompleted: false,
        deliveredSuccess: false,
        falseNegative: true,
        sliceReached: "s1",
        planningMetrics: {
          autoFixRounds: 0,
          llmRepairRounds: 0,
          sliceValidationFailureRounds: 0,
          firstPass: true,
          converged: true,
          failureCodes: {}
        }
      })
    ];

    const summary = summarize(records);
    expect(summary.chainCompletedRate).toBeCloseTo(0.5);
    expect(summary.deliveredSuccessRate).toBeCloseTo(0.5);
    expect(summary.falseNegativeCount).toBe(1);
    expect(summary.scopeViolations).toBe(0);
    expect(summary.taskVerificationDivergence).toBe(1);
    expect(summary.verificationFailureCodes).toEqual({ VACUOUS_TEST: 1 });
    expect(summary.failureLayers).toEqual({ planning: 0, verification: 1, agent: 0 });
    expect(summary.planningRepair.autoFixRounds).toBe(2);
    expect(summary.planningRepair.llmRepairRounds).toBe(1);
    expect(summary.planningRepair.firstPassRate).toBeCloseTo(0.5);
    expect(summary.planningRepair.convergenceRate).toBe(1);
    expect(summary.sliceReachedDistribution).toEqual({ s2: 1, s1: 1 });
  });

  it("summarize：旧记录缺新字段时按缺省降级（不产生 NaN）", () => {
    const summary = summarize([record()]);
    expect(summary.chainCompletedRate).toBe(0);
    expect(summary.deliveredSuccessRate).toBe(0);
    expect(summary.falseNegativeCount).toBe(0);
    expect(summary.planningRepair.firstPassRate).toBeNull();
    expect(summary.planningRepair.convergenceRate).toBeNull();
  });
});
