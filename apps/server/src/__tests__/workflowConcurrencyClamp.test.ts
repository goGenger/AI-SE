import { PgWorkflowRepository, ProjectRepository } from "@ai-se/database";
import { WorkflowTaskExecutor } from "@ai-se/workflow-engine";
import { describe, expect, it, vi } from "vitest";
import { WorkflowService } from "../services/workflowService";

/**
 * F1-7（FX-23）：T3 未做前不开放并行——工作流创建期 `maxConcurrency` 被钳为 1 并留痕
 * （事件 `WORKFLOW_MAX_CONCURRENCY_CLAMPED`；请求值 1 原样通过、不产生钳制事件）。
 */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REQUIREMENT_ID = "22222222-2222-4222-8222-222222222222";

function basePolicy(maxConcurrency: number) {
  return {
    maxConcurrency,
    maxRetries: 1,
    failureStrategy: "FAIL_FAST" as const,
    allowRetry: true,
    allowReplan: false,
    approvalRequired: false
  };
}

function setup() {
  const created: Array<Record<string, unknown>> = [];
  const events: Array<{ eventType: string; payload?: unknown }> = [];
  const workflows = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      const now = new Date().toISOString();
      return {
        id: "wf-1",
        projectId: input.projectId,
        requirementId: input.requirementId,
        planningVersion: 1,
        status: "PENDING",
        policy: input.policy,
        input: {},
        createdAt: now,
        updatedAt: now
      };
    }),
    createEvent: vi.fn(async (event: { eventType: string; payload?: unknown }) => {
      events.push(event);
    })
  } as unknown as PgWorkflowRepository;
  const projects = {
    findById: vi.fn(async () => ({ id: PROJECT_ID }))
  } as unknown as ProjectRepository;
  const service = new WorkflowService({
    workflows,
    projects,
    executor: { execute: vi.fn(), cancel: vi.fn() } as unknown as WorkflowTaskExecutor
  });
  return { service, created, events };
}

describe("FX-23 工作流并行钳制（创建期）", () => {
  it("请求 maxConcurrency=4 → 创建为 1，并发事件 WORKFLOW_MAX_CONCURRENCY_CLAMPED", async () => {
    const { service, created, events } = setup();

    const workflow = await service.create({
      projectId: PROJECT_ID,
      requirementId: REQUIREMENT_ID,
      policy: basePolicy(4),
      approvalTaskKeys: []
    });

    expect((created[0]?.policy as { maxConcurrency: number }).maxConcurrency).toBe(1);
    expect(workflow.policy.maxConcurrency).toBe(1);
    const clampEvent = events.find(
      (event) => event.eventType === "WORKFLOW_MAX_CONCURRENCY_CLAMPED"
    );
    expect(clampEvent?.payload).toMatchObject({
      requestedMaxConcurrency: 4,
      appliedMaxConcurrency: 1
    });
  });

  it("请求 maxConcurrency=1 → 原样通过，不产生钳制事件", async () => {
    const { service, created, events } = setup();

    await service.create({
      projectId: PROJECT_ID,
      requirementId: REQUIREMENT_ID,
      policy: basePolicy(1),
      approvalTaskKeys: []
    });

    expect((created[0]?.policy as { maxConcurrency: number }).maxConcurrency).toBe(1);
    expect(events.some((event) => event.eventType === "WORKFLOW_MAX_CONCURRENCY_CLAMPED")).toBe(
      false
    );
  });
});
