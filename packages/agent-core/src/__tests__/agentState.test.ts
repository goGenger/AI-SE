import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createInitialAgentState } from "../agent/AgentState";

describe("AgentState", () => {
  it("creates a bounded initial state", () => {
    const state = createInitialAgentState({
      messages: [new HumanMessage("fix tests")],
      projectId: "project-1",
      taskId: "task-1",
      agentRunId: "run-1",
      metadata: { source: "test" }
    });

    expect(state.messages).toHaveLength(1);
    expect(state.projectId).toBe("project-1");
    expect(state.taskId).toBe("task-1");
    expect(state.agentRunId).toBe("run-1");
    expect(state.iteration).toBe(0);
    expect(state.status).toBe("running");
    expect(state.toolResults).toEqual([]);
    expect(state.metadata).toEqual({ source: "test" });
  });
});
