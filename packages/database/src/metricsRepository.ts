import { Pool } from "pg";

/**
 * 7-B：`docs/12` 九项指标里 `GET /api/agents/metrics` 没覆盖的那几项。
 * 覆盖项（成功率三项、token、成本）一律复用 `PgAgentArtifactRepository.metrics()`，
 * 不在这里另写一份口径——避免同一件事出现两套数字。
 */
export interface PlatformMetricsAggregate {
  /** Agent 运行按状态计数；口径与 `agentSuccessRate` 的分母一致（`input ? 'agentName'`）。 */
  agentRuns: Record<string, number>;
  /** 工具调用按状态计数。 */
  toolCalls: Record<string, number>;
  /** 部署按状态计数。 */
  deployments: Record<string, number>;
  toolDurationMs: number;
  toolDurationSamples: number;
  workflowDurationMs: number;
  workflowDurationSamples: number;
}

interface AggregateRow {
  agent_runs: Record<string, string> | null;
  tool_calls: Record<string, string> | null;
  deployments: Record<string, string> | null;
  tool_duration_ms: string | null;
  tool_duration_samples: string | null;
  workflow_duration_ms: string | null;
  workflow_duration_samples: string | null;
}

function counts(value: Record<string, string> | null): Record<string, number> {
  return Object.fromEntries(Object.entries(value ?? {}).map(([key, total]) => [key, Number(total)]));
}

function total(value: string | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class PgMetricsRepository {
  constructor(private readonly pool: Pool) {}

  async aggregate(): Promise<PlatformMetricsAggregate> {
    const result = await this.pool.query<AggregateRow>(`
      SELECT
        (SELECT jsonb_object_agg(status, total) FROM (
           SELECT status, count(*) AS total FROM agent_runs WHERE input ? 'agentName' GROUP BY status
         ) AS agent_run_status) AS agent_runs,
        (SELECT jsonb_object_agg(status, total) FROM (
           SELECT status, count(*) AS total FROM tool_calls GROUP BY status
         ) AS tool_call_status) AS tool_calls,
        (SELECT jsonb_object_agg(status, total) FROM (
           SELECT status, count(*) AS total FROM deployments GROUP BY status
         ) AS deployment_status) AS deployments,
        (SELECT COALESCE(sum(duration), 0) FROM tool_calls WHERE duration IS NOT NULL) AS tool_duration_ms,
        (SELECT count(*) FROM tool_calls WHERE duration IS NOT NULL) AS tool_duration_samples,
        (SELECT COALESCE(sum(extract(epoch FROM (finished_at - started_at)) * 1000), 0)
           FROM workflow_runs
          WHERE started_at IS NOT NULL AND finished_at IS NOT NULL) AS workflow_duration_ms,
        (SELECT count(*) FROM workflow_runs
          WHERE started_at IS NOT NULL AND finished_at IS NOT NULL) AS workflow_duration_samples
    `);
    const row = result.rows[0];
    return {
      agentRuns: counts(row?.agent_runs ?? null),
      toolCalls: counts(row?.tool_calls ?? null),
      deployments: counts(row?.deployments ?? null),
      toolDurationMs: total(row?.tool_duration_ms ?? null),
      toolDurationSamples: total(row?.tool_duration_samples ?? null),
      workflowDurationMs: total(row?.workflow_duration_ms ?? null),
      workflowDurationSamples: total(row?.workflow_duration_samples ?? null)
    };
  }
}
