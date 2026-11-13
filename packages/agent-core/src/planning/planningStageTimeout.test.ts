import type { JsonObject, Requirement } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { PlanningAgent } from "./PlanningAgent";
import { PlanningStageTimeoutError, runLevel1PlanningGraph, stageBudgetMs } from "./PlanningGraph";
import type { PlanningModel, PlanningModelRequest } from "./PlanningModel";
import { ScriptedPlanningModel } from "./ScriptedPlanningModel";

/**
 * N-51（`docs/232` §9.20 F4）：阶段墙钟耗尽此前抛的是**裸 Error**，于是 `agent_runs.error.code`
 * 把它记成 `PLANNING_ERROR`——与「模型吐出非法 JSON」同码。两者处置相反：超时是瞬态的（该重试/
 * 升级），解析失败是产物质量问题。第八次回归里三个切片做完、第四片超时把整轮夹具掐了，
 * 而账本上只留下一句 `PLANNING_ERROR`。
 */

/** 每次模型调用都比阶段预算慢；收到 abort 后抛错，与真实 provider 的取消行为一致。 */
class SlowModel implements PlanningModel {
  async generateStructured<TOutput extends JsonObject>(
    request: PlanningModelRequest<TOutput>
  ): Promise<unknown> {
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (request.signal?.aborted) throw new Error("aborted by stage budget");
    return new ScriptedPlanningModel().generateStructured(request);
  }
}

function makeRequirement(): Requirement {
  const now = new Date().toISOString();
  return {
    id: "req-1",
    projectId: "project-1",
    title: "Todo list",
    description: "A small todo list",
    rawContent: "Users can add, list and complete todo items.",
    status: "ANALYZED",
    version: 1,
    createdAt: now,
    updatedAt: now
  };
}

function context() {
  return {
    requestId: "run-1",
    projectId: "project-1",
    requirementId: "req-1",
    taskId: "task-1",
    agentRunId: "run-1"
  };
}

describe("N-51 阶段墙钟耗尽的错误码", () => {
  it("阶段预算耗尽 → 抛出可识别的 PlanningStageTimeoutError", async () => {
    await expect(
      runLevel1PlanningGraph({
        agentRunId: "run-1",
        taskId: "task-1",
        requirement: makeRequirement(),
        model: new SlowModel(),
        stageTimeoutMs: 10,
        stageRetries: 0
      })
    ).rejects.toBeInstanceOf(PlanningStageTimeoutError);
  });

  it("PlanningAgent 把它记成 timed_out / TIMEOUT_ERROR（不再是 PLANNING_ERROR）", async () => {
    const agent = new PlanningAgent({
      model: new SlowModel(),
      pipeline: "level1",
      stageTimeoutMs: 10,
      stageRetries: 0
    });

    const result = await agent.run(makeRequirement(), context(), { timeoutMs: 60_000 });

    expect(result.status).toBe("timed_out");
    expect(result.error?.code).toBe("TIMEOUT_ERROR");
    expect(result.error?.message).toMatch(/Planning stage timed out: requirement_analysis/);
  });
});

describe("N-52 `task_planning` 单独一档预算", () => {
  it("只覆盖 task_planning；其余阶段仍是通用预算", () => {
    const options = { stageTimeoutMs: 150_000, taskPlanningTimeoutMs: 300_000 };
    expect(stageBudgetMs("task_planning", options)).toBe(300_000);
    expect(stageBudgetMs("functional_spec", options)).toBe(150_000);
    expect(stageBudgetMs("slice_planning", options)).toBe(150_000);
  });

  it("没配这一档时沿用通用预算（旧行为逐字不变）", () => {
    expect(stageBudgetMs("task_planning", { stageTimeoutMs: 150_000 })).toBe(150_000);
  });
});
