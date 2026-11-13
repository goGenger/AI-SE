import type { TaskPlan, WorkflowRun } from "@ai-se/shared";
import { describe, expect, it, vi } from "vitest";
import { createPlanningFixWorkflowOpener } from "../services/incidentFixWorkflowOpener";

const plan: TaskPlan = {
  summary: "fixture",
  tasks: [
    {
      id: "CI",
      title: "CI",
      description: "ci",
      type: "BUILD",
      priority: "HIGH",
      dependencies: [],
      estimatedComplexity: 1,
      acceptanceCriteria: ["ok"],
      sourceSpecTypes: ["TECHNICAL"],
      delivery: { action: "CI", ref: "main" }
    },
    {
      id: "STAGING",
      title: "Staging",
      description: "staging",
      type: "DEPLOY",
      priority: "HIGH",
      dependencies: ["CI"],
      estimatedComplexity: 1,
      acceptanceCriteria: ["ok"],
      sourceSpecTypes: ["ARCHITECTURE"],
      delivery: { action: "DEPLOY", environment: "staging" }
    },
    {
      id: "VERIFY",
      title: "Verify",
      description: "verify",
      type: "TEST",
      priority: "HIGH",
      dependencies: ["STAGING"],
      estimatedComplexity: 1,
      acceptanceCriteria: ["ok"],
      sourceSpecTypes: ["FUNCTIONAL"],
      delivery: { action: "VERIFY", environment: "staging" }
    },
    {
      id: "PRODUCTION",
      title: "Production",
      description: "prod",
      type: "DEPLOY",
      priority: "HIGH",
      dependencies: ["VERIFY"],
      estimatedComplexity: 1,
      acceptanceCriteria: ["ok"],
      sourceSpecTypes: ["ARCHITECTURE"],
      delivery: { action: "DEPLOY", environment: "production" }
    }
  ]
};

describe("Phase 8-D fix workflow opener", () => {
  it("SRE-14: sets deployFailureStrategy=ROLLBACK and keeps PRODUCTION approval key", async () => {
    const create = vi.fn(async (input: { policy: unknown; approvalTaskKeys?: string[] }) => {
      expect(input.policy).toMatchObject({ deployFailureStrategy: "ROLLBACK" });
      expect(input.approvalTaskKeys).toEqual(["PRODUCTION"]);
      return {
        id: "11111111-1111-4111-8111-111111111111",
        status: "PENDING"
      } as WorkflowRun;
    });
    const start = vi.fn(async (id: string) => ({ id, status: "RUNNING" }) as WorkflowRun);
    const open = createPlanningFixWorkflowOpener({
      planning: {
        createRequirement: vi.fn(async () => ({
          id: "22222222-2222-4222-8222-222222222222"
        })),
        savePlanningResult: vi.fn(async () => undefined)
      } as never,
      workflows: { create, start } as never
    });

    const result = await open({
      projectId: "33333333-3333-4333-8333-333333333333",
      title: "SRE fix",
      description: "desc",
      rawContent: "raw",
      taskPlan: plan,
      approvalTaskKeys: ["PRODUCTION"],
      start: true
    });

    expect(result.started).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });

  it("SRE-15: never drops PRODUCTION from approvalTaskKeys by default", async () => {
    const create = vi.fn(async (input: { approvalTaskKeys?: string[] }) => {
      expect(input.approvalTaskKeys).toEqual(["PRODUCTION"]);
      return { id: "11111111-1111-4111-8111-111111111111", status: "PENDING" } as WorkflowRun;
    });
    const open = createPlanningFixWorkflowOpener({
      planning: {
        createRequirement: vi.fn(async () => ({
          id: "22222222-2222-4222-8222-222222222222"
        })),
        savePlanningResult: vi.fn(async () => undefined)
      } as never,
      workflows: { create, start: vi.fn() } as never
    });
    await open({
      projectId: "33333333-3333-4333-8333-333333333333",
      title: "SRE fix",
      description: "desc",
      rawContent: "raw",
      taskPlan: plan,
      start: false
    });
  });
});
