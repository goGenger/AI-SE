import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE, JsonObject, Requirement } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { AgentLifecycleHooks } from "../agent/AgentLifecycle";
import { PlanningModel, PlanningModelRequest } from "./PlanningModel";
import {
  PlanningValidationError,
  runLevel1PlanningGraph,
  runPlanningGraph
} from "./PlanningGraph";
import { createTodoPlanningFixtures, ScriptedPlanningModel } from "./ScriptedPlanningModel";
import { INVENTED_API_ENDPOINT_ERROR_PREFIX } from "./validateConsumedApiSpec";

function requirement(): Requirement {
  const timestamp = new Date().toISOString();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "Todo 管理系统",
    description: "Planning sample",
    rawContent: "创建一个简单的 Todo 管理系统，支持用户创建、查看、修改和删除 Todo。",
    status: "DRAFT",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}


function frontendVueConsumeFixtures() {
  const fixtures = createTodoPlanningFixtures();
  fixtures.architecture = {
    components: [
      {
        name: "Todo Console",
        responsibility: "Render Todo list and editing states.",
        dependencies: ["Todo API client"]
      },
      {
        name: "Todo API client",
        responsibility: "Encapsulate the provided Todo HTTP contract for page use.",
        dependencies: []
      }
    ],
    dataFlow: ["Vue Todo Console calls the Todo API client, which follows the provided TRD wrappers."]
  };
  fixtures.api_spec = {
    endpoints: [
      {
        method: "GET",
        path: "/api/todos",
        description: "List Todo items.",
        request: {},
        response: { todos: "Todo[]" },
        errors: []
      },
      {
        method: "POST",
        path: "/api/todos",
        description: "Create a Todo item.",
        request: { title: "string" },
        response: { id: "uuid", title: "string" },
        errors: ["VALIDATION_ERROR"]
      }
    ],
    encapsulation: [
      {
        source: "GET /api/todos",
        client: "src/api/todo.ts#listTodos",
        pages: ["Todo List"],
        notes: "Follow the TRD wrapper example."
      },
      {
        source: "POST /api/todos",
        client: "src/api/todo.ts#createTodo",
        pages: ["Todo List"],
        notes: "Follow the TRD wrapper example."
      }
    ]
  };
  fixtures.task_planning = {
    summary: "Implement Todo frontend encapsulation, UI, tests, and review.",
    tasks: [
      {
        id: "TASK-001",
        title: "Design Todo frontend encapsulation",
        description: "Confirm how the provided Todo contract is wrapped and wired to pages.",
        type: "DESIGN",
        priority: "HIGH",
        dependencies: [],
        estimatedComplexity: 2,
        acceptanceCriteria: ["Encapsulation design follows the TRD example."],
        sourceSpecTypes: ["REQUIREMENT_ANALYSIS", "API"]
      },
      {
        id: "TASK-002",
        title: "Implement Todo API client and console",
        description: "Add the TRD wrapper functions and wire them to the Todo list page.",
        type: "FRONTEND",
        priority: "HIGH",
        dependencies: ["TASK-001"],
        estimatedComplexity: 4,
        acceptanceCriteria: ["Todo page uses the encapsulated list and create APIs."],
        sourceSpecTypes: ["API", "UI"]
      },
      {
        id: "TASK-003",
        title: "Add Todo frontend tests",
        description: "Cover the encapsulated client and page behavior.",
        type: "TEST",
        priority: "MEDIUM",
        dependencies: ["TASK-002"],
        estimatedComplexity: 3,
        acceptanceCriteria: ["Automated tests cover the planned Todo behavior."],
        sourceSpecTypes: ["FUNCTIONAL", "TECHNICAL"]
      },
      {
        id: "TASK-004",
        title: "Review Todo frontend plan",
        description: "Review the planned encapsulation and page wiring.",
        type: "REVIEW",
        priority: "LOW",
        dependencies: ["TASK-003"],
        estimatedComplexity: 1,
        acceptanceCriteria: ["Review confirms the frontend plan is ready."],
        sourceSpecTypes: ["REQUIREMENT_ANALYSIS"]
      }
    ]
  };
  return fixtures;
}

function lifecycle(events: string[]): AgentLifecycleHooks {
  return {
    async onEvent(record) {
      events.push(record.eventType);
    },
    async onIteration(record) {
      events.push(`iteration:${record.iteration}`);
    }
  };
}

/** 捕获每个阶段收到的提示词，用于断言规划期守卫的提示词接线。 */
class RecordingPlanningModel extends ScriptedPlanningModel {
  readonly prompts: string[] = [];

  async generateStructured<TOutput extends JsonObject>(
    request: PlanningModelRequest<TOutput>
  ): Promise<unknown> {
    this.prompts.push(request.prompt);
    return super.generateStructured(request);
  }
}

describe("PlanningGraph", () => {
  it("runs requirement analysis through specification and task DAG validation", async () => {
    const events: string[] = [];

    const result = await runPlanningGraph({
      profile: BACKEND_NODE_PROFILE,
      agentRunId: "33333333-3333-4333-8333-333333333333",
      taskId: "44444444-4444-4444-8444-444444444444",
      requirement: requirement(),
      model: new ScriptedPlanningModel(),
      lifecycle: lifecycle(events)
    });

    expect(result.requirementAnalysis.summary).toContain("Todo");
    expect(result.functionalSpec.requirements).toHaveLength(4);
    expect(result.taskPlan.tasks.map((task) => task.id)).toContain("TASK-001");
    expect(events).toContain("REQUIREMENT_ANALYSIS_STARTED");
    expect(events).toContain("SPEC_VALIDATION_COMPLETED");
    expect(events).toContain("TASK_DAG_GENERATED");
  });

  it("把用户提供的技术文档带进每个阶段的输入，且与 rawContent 并列（D1）", async () => {
    const inputs: JsonObject[] = [];
    class RecordingInputModel extends ScriptedPlanningModel {
      async generateStructured<TOutput extends JsonObject>(
        request: PlanningModelRequest<TOutput>
      ): Promise<unknown> {
        inputs.push(request.input);
        return super.generateStructured(request);
      }
    }
    const doc = { fileName: "arch.md", text: "既定方案：单体 + SQLite", truncated: false };

    await runPlanningGraph({
      agentRunId: "66666666-6666-4666-8666-666666666666",
      taskId: "77777777-7777-4777-8777-777777777777",
      requirement: requirement(),
      model: new RecordingInputModel(),
      profile: BACKEND_NODE_PROFILE,
      providedTechnicalDocs: [doc]
    });

    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.providedTechnicalDocs).toEqual([doc]);
      // 并列而不合并：技术文档不得出现在 requirement.rawContent 里（那是 AC 解析器的唯一输入）。
      expect(JSON.stringify(input.requirement)).not.toContain("既定方案");
    }
  });

  it("有冲突裁决时带进各阶段输入；缺省时为空数组", async () => {
    const withResolutions: JsonObject[] = [];
    const withoutResolutions: JsonObject[] = [];
    class RecordingInputModel extends ScriptedPlanningModel {
      constructor(private readonly sink: JsonObject[]) {
        super();
      }
      async generateStructured<TOutput extends JsonObject>(
        request: PlanningModelRequest<TOutput>
      ): Promise<unknown> {
        this.sink.push(request.input);
        return super.generateStructured(request);
      }
    }
    const resolution = {
      topic: "auth",
      source: "trd.md",
      prdSays: "JWT",
      documentSays: "session",
      choice: "FOLLOW_PRD" as const
    };

    await runPlanningGraph({
      agentRunId: "66666666-6666-4666-8666-666666666611",
      taskId: "77777777-7777-4777-8777-777777777711",
      requirement: requirement(),
      model: new RecordingInputModel(withResolutions),
      profile: BACKEND_NODE_PROFILE,
      conflictResolutions: [resolution]
    });
    await runPlanningGraph({
      agentRunId: "66666666-6666-4666-8666-666666666612",
      taskId: "77777777-7777-4777-8777-777777777712",
      requirement: requirement(),
      model: new RecordingInputModel(withoutResolutions),
      profile: BACKEND_NODE_PROFILE
    });

    expect(withResolutions.length).toBeGreaterThan(0);
    for (const input of withResolutions) {
      expect(input.conflictResolutions).toEqual([resolution]);
    }
    expect(withoutResolutions.length).toBeGreaterThan(0);
    for (const input of withoutResolutions) {
      expect(input.conflictResolutions).toEqual([]);
    }
  });

  it("有 UI 参照图时带进各阶段输入；缺省时为空数组", async () => {
    const withImages: JsonObject[] = [];
    const withoutImages: JsonObject[] = [];
    class RecordingInputModel extends ScriptedPlanningModel {
      constructor(private readonly sink: JsonObject[]) {
        super();
      }
      async generateStructured<TOutput extends JsonObject>(
        request: PlanningModelRequest<TOutput>
      ): Promise<unknown> {
        this.sink.push(request.input);
        return super.generateStructured(request);
      }
    }
    const ui = {
      fileName: "home.png",
      mimeType: "image/png",
      note: "[UI reference image: home.png]",
      base64: "aaa"
    };

    await runPlanningGraph({
      agentRunId: "66666666-6666-4666-8666-666666666601",
      taskId: "77777777-7777-4777-8777-777777777701",
      requirement: requirement(),
      model: new RecordingInputModel(withImages),
      profile: BACKEND_NODE_PROFILE,
      providedUiReferences: [ui]
    });
    await runPlanningGraph({
      agentRunId: "66666666-6666-4666-8666-666666666602",
      taskId: "77777777-7777-4777-8777-777777777702",
      requirement: requirement(),
      model: new RecordingInputModel(withoutImages),
      profile: BACKEND_NODE_PROFILE
    });

    expect(withImages.length).toBeGreaterThan(0);
    for (const input of withImages) {
      expect(input.providedUiReferences).toEqual([ui]);
      expect(JSON.stringify(input.requirement)).not.toContain("home.png");
    }
    expect(withoutImages.length).toBeGreaterThan(0);
    for (const input of withoutImages) {
      expect(input.providedUiReferences).toEqual([]);
    }
  });

  it("repairs invalid structured output and continues", async () => {
    const events: string[] = [];

    const result = await runPlanningGraph({
      profile: BACKEND_NODE_PROFILE,
      agentRunId: "55555555-5555-4555-8555-555555555555",
      taskId: "66666666-6666-4666-8666-666666666666",
      requirement: requirement(),
      model: new ScriptedPlanningModel(undefined, ["functional_spec"]),
      lifecycle: lifecycle(events)
    });

    expect(result.functionalSpec.requirements[0].id).toBe("FR-001");
    expect(events).toContain("PLANNING_SCHEMA_VALIDATION_FAILED");
    expect(events).toContain("PLANNING_REPAIR_COMPLETED");
  });
  it("rejects delivery-chain plans and drops the delivery requirement when the project has no repository bound", async () => {
    const events: string[] = [];
    const model = new RecordingPlanningModel();

    // 默认夹具（Todo）本身以 CI / DEPLOY / VERIFY / DEPLOY 收尾 —— 正是运行期必然
    // REPOSITORY_NOT_CONFIGURED 的形状；未绑定仓库时必须被规划期守卫拦下。
    await expect(
      runPlanningGraph({
        profile: BACKEND_NODE_PROFILE,
        agentRunId: "77777777-7777-4777-8777-777777777777",
        taskId: "88888888-8888-4888-8888-888888888888",
        requirement: requirement(),
        model,
        lifecycle: lifecycle(events),
        deliveryConfigured: false
      })
    ).rejects.toThrow(/no Git repository bound/);

    // 提示词同步切换：不再要求以交付链收尾。
    const taskPlanningPrompt = model.prompts.at(-1) ?? "";
    expect(taskPlanningPrompt).toContain("NO Git repository bound");
    expect(taskPlanningPrompt).not.toContain("End delivery-ready plans");
    expect(events).toContain("TASK_DAG_VALIDATION_FAILED");
    expect(events).toContain("PLANNING_REPAIR_REQUESTED");
  });

  it("keeps the delivery-chain requirement when a repository is bound", async () => {
    const events: string[] = [];
    const model = new RecordingPlanningModel();

    await runPlanningGraph({
      profile: BACKEND_NODE_PROFILE,
      agentRunId: "99999999-9999-4999-8999-999999999999",
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      requirement: requirement(),
      model,
      lifecycle: lifecycle(events),
      deliveryConfigured: true
    });

    expect(model.prompts.at(-1) ?? "").toContain("End delivery-ready plans");
  });

  /**
   * N-30（`docs/213`）：`validateImplementationCoverage` 要求每个 Must AC 被**实现类**任务覆盖，
   * 而这条规则此前**从未写进提示词**——规划器只能靠猜。实测 L1-M4r run 3：最终切片的 5 条容器/构建类
   * AC 连续三轮修复都覆盖不上，整次运行止步于切片 3 规划。提示词必须点名这条要求。
   */
  it("tells the planner that every Must AC needs an implementation task (N-30)", async () => {
    const events: string[] = [];
    const model = new RecordingPlanningModel();

    await runPlanningGraph({
      profile: BACKEND_NODE_PROFILE,
      agentRunId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      taskId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      requirement: requirement(),
      model,
      lifecycle: lifecycle(events),
      acceptanceCriteria: [
        {
          acKey: "AC-24",
          text: "`docker build` 成功；`docker run` 后健康端点可达",
          priority: "Must",
          verification: "容器运行",
          smoke: false,
          frKeys: []
        }
      ],
      isFinalSlice: true
    }).catch(() => undefined);

    const taskPlanningPrompt =
      model.prompts.find((prompt) => prompt.includes("Acceptance criteria coverage")) ?? "";
    expect(taskPlanningPrompt).toContain(
      "at least one implementation task (BACKEND, FRONTEND or DATABASE)"
    );
    expect(taskPlanningPrompt).toContain(
      "TEST, REVIEW, BUILD and DEPLOY tasks do not satisfy this"
    );
  });

  it("level1：analysis + slice_planning 覆盖检查通过并产出切片计划", async () => {
    const events: string[] = [];

    const result = await runLevel1PlanningGraph({
      agentRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      taskId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      requirement: requirement(),
      model: new ScriptedPlanningModel(),
      lifecycle: lifecycle(events)
    });

    expect(result.slicePlan.slices.map((slice) => slice.id)).toEqual(["SLICE-1", "SLICE-2"]);
    expect(events).toContain("SLICE_PLANNING_STARTED");
    expect(events).toContain("SLICE_PLAN_GENERATED");
    expect(events).toContain("SLICE_PLANNING_COMPLETED");
  });

  it("覆盖检查反例：漏 FR / 虚构 FR 先红后重做，重做后恢复", async () => {
    const events: string[] = [];
    const badPlan = {
      slices: [
        {
          id: "SLICE-1",
          title: "坏计划",
          goal: "漏掉全部 FR 且含虚构编号。",
          frKeys: ["FR-999"],
          dependsOn: [],
          order: 1,
          involvesUi: true
        }
      ],
      milestones: []
    };

    class CoverageRepairModel extends ScriptedPlanningModel {
      sliceAttempts = 0;

      override async generateStructured<TOutput extends JsonObject>(
        request: PlanningModelRequest<TOutput>
      ): Promise<unknown> {
        if (request.stage === "slice_planning") {
          this.sliceAttempts += 1;
          if (this.sliceAttempts === 1) {
            return badPlan;
          }
        }
        return super.generateStructured(request);
      }
    }

    const model = new CoverageRepairModel();
    const result = await runLevel1PlanningGraph({
      agentRunId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      taskId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      requirement: requirement(),
      model,
      lifecycle: lifecycle(events)
    });

    expect(model.sliceAttempts).toBe(2);
    expect(result.slicePlan.slices).toHaveLength(2);
    expect(events).toContain("SLICE_PLAN_VALIDATION_FAILED");
    expect(events).toContain("SLICE_PLAN_REDO_REQUESTED");
  });

  it("覆盖检查耗尽重做上限后失败并保留覆盖错误", async () => {
    class AlwaysBadSliceModel extends ScriptedPlanningModel {
      override async generateStructured<TOutput extends JsonObject>(
        request: PlanningModelRequest<TOutput>
      ): Promise<unknown> {
        if (request.stage === "slice_planning") {
          return {
            slices: [
              {
                id: "SLICE-1",
                title: "永远漏 FR",
                goal: "只覆盖 FR-001。",
                frKeys: ["FR-001"],
                dependsOn: [],
                order: 1,
                involvesUi: true
              }
            ],
            milestones: []
          };
        }
        return super.generateStructured(request);
      }
    }

    const events: string[] = [];
    await expect(
      runLevel1PlanningGraph({
        agentRunId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        taskId: "11111111-2222-4333-8444-555555555555",
        requirement: requirement(),
        model: new AlwaysBadSliceModel(),
        lifecycle: lifecycle(events)
      })
    ).rejects.toThrow(/Slice plan coverage validation failed/);

    expect(events.filter((event) => event === "SLICE_PLAN_VALIDATION_FAILED")).toHaveLength(3);
  });

  it("level2：单切片第二级支持跳过 ui_spec 并发跳过事件", async () => {
    const events: string[] = [];
    const fixtures = createTodoPlanningFixtures();
    fixtures.slice_planning = {
      slices: [
        {
          id: "SLICE-1",
          title: "纯后端切片",
          goal: "只交付后端与存储。",
          frKeys: ["FR-001"],
          dependsOn: [],
          order: 1,
          involvesUi: false,
          acceptanceCriteria: []
        }
      ],
      milestones: []
    };

    const result = await runPlanningGraph({
      profile: BACKEND_NODE_PROFILE,
      agentRunId: "22222222-3333-4444-8555-666666666666",
      taskId: "33333333-4444-4555-8666-777777777777",
      requirement: requirement(),
      model: new ScriptedPlanningModel(fixtures),
      lifecycle: lifecycle(events),
      pipeline: "level2",
      slice: {
        key: "SLICE-1",
        title: "纯后端切片",
        goal: "只交付后端与存储。",
        frKeys: ["FR-001"]
      },
      skipStages: ["ui_spec"],
      seedAnalysis: fixtures.requirement_analysis
    });

    expect(result.uiSpec).toBeUndefined();
    expect(result.taskPlan.tasks.length).toBeGreaterThan(0);
    expect(events).toContain("SLICE_STAGE_SKIPPED");
    expect(events).toContain("SPEC_VALIDATION_COMPLETED");
    expect(events).not.toContain("UI_SPEC_GENERATION_STARTED");
  });

  it("G2：level2 支持跳过 database_spec（involvesData=false 切片）并发跳过事件", async () => {
    const events: string[] = [];
    const fixtures = createTodoPlanningFixtures();
    fixtures.slice_planning = {
      slices: [
        {
          id: "SLICE-1",
          title: "无数据变更切片",
          goal: "仅脚本与文档，无数据层变更。",
          frKeys: ["FR-001"],
          dependsOn: [],
          order: 1,
          involvesUi: false,
          acceptanceCriteria: []
        }
      ],
      milestones: []
    };

    const result = await runPlanningGraph({
      profile: BACKEND_NODE_PROFILE,
      agentRunId: "22222222-3333-4444-8555-666666666667",
      taskId: "33333333-4444-4555-8666-777777777778",
      requirement: requirement(),
      model: new ScriptedPlanningModel(fixtures),
      lifecycle: lifecycle(events),
      pipeline: "level2",
      slice: {
        key: "SLICE-1",
        title: "无数据变更切片",
        goal: "仅脚本与文档，无数据层变更。",
        frKeys: ["FR-001"]
      },
      skipStages: ["ui_spec", "database_spec"],
      seedAnalysis: fixtures.requirement_analysis
    });

    expect(result.databaseSpec).toBeUndefined();
    expect(result.uiSpec).toBeUndefined();
    expect(result.taskPlan.tasks.length).toBeGreaterThan(0);
    expect(events).toContain("SLICE_STAGE_SKIPPED");
    expect(events).toContain("SPEC_VALIDATION_COMPLETED");
    expect(events).not.toContain("DATABASE_SPEC_GENERATION_STARTED");
    expect(events).not.toContain("UI_SPEC_GENERATION_STARTED");
  });

  it("N4 测试先行：补边成环 → 不自动修复（记录环路径）→ LLM 重做后恢复", async () => {
    const events: string[] = [];
    const records: Array<{ eventType: string; payload: JsonObject }> = [];
    const numbered: Requirement = {
      ...requirement(),
      rawContent: [
        "## 验收标准",
        "",
        "### FR-001 创建",
        "",
        "| 编号 | 验收标准 | 优先级 | 验证方式 | smoke |",
        "| --- | --- | --- | --- | --- |",
        "| AC-01 | 创建成功返回 201。 | Must | 单测 | 是 |",
        "| AC-02 | 查询返回列表。 | Should | 单测 | 否 |"
      ].join("\n")
    };
    const fixtures = createTodoPlanningFixtures();

    const writeTests = {
      id: "TASK-001",
      title: "写 AC 测试",
      description: "先写 AC 编号测试并展示红灯。",
      type: "TEST",
      priority: "HIGH",
      dependencies: [] as string[],
      estimatedComplexity: 2,
      acceptanceCriteria: ["AC-01/AC-02 测试先行"],
      acKeys: ["AC-01", "AC-02"],
      sourceSpecTypes: ["REQUIREMENT_ANALYSIS"]
    };
    const backendTask = {
      id: "TASK-002",
      title: "实现创建",
      description: "实现创建端点。",
      type: "BACKEND",
      priority: "HIGH",
      dependencies: [] as string[],
      estimatedComplexity: 3,
      acceptanceCriteria: ["创建可用"],
      acKeys: ["AC-01"],
      sourceSpecTypes: ["REQUIREMENT_ANALYSIS"]
    };
    // F1-3：测试任务反向依赖实现任务 → 补边会成环 → 不自动修复、记录环路径 → 走 LLM 修复。
    // N-46（`docs/232` §9.9）：中间的 BUILD 任务让这条环上**没有**可断的「测试依赖实现」倒置边，
    // 用例才仍然落在「交 LLM 修复轮」这条路径上（有倒置边的形状现在由规则 1 同轮修好）。
    const batchTask = {
      id: "TASK-003",
      title: "产出构建物",
      description: "构建。",
      type: "BUILD",
      priority: "MEDIUM",
      dependencies: ["TASK-002"],
      estimatedComplexity: 2,
      acceptanceCriteria: ["构建成功"],
      sourceSpecTypes: ["REQUIREMENT_ANALYSIS"]
    };
    const badPlan = {
      summary: "测试任务经 BUILD 反向依赖实现任务（补边成环）",
      tasks: [{ ...writeTests, dependencies: ["TASK-003"] }, backendTask, batchTask]
    };
    const fixedPlan = {
      summary: "测试先行恢复",
      tasks: [writeTests, { ...backendTask, dependencies: ["TASK-001"] }, batchTask]
    };

    class TestFirstRepairModel extends ScriptedPlanningModel {
      taskPlanAttempts = 0;

      override async generateStructured<TOutput extends JsonObject>(
        request: PlanningModelRequest<TOutput>
      ): Promise<unknown> {
        if (request.stage === "task_planning") {
          this.taskPlanAttempts += 1;
          return this.taskPlanAttempts === 1 ? badPlan : fixedPlan;
        }
        return super.generateStructured(request);
      }
    }

    const model = new TestFirstRepairModel();
    const result = await runPlanningGraph({
      profile: BACKEND_NODE_PROFILE,
      agentRunId: "66666666-7777-4888-8999-000000000000",
      taskId: "77777777-8888-4999-8000-111111111111",
      requirement: numbered,
      model,
      lifecycle: {
        async onEvent(record) {
          events.push(record.eventType);
          records.push({ eventType: record.eventType, payload: record.payload });
        }
      },
      pipeline: "level2",
      slice: { key: "SLICE-1", title: "创建切片", goal: "交付创建能力。", frKeys: ["FR-001"] },
      skipStages: ["ui_spec"],
      seedAnalysis: fixtures.requirement_analysis
    });

    expect(model.taskPlanAttempts).toBe(2);
    expect(events).toContain("TASK_DAG_VALIDATION_FAILED");
    expect(events).toContain("PLANNING_REPAIR_REQUESTED");

    const autoFixed = records.filter((entry) => entry.eventType === "PLAN_AUTOFIXED");
    expect(autoFixed).toHaveLength(1);
    expect(autoFixed[0]?.payload).toMatchObject({
      rule: "test-first-edge",
      status: "cycle-blocked",
      implementationTaskId: "TASK-002",
      testTaskId: "TASK-001",
      cyclePath: ["TASK-001", "TASK-002", "TASK-003", "TASK-001"]
    });

    const backend = result.taskPlan.tasks.find((task) => task.id === "TASK-002");
    expect(backend?.dependencies).toContain("TASK-001");
    expect(result.taskPlan.tasks.find((task) => task.id === "TASK-001")?.dependencies).toEqual([]);
  });

  it("阶段级预算：慢阶段被墙钟中止（重试 0 次即有界失败）", async () => {
    const events: string[] = [];

    class SlowModel implements PlanningModel {
      async generateStructured<TOutput extends JsonObject>(
        request: PlanningModelRequest<TOutput>
      ): Promise<unknown> {
        await new Promise((resolve) => setTimeout(resolve, 60));
        if (request.signal?.aborted) {
          throw new Error("aborted by stage budget");
        }
        return new ScriptedPlanningModel().generateStructured(request);
      }
    }

    await expect(
      runLevel1PlanningGraph({
        agentRunId: "44444444-5555-4666-8777-888888888888",
        taskId: "55555555-6666-4777-8888-999999999999",
        requirement: requirement(),
        model: new SlowModel(),
        lifecycle: lifecycle(events),
        stageTimeoutMs: 10,
        stageRetries: 0
      })
    ).rejects.toThrow(/Planning stage timed out: requirement_analysis/);

    expect(events).toContain("PLANNING_STAGE_TIMEOUT");
  });

  it("frontend-vue still runs api_spec in consume mode and keeps TRD encapsulation as FRONTEND work", async () => {
    const events: string[] = [];
    const model = new RecordingPlanningModel(frontendVueConsumeFixtures());
    const trd = {
      fileName: "trd.md",
      text: [
        "Frontend encapsulation example:",
        "export function listTodos() { return request.get('/api/todos'); }",
        "export function createTodo(title) { return request.post('/api/todos', { title }); }"
      ].join("\n"),
      truncated: false
    };

    const result = await runPlanningGraph({
      profile: FRONTEND_VUE_PROFILE,
      agentRunId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1",
      taskId: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbb1",
      requirement: requirement(),
      model,
      lifecycle: lifecycle(events),
      pipeline: "level2",
      slice: {
        key: "SLICE-1",
        title: "Todo 核心读写",
        goal: "交付创建与查看 Todo 的最小可用切片。",
        frKeys: ["FR-001", "FR-002"]
      },
      skipStages: ["database_spec"],
      seedAnalysis: createTodoPlanningFixtures().requirement_analysis,
      providedTechnicalDocs: [trd],
      deliveryConfigured: false
    });

    expect(events).toContain("API_SPEC_GENERATION_STARTED");
    expect(events).toContain("API_SPEC_GENERATION_COMPLETED");
    expect(events).not.toContain("DATABASE_SPEC_GENERATION_STARTED");
    expect(result.apiSpec.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual([
      "GET /api/todos",
      "POST /api/todos"
    ]);
    expect(result.apiSpec.encapsulation).toEqual([
      {
        source: "GET /api/todos",
        client: "src/api/todo.ts#listTodos",
        pages: ["Todo List"],
        notes: "Follow the TRD wrapper example."
      },
      {
        source: "POST /api/todos",
        client: "src/api/todo.ts#createTodo",
        pages: ["Todo List"],
        notes: "Follow the TRD wrapper example."
      }
    ]);
    expect(result.taskPlan.tasks.map((task) => task.type)).toEqual(["DESIGN", "FRONTEND", "TEST", "REVIEW"]);
    expect(result.taskPlan.tasks.some((task) => /BACKEND|DATABASE/.test(task.type))).toBe(false);

    const apiPrompt = model.prompts.find((prompt) => prompt.includes("Output Schema: ApiSpec.")) ?? "";
    expect(apiPrompt).toContain("Frontend API encapsulation planner");
    const architecturePrompt = model.prompts.find((prompt) =>
      prompt.includes("Output Schema: ArchitectureSpec.")
    ) ?? "";
    expect(architecturePrompt).toContain("Do not invent backend services, databases, or a server-side API");
  });

  it("frontend-vue rejects an invented backend API when no contract grounds the endpoints", async () => {
    const events: string[] = [];
    const fixtures = createTodoPlanningFixtures();

    await expect(
      runPlanningGraph({
        profile: FRONTEND_VUE_PROFILE,
        agentRunId: "aaaaaaaa-2222-4222-8222-aaaaaaaaaaa2",
        taskId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2",
        requirement: requirement(),
        model: new ScriptedPlanningModel(fixtures),
        lifecycle: lifecycle(events),
        pipeline: "level2",
        slice: {
          key: "SLICE-1",
          title: "Todo 核心读写",
          goal: "交付创建与查看 Todo 的最小可用切片。",
          frKeys: ["FR-001", "FR-002"]
        },
        skipStages: ["database_spec", "ui_spec"],
        seedAnalysis: fixtures.requirement_analysis,
        maxValidationRetries: 0
      })
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PlanningValidationError);
      expect((error as PlanningValidationError).message).toMatch(
        /Structured output validation failed at api_spec/
      );
      expect((error as PlanningValidationError).validationErrors[0]).toContain(
        INVENTED_API_ENDPOINT_ERROR_PREFIX
      );
      return true;
    });

    expect(events).toContain("API_SPEC_GENERATION_STARTED");
    expect(events).toContain("PLANNING_SCHEMA_VALIDATION_FAILED");
    expect(events).not.toContain("API_SPEC_GENERATION_COMPLETED");
  });
});
