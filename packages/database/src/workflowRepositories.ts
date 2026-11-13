import {
  Approval,
  ApprovalStatus,
  ApiErrorBody,
  CreateWorkflowData,
  isAutonomyLevel,
  JsonObject,
  Task,
  TaskDependencyView,
  TaskPriority,
  TaskStatus,
  TaskType,
  WorkflowEvent,
  WorkflowFailureStrategy,
  WorkflowPolicy,
  WorkflowRun,
  WorkflowStatus,
  WorkflowSummary
} from "@ai-se/shared";
import {
  countWorkflowTaskProgress,
  ReplanInput,
  WorkflowRunPatch,
  WorkflowRunUsage,
  WorkflowTaskPatch
} from "@ai-se/workflow-engine";
import { Pool, PoolClient } from "pg";
import { jsonbSafe } from "./jsonbSafe";

interface WorkflowRow {
  id: string;
  project_id: string;
  requirement_id: string;
  planning_version: number;
  status: WorkflowStatus;
  max_concurrency: number;
  max_retries: number;
  failure_strategy: WorkflowFailureStrategy;
  allow_retry: boolean;
  allow_replan: boolean;
  approval_required: boolean;
  autonomy_level: string | null;
  max_cost_usd: string | number | null;
  max_tokens: string | number | null;
  max_wall_clock_ms: string | number | null;
  input: unknown;
  output: unknown | null;
  error: unknown | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TaskRow {
  id: string;
  project_id: string;
  requirement_id: string | null;
  workflow_run_id: string | null;
  task_key: string;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_agent: string | null;
  input: unknown;
  output: unknown | null;
  retry_count: number;
  version: number;
  plan_task_id: string | null;
  origin: "ORIGINAL" | "RUNTIME" | "DYNAMIC";
  creation_reason: string | null;
  source_task_id: string | null;
  resolved_by_task_id: string | null;
  approval_required: boolean;
  claim_token: string | null;
  claimed_at: Date | string | null;
  failure_handled: boolean;
  /** N2：第二级任务计划的切片归属（旧数据为 NULL）。 */
  slice_key: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DependencyRow {
  id: string;
  source_task_id: string;
  target_task_id: string;
  source_task_key: string;
  target_task_key: string;
  workflow_run_id: string | null;
  origin: "ORIGINAL" | "RUNTIME" | "DYNAMIC";
  active: boolean;
  created_at: Date | string;
}

interface ApprovalRow {
  id: string;
  workflow_run_id: string | null;
  task_id: string | null;
  /** N2 关口 1：需求级审批的归属需求（任务级审批为 NULL）。 */
  requirement_id: string | null;
  status: ApprovalStatus;
  reason: string;
  comment: string;
  requested_at: Date | string;
  decided_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EventRow {
  id: string;
  workflow_run_id: string | null;
  task_id: string | null;
  agent_run_id: string | null;
  event_type: string;
  payload: unknown;
  created_at: Date | string;
}

interface WorkflowSummaryRow extends WorkflowRow {
  project_name: string | null;
  requirement_name: string | null;
  task_total: number;
  task_completed: number;
}

function iso(value: Date | string | null): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function optionalObject(value: unknown | null): JsonObject | undefined {
  return value ? object(value) : undefined;
}

function mapError(value: unknown | null): ApiErrorBody | undefined {
  const data = optionalObject(value);
  if (!data) return undefined;
  return {
    code: typeof data.code === "string" ? data.code : "WORKFLOW_ERROR",
    message: typeof data.message === "string" ? data.message : "Workflow failed",
    details: data.details
  };
}

function mapWorkflow(row: WorkflowRow): WorkflowRun {
  const policy: WorkflowPolicy = {
    maxConcurrency: row.max_concurrency,
    maxRetries: row.max_retries,
    failureStrategy: row.failure_strategy,
    allowRetry: row.allow_retry,
    allowReplan: row.allow_replan,
    approvalRequired: row.approval_required,
    ...(isAutonomyLevel(row.autonomy_level) ? { autonomyLevel: row.autonomy_level } : {}),
    ...(row.max_cost_usd !== null ? { maxCostUsd: Number(row.max_cost_usd) } : {}),
    ...(row.max_tokens !== null ? { maxTokens: Number(row.max_tokens) } : {}),
    ...(row.max_wall_clock_ms !== null ? { maxWallClockMs: Number(row.max_wall_clock_ms) } : {})
  };
  return {
    id: row.id,
    projectId: row.project_id,
    requirementId: row.requirement_id,
    planningVersion: row.planning_version,
    status: row.status,
    policy,
    input: object(row.input),
    output: optionalObject(row.output),
    error: mapError(row.error),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? ""
  };
}

function mapSummary(row: WorkflowSummaryRow): WorkflowSummary {
  return {
    ...mapWorkflow(row),
    projectName: row.project_name,
    requirementName: row.requirement_name,
    taskProgress: {
      total: Number(row.task_total),
      completed: Number(row.task_completed)
    }
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    requirementId: row.requirement_id ?? undefined,
    workflowRunId: row.workflow_run_id ?? undefined,
    taskKey: row.task_key,
    title: row.title,
    description: row.description,
    type: row.type,
    status: row.status,
    priority: row.priority,
    assignedAgent: row.assigned_agent ?? undefined,
    input: object(row.input),
    output: optionalObject(row.output),
    retryCount: row.retry_count,
    version: row.version,
    planTaskId: row.plan_task_id ?? undefined,
    origin: row.origin,
    creationReason: row.creation_reason ?? undefined,
    sourceTaskId: row.source_task_id ?? undefined,
    resolvedByTaskId: row.resolved_by_task_id ?? undefined,
    approvalRequired: row.approval_required,
    claimToken: row.claim_token ?? undefined,
    claimedAt: iso(row.claimed_at),
    failureHandled: row.failure_handled,
    sliceKey: row.slice_key ?? undefined,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? ""
  };
}

function mapDependency(row: DependencyRow): TaskDependencyView {
  return {
    id: row.id,
    sourceTaskId: row.source_task_id,
    targetTaskId: row.target_task_id,
    sourceTaskKey: row.source_task_key,
    targetTaskKey: row.target_task_key,
    workflowRunId: row.workflow_run_id ?? undefined,
    origin: row.origin,
    active: row.active,
    createdAt: iso(row.created_at) ?? ""
  };
}

function mapApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id ?? undefined,
    taskId: row.task_id ?? undefined,
    requirementId: row.requirement_id ?? undefined,
    status: row.status,
    reason: row.reason,
    comment: row.comment,
    requestedAt: iso(row.requested_at) ?? "",
    decidedAt: iso(row.decided_at),
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? ""
  };
}

function mapEvent(row: EventRow): WorkflowEvent {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id ?? undefined,
    taskId: row.task_id ?? undefined,
    agentRunId: row.agent_run_id ?? undefined,
    eventType: row.event_type,
    payload: object(row.payload),
    createdAt: iso(row.created_at) ?? ""
  };
}

async function insertRuntimeTask(
  client: PoolClient,
  input: {
    id?: string;
    workflowRunId: string;
    projectId: string;
    planTaskId?: string;
    taskKey: string;
    title: string;
    description: string;
    type: TaskType;
    priority: TaskPriority;
    assignedAgent?: string;
    data: JsonObject;
    version: number;
    origin: "RUNTIME" | "DYNAMIC";
    creationReason?: string;
    sourceTaskId?: string;
    approvalRequired: boolean;
    /** N2：切片归属（运行时克隆随计划任务携带）。 */
    sliceKey?: string;
  }
): Promise<Task> {
  const result = await client.query<TaskRow>(
    `
      INSERT INTO tasks (
        id, project_id, workflow_run_id, plan_task_id, task_key, title, description,
        type, status, priority, assigned_agent, input, version, origin,
        creation_reason, source_task_id, approval_required, slice_key
      )
      VALUES (
        COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7,
        $8, 'PENDING', $9, $10, $11, $12, $13, $14, $15, $16, $17
      )
      RETURNING *
    `,
    [
      input.id ?? null,
      input.projectId,
      input.workflowRunId,
      input.planTaskId ?? null,
      input.taskKey,
      input.title,
      input.description,
      input.type,
      input.priority,
      input.assignedAgent ?? null,
      jsonbSafe(input.data),
      input.version,
      input.origin,
      input.creationReason ?? null,
      input.sourceTaskId ?? null,
      input.approvalRequired,
      input.sliceKey ?? null
    ]
  );
  return mapTask(result.rows[0]);
}

export class PgWorkflowRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateWorkflowData): Promise<WorkflowRun> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const requirement = await client.query<{ project_id: string }>(
        "SELECT project_id FROM requirements WHERE id = $1 FOR SHARE",
        [input.requirementId]
      );
      if (!requirement.rows[0] || requirement.rows[0].project_id !== input.projectId) {
        throw new Error("Requirement does not belong to project");
      }
      const versionResult = await client.query<{ version: number | string | null }>(
        `SELECT MAX(version) AS version FROM tasks WHERE requirement_id = $1 AND workflow_run_id IS NULL${input.sliceKey ? " AND slice_key = $2" : ""}`,
        input.sliceKey ? [input.requirementId, input.sliceKey] : [input.requirementId]
      );
      const planningVersion = input.planningVersion ?? Number(versionResult.rows[0]?.version ?? 0);
      if (planningVersion <= 0) throw new Error("Requirement has no task plan");

      const policy = input.policy;
      const workflowResult = await client.query<WorkflowRow>(
        `
          INSERT INTO workflow_runs (
            project_id, requirement_id, planning_version, max_concurrency, max_retries,
            failure_strategy, allow_retry, allow_replan, approval_required, autonomy_level, input,
            max_cost_usd, max_tokens, max_wall_clock_ms
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          RETURNING *
        `,
        [
          input.projectId,
          input.requirementId,
          planningVersion,
          policy.maxConcurrency,
          policy.maxRetries,
          policy.failureStrategy,
          policy.allowRetry,
          policy.allowReplan,
          policy.approvalRequired,
          policy.autonomyLevel ?? null,
          {
            approvalTaskKeys: input.approvalTaskKeys,
            workspacePath: input.workspacePath,
            ...(input.sliceKey ? { sliceKey: input.sliceKey } : {})
          },
          policy.maxCostUsd ?? null,
          policy.maxTokens ?? null,
          policy.maxWallClockMs ?? null
        ]
      );
      const workflow = mapWorkflow(workflowResult.rows[0]);
      const planTasks = await client.query<TaskRow>(
        `
          SELECT * FROM tasks
          WHERE requirement_id = $1 AND version = $2 AND workflow_run_id IS NULL${input.sliceKey ? " AND slice_key = $3" : ""}
          ORDER BY task_key ASC
        `,
        input.sliceKey
          ? [input.requirementId, planningVersion, input.sliceKey]
          : [input.requirementId, planningVersion]
      );
      if (planTasks.rows.length === 0) throw new Error("Task plan version not found");

      const runtimeIds = new Map<string, string>();
      for (const row of planTasks.rows) {
        const planTask = mapTask(row);
        const runtime = await insertRuntimeTask(client, {
          workflowRunId: workflow.id,
          projectId: planTask.projectId,
          planTaskId: planTask.id,
          taskKey: planTask.taskKey,
          title: planTask.title,
          description: planTask.description,
          type: planTask.type,
          priority: planTask.priority,
          assignedAgent: planTask.assignedAgent,
          data: planTask.input,
          version: planTask.version,
          origin: "RUNTIME",
          sliceKey: planTask.sliceKey,
          approvalRequired:
            policy.approvalRequired ||
            input.approvalTaskKeys.includes(planTask.taskKey) ||
            (planTask.type === "DEPLOY" &&
              typeof planTask.input.delivery === "object" &&
              planTask.input.delivery !== null &&
              (planTask.input.delivery as JsonObject).environment === "production")
        });
        runtimeIds.set(planTask.id, runtime.id);
      }

      const dependencies = await client.query<{ source_task_id: string; target_task_id: string }>(
        `
          SELECT d.source_task_id, d.target_task_id
          FROM task_dependencies d
          JOIN tasks source ON source.id = d.source_task_id
          JOIN tasks target ON target.id = d.target_task_id
          WHERE source.requirement_id = $1 AND target.requirement_id = $1
            AND source.version = $2 AND target.version = $2
        `,
        [input.requirementId, planningVersion]
      );
      for (const dependency of dependencies.rows) {
        const sourceId = runtimeIds.get(dependency.source_task_id);
        const targetId = runtimeIds.get(dependency.target_task_id);
        if (!sourceId || !targetId) throw new Error("Cannot clone task dependency");
        await client.query(
          `
            INSERT INTO task_dependencies (
              source_task_id, target_task_id, workflow_run_id, origin
            ) VALUES ($1, $2, $3, 'RUNTIME')
          `,
          [sourceId, targetId, workflow.id]
        );
      }

      await client.query("COMMIT");
      return workflow;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findMany(): Promise<WorkflowSummary[]> {
    const result = await this.pool.query<WorkflowSummaryRow>(
      `SELECT wr.*, p.name AS project_name, r.title AS requirement_name,
              0::int AS task_total,
              0::int AS task_completed
         FROM workflow_runs wr
         LEFT JOIN projects p ON p.id = wr.project_id
         LEFT JOIN requirements r ON r.id = wr.requirement_id
        ORDER BY wr.created_at DESC`
    );
    const summaries = result.rows.map(mapSummary);
    if (summaries.length === 0) return summaries;

    // 进度与引擎 isFailureResolved 同源：FAILED 且被 REPLAN 链解决也算 completed（避免 SUCCESS 工作流显示 18/20）。
    const progressResult = await this.pool.query<{
      id: string;
      workflow_run_id: string;
      status: TaskStatus;
      resolved_by_task_id: string | null;
    }>(
      `SELECT id, workflow_run_id, status, resolved_by_task_id
         FROM tasks
        WHERE workflow_run_id = ANY($1::uuid[])`,
      [summaries.map((summary) => summary.id)]
    );

    const byWorkflow = new Map<string, Task[]>();
    for (const row of progressResult.rows) {
      const stub = {
        id: row.id,
        status: row.status,
        ...(row.resolved_by_task_id ? { resolvedByTaskId: row.resolved_by_task_id } : {})
      } as Task;
      const list = byWorkflow.get(row.workflow_run_id) ?? [];
      list.push(stub);
      byWorkflow.set(row.workflow_run_id, list);
    }
    for (const summary of summaries) {
      summary.taskProgress = countWorkflowTaskProgress(byWorkflow.get(summary.id) ?? []);
    }
    return summaries;
  }

  /**
   * UX-03: the first recovery / diagnostic task spawned from `sourceTaskId`
   * (earliest created — the engine's debug task), used for the run's recovery chain.
   */
  async findTaskBySourceTaskId(sourceTaskId: string): Promise<Task | null> {
    const result = await this.pool.query<TaskRow>(
      "SELECT * FROM tasks WHERE source_task_id = $1 ORDER BY created_at ASC LIMIT 1",
      [sourceTaskId]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async findWorkflowById(id: string): Promise<WorkflowRun | null> {
    const result = await this.pool.query<WorkflowRow>("SELECT * FROM workflow_runs WHERE id = $1", [
      id
    ]);
    return result.rows[0] ? mapWorkflow(result.rows[0]) : null;
  }

  async findWorkflowsByStatuses(statuses: WorkflowStatus[]): Promise<WorkflowRun[]> {
    const result = await this.pool.query<WorkflowRow>(
      "SELECT * FROM workflow_runs WHERE status = ANY($1::text[]) ORDER BY created_at ASC",
      [statuses]
    );
    return result.rows.map(mapWorkflow);
  }

  async updateWorkflow(
    id: string,
    expectedStatuses: WorkflowStatus[],
    patch: WorkflowRunPatch
  ): Promise<WorkflowRun | null> {
    const result = await this.pool.query<WorkflowRow>(
      `
        UPDATE workflow_runs SET
          status = COALESCE($3, status), output = COALESCE($4, output),
          error = CASE WHEN $8 THEN NULL ELSE COALESCE($5, error) END,
          started_at = COALESCE($6, started_at),
          finished_at = CASE WHEN $9 THEN NULL ELSE COALESCE($7, finished_at) END
        WHERE id = $1 AND status = ANY($2::text[])
        RETURNING *
      `,
      [
        id,
        expectedStatuses,
        patch.status ?? null,
        jsonbSafe(patch.output ?? null),
        patch.error ?? null,
        patch.startedAt ?? null,
        patch.finishedAt ?? null,
        patch.clearError ?? false,
        patch.clearFinishedAt ?? false
      ]
    );
    return result.rows[0] ? mapWorkflow(result.rows[0]) : null;
  }

  /** T6：调整工作流预算列（仅 RUNNING/PAUSED；null = 清除该上限）。 */
  async updateWorkflowPolicy(id: string, policy: WorkflowPolicy): Promise<WorkflowRun | null> {
    const result = await this.pool.query<WorkflowRow>(
      `
        UPDATE workflow_runs SET
          max_cost_usd = $2, max_tokens = $3, max_wall_clock_ms = $4
        WHERE id = $1 AND status IN ('RUNNING', 'PAUSED')
        RETURNING *
      `,
      [id, policy.maxCostUsd ?? null, policy.maxTokens ?? null, policy.maxWallClockMs ?? null]
    );
    return result.rows[0] ? mapWorkflow(result.rows[0]) : null;
  }

  async findTasks(workflowRunId: string): Promise<Task[]> {
    const result = await this.pool.query<TaskRow>(
      "SELECT * FROM tasks WHERE workflow_run_id = $1 ORDER BY created_at ASC, task_key ASC",
      [workflowRunId]
    );
    return result.rows.map(mapTask);
  }

  async findDependencies(workflowRunId: string): Promise<TaskDependencyView[]> {
    const result = await this.pool.query<DependencyRow>(
      `
        SELECT d.*, source.task_key AS source_task_key, target.task_key AS target_task_key
        FROM task_dependencies d
        JOIN tasks source ON source.id = d.source_task_id
        JOIN tasks target ON target.id = d.target_task_id
        WHERE d.workflow_run_id = $1
        ORDER BY d.created_at ASC
      `,
      [workflowRunId]
    );
    return result.rows.map(mapDependency);
  }

  async updateTask(
    id: string,
    expectedStatuses: TaskStatus[],
    patch: WorkflowTaskPatch
  ): Promise<Task | null> {
    const result = await this.pool.query<TaskRow>(
      `
        UPDATE tasks SET
          status = COALESCE($3, status), output = COALESCE($4, output),
          assigned_agent = COALESCE($5, assigned_agent), retry_count = COALESCE($6, retry_count),
          resolved_by_task_id = COALESCE($7, resolved_by_task_id),
          failure_handled = COALESCE($8, failure_handled),
          started_at = COALESCE($9, started_at), finished_at = COALESCE($10, finished_at),
          claim_token = CASE WHEN $11 THEN NULL ELSE claim_token END,
          claimed_at = CASE WHEN $11 THEN NULL ELSE claimed_at END,
          type = COALESCE($12, type),
          title = COALESCE($13, title),
          description = COALESCE($14, description),
          input = COALESCE($15, input)
        WHERE id = $1 AND status = ANY($2::text[])
        RETURNING *
      `,
      [
        id,
        expectedStatuses,
        patch.status ?? null,
        jsonbSafe(patch.output ?? null),
        patch.assignedAgent ?? null,
        patch.retryCount ?? null,
        patch.resolvedByTaskId ?? null,
        patch.failureHandled ?? null,
        patch.startedAt ?? null,
        patch.finishedAt ?? null,
        patch.clearClaim ?? false,
        patch.type ?? null,
        patch.title ?? null,
        patch.description ?? null,
        jsonbSafe(patch.input ?? null)
      ]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async claimNextTask(workflowRunId: string, claimToken: string): Promise<Task | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const workflow = await client.query<{ max_concurrency: number; status: WorkflowStatus }>(
        "SELECT max_concurrency, status FROM workflow_runs WHERE id = $1 FOR UPDATE",
        [workflowRunId]
      );
      const row = workflow.rows[0];
      if (!row || row.status !== "RUNNING") {
        await client.query("ROLLBACK");
        return null;
      }
      const running = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM tasks WHERE workflow_run_id = $1 AND status = 'RUNNING'",
        [workflowRunId]
      );
      if (Number(running.rows[0].count) >= row.max_concurrency) {
        await client.query("ROLLBACK");
        return null;
      }
      const candidate = await client.query<{ id: string }>(
        `
          SELECT id FROM tasks
          WHERE workflow_run_id = $1 AND status = 'READY'
          ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, created_at ASC
          FOR UPDATE SKIP LOCKED LIMIT 1
        `,
        [workflowRunId]
      );
      if (!candidate.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      const claimed = await client.query<TaskRow>(
        `
          UPDATE tasks SET status = 'RUNNING', claim_token = $2, claimed_at = now(),
            started_at = COALESCE(started_at, now())
          WHERE id = $1 AND status = 'READY'
          RETURNING *
        `,
        [candidate.rows[0].id, claimToken]
      );
      await client.query("COMMIT");
      return claimed.rows[0] ? mapTask(claimed.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimFailureHandling(taskId: string): Promise<Task | null> {
    const result = await this.pool.query<TaskRow>(
      `UPDATE tasks SET failure_handled = true WHERE id = $1 AND status = 'FAILED' AND failure_handled = false RETURNING *`,
      [taskId]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async cancelNonTerminalTasks(workflowRunId: string): Promise<Task[]> {
    const result = await this.pool.query<TaskRow>(
      `
        UPDATE tasks SET status = 'CANCELLED', finished_at = COALESCE(finished_at, now()),
          claim_token = NULL, claimed_at = NULL
        WHERE workflow_run_id = $1 AND status IN (
          'PENDING', 'READY', 'RUNNING', 'RETRYING', 'WAITING_APPROVAL'
        ) RETURNING *
      `,
      [workflowRunId]
    );
    return result.rows.map(mapTask);
  }

  async recoverRunningTasks(workflowRunId: string): Promise<number> {
    // N-37：崩溃恢复**消耗重试预算**。此前这里只翻状态不加计数，进程反复崩溃时
    // 同一个任务可以被无上限地重新排队——重试预算形同虚设。
    // 转移合法性由引擎侧 `assertTaskTransition(RUNNING -> RETRYING)` 保证。
    const result = await this.pool.query(
      `
        UPDATE tasks
        SET status = 'RETRYING',
            claim_token = NULL,
            claimed_at = NULL,
            retry_count = retry_count + 1,
            updated_at = now()
        WHERE workflow_run_id = $1 AND status = 'RUNNING'
      `,
      [workflowRunId]
    );
    return result.rowCount ?? 0;
  }

  async createApproval(workflowRunId: string, taskId: string, reason: string): Promise<Approval> {
    const result = await this.pool.query<ApprovalRow>(
      `
        INSERT INTO approvals (workflow_run_id, task_id, reason)
        VALUES ($1, $2, $3)
        ON CONFLICT (task_id) DO UPDATE SET reason = EXCLUDED.reason
        RETURNING *
      `,
      [workflowRunId, taskId, reason]
    );
    return mapApproval(result.rows[0]);
  }

  async findApprovals(workflowRunId: string): Promise<Approval[]> {
    const result = await this.pool.query<ApprovalRow>(
      "SELECT * FROM approvals WHERE workflow_run_id = $1 ORDER BY requested_at ASC",
      [workflowRunId]
    );
    return result.rows.map(mapApproval);
  }

  async findApprovalById(id: string): Promise<Approval | null> {
    const result = await this.pool.query<ApprovalRow>("SELECT * FROM approvals WHERE id = $1", [
      id
    ]);
    return result.rows[0] ? mapApproval(result.rows[0]) : null;
  }

  /** N2 关口 1：需求级切片计划审批（同表、无 workflow/task 归属）。 */
  async createRequirementApproval(requirementId: string, reason: string): Promise<Approval> {
    const result = await this.pool.query<ApprovalRow>(
      `
        INSERT INTO approvals (requirement_id, reason)
        VALUES ($1, $2)
        RETURNING *
      `,
      [requirementId, reason]
    );
    return mapApproval(result.rows[0]);
  }

  async findPendingApprovalByRequirement(requirementId: string): Promise<Approval | null> {
    const result = await this.pool.query<ApprovalRow>(
      `
        SELECT * FROM approvals
        WHERE requirement_id = $1 AND status = 'PENDING'
        ORDER BY requested_at ASC
        LIMIT 1
      `,
      [requirementId]
    );
    return result.rows[0] ? mapApproval(result.rows[0]) : null;
  }

  /** N2：关口 1 拒绝次数（重做上限 2 次的判定依据）。 */
  async countRejectedApprovalsByRequirement(requirementId: string): Promise<number> {
    const result = await this.pool.query<{ count: string | number }>(
      "SELECT count(*) AS count FROM approvals WHERE requirement_id = $1 AND status = 'REJECTED'",
      [requirementId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * F1-3 增补（L3 前置修复）：按 reason 前缀统计需求级审批数——
   * 用于切片规划升级重试上限（防确定性失败 + 自动批准造成无限重试循环）。
   */
  async countApprovalsByRequirement(requirementId: string, reasonPrefix: string): Promise<number> {
    const result = await this.pool.query<{ count: string | number }>(
      "SELECT count(*) AS count FROM approvals WHERE requirement_id = $1 AND starts_with(reason, $2)",
      [requirementId, reasonPrefix]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async decideApproval(
    id: string,
    status: "APPROVED" | "REJECTED",
    comment: string
  ): Promise<Approval | null> {
    const result = await this.pool.query<ApprovalRow>(
      `
        UPDATE approvals SET status = $2, comment = $3, decided_at = now()
        WHERE id = $1 AND status = 'PENDING' RETURNING *
      `,
      [id, status, comment]
    );
    return result.rows[0] ? mapApproval(result.rows[0]) : null;
  }

  async setDependenciesActive(
    workflowRunId: string,
    updates: Array<{ id: string; active: boolean }>
  ): Promise<void> {
    if (updates.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const update of updates) {
        await client.query(
          "UPDATE task_dependencies SET active = $3 WHERE id = $1 AND workflow_run_id = $2",
          [update.id, workflowRunId, update.active]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async applyReplan(input: ReplanInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const source = await client.query<TaskRow>("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [
        input.sourceTaskId
      ]);
      if (!source.rows[0] || source.rows[0].workflow_run_id !== input.workflowRunId) {
        throw new Error("Re-plan source task is invalid");
      }
      for (const task of input.tasks) {
        await insertRuntimeTask(client, {
          id: task.id,
          workflowRunId: task.workflowRunId,
          projectId: task.projectId,
          planTaskId: task.planTaskId,
          taskKey: task.taskKey,
          title: task.title,
          description: task.description,
          type: task.type,
          priority: task.priority,
          data: task.input,
          version: source.rows[0].version,
          origin: "DYNAMIC",
          creationReason: task.creationReason,
          sourceTaskId: task.sourceTaskId,
          sliceKey: source.rows[0].slice_key ?? undefined,
          approvalRequired: task.approvalRequired
        });
      }
      if (input.deactivateDependencyIds.length > 0) {
        await client.query(
          "UPDATE task_dependencies SET active = false WHERE id = ANY($1::uuid[]) AND workflow_run_id = $2",
          [input.deactivateDependencyIds, input.workflowRunId]
        );
      }
      for (const dependency of input.dependencies) {
        await client.query(
          `
            INSERT INTO task_dependencies (
              source_task_id, target_task_id, workflow_run_id, origin
            ) VALUES ($1, $2, $3, 'DYNAMIC')
          `,
          [dependency.sourceTaskId, dependency.targetTaskId, input.workflowRunId]
        );
      }
      await client.query(
        "UPDATE tasks SET resolved_by_task_id = $2, failure_handled = true WHERE id = $1",
        [input.sourceTaskId, input.resolvedByTaskId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createEvent(input: {
    workflowRunId: string;
    taskId?: string;
    agentRunId?: string;
    eventType: string;
    payload: JsonObject;
  }): Promise<WorkflowEvent> {
    const result = await this.pool.query<EventRow>(
      `
        INSERT INTO workflow_events (
          workflow_run_id, task_id, agent_run_id, event_type, payload
        ) VALUES ($1, $2, $3, $4, $5) RETURNING *
      `,
      [
        input.workflowRunId,
        input.taskId ?? null,
        input.agentRunId ?? null,
        input.eventType,
        jsonbSafe(input.payload)
      ]
    );
    return mapEvent(result.rows[0]);
  }

  async findEvents(workflowRunId: string): Promise<WorkflowEvent[]> {
    const result = await this.pool.query<EventRow>(
      "SELECT * FROM workflow_events WHERE workflow_run_id = $1 ORDER BY sequence ASC, created_at ASC",
      [workflowRunId]
    );
    return result.rows.map(mapEvent);
  }

  /** T6：按 workflowRunId 聚合 agent run 用量（token_usage/estimated_cost；窄读、不新表）。 */
  async sumRunUsage(workflowRunId: string): Promise<WorkflowRunUsage> {
    const result = await this.pool.query<{
      input_tokens: number;
      output_tokens: number;
      cost_rows: number;
      estimated_cost_usd: number;
    }>(
      `
        SELECT
          COALESCE(SUM(COALESCE((token_usage->>'input_tokens')::int, 0)), 0)::int AS input_tokens,
          COALESCE(SUM(COALESCE((token_usage->>'output_tokens')::int, 0)), 0)::int AS output_tokens,
          COUNT(estimated_cost)::int AS cost_rows,
          COALESCE(SUM(estimated_cost), 0)::float8 AS estimated_cost_usd
        FROM agent_runs
        WHERE input->>'workflowRunId' = $1
      `,
      [workflowRunId]
    );
    const row = result.rows[0];
    return {
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      estimatedCostUsd: row && row.cost_rows > 0 ? row.estimated_cost_usd : null
    };
  }

  /**
   * UX-02: newest-first page for the event timeline. `created_at DESC` per the
   * timeline contract; `sequence DESC` breaks ties for events written in the
   * same millisecond by the engine.
   */
  async findEventsPage(
    workflowRunId: string,
    limit: number,
    offset: number
  ): Promise<{ items: WorkflowEvent[]; total: number }> {
    const [rows, count] = await Promise.all([
      this.pool.query<EventRow>(
        "SELECT * FROM workflow_events WHERE workflow_run_id = $1 ORDER BY created_at DESC, sequence DESC LIMIT $2 OFFSET $3",
        [workflowRunId, limit, offset]
      ),
      this.pool.query<{ total: string | number }>(
        "SELECT count(*) AS total FROM workflow_events WHERE workflow_run_id = $1",
        [workflowRunId]
      )
    ]);
    return { items: rows.rows.map(mapEvent), total: Number(count.rows[0]?.total ?? 0) };
  }
}
