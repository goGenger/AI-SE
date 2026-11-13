import {
  AgentRun,
  AgentRunDetailView,
  Requirement,
  RequirementTasksView,
  Specification
} from "@ai-se/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentRun, listAgentRuns } from "../../api/agentRuns";
import {
  analyzeRequirement,
  createRequirement,
  getRequirement,
  listRequirementAcceptanceCriteria,
  listRequirementConflictResolutions,
  listRequirementSlices,
  listRequirementSpecifications,
  listRequirementTasks,
  listRequirementTraceability,
  listRequirements,
  startRequirementSliceWorkflow
} from "../../api/requirements";
import { useRequirementsStore } from "../requirements";

vi.mock("../../api/agentRuns", () => ({
  getAgentRun: vi.fn(),
  listAgentRuns: vi.fn(),
  openAgentRunStream: vi.fn()
}));

vi.mock("../../api/requirements", () => ({
  analyzeRequirement: vi.fn(),
  createRequirement: vi.fn(),
  getRequirement: vi.fn(),
  listRequirementAcceptanceCriteria: vi.fn(),
  listRequirementConflictResolutions: vi.fn(),
  listRequirementSlices: vi.fn(),
  listRequirementSpecifications: vi.fn(),
  listRequirementTasks: vi.fn(),
  listRequirementTraceability: vi.fn(),
  listRequirements: vi.fn(),
  startRequirementSliceWorkflow: vi.fn()
}));

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  const timestamp = new Date().toISOString();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "Todo",
    description: "",
    rawContent: "Create Todo CRUD.",
    status: "DRAFT",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function specification(): Specification {
  const timestamp = new Date().toISOString();
  return {
    id: "spec-1",
    projectId: "project-1",
    requirementId: "requirement-1",
    type: "API",
    version: 1,
    status: "VALIDATED",
    content: { endpoints: [] },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function taskGraph(): RequirementTasksView {
  return {
    tasks: [],
    dependencies: []
  };
}

function agentRun(): AgentRun {
  const timestamp = new Date().toISOString();
  return {
    id: "33333333-3333-4333-8333-333333333333",
    taskId: "44444444-4444-4444-8444-444444444444",
    status: "running",
    input: { runtime: "planning-agent", requirementId: requirement().id },
    currentIteration: 1,
    maxIterations: 8,
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function agentRunDetail(run = agentRun()): AgentRunDetailView {
  return {
    run,
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

describe("requirements store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(listAgentRuns).mockResolvedValue([]);
    vi.mocked(listRequirementConflictResolutions).mockResolvedValue([]);
  });

  it("loads requirements for a project", async () => {
    vi.mocked(listRequirements).mockResolvedValue([requirement()]);
    const store = useRequirementsStore();

    await store.loadRequirements(requirement().projectId);

    expect(store.requirements).toHaveLength(1);
    expect(store.loading).toBe(false);
  });

  it("creates and selects a requirement", async () => {
    const created = requirement();
    vi.mocked(createRequirement).mockResolvedValue(created);
    vi.mocked(getRequirement).mockResolvedValue(created);
    vi.mocked(listRequirementSpecifications).mockResolvedValue([specification()]);
    vi.mocked(listRequirementTasks).mockResolvedValue(taskGraph());
    vi.mocked(listRequirementSlices).mockResolvedValue({ slices: [], approval: null });
    vi.mocked(listRequirementAcceptanceCriteria).mockResolvedValue({ criteria: [] });
    vi.mocked(listRequirementTraceability).mockResolvedValue({
      requirementId: created.id,
      generatedAt: "",
      summary: { total: 0, passed: 0, failed: 0, unverified: 0, noTest: 0 },
      criteria: []
    });
    const store = useRequirementsStore();

    await store.createRequirement(created.projectId, {
      title: "Todo",
      rawContent: "Create Todo CRUD."
    });

    expect(createRequirement).toHaveBeenCalledWith(created.projectId, {
      title: "Todo",
      rawContent: "Create Todo CRUD."
    });
    expect(store.selectedRequirement?.id).toBe(created.id);
    expect(store.specifications).toHaveLength(1);
    expect(store.slices.slices).toHaveLength(0);
    expect(store.acceptanceCriteria.criteria).toHaveLength(0);
    expect(store.traceability.criteria).toHaveLength(0);
  });

  it("loads acceptance criteria with task mapping counts (N3)", async () => {
    const selected = requirement();
    vi.mocked(getRequirement).mockResolvedValue(selected);
    vi.mocked(listRequirementSpecifications).mockResolvedValue([]);
    vi.mocked(listRequirementTasks).mockResolvedValue(taskGraph());
    vi.mocked(listRequirementSlices).mockResolvedValue({ slices: [], approval: null });
    vi.mocked(listRequirementTraceability).mockResolvedValue({
      requirementId: selected.id,
      generatedAt: "",
      summary: { total: 0, passed: 0, failed: 0, unverified: 0, noTest: 0 },
      criteria: []
    });
    vi.mocked(listRequirementAcceptanceCriteria).mockResolvedValue({
      criteria: [
        {
          acKey: "AC-01",
          text: "注册成功返回 201。",
          priority: "Must",
          verification: "HTTP 断言",
          smoke: true,
          frKeys: ["FR-1"],
          mappingCount: 2
        }
      ]
    });
    const store = useRequirementsStore();

    await store.loadRequirement(selected.id);

    expect(store.acceptanceCriteria.criteria).toHaveLength(1);
    expect(store.acceptanceCriteria.criteria[0]).toMatchObject({
      acKey: "AC-01",
      priority: "Must",
      smoke: true,
      mappingCount: 2
    });
  });

  it("loads the traceability table for the selected requirement (N5)", async () => {
    const selected = requirement();
    vi.mocked(getRequirement).mockResolvedValue(selected);
    vi.mocked(listRequirementSpecifications).mockResolvedValue([]);
    vi.mocked(listRequirementTasks).mockResolvedValue(taskGraph());
    vi.mocked(listRequirementSlices).mockResolvedValue({ slices: [], approval: null });
    vi.mocked(listRequirementAcceptanceCriteria).mockResolvedValue({ criteria: [] });
    vi.mocked(listRequirementTraceability).mockResolvedValue({
      requirementId: selected.id,
      generatedAt: "2026-10-06T13:00:00.000Z",
      summary: { total: 1, passed: 1, failed: 0, unverified: 0, noTest: 0 },
      criteria: [
        {
          acKey: "AC-01",
          text: "注册成功返回 201。",
          priority: "Must",
          smoke: true,
          frKeys: ["FR-1"],
          status: "passed",
          tests: [
            {
              taskKey: "S1-T13",
              taskType: "TEST",
              expected: "pass",
              result: "passed",
              command: "npm run test",
              exitCode: 0
            }
          ]
        }
      ]
    });
    const store = useRequirementsStore();

    await store.loadRequirement(selected.id);

    expect(store.traceability.criteria).toHaveLength(1);
    expect(store.traceability.criteria[0]).toMatchObject({
      acKey: "AC-01",
      status: "passed"
    });
    expect(store.traceability.summary.passed).toBe(1);
    expect(store.traceability.criteria[0]?.tests[0]?.taskKey).toBe("S1-T13");
  });

  it("starts analysis and loads the agent run", async () => {
    const selected = requirement({ status: "ANALYZED" });
    vi.mocked(analyzeRequirement).mockResolvedValue({
      requirementId: selected.id,
      agentRunId: agentRun().id,
      status: "ANALYZING",
      version: 2,
      accepted: true
    });
    vi.mocked(getAgentRun).mockResolvedValue(agentRunDetail());
    const store = useRequirementsStore();
    store.requirements = [selected];
    store.selectedRequirement = selected;

    const result = await store.analyzeSelectedRequirement();

    expect(result?.accepted).toBe(true);
    expect(store.selectedRequirement.status).toBe("ANALYZING");
    expect(store.selectedRequirement.version).toBe(2);
    // 列表与详情必须同步，避免「列表已分析 / 详情分析中」。
    expect(store.requirements[0]?.status).toBe("ANALYZING");
    expect(store.requirements[0]?.version).toBe(2);
    expect(store.currentAgentRun?.run.id).toBe(agentRun().id);
    store.stopRealtime();
  });

  it("loadRequirement syncs list status and attaches latest planning run", async () => {
    const selected = requirement({ status: "ANALYZING" });
    const stale = requirement({ status: "ANALYZED" });
    const run = agentRun();
    vi.mocked(getRequirement).mockResolvedValue(selected);
    vi.mocked(listRequirementSpecifications).mockResolvedValue([]);
    vi.mocked(listRequirementTasks).mockResolvedValue(taskGraph());
    vi.mocked(listRequirementSlices).mockResolvedValue({ slices: [], approval: null });
    vi.mocked(listRequirementAcceptanceCriteria).mockResolvedValue({ criteria: [] });
    vi.mocked(listRequirementTraceability).mockResolvedValue({
      requirementId: selected.id,
      generatedAt: "",
      summary: { total: 0, passed: 0, failed: 0, unverified: 0, noTest: 0 },
      criteria: []
    });
    vi.mocked(listAgentRuns).mockResolvedValue([
      {
        ...run,
        projectName: null,
        workflowRunId: null,
        requirementName: selected.title,
        planningVersion: 1,
        taskKey: null,
        taskTitle: null,
        agentName: null,
        agentType: null
      }
    ]);
    vi.mocked(getAgentRun).mockResolvedValue(agentRunDetail(run));

    const store = useRequirementsStore();
    store.requirements = [stale];
    await store.loadRequirement(selected.id);

    expect(store.selectedRequirement?.status).toBe("ANALYZING");
    expect(store.requirements[0]?.status).toBe("ANALYZING");
    expect(store.currentAgentRun?.run.id).toBe(run.id);
    store.stopRealtime();
  });

  it("starts a planned slice workflow via start-workflow API (sliceKey wiring)", async () => {
    const selected = requirement({ status: "ANALYZED" });
    vi.mocked(startRequirementSliceWorkflow).mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      projectId: selected.projectId,
      requirementId: selected.id,
      planningVersion: 2,
      status: "PENDING",
      policy: {
        maxConcurrency: 1,
        maxRetries: 0,
        failureStrategy: "FAIL_FAST",
        allowRetry: false,
        allowReplan: false,
        approvalRequired: false
      },
      input: { sliceKey: "slice-1-foundation" },
      createdAt: selected.createdAt,
      updatedAt: selected.updatedAt
    } as never);
    vi.mocked(getRequirement).mockResolvedValue(selected);
    vi.mocked(listRequirementSpecifications).mockResolvedValue([]);
    vi.mocked(listRequirementTasks).mockResolvedValue(taskGraph());
    vi.mocked(listRequirementSlices).mockResolvedValue({
      slices: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          projectId: selected.projectId,
          requirementId: selected.id,
          planningVersion: 2,
          sliceKey: "slice-1-foundation",
          title: "foundation",
          goal: "boot",
          frKeys: ["FR-01"],
          dependsOn: [],
          order: 1,
          involvesUi: true,
          status: "RUNNING",
          workflowRunId: "33333333-3333-4333-8333-333333333333",
          createdAt: selected.createdAt,
          updatedAt: selected.updatedAt
        }
      ],
      approval: null
    });
    vi.mocked(listRequirementAcceptanceCriteria).mockResolvedValue({ criteria: [] });
    vi.mocked(listRequirementTraceability).mockResolvedValue({
      requirementId: selected.id,
      generatedAt: "",
      summary: { total: 0, passed: 0, failed: 0, unverified: 0, noTest: 0 },
      criteria: []
    });

    const store = useRequirementsStore();
    store.selectedRequirement = selected;
    const workflow = await store.startSliceWorkflow("slice-1-foundation");

    expect(startRequirementSliceWorkflow).toHaveBeenCalledWith(
      selected.id,
      "slice-1-foundation",
      {}
    );
    expect(workflow?.id).toBe("33333333-3333-4333-8333-333333333333");
    expect(store.slices.slices[0]?.status).toBe("RUNNING");
  });
});
