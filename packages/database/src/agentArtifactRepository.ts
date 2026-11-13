import {
  AgentArtifact,
  AgentArtifactType,
  AgentEvaluationMetrics,
  JsonObject
} from "@ai-se/shared";
import { Pool } from "pg";

interface ArtifactRow {
  id: string;
  project_id: string;
  task_id: string;
  agent_run_id: string;
  agent_name: string;
  type: AgentArtifactType;
  name: string;
  content: unknown;
  metadata: unknown;
  created_at: Date | string;
}

export interface CreateAgentArtifactRecord {
  projectId: string;
  taskId: string;
  agentRunId: string;
  agentName: string;
  type: AgentArtifactType;
  name: string;
  content: JsonObject;
  metadata?: JsonObject;
}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function mapArtifact(row: ArtifactRow): AgentArtifact {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    agentRunId: row.agent_run_id,
    agentName: row.agent_name,
    type: row.type,
    name: row.name,
    content: object(row.content),
    metadata: object(row.metadata),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString()
  };
}

function optionalNumber(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function rate(success: string | number, total: string | number): number | undefined {
  const denominator = Number(total);
  return denominator > 0 ? Number(success) / denominator : undefined;
}

export class PgAgentArtifactRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateAgentArtifactRecord): Promise<AgentArtifact> {
    const result = await this.pool.query<ArtifactRow>(
      `
        INSERT INTO agent_artifacts (
          project_id, task_id, agent_run_id, agent_name, type, name, content, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `,
      [
        input.projectId,
        input.taskId,
        input.agentRunId,
        input.agentName,
        input.type,
        input.name,
        input.content,
        input.metadata ?? {}
      ]
    );
    return mapArtifact(result.rows[0]);
  }

  async findByAgentRunId(agentRunId: string): Promise<AgentArtifact[]> {
    const result = await this.pool.query<ArtifactRow>(
      "SELECT * FROM agent_artifacts WHERE agent_run_id = $1 ORDER BY created_at ASC",
      [agentRunId]
    );
    return result.rows.map(mapArtifact);
  }

  async findByTaskIds(taskIds: string[]): Promise<AgentArtifact[]> {
    if (taskIds.length === 0) return [];
    const result = await this.pool.query<ArtifactRow>(
      "SELECT * FROM agent_artifacts WHERE task_id = ANY($1::uuid[]) ORDER BY created_at ASC",
      [taskIds]
    );
    return result.rows.map(mapArtifact);
  }

  async findMany(agentName?: string): Promise<AgentArtifact[]> {
    const result = agentName
      ? await this.pool.query<ArtifactRow>(
          "SELECT * FROM agent_artifacts WHERE agent_name = $1 ORDER BY created_at DESC LIMIT 100",
          [agentName]
        )
      : await this.pool.query<ArtifactRow>(
          "SELECT * FROM agent_artifacts ORDER BY created_at DESC LIMIT 100"
        );
    return result.rows.map(mapArtifact);
  }

  /**
   * 功能清点 T3（基线回归）：某项目里**最近一条**带指定 `metadata.kind` 的工件。
   *
   * `agent_artifacts.type` 是封闭集合（迁移 005），截图基线只能靠 `metadata.kind` 区分；
   * 没有为此加索引——基线查询是每任务一次、项目内行数有限，走的是
   * `agent_artifacts_project_id_idx` 上的顺序扫描。
   */
  async findLatestByMetadataKind(
    projectId: string,
    kind: string
  ): Promise<AgentArtifact | null> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT * FROM agent_artifacts
        WHERE project_id = $1 AND metadata->>'kind' = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [projectId, kind]
    );
    const row = result.rows[0];
    return row ? mapArtifact(row) : null;
  }

  async metrics(): Promise<AgentEvaluationMetrics> {
    const result = await this.pool.query<{
      agent_success: string;
      agent_total: string;
      task_success: string;
      task_total: string;
      tool_success: string;
      tool_total: string;
      test_success: string;
      test_total: string;
      review_success: string;
      review_total: string;
      repair_success: string;
      repair_total: string;
      average_iterations: string | null;
      average_task_duration_ms: string | null;
      token_usage: string | null;
      estimated_cost: string | null;
    }>(`
      SELECT
        (SELECT count(*) FROM agent_runs WHERE input ? 'agentName' AND status = 'succeeded') AS agent_success,
        (SELECT count(*) FROM agent_runs WHERE input ? 'agentName') AS agent_total,
        (SELECT count(*) FROM tasks WHERE workflow_run_id IS NOT NULL AND status = 'SUCCESS') AS task_success,
        (SELECT count(*) FROM tasks WHERE workflow_run_id IS NOT NULL AND status IN ('SUCCESS', 'FAILED', 'BLOCKED', 'CANCELLED')) AS task_total,
        (SELECT count(*) FROM tool_calls WHERE status = 'succeeded') AS tool_success,
        (SELECT count(*) FROM tool_calls WHERE status IN ('succeeded', 'failed', 'cancelled', 'timed_out')) AS tool_total,
        (SELECT count(*) FROM tasks WHERE workflow_run_id IS NOT NULL AND type = 'TEST' AND status = 'SUCCESS') AS test_success,
        (SELECT count(*) FROM tasks WHERE workflow_run_id IS NOT NULL AND type = 'TEST' AND status IN ('SUCCESS', 'FAILED')) AS test_total,
        (SELECT count(*) FROM tasks WHERE workflow_run_id IS NOT NULL AND type = 'REVIEW' AND status = 'SUCCESS') AS review_success,
        (SELECT count(*) FROM tasks WHERE workflow_run_id IS NOT NULL AND type = 'REVIEW' AND status IN ('SUCCESS', 'FAILED')) AS review_total,
        (SELECT count(*) FROM tasks WHERE origin = 'DYNAMIC' AND status = 'SUCCESS') AS repair_success,
        (SELECT count(*) FROM tasks WHERE origin = 'DYNAMIC' AND status IN ('SUCCESS', 'FAILED')) AS repair_total,
        (SELECT avg(current_iteration) FROM agent_runs WHERE input ? 'agentName') AS average_iterations,
        (SELECT avg(extract(epoch FROM (finished_at - started_at)) * 1000) FROM tasks WHERE started_at IS NOT NULL AND finished_at IS NOT NULL) AS average_task_duration_ms,
        (SELECT sum(CASE WHEN token_usage->>'total_tokens' ~ '^[0-9]+$' THEN (token_usage->>'total_tokens')::numeric ELSE 0 END) FROM agent_runs) AS token_usage,
        (SELECT sum(estimated_cost) FROM agent_runs) AS estimated_cost
    `);
    const row = result.rows[0];
    return {
      agentSuccessRate: rate(row.agent_success, row.agent_total),
      taskSuccessRate: rate(row.task_success, row.task_total),
      toolSuccessRate: rate(row.tool_success, row.tool_total),
      testPassRate: rate(row.test_success, row.test_total),
      reviewPassRate: rate(row.review_success, row.review_total),
      repairSuccessRate: rate(row.repair_success, row.repair_total),
      averageAgentIterations: optionalNumber(row.average_iterations),
      averageTaskDurationMs: optionalNumber(row.average_task_duration_ms),
      tokenUsage: optionalNumber(row.token_usage),
      estimatedCost: optionalNumber(row.estimated_cost)
    };
  }
}
