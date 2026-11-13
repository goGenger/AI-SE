import type { PgPlanningRepository } from "@ai-se/database";
import type { CreateWorkflowData, TaskPlan, WorkflowRun } from "@ai-se/shared";
import { WorkflowService } from "./workflowService";

/**
 * Opens a fix workflow through the **existing** planning + WorkflowService path
 * (SRE-10). No second runtime.
 */
export interface IncidentFixWorkflowOpenInput {
  projectId: string;
  title: string;
  description: string;
  rawContent: string;
  taskPlan: TaskPlan;
  /** Always include PRODUCTION for defense in depth (repo also keys off env). */
  approvalTaskKeys?: string[];
  workspacePath?: string;
  /** When true, call WorkflowService.start after create. */
  start: boolean;
}

export interface IncidentFixWorkflowOpenResult {
  workflowRunId: string;
  requirementId: string;
  started: boolean;
}

export function createPlanningFixWorkflowOpener(deps: {
  planning: Pick<PgPlanningRepository, "createRequirement" | "savePlanningResult">;
  workflows: Pick<WorkflowService, "create" | "start">;
}): (input: IncidentFixWorkflowOpenInput) => Promise<IncidentFixWorkflowOpenResult> {
  return async (input) => {
    const requirement = await deps.planning.createRequirement(input.projectId, {
      title: input.title.slice(0, 160),
      description: input.description.slice(0, 1000),
      rawContent: input.rawContent
    });

    await deps.planning.savePlanningResult({
      projectId: input.projectId,
      requirementId: requirement.id,
      requirementVersion: 1,
      version: 1,
      analysis: {
        id: `incident-remediation-${requirement.id}`,
        summary: input.title,
        goals: ["Controlled staging remediation for a whitelisted incident fault type"],
        constraints: [
          "Reuse DeliveryOrchestrator task types only",
          "Production DEPLOY remains WAITING_APPROVAL (even if INCIDENT_AUTO_REMEDIATE is on)",
          "No arbitrary production shell / secrets mutation",
          "Staging DEPLOY failure uses deployFailureStrategy=ROLLBACK"
        ],
        assumptions: ["Staging and production environments are configured for the project"],
        acceptanceCriteria: [
          "CI → staging DEPLOY → staging VERIFY complete or fail without production promotion",
          "Production DEPLOY waits for approval"
        ],
        risks: ["Starting without environments configured will fail staging deploy tasks"]
      },
      specifications: [
        { type: "FUNCTIONAL", content: { requirements: [] } },
        { type: "TECHNICAL", content: { requirements: [] } },
        { type: "ARCHITECTURE", content: { components: [], dataFlow: [] } },
        { type: "API", content: { endpoints: [] } },
        { type: "DATABASE", content: { tables: [] } },
        { type: "UI", content: { pages: [] } }
      ],
      taskPlan: input.taskPlan
    });

    // 8-D SRE-14: staging DEPLOY failure uses existing ROLLBACK path (L1 deployFailureStrategy).
    // approvalRequired stays false at workflow level; PRODUCTION still waits via approvalTaskKeys
    // + repository rules on environment===production (never silent prod auto-deploy).
    const createInput: CreateWorkflowData = {
      projectId: input.projectId,
      requirementId: requirement.id,
      planningVersion: 1,
      policy: {
        maxConcurrency: 1,
        maxRetries: 1,
        failureStrategy: "FAIL_FAST",
        allowRetry: true,
        allowReplan: false,
        approvalRequired: false,
        deployFailureStrategy: "ROLLBACK"
      },
      approvalTaskKeys: input.approvalTaskKeys ?? ["PRODUCTION"],
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {})
    };

    let workflow: WorkflowRun = await deps.workflows.create(createInput);
    let started = false;
    if (input.start) {
      workflow = await deps.workflows.start(workflow.id);
      started = true;
    }

    return {
      workflowRunId: workflow.id,
      requirementId: requirement.id,
      started
    };
  };
}
