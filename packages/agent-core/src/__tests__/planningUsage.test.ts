import { describe, expect, it } from "vitest";
import type { JsonObject, Requirement } from "@ai-se/shared";
import { PlanningAgent } from "../planning/PlanningAgent";
import { ScriptedPlanningModel } from "../planning/ScriptedPlanningModel";
import {
  addTokenUsage,
  type PlanningModel,
  type PlanningModelRequest
} from "../planning/PlanningModel";

/**
 * N-25（`docs/206`）：规划段的用量此前**从未采集**——807 次 `planning-agent` run 的
 * `agent_runs.token_usage` 全空，于是周用量守卫与 eval 指标都看不见这一段。
 *
 * 修法走**回调**而不是改返回值：一次逻辑调用可能因解析失败被重采样多次，而
 * `OutputParserException` 只带 `llmOutput: string`、**不含用量**——返回路径拿不到失败那几次。
 * `handleLLMEnd` 在模型调用结束时触发，与解析成败无关。
 */

const USAGE: JsonObject = {
  input_tokens: 100,
  output_tokens: 10,
  total_tokens: 110,
  input_token_details: { cache_read: 40 }
};

/** 每调用一次模型就报一次用量；可选在第 N 次调用后抛错（模拟失败 run）。 */
class UsageModel implements PlanningModel {
  calls = 0;
  constructor(
    private readonly inner: PlanningModel,
    private readonly failAtCall?: number
  ) {}

  async generateStructured<TOutput extends JsonObject>(
    request: PlanningModelRequest<TOutput>
  ): Promise<unknown> {
    this.calls += 1;
    request.onUsage?.(USAGE);
    if (this.failAtCall === this.calls) throw new Error("model exploded");
    return this.inner.generateStructured(request);
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

function runAgent(model: PlanningModel) {
  const agent = new PlanningAgent({ model, pipeline: "level1" });
  return agent.run(
    makeRequirement(),
    {
      requestId: "run-1",
      projectId: "project-1",
      requirementId: "req-1",
      taskId: "task-1",
      agentRunId: "run-1"
    },
    { timeoutMs: 30_000 }
  );
}

describe("N-25：规划段用量采集", () => {
  it("addTokenUsage 累加数值与嵌套明细（重采样必须相加，不能只取最后一次）", () => {
    expect(addTokenUsage(USAGE, USAGE)).toEqual({
      input_tokens: 200,
      output_tokens: 20,
      total_tokens: 220,
      input_token_details: { cache_read: 80 }
    });
    // 非数值字段不参与求和（不是 token 计数）。
    expect(addTokenUsage({ model: "x", input_tokens: 1 }, { model: "y", input_tokens: 2 })).toEqual({
      model: "x",
      input_tokens: 3
    });
  });

  it("28a：成功的规划 run 带累计用量，且经 onRunFinished 落盘", async () => {
    const model = new UsageModel(new ScriptedPlanningModel());
    const finished: JsonObject[] = [];
    const agent = new PlanningAgent({
      model,
      pipeline: "level1",
      lifecycle: {
        onRunFinished: async (record) => {
          finished.push((record.tokenUsage ?? {}) as JsonObject);
        }
      }
    });

    const result = await agent.run(
      makeRequirement(),
      {
        requestId: "run-1",
        projectId: "project-1",
        requirementId: "req-1",
        taskId: "task-1",
        agentRunId: "run-1"
      },
      { timeoutMs: 30_000 }
    );

    expect(result.status).toBe("succeeded");
    expect(model.calls).toBeGreaterThan(0);
    // 每个阶段各报一次，累计 = 单次 × 调用次数。
    expect(result.tokenUsage).toEqual({
      input_tokens: 100 * model.calls,
      output_tokens: 10 * model.calls,
      total_tokens: 110 * model.calls,
      input_token_details: { cache_read: 40 * model.calls }
    });
    expect(finished.at(-1)?.input_tokens).toBe(100 * model.calls);
  });

  it("28b：失败的规划 run 也带用量（失败同样花了钱）", async () => {
    const model = new UsageModel(new ScriptedPlanningModel(), 1);
    const finished: JsonObject[] = [];
    const agent = new PlanningAgent({
      model,
      pipeline: "level1",
      lifecycle: {
        onRunFinished: async (record) => {
          finished.push((record.tokenUsage ?? {}) as JsonObject);
        }
      }
    });

    const result = await agent.run(
      makeRequirement(),
      {
        requestId: "run-1",
        projectId: "project-1",
        requirementId: "req-1",
        taskId: "task-1",
        agentRunId: "run-1"
      },
      { timeoutMs: 30_000 }
    );

    expect(result.status).not.toBe("succeeded");
    expect(result.tokenUsage).toEqual(USAGE);
    expect(finished.at(-1)?.input_tokens).toBe(100);
  });

  it("28d：脚本化模型不报用量，run 的 tokenUsage 保持缺省（不造假值）", async () => {
    const result = await runAgent(new ScriptedPlanningModel());
    expect(result.status).toBe("succeeded");
    expect(result.tokenUsage).toBeUndefined();
  });
});
