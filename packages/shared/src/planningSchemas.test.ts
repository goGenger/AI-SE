import { describe, expect, it } from "vitest";
import {
  ApiSpecSchema,
  ArchitectureSpecSchema,
  DatabaseSpecSchema,
  RequirementAnalysisSchema,
  SlicePlanSchema,
  TaskPlanSchema,
  UiSpecSchema
} from "./index";

describe("Phase 3 planning schemas", () => {
  it("accepts a valid requirement analysis", () => {
    const result = RequirementAnalysisSchema.safeParse({
      id: "REQ-001",
      summary: "Create Todo management.",
      goals: ["Create Todos"],
      constraints: [],
      assumptions: ["Todos are persisted."],
      acceptanceCriteria: ["Todo can be created."],
      risks: []
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid requirement analysis", () => {
    const result = RequirementAnalysisSchema.safeParse({
      id: "REQ-001",
      summary: "",
      goals: [],
      acceptanceCriteria: []
    });

    expect(result.success).toBe(false);
  });

  it("accepts a valid API spec", () => {
    const result = ApiSpecSchema.safeParse({
      endpoints: [
        {
          method: "POST",
          path: "/api/todos",
          description: "Create Todo",
          request: { title: "string" },
          response: { id: "uuid" },
          errors: ["VALIDATION_ERROR"]
        }
      ]
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid API spec paths", () => {
    const result = ApiSpecSchema.safeParse({
      endpoints: [
        {
          method: "GET",
          path: "api/todos",
          description: "List Todo"
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it("accepts a valid database spec", () => {
    const result = DatabaseSpecSchema.safeParse({
      tables: [
        {
          name: "todos",
          columns: ["id", "title"],
          indexes: [],
          relations: []
        }
      ]
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid database spec", () => {
    const result = DatabaseSpecSchema.safeParse({
      tables: [{ name: "todos", columns: [] }]
    });

    expect(result.success).toBe(false);
  });

  it("accepts empty specs for categories a requirement does not involve", () => {
    // 不涉及 API / 数据库 / 架构 / UI 的需求：空数组是正确输出（禁止为凑数虚构条目）。
    expect(ApiSpecSchema.safeParse({ endpoints: [] }).success).toBe(true);
    expect(DatabaseSpecSchema.safeParse({ tables: [] }).success).toBe(true);
    expect(ArchitectureSpecSchema.safeParse({ components: [], dataFlow: [] }).success).toBe(true);
    expect(UiSpecSchema.safeParse({ pages: [] }).success).toBe(true);
  });

  it("strips unknown page keys from ui specs (vision-influenced extras)", () => {
    const parsed = UiSpecSchema.safeParse({
      pages: [
        {
          name: "Dashboard",
          components: ["StatCard"],
          interactions: ["click"],
          states: ["empty"],
          additionalElements: ["extra"]
        }
      ]
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.pages[0]).toEqual({
        name: "Dashboard",
        components: ["StatCard"],
        interactions: ["click"],
        states: ["empty"]
      });
    }
  });

  it("still rejects malformed entries inside otherwise valid specs", () => {
    expect(
      ApiSpecSchema.safeParse({
        endpoints: [{ method: "GET", path: "no-slash", description: "x" }]
      }).success
    ).toBe(false);
    expect(
      ArchitectureSpecSchema.safeParse({
        components: [{ name: "", responsibility: "x" }],
        dataFlow: ["ok"]
      }).success
    ).toBe(false);
  });

  it("accepts a valid task plan", () => {
    const result = TaskPlanSchema.safeParse({
      summary: "Plan Todo implementation.",
      tasks: [
        {
          id: "TASK-001",
          title: "Design",
          description: "Design Todo flow.",
          type: "DESIGN",
          priority: "HIGH",
          dependencies: [],
          estimatedComplexity: 1,
          acceptanceCriteria: ["Design is clear."],
          sourceSpecTypes: ["ARCHITECTURE"]
        }
      ]
    });

    expect(result.success).toBe(true);
  });

  it("accepts visualBaselineGaps on analysis / UI spec / slice plan and default slice acceptanceCriteria", () => {
    expect(
      RequirementAnalysisSchema.safeParse({
        id: "REQ-001",
        summary: "Create Todo management.",
        goals: ["Create Todos"],
        constraints: [],
        assumptions: ["Todos are persisted."],
        acceptanceCriteria: ["Todo can be created."],
        risks: [],
        visualBaselineGaps: [
          { page: "Todo List", state: "Empty", note: "No official visual baseline was provided." }
        ]
      }).success
    ).toBe(true);

    expect(
      UiSpecSchema.safeParse({
        pages: [
          {
            name: "Todo List",
            components: ["Form"],
            interactions: [],
            states: ["Empty"]
          }
        ],
        visualBaselineGaps: [
          { page: "Todo List", state: "Empty", note: "No official visual baseline was provided." }
        ]
      }).success
    ).toBe(true);

    const slicePlan = SlicePlanSchema.safeParse({
      slices: [
        {
          id: "SLICE-1",
          title: "Core",
          goal: "Deliver the list.",
          frKeys: ["FR-001"],
          dependsOn: [],
          order: 1,
          involvesUi: true,
          involvesData: false
        }
      ],
      milestones: [],
      visualBaselineGaps: [{ page: "Todo List", note: "No official visual baseline was provided." }]
    });
    expect(slicePlan.success).toBe(true);
    if (slicePlan.success) {
      expect(slicePlan.data.slices[0]?.acceptanceCriteria).toEqual([]);
    }
  });

  it("accepts optional frontend encapsulation and apiContractGaps on an API spec", () => {
    const parsed = ApiSpecSchema.safeParse({
      endpoints: [
        {
          method: "GET",
          path: "/api/todos",
          description: "List Todo",
          request: {},
          response: { todos: "Todo[]" },
          errors: []
        }
      ],
      encapsulation: [
        {
          source: "GET /api/todos",
          client: "src/api/todo.ts#listTodos",
          pages: ["Todo List"],
          notes: "Follow the TRD wrapper example."
        }
      ],
      apiContractGaps: []
    });
    expect(parsed.success).toBe(true);

    const gapOnly = ApiSpecSchema.safeParse({
      endpoints: [],
      apiContractGaps: [{ topic: "Todo API", note: "No API contract was provided." }]
    });
    expect(gapOnly.success).toBe(true);
  });
});
