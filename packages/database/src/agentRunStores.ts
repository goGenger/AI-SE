import {
  AgentRun,
  AgentRunContext,
  AgentRunStatus,
  AgentRunSummary,
  ApiErrorBody,
  JsonObject,
  ToolCallAudit,
  ToolCallStatus,
  WorkflowEvent
} from "@ai-se/shared";
import { Pool } from "pg";
import { jsonbSafe } from "./jsonbSafe";

interface AgentRunRow {
  id: string;
  project_id: string | null;
  task_id: string;
  status: AgentRunStatus;
  input: unknown;
  output: unknown | null;
  current_iteration: number;
  max_iterations: number;
  retry_count: number;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  error: unknown | null;
  token_usage: unknown | null;
  estimated_cost: string | number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** UX-03: agent_runs LEFT JOINed with the engineering context entities. */
interface AgentRunSummaryRow extends AgentRunRow {
  project_name: string | null;
  requirement_name: string | null;
  planning_version: number | null;
  task_key: string | null;
  task_title: string | null;
  agent_name: string | null;
  agent_type: string | null;
}

interface AgentRunContextRow {
  project_name: string | null;
  agent_name: string | null;
  agent_type: string | null;
  workflow_id: string | null;
  requirement_name: string | null;
  planning_version: number | null;
  max_retries: number | null;
  task_row_id: string | null;
  task_key: string | null;
  task_title: string | null;
  task_type: string | null;
  task_status: string | null;
  task_origin: string | null;
  task_retry_count: number | null;
  creation_reason: string | null;
  task_outcome: string | null;
  task_summary: string | null;
}

interface ToolCallRow {
  id: string;
  agent_run_id: string;
  iteration: number;
  tool_call_id: string;
  tool_name: string;
  input: unknown;
  output: unknown | null;
  status: ToolCallStatus;
  error: unknown | null;
  duration: number | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  created_at: Date | string;
}

interface WorkflowEventRow {
  id: string;
  workflow_run_id: string | null;
  task_id: string | null;
  agent_run_id: string | null;
  event_type: string;
  payload: unknown;
  created_at: Date | string;
}

export interface CreateAgentRunRecord {
  id?: string;
  projectId?: string;
  taskId: string;
  status?: AgentRunStatus;
  input: JsonObject;
  maxIterations: number;
}

export interface UpdateAgentRunRecord {
  status?: AgentRunStatus;
  output?: JsonObject;
  currentIteration?: number;
  retryCount?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: ApiErrorBody;
  tokenUsage?: JsonObject;
  estimatedCost?: number;
}

export interface CreateToolCallRecord {
  agentRunId: string;
  iteration: number;
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  status?: ToolCallStatus;
  startedAt?: string;
}

export interface FinishToolCallRecord {
  agentRunId: string;
  toolCallId: string;
  output?: JsonObject;
  status: ToolCallStatus;
  error?: ApiErrorBody;
  duration?: number;
  finishedAt?: string;
}

export interface CreateWorkflowEventRecord {
  workflowRunId?: string;
  taskId?: string;
  agentRunId?: string;
  eventType: string;
  payload: JsonObject;
  createdAt?: string;
}

function toIsoString(value: Date | string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function jsonObject(value: unknown): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

function optionalJsonObject(value: unknown | null): JsonObject | undefined {
  if (!value) {
    return undefined;
  }

  return jsonObject(value);
}

function optionalError(value: unknown | null): ApiErrorBody | undefined {
  const object = optionalJsonObject(value);
  if (!object) {
    return undefined;
  }

  return {
    code: typeof object.code === "string" ? object.code : "UNKNOWN_ERROR",
    message: typeof object.message === "string" ? object.message : "Unknown error",
    details: object.details
  };
}

function optionalCost(value: string | number | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  return Number(value);
}

function mapAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    taskId: row.task_id,
    status: row.status,
    input: jsonObject(row.input),
    output: optionalJsonObject(row.output),
    currentIteration: row.current_iteration,
    maxIterations: row.max_iterations,
    retryCount: row.retry_count,
    startedAt: toIsoString(row.started_at),
    finishedAt: toIsoString(row.finished_at),
    error: optionalError(row.error),
    tokenUsage: optionalJsonObject(row.token_usage),
    estimatedCost: optionalCost(row.estimated_cost),
    createdAt: toIsoString(row.created_at) ?? "",
    updatedAt: toIsoString(row.updated_at) ?? ""
  };
}

function mapAgentRunSummary(row: AgentRunSummaryRow): AgentRunSummary {
  const input = jsonObject(row.input);
  return {
    ...mapAgentRun(row),
    projectName: row.project_name,
    workflowRunId: typeof input.workflowRunId === "string" ? input.workflowRunId : null,
    requirementName: row.requirement_name,
    planningVersion: row.planning_version,
    taskKey: row.task_key,
    taskTitle: row.task_title,
    agentName: row.agent_name,
    agentType: row.agent_type
  };
}

function mapContext(row: AgentRunContextRow): AgentRunContext {
  return {
    projectName: row.project_name,
    workflow: row.workflow_id
      ? {
          id: row.workflow_id,
          requirementName: row.requirement_name,
          planningVersion: row.planning_version ?? 1
        }
      : null,
    task:
      row.task_row_id && row.task_key !== null
        ? {
            id: row.task_row_id,
            taskKey: row.task_key,
            title: row.task_title ?? "",
            type: row.task_type ?? "",
            status: row.task_status ?? "",
            origin: row.task_origin ?? "",
            retryCount: row.task_retry_count ?? 0,
            ...(row.creation_reason ? { creationReason: row.creation_reason } : {}),
            ...(row.task_outcome !== null ? { outcome: row.task_outcome } : {}),
            ...(row.task_summary !== null ? { summary: row.task_summary } : {})
          }
        : null,
    agentName: row.agent_name,
    agentType: row.agent_type,
    maxRetries: row.max_retries
  };
}

function mapToolCall(row: ToolCallRow): ToolCallAudit {
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    iteration: row.iteration,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    input: jsonObject(row.input),
    output: optionalJsonObject(row.output),
    status: row.status,
    error: optionalError(row.error),
    duration: row.duration ?? undefined,
    startedAt: toIsoString(row.started_at) ?? "",
    finishedAt: toIsoString(row.finished_at),
    createdAt: toIsoString(row.created_at) ?? ""
  };
}

function mapWorkflowEvent(row: WorkflowEventRow): WorkflowEvent {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id ?? undefined,
    taskId: row.task_id ?? undefined,
    agentRunId: row.agent_run_id ?? undefined,
    eventType: row.event_type,
    payload: jsonObject(row.payload),
    createdAt: toIsoString(row.created_at) ?? ""
  };
}

export class PgAgentRunStore {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateAgentRunRecord): Promise<AgentRun> {
    const result = await this.pool.query<AgentRunRow>(
      `
        INSERT INTO agent_runs (id, project_id, task_id, status, input, max_iterations)
        VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6)
        RETURNING *
      `,
      [
        input.id ?? null,
        input.projectId ?? null,
        input.taskId,
        input.status ?? "created",
        jsonbSafe(input.input),
        input.maxIterations
      ]
    );

    return mapAgentRun(result.rows[0]);
  }

  async findMany(): Promise<AgentRunSummary[]> {
    const result = await this.pool.query<AgentRunSummaryRow>(`
      SELECT ar.*,
             p.name AS project_name,
             r.title AS requirement_name,
             wr.planning_version,
             t.task_key,
             t.title AS task_title,
             ar.input->>'agentName' AS agent_name,
             ar.input->>'agentType' AS agent_type
        FROM agent_runs ar
        LEFT JOIN projects p ON p.id = ar.project_id
        LEFT JOIN tasks t ON t.id = ar.task_id
        LEFT JOIN workflow_runs wr ON wr.id = (ar.input->>'workflowRunId')::uuid
        LEFT JOIN requirements r ON r.id = wr.requirement_id
       ORDER BY ar.created_at DESC
    `);

    return result.rows.map(mapAgentRunSummary);
  }

  /**
   * UX-03: readable context chain for one run (project / workflow+requirement /
   * task), resolved from the existing entities via the run's own identifiers.
   * Returns null when the run row does not exist.
   */
  async findContext(id: string): Promise<AgentRunContext | null> {
    const result = await this.pool.query<AgentRunContextRow>(
      `
        SELECT p.name AS project_name,
               ar.input->>'agentName' AS agent_name,
               ar.input->>'agentType' AS agent_type,
               wr.id AS workflow_id,
               r.title AS requirement_name,
               wr.planning_version,
               wr.max_retries,
               t.id AS task_row_id,
               t.task_key,
               t.title AS task_title,
               t.type AS task_type,
               t.status AS task_status,
               t.origin AS task_origin,
               t.retry_count AS task_retry_count,
               t.creation_reason,
               t.output->>'outcome' AS task_outcome,
               t.output->>'summary' AS task_summary
        FROM agent_runs ar
        LEFT JOIN projects p ON p.id = ar.project_id
        LEFT JOIN tasks t ON t.id = ar.task_id
        LEFT JOIN workflow_runs wr ON wr.id = (ar.input->>'workflowRunId')::uuid
        LEFT JOIN requirements r ON r.id = wr.requirement_id
        WHERE ar.id = $1
      `,
      [id]
    );

    return result.rows[0] ? mapContext(result.rows[0]) : null;
  }

  async findById(id: string): Promise<AgentRun | null> {
    const result = await this.pool.query<AgentRunRow>("SELECT * FROM agent_runs WHERE id = $1", [
      id
    ]);

    return result.rows[0] ? mapAgentRun(result.rows[0]) : null;
  }

  async findByTaskId(taskId: string): Promise<AgentRun[]> {
    const result = await this.pool.query<AgentRunRow>(
      `SELECT * FROM agent_runs WHERE task_id = $1 ORDER BY created_at DESC`,
      [taskId]
    );
    return result.rows.map(mapAgentRun);
  }

  /** 7-C：一次取回一组任务的全部 Agent Run（追踪树；空数组不发查询）。 */
  async findByTaskIds(taskIds: string[]): Promise<AgentRun[]> {
    if (taskIds.length === 0) return [];
    const result = await this.pool.query<AgentRunRow>(
      `SELECT * FROM agent_runs WHERE task_id = ANY($1::uuid[])
        ORDER BY created_at ASC, id ASC`,
      [taskIds]
    );
    return result.rows.map(mapAgentRun);
  }

  async update(id: string, patch: UpdateAgentRunRecord): Promise<AgentRun | null> {
    const result = await this.pool.query<AgentRunRow>(
      `
        UPDATE agent_runs
        SET
          status = COALESCE($2, status),
          output = COALESCE($3, output),
          current_iteration = COALESCE($4, current_iteration),
          retry_count = COALESCE($5, retry_count),
          started_at = COALESCE($6, started_at),
          finished_at = COALESCE($7, finished_at),
          error = COALESCE($8, error),
          token_usage = COALESCE($9, token_usage),
          estimated_cost = COALESCE($10, estimated_cost)
        WHERE id = $1
        RETURNING *
      `,
      [
        id,
        patch.status ?? null,
        jsonbSafe(patch.output ?? null),
        patch.currentIteration ?? null,
        patch.retryCount ?? null,
        patch.startedAt ?? null,
        patch.finishedAt ?? null,
        jsonbSafe(patch.error ?? null),
        jsonbSafe(patch.tokenUsage ?? null),
        patch.estimatedCost ?? null
      ]
    );

    return result.rows[0] ? mapAgentRun(result.rows[0]) : null;
  }

  async markCancellationRequested(id: string): Promise<AgentRun | null> {
    const result = await this.pool.query<AgentRunRow>(
      `
        UPDATE agent_runs
        SET status = CASE
          WHEN status IN ('created', 'running') THEN 'cancelling'
          ELSE status
        END
        WHERE id = $1
        RETURNING *
      `,
      [id]
    );

    return result.rows[0] ? mapAgentRun(result.rows[0]) : null;
  }

  async markInterruptedRuns(message: string): Promise<number> {
    const result = await this.pool.query(
      `
        UPDATE agent_runs
        SET
          status = 'failed',
          finished_at = COALESCE(finished_at, now()),
          error = jsonb_build_object('code', 'UNKNOWN_ERROR', 'message', $1)
        WHERE status IN ('created', 'running', 'cancelling')
      `,
      [message]
    );

    return result.rowCount ?? 0;
  }
}

export class PgToolCallStore {
  constructor(private readonly pool: Pool) {}

  async start(input: CreateToolCallRecord): Promise<ToolCallAudit> {
    const result = await this.pool.query<ToolCallRow>(
      `
        INSERT INTO tool_calls (
          agent_run_id,
          iteration,
          tool_call_id,
          tool_name,
          input,
          status,
          started_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
        ON CONFLICT (agent_run_id, tool_call_id)
        DO UPDATE SET
          iteration = EXCLUDED.iteration,
          tool_name = EXCLUDED.tool_name,
          input = EXCLUDED.input,
          status = EXCLUDED.status,
          started_at = EXCLUDED.started_at
        RETURNING *
      `,
      [
        input.agentRunId,
        input.iteration,
        input.toolCallId,
        input.toolName,
        jsonbSafe(input.input),
        input.status ?? "running",
        input.startedAt ?? null
      ]
    );

    return mapToolCall(result.rows[0]);
  }

  async finish(input: FinishToolCallRecord): Promise<ToolCallAudit | null> {
    const result = await this.pool.query<ToolCallRow>(
      `
        UPDATE tool_calls
        SET
          output = COALESCE($3, output),
          status = $4,
          error = COALESCE($5, error),
          duration = COALESCE($6, duration),
          finished_at = COALESCE($7, now())
        WHERE agent_run_id = $1 AND tool_call_id = $2
        RETURNING *
      `,
      [
        input.agentRunId,
        input.toolCallId,
        jsonbSafe(input.output ?? null),
        input.status,
        jsonbSafe(input.error ?? null),
        input.duration ?? null,
        input.finishedAt ?? null
      ]
    );

    return result.rows[0] ? mapToolCall(result.rows[0]) : null;
  }

  async findByAgentRunId(agentRunId: string): Promise<ToolCallAudit[]> {
    const result = await this.pool.query<ToolCallRow>(
      `
        SELECT *
        FROM tool_calls
        WHERE agent_run_id = $1
        ORDER BY started_at ASC, created_at ASC
      `,
      [agentRunId]
    );

    return result.rows.map(mapToolCall);
  }

  /** 7-C：一次取回一组 Agent Run 的全部工具调用（追踪树；空数组不发查询）。 */
  async findByAgentRunIds(agentRunIds: string[]): Promise<ToolCallAudit[]> {
    if (agentRunIds.length === 0) return [];
    const result = await this.pool.query<ToolCallRow>(
      `
        SELECT *
        FROM tool_calls
        WHERE agent_run_id = ANY($1::uuid[])
        ORDER BY started_at ASC, created_at ASC, tool_call_id ASC
      `,
      [agentRunIds]
    );

    return result.rows.map(mapToolCall);
  }
}

export class PgWorkflowEventStore {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateWorkflowEventRecord): Promise<WorkflowEvent> {
    const result = await this.pool.query<WorkflowEventRow>(
      `
        INSERT INTO workflow_events (
          workflow_run_id, task_id, agent_run_id, event_type, payload, created_at
        )
        VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))
        RETURNING *
      `,
      [
        input.workflowRunId ?? null,
        input.taskId ?? null,
        input.agentRunId ?? null,
        input.eventType,
        input.payload,
        input.createdAt ?? null
      ]
    );

    return mapWorkflowEvent(result.rows[0]);
  }

  async findByAgentRunId(agentRunId: string): Promise<WorkflowEvent[]> {
    const result = await this.pool.query<WorkflowEventRow>(
      `
        SELECT *
        FROM workflow_events
        WHERE agent_run_id = $1
        ORDER BY sequence ASC, created_at ASC
      `,
      [agentRunId]
    );

    return result.rows.map(mapWorkflowEvent);
  }

  /**
   * UX-03: engine-level failure / recovery events for one task — bounded narrow
   * query (event types only), used to derive the run's recovery state without
   * loading the workflow's full event history.
   */
  async findTaskFailureEvents(workflowRunId: string, taskId: string): Promise<WorkflowEvent[]> {
    const result = await this.pool.query<WorkflowEventRow>(
      `
        SELECT *
        FROM workflow_events
        WHERE workflow_run_id = $1
          AND task_id = $2
          AND event_type IN ('FAILURE_ROUTED', 'FAILURE_HUMAN_REQUIRED', 'TASK_RETRYING')
        ORDER BY sequence ASC, created_at ASC
      `,
      [workflowRunId, taskId]
    );

    return result.rows.map(mapWorkflowEvent);
  }

  async findByWorkflowRunId(workflowRunId: string): Promise<WorkflowEvent[]> {
    const result = await this.pool.query<WorkflowEventRow>(
      `
        SELECT *
        FROM workflow_events
        WHERE workflow_run_id = $1
        ORDER BY sequence ASC, created_at ASC
      `,
      [workflowRunId]
    );
    return result.rows.map(mapWorkflowEvent);
  }

  /**
   * 7-A: 触发该工作流的 HTTP 请求 ID（`WORKFLOW_STARTED` payload 里记录）。
   * 窄查询，只取最早一条；本改动之前启动的运行没有该字段 → undefined。
   */
  async findWorkflowStartedRequestId(workflowRunId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ request_id: string | null }>(
      `
        SELECT payload->>'requestId' AS request_id
        FROM workflow_events
        WHERE workflow_run_id = $1
          AND event_type = 'WORKFLOW_STARTED'
        ORDER BY sequence ASC, created_at ASC
        LIMIT 1
      `,
      [workflowRunId]
    );
    const requestId = result.rows[0]?.request_id;
    return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
  }
}
