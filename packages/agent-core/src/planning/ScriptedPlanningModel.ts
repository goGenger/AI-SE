import {
  ApiSpecContent,
  ArchitectureSpecContent,
  DatabaseSpecContent,
  FunctionalSpecContent,
  JsonObject,
  RequirementAnalysis,
  SlicePlan,
  TaskPlan,
  TechnicalSpecContent,
  UiSpecContent
} from "@ai-se/shared";
import { PlanningModel, PlanningModelRequest } from "./PlanningModel";
import { PlanningStage } from "./PlanningState";

export interface PlanningFixtures {
  requirement_analysis: RequirementAnalysis;
  slice_planning: SlicePlan;
  functional_spec: FunctionalSpecContent;
  technical_spec: TechnicalSpecContent;
  architecture: ArchitectureSpecContent;
  api_spec: ApiSpecContent;
  database_spec: DatabaseSpecContent;
  ui_spec: UiSpecContent;
  task_planning: TaskPlan;
}

export function createTodoPlanningFixtures(): PlanningFixtures {
  return {
    requirement_analysis: {
      id: "REQ-ANALYSIS-001",
      summary: "Todo management with create, view, update, and delete operations.",
      goals: ["Manage Todo items through a simple application flow."],
      constraints: ["Only plan the software work; do not implement code in Phase 3."],
      assumptions: ["Todo items need a persisted title, completion state, and timestamps."],
      acceptanceCriteria: [
        "Users can create Todo items.",
        "Users can view Todo items.",
        "Users can update Todo items.",
        "Users can delete Todo items."
      ],
      risks: ["Ambiguous authentication requirements are treated as out of scope."],
      functionalRequirements: [
        { id: "FR-001", title: "Create Todo" },
        { id: "FR-002", title: "View Todos" },
        { id: "FR-003", title: "Update Todo" },
        { id: "FR-004", title: "Delete Todo" }
      ],
      visualBaselineGaps: [
        {
          page: "Todo List",
          state: "Empty",
          note: "No official visual baseline was provided for the Todo List empty state."
        }
      ]
    },
    slice_planning: {
      slices: [
        {
          id: "SLICE-1",
          title: "Todo 核心读写",
          goal: "交付创建与查看 Todo 的最小可用切片。",
          frKeys: ["FR-001", "FR-002"],
          dependsOn: [],
          order: 1,
          involvesUi: true,
          involvesData: false,
          acceptanceCriteria: [
            "Users can create and view Todo items, verified by a named acceptance check."
          ]
        },
        {
          id: "SLICE-2",
          title: "Todo 编辑与删除",
          goal: "交付编辑与删除能力并收尾。",
          frKeys: ["FR-003", "FR-004"],
          dependsOn: ["SLICE-1"],
          order: 2,
          involvesUi: true,
          involvesData: false,
          acceptanceCriteria: [
            "Users can update and delete Todo items, verified by a named acceptance check."
          ]
        }
      ],
      milestones: ["SLICE-1 可用", "SLICE-2 完成"],
      visualBaselineGaps: [
        {
          page: "Todo List",
          state: "Empty",
          note: "No official visual baseline was provided for the Todo List empty state."
        }
      ]
    },
    functional_spec: {
      requirements: [
        {
          id: "FR-001",
          title: "Create Todo",
          description: "User can create a Todo item with a title.",
          priority: "HIGH",
          acceptanceCriteria: ["A valid Todo title creates a new item."]
        },
        {
          id: "FR-002",
          title: "View Todos",
          description: "User can see existing Todo items.",
          priority: "HIGH",
          acceptanceCriteria: ["Todo list shows persisted items."]
        },
        {
          id: "FR-003",
          title: "Update Todo",
          description: "User can edit Todo title and completion state.",
          priority: "MEDIUM",
          acceptanceCriteria: ["Saved changes are visible after refresh."]
        },
        {
          id: "FR-004",
          title: "Delete Todo",
          description: "User can delete an existing Todo item.",
          priority: "MEDIUM",
          acceptanceCriteria: ["Deleted Todo no longer appears in the list."]
        }
      ]
    },
    technical_spec: {
      requirements: [
        {
          id: "TR-001",
          category: "backend",
          description: "Expose REST endpoints for Todo CRUD.",
          constraints: ["Use existing Node.js and TypeScript API patterns."]
        },
        {
          id: "TR-002",
          category: "database",
          description: "Persist Todo records in PostgreSQL.",
          constraints: ["Use migrations and parameterized SQL."]
        },
        {
          id: "TR-003",
          category: "frontend",
          description: "Provide a Vue console page for Todo management.",
          constraints: ["Use existing Vue 3 and Pinia patterns."]
        }
      ]
    },
    architecture: {
      components: [
        {
          name: "Todo API",
          responsibility: "Validate requests and expose Todo CRUD.",
          dependencies: ["Todo Repository"]
        },
        {
          name: "Todo Repository",
          responsibility: "Persist and query Todo rows.",
          dependencies: ["PostgreSQL"]
        },
        {
          name: "Todo Console",
          responsibility: "Render Todo list and editing states.",
          dependencies: ["Todo API"]
        }
      ],
      dataFlow: [
        "Vue Todo Console calls Todo API.",
        "Todo API validates input and uses Todo Repository.",
        "Todo Repository reads and writes PostgreSQL."
      ]
    },
    api_spec: {
      endpoints: [
        {
          method: "POST",
          path: "/api/todos",
          description: "Create a Todo item.",
          request: { title: "string" },
          response: { id: "uuid", title: "string", completed: "boolean" },
          errors: ["VALIDATION_ERROR"]
        },
        {
          method: "GET",
          path: "/api/todos",
          description: "List Todo items.",
          request: {},
          response: { todos: "Todo[]" },
          errors: []
        },
        {
          method: "PATCH",
          path: "/api/todos/:id",
          description: "Update a Todo item.",
          request: { title: "string", completed: "boolean" },
          response: { id: "uuid", title: "string", completed: "boolean" },
          errors: ["VALIDATION_ERROR", "TODO_NOT_FOUND"]
        },
        {
          method: "DELETE",
          path: "/api/todos/:id",
          description: "Delete a Todo item.",
          request: {},
          response: { id: "uuid" },
          errors: ["TODO_NOT_FOUND"]
        }
      ]
    },
    database_spec: {
      tables: [
        {
          name: "todos",
          columns: [
            "id uuid primary key",
            "title text",
            "completed boolean",
            "created_at",
            "updated_at"
          ],
          indexes: ["todos_created_at_idx"],
          relations: []
        }
      ]
    },
    ui_spec: {
      pages: [
        {
          name: "Todo List",
          components: ["Todo form", "Todo table", "Empty state", "Error state"],
          interactions: ["Create Todo", "Toggle completed", "Edit title", "Delete Todo"],
          states: ["Loading", "Error", "Empty", "Ready"]
        }
      ],
      visualBaselineGaps: [
        {
          page: "Todo List",
          state: "Empty",
          note: "No official visual baseline was provided for the Todo List empty state."
        }
      ]
    },
    task_planning: {
      summary: "Implement Todo storage, API, UI, tests, and review in dependency order.",
      tasks: [
        {
          id: "TASK-001",
          title: "Design Todo architecture",
          description: "Confirm Todo data flow, API surface, and UI states.",
          type: "DESIGN",
          priority: "HIGH",
          dependencies: [],
          estimatedComplexity: 2,
          acceptanceCriteria: ["Architecture and traceability are clear."],
          sourceSpecTypes: ["REQUIREMENT_ANALYSIS", "ARCHITECTURE"]
        },
        {
          id: "TASK-002",
          title: "Create Todo database migration",
          description: "Add PostgreSQL table and indexes for Todo persistence.",
          type: "DATABASE",
          priority: "HIGH",
          dependencies: ["TASK-001"],
          estimatedComplexity: 3,
          acceptanceCriteria: ["Todo table migration applies cleanly."],
          sourceSpecTypes: ["DATABASE"]
        },
        {
          id: "TASK-003",
          title: "Build Todo API",
          description: "Add validated REST endpoints for Todo CRUD.",
          type: "BACKEND",
          priority: "HIGH",
          dependencies: ["TASK-002"],
          estimatedComplexity: 4,
          acceptanceCriteria: ["Todo CRUD API tests pass."],
          sourceSpecTypes: ["API", "TECHNICAL"]
        },
        {
          id: "TASK-004",
          title: "Build Todo console UI",
          description: "Add Vue page and store for Todo list and editing states.",
          type: "FRONTEND",
          priority: "MEDIUM",
          dependencies: ["TASK-003"],
          estimatedComplexity: 4,
          acceptanceCriteria: [
            "Todo UI supports create, update, delete, loading, empty, and error states."
          ],
          sourceSpecTypes: ["UI", "FUNCTIONAL"]
        },
        {
          id: "TASK-005",
          title: "Add Todo integration tests",
          description: "Cover the Todo flow across API and frontend model behavior.",
          type: "TEST",
          priority: "MEDIUM",
          dependencies: ["TASK-003", "TASK-004"],
          estimatedComplexity: 3,
          acceptanceCriteria: ["Automated tests cover the planned Todo behavior."],
          sourceSpecTypes: ["FUNCTIONAL", "TECHNICAL"]
        },
        {
          id: "TASK-006",
          title: "Review Todo implementation plan",
          description: "Review the planned implementation for gaps and risks.",
          type: "REVIEW",
          priority: "LOW",
          dependencies: ["TASK-005"],
          estimatedComplexity: 1,
          acceptanceCriteria: ["Review confirms the plan is ready for a future execution phase."],
          sourceSpecTypes: ["REQUIREMENT_ANALYSIS"]
        },
        {
          id: "TASK-007",
          title: "Run CI and publish Todo image",
          description: "Run quality gates and publish an immutable Docker image.",
          type: "BUILD",
          priority: "HIGH",
          dependencies: ["TASK-006"],
          estimatedComplexity: 2,
          acceptanceCriteria: ["CI succeeds and records the Git commit and image."],
          sourceSpecTypes: ["ARCHITECTURE", "TECHNICAL"],
          delivery: { action: "CI", ref: "main", workflowFile: "ci.yml" }
        },
        {
          id: "TASK-008",
          title: "Deploy Todo to staging",
          description: "Deploy the CI image to the configured staging environment.",
          type: "DEPLOY",
          priority: "HIGH",
          dependencies: ["TASK-007"],
          estimatedComplexity: 2,
          acceptanceCriteria: ["Staging health and readiness checks pass."],
          sourceSpecTypes: ["ARCHITECTURE", "TECHNICAL"],
          delivery: { action: "DEPLOY", environment: "staging" }
        },
        {
          id: "TASK-009",
          title: "Verify Todo staging release",
          description: "Run release verification against the staging deployment.",
          type: "TEST",
          priority: "HIGH",
          dependencies: ["TASK-008"],
          estimatedComplexity: 2,
          acceptanceCriteria: ["Staging E2E health verification passes."],
          sourceSpecTypes: ["FUNCTIONAL", "TECHNICAL"],
          delivery: { action: "VERIFY", environment: "staging" }
        },
        {
          id: "TASK-010",
          title: "Deploy Todo to production",
          description: "Deploy the verified image to production after human approval.",
          type: "DEPLOY",
          priority: "HIGH",
          dependencies: ["TASK-009"],
          estimatedComplexity: 2,
          acceptanceCriteria: ["Production health and readiness checks pass."],
          sourceSpecTypes: ["ARCHITECTURE", "TECHNICAL"],
          delivery: { action: "DEPLOY", environment: "production" }
        }
      ]
    }
  };
}

export class ScriptedPlanningModel implements PlanningModel {
  private readonly invalidOnceStages = new Set<PlanningStage>();

  constructor(
    private readonly fixtures: PlanningFixtures = createTodoPlanningFixtures(),
    invalidOnceForStages: PlanningStage[] = []
  ) {
    for (const stage of invalidOnceForStages) {
      this.invalidOnceStages.add(stage);
    }
  }

  async generateStructured<TOutput extends JsonObject>(
    request: PlanningModelRequest<TOutput>
  ): Promise<unknown> {
    if (this.invalidOnceStages.delete(request.stage)) {
      return { invalid: true };
    }

    return this.fixtures[request.stage];
  }
}
