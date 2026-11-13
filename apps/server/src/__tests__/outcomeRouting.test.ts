import { ProfessionalOutcome } from "@ai-se/agent-core";
import { Task } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  isDebugHandoff,
  resolveOutcomeErrorType,
  resolveOutcomeFixTaskType,
  resolveOutcomeTaskStatus,
  resolveRunFailureErrorType
} from "../services/workflowTaskExecutor";

/**
 * N-22（`docs/199`）：`REPLAN` 结果的两处缺口——**路由**与**可归因性**。
 *
 * 起因（L1-M4n run 2，workflow `a85a6970`）：`T7` 因一条过期断言失败后，`T7-REPLAN-1`
 * （backend-agent）报 `outcome = "REPLAN"`，并在 `recommendations` 里**用自由文本**要求
 * 「Route a TEST-type task to correct `src/bearer-auth-middleware.test.js` line 333 …」，
 * 而 `fixTaskType` 为空 ⇒ `WorkflowEngine.debugTargetType` 第 1 步读不到值、落到第 3 步，
 * 产出**又一个 BACKEND**。同一失败**无 `errorType`、无 `verification` 记录** ⇒ 批次归因里看不见。
 */

function outcome(overrides: Partial<ProfessionalOutcome> = {}): ProfessionalOutcome {
  return {
    status: "REPLAN",
    summary: "submit_result test outcome",
    artifacts: [],
    issues: [],
    recommendations: [],
    metadata: {},
    ...overrides
  };
}

describe("resolveOutcomeFixTaskType（N-22）", () => {
  it("根字段优先于 metadata（新通道生效）", () => {
    expect(
      resolveOutcomeFixTaskType(
        outcome({ fixTaskType: "TEST", metadata: { fixTaskType: "BACKEND" } })
      )
    ).toBe("TEST");
  });

  it("根字段缺省时回落 metadata（历史任务与未更新提示词的 agent）", () => {
    expect(resolveOutcomeFixTaskType(outcome({ metadata: { fixTaskType: "BACKEND" } }))).toBe(
      "BACKEND"
    );
  });

  it("两者都缺省 ⇒ undefined（判据 25g：路由仍走第 3 步兜底，行为不变）", () => {
    expect(resolveOutcomeFixTaskType(outcome())).toBeUndefined();
  });

  it("空串与非字符串按缺省处理（不把 `\"\"` 当成一个值）", () => {
    expect(resolveOutcomeFixTaskType(outcome({ fixTaskType: "" }))).toBeUndefined();
    expect(resolveOutcomeFixTaskType(outcome({ metadata: { fixTaskType: 7 } }))).toBeUndefined();
  });
});

describe("resolveOutcomeErrorType（N-22 判据 25e）", () => {
  it("REPLAN 且 agent 未给码 ⇒ REPLAN_REQUESTED（此前为空，批次归因看不见）", () => {
    expect(resolveOutcomeErrorType(outcome({ status: "REPLAN" }))).toBe("REPLAN_REQUESTED");
  });

  it("agent 自己给了码 ⇒ 用它的（更具体）", () => {
    expect(
      resolveOutcomeErrorType(outcome({ status: "REPLAN", metadata: { errorType: "CI_FAILED" } }))
    ).toBe("CI_FAILED");
  });

  it("非 REPLAN 且无码 ⇒ undefined（不改变既有行为）", () => {
    expect(resolveOutcomeErrorType(outcome({ status: "FAILED" }))).toBeUndefined();
  });

  it("非 REPLAN 有码 ⇒ 照旧", () => {
    expect(
      resolveOutcomeErrorType(
        outcome({ status: "FAILED", metadata: { errorType: "VERIFICATION_FAILED" } })
      )
    ).toBe("VERIFICATION_FAILED");
  });
});

/**
 * N-29（`docs/211`）：**DEBUG 任务的 `REPLAN` 是「交接」，不是失败。**
 *
 * `replan()` 造的 `-REPLAN-N` **依赖** `-DEBUG-N` 成功（`WorkflowEngine.ts:1034`）。
 * 诊断 agent 诚实地报 `REPLAN`（库内原文："retrying the DATABASE task would not change the
 * failure"）被判失败 ⇒ **重试恒 PENDING、从不运行**；平台还在诊断任务上继续 replan，
 * 嵌套出 `Diagnose Diagnose …` 直到预算耗尽——L1-M4q 三次运行**全部**如此，
 * 2026-10-21 的 `-REPLAN-` 任务 **13/28 从未运行**。
 */
describe("isDebugHandoff（N-29）", () => {
  const task = (overrides: Partial<Task> = {}): Task => ({
    id: "task-debug",
    projectId: "project-1",
    taskKey: "T7-DEBUG-1",
    title: "Diagnose T7",
    description: "",
    type: "DEBUG",
    status: "RUNNING",
    priority: "MEDIUM",
    input: {},
    retryCount: 0,
    version: 1,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    ...overrides
  });

  it("31a：DEBUG + REPLAN + 合法 fixTaskType ⇒ 交接", () => {
    expect(isDebugHandoff(task(), outcome({ fixTaskType: "TEST" }))).toBe(true);
  });

  it("31a：DEBUG + REPLAN + 非空 fixSteps（无 fixTaskType）⇒ 交接", () => {
    expect(
      isDebugHandoff(task(), outcome({ metadata: { fixSteps: ["edit src/a.js", "rerun ci"] } }))
    ).toBe(true);
  });

  it("31b：DEBUG + REPLAN 但既无合法类型也无步骤 ⇒ 不是交接（不收养懒）", () => {
    expect(isDebugHandoff(task(), outcome())).toBe(false);
    expect(isDebugHandoff(task(), outcome({ fixTaskType: "IMPLEMENTATION" }))).toBe(false);
    expect(isDebugHandoff(task(), outcome({ metadata: { fixSteps: [] } }))).toBe(false);
  });

  it("31c：非 DEBUG 源的 REPLAN 不算交接（语义不变）", () => {
    expect(isDebugHandoff(task({ type: "BACKEND" }), outcome({ fixTaskType: "TEST" }))).toBe(
      false
    );
  });

  it("非 REPLAN 结果一律不算交接", () => {
    expect(isDebugHandoff(task(), outcome({ status: "SUCCESS", fixTaskType: "TEST" }))).toBe(
      false
    );
  });
});

/**
 * N-29 的**接线**：`isDebugHandoff` 判对了还不够，状态映射必须真的用它。
 * 去掉映射里的 `!handoff`，上面整块单测照样全绿，而修复被完整退回——所以这条也测。
 */
describe("resolveOutcomeTaskStatus（N-29 接线）", () => {
  it("run 成功 + REPLAN + 交接 ⇒ succeeded（重试才跑得起来）", () => {
    expect(resolveOutcomeTaskStatus("succeeded", outcome({ status: "REPLAN" }), true)).toBe(
      "succeeded"
    );
  });

  it("run 成功 + REPLAN + 非交接 ⇒ failed（既有行为不变）", () => {
    expect(resolveOutcomeTaskStatus("succeeded", outcome({ status: "REPLAN" }), false)).toBe(
      "failed"
    );
  });

  it("run 成功 + SUCCESS ⇒ succeeded（与 handoff 无关）", () => {
    expect(resolveOutcomeTaskStatus("succeeded", outcome({ status: "SUCCESS" }), false)).toBe(
      "succeeded"
    );
  });

  it("run 失败/取消/超时 ⇒ 原样透传", () => {
    expect(resolveOutcomeTaskStatus("failed", outcome({ status: "SUCCESS" }), true)).toBe("failed");
    expect(resolveOutcomeTaskStatus("cancelled", outcome({ status: "SUCCESS" }), true)).toBe(
      "cancelled"
    );
    expect(resolveOutcomeTaskStatus("timed_out", outcome({ status: "SUCCESS" }), true)).toBe(
      "timed_out"
    );
  });
});

describe("QA / gate failure → repair targeting (autonomy)", () => {
  it("Approval withheld + missing bins ⇒ fixTaskType FRONTEND and GATE_FAILURE", () => {
    const rejected = outcome({
      status: "FAILED",
      summary:
        "Approval withheld; npm run type-check -> sh: 1: vue-tsc: not found; eslint/vitest not found"
    });
    expect(resolveOutcomeFixTaskType(rejected, { taskType: "REVIEW" })).toBe("FRONTEND");
    expect(resolveOutcomeErrorType(rejected)).toBe("GATE_FAILURE");
  });

  it("plain FAILED without gate evidence still has no inferred fixTaskType", () => {
    const plain = outcome({ status: "FAILED", summary: "could not finish in time" });
    expect(resolveOutcomeFixTaskType(plain, { taskType: "REVIEW" })).toBeUndefined();
    expect(resolveOutcomeErrorType(plain)).toBeUndefined();
  });
});


describe("resolveRunFailureErrorType (AFC-M3)", () => {
  it("timed_out / TIMEOUT_ERROR → AGENT_TIMEOUT", () => {
    expect(resolveRunFailureErrorType("timed_out", outcome({ status: "FAILED" }))).toBe(
      "AGENT_TIMEOUT"
    );
    expect(
      resolveRunFailureErrorType("failed", outcome({ status: "FAILED" }), "TIMEOUT_ERROR")
    ).toBe("AGENT_TIMEOUT");
  });

  it("infra codes → INFRA_RETRY_EXHAUSTED", () => {
    expect(
      resolveRunFailureErrorType("failed", outcome({ status: "FAILED" }), "SANDBOX_ERROR")
    ).toBe("INFRA_RETRY_EXHAUSTED");
  });
});
