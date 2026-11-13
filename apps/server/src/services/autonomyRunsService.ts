import type { WorkflowRun, WorkflowSummary } from "@ai-se/shared";
import type { PgWorkflowRepository } from "@ai-se/database";
import {
  aggregateAutonomyRuns,
  AUTONOMY_TRIGGER_EVENT_TYPES,
  isAutonomyDynamicTaskKey,
  type AutonomyRunRecord
} from "./autonomyRunsAggregator";

export type {
  AutonomyRunRecord,
  AutonomyOutcome,
  AutonomyRepairTaskSummary
} from "./autonomyRunsAggregator";

export interface AutonomyRunsQuery {
  workflowId?: string;
  /** 默认 200，防止一次扫全库事件过大。 */
  limit?: number;
}

const TRIGGER = new Set<string>(AUTONOMY_TRIGGER_EVENT_TYPES);

/**
 * 自治记录只读服务：从既有 workflow_runs / tasks / workflow_events 聚合，
 * 不写新表、不复制事件流。
 */
export class AutonomyRunsService {
  constructor(private readonly workflows: PgWorkflowRepository) {}

  async list(query: AutonomyRunsQuery = {}): Promise<AutonomyRunRecord[]> {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 500);
    const summaries = await this.workflows.findMany();
    const byId = new Map(summaries.map((row) => [row.id, row]));

    const targets: Array<{ id: string; summary: WorkflowSummary | null }> = [];
    if (query.workflowId) {
      targets.push({
        id: query.workflowId,
        summary: byId.get(query.workflowId) ?? null
      });
    } else {
      for (const summary of summaries) {
        targets.push({ id: summary.id, summary });
      }
    }

    const inputs = [];
    for (const target of targets) {
      const workflow =
        (target.summary ? summaryToRun(target.summary) : null) ??
        (await this.workflows.findWorkflowById(target.id));
      if (!workflow) continue;

      const [tasks, events] = await Promise.all([
        this.workflows.findTasks(target.id),
        this.workflows.findEvents(target.id)
      ]);

      const entered =
        events.some((event) => TRIGGER.has(event.eventType)) ||
        tasks.some((task) => isAutonomyDynamicTaskKey(task.taskKey));
      if (!entered) continue;

      inputs.push({
        workflow,
        projectName: target.summary?.projectName ?? null,
        requirementName: target.summary?.requirementName ?? null,
        tasks,
        events
      });
    }

    return aggregateAutonomyRuns(inputs).slice(0, limit);
  }
}

function summaryToRun(summary: WorkflowSummary): WorkflowRun {
  return {
    id: summary.id,
    projectId: summary.projectId,
    requirementId: summary.requirementId,
    planningVersion: summary.planningVersion,
    status: summary.status,
    policy: summary.policy,
    input: summary.input,
    ...(summary.output ? { output: summary.output } : {}),
    ...(summary.error ? { error: summary.error } : {}),
    ...(summary.startedAt ? { startedAt: summary.startedAt } : {}),
    ...(summary.finishedAt ? { finishedAt: summary.finishedAt } : {}),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt
  };
}
