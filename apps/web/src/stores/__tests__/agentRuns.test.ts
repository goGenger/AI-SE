import { AgentRun, AgentRunDetailView, AgentRunSummary } from "@ai-se/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelAgentRun, createAgentRun, getAgentRun, listAgentRuns } from "../../api/agentRuns";
import { useAgentRunsStore } from "../agentRuns";

vi.mock("../../api/agentRuns", () => ({
  cancelAgentRun: vi.fn(),
  createAgentRun: vi.fn(),
  getAgentRun: vi.fn(),
  listAgentRuns: vi.fn(),
  openAgentRunStream: vi.fn(),
  runCodingAgentDemo: vi.fn()
}));

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  const timestamp = new Date().toISOString();
  return {
    id: "run-1",
    taskId: "task-1",
    status: "created",
    input: { task: "fix tests" },
    currentIteration: 0,
    maxIterations: 16,
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

/** UX-03：列表 DTO = AgentRun + 服务端解析的上下文。 */
function summary(overrides: Partial<AgentRunSummary> = {}): AgentRunSummary {
  return {
    ...run(),
    projectName: "Mini Todo",
    workflowRunId: "wf-1",
    requirementName: "Todo 管理系统",
    planningVersion: 1,
    taskKey: "T-004",
    taskTitle: "Error handling middleware",
    agentName: "backend-agent",
    agentType: "BACKEND",
    ...overrides
  };
}

function detail(agentRun = run()): AgentRunDetailView {
  return {
    run: agentRun,
    toolCalls: [],
    events: [],
    context: {
      projectName: null,
      workflow: null,
      task: null,
      agentName: null,
      agentType: null,
      maxRetries: null
    },
    recovery: null,
    artifacts: [],
    evidence: []
  };
}

describe("agentRuns store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("loads agent runs", async () => {
    vi.mocked(listAgentRuns).mockResolvedValue([summary()]);
    const store = useAgentRunsStore();

    await store.loadRuns();

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].projectName).toBe("Mini Todo");
    expect(store.loading).toBe(false);
  });

  it("creates and selects a run", async () => {
    const created = run();
    vi.mocked(createAgentRun).mockResolvedValue(created);
    vi.mocked(getAgentRun).mockResolvedValue(detail(created));
    vi.mocked(listAgentRuns).mockResolvedValue([summary()]);
    const store = useAgentRunsStore();

    await store.create("fix tests");

    expect(createAgentRun).toHaveBeenCalledWith({ task: "fix tests" });
    expect(store.currentRun?.run.id).toBe("run-1");
    // UX-03：创建后刷新列表，使新条目携带服务端解析的上下文
    await vi.waitFor(() => expect(listAgentRuns).toHaveBeenCalled());
    expect(store.runs[0].projectName).toBe("Mini Todo");
    store.stopRealtime();
  });

  it("cancels the current run", async () => {
    const active = run({ status: "running" });
    const cancelling = run({ status: "cancelling" });
    vi.mocked(cancelAgentRun).mockResolvedValue(cancelling);
    const store = useAgentRunsStore();
    store.currentRun = detail(active);
    store.runs = [summary({ ...active })];

    await store.cancelCurrentRun();

    expect(cancelAgentRun).toHaveBeenCalledWith("run-1");
    expect(store.currentRun.run.status).toBe("cancelling");
    expect(store.runs[0].status).toBe("cancelling");
  });

  it("UX-03: realtime snapshots keep enriched list context and the full detail", () => {
    const store = useAgentRunsStore();
    store.runs = [summary()];

    store.applySnapshot(detail(run({ status: "running" })));

    expect(store.runs[0].status).toBe("running");
    expect(store.runs[0].projectName).toBe("Mini Todo");
    expect(store.runs[0].requirementName).toBe("Todo 管理系统");
    expect(store.currentRun?.artifacts).toEqual([]);
    expect(store.currentRun?.context.projectName).toBeNull();
    store.stopRealtime();
  });
});
