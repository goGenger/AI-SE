import { PgAgentArtifactRepository, PgMetricsRepository } from "@ai-se/database";
import { PrometheusMetric, renderPrometheusText } from "./prometheusText";

/**
 * 7-B：`docs/12` 九项指标的只读导出（Prometheus 文本格式）。
 *
 * | docs/12 九项 | 本服务 | 来源 |
 * | --- | --- | --- |
 * | Agent Run Count | `ai_se_agent_runs{status}` | 本阶段新增聚合 |
 * | Agent / Task / Tool Success Rate | 同名 gauge | 复用 `PgAgentArtifactRepository.metrics()` |
 * | Tool Duration | `ai_se_tool_duration_seconds`（均值）+ `_observations` | 本阶段新增聚合 |
 * | Workflow Duration | `ai_se_workflow_duration_seconds`（均值）+ `_observations` | 本阶段新增聚合 |
 * | Token Usage / Estimated Cost | 同名 gauge | 复用 `PgAgentArtifactRepository.metrics()` |
 * | Deployment Success/Failure | `ai_se_deployments{status}` | 本阶段新增聚合 |
 *
 * 标签只允许有限集合（当前只有 `status`，取值来自库里的 CHECK 约束枚举）。
 * 禁止把 `requestId` / `taskId` / `workflowRunId` 当标签（高基数）。
 */
export class MetricsService {
  constructor(
    private readonly dependencies: {
      artifacts: Pick<PgAgentArtifactRepository, "metrics">;
      metrics: Pick<PgMetricsRepository, "aggregate">;
    }
  ) {}

  async render(): Promise<string> {
    const [evaluation, aggregate] = await Promise.all([
      this.dependencies.artifacts.metrics(),
      this.dependencies.metrics.aggregate()
    ]);

    const statusSamples = (counts: Record<string, number>) =>
      Object.entries(counts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, value]) => ({ labels: { status }, value }));

    const metrics: PrometheusMetric[] = [
      {
        name: "ai_se_agent_runs",
        help: "Agent runs with a resolved agent, by status (same population as ai_se_agent_success_rate).",
        type: "gauge",
        samples: statusSamples(aggregate.agentRuns)
      },
      {
        name: "ai_se_agent_success_rate",
        help: "Succeeded agent runs divided by agent runs with a resolved agent (0-1).",
        type: "gauge",
        samples: optionalSamples(evaluation.agentSuccessRate)
      },
      {
        name: "ai_se_task_success_rate",
        help: "Successful workflow tasks divided by terminal workflow tasks (0-1).",
        type: "gauge",
        samples: optionalSamples(evaluation.taskSuccessRate)
      },
      {
        name: "ai_se_tool_success_rate",
        help: "Succeeded tool calls divided by terminal tool calls (0-1).",
        type: "gauge",
        samples: optionalSamples(evaluation.toolSuccessRate)
      },
      {
        name: "ai_se_tool_duration_seconds",
        help: "Mean tool call duration in seconds.",
        type: "gauge",
        samples: meanSamples(aggregate.toolDurationMs, aggregate.toolDurationSamples)
      },
      {
        name: "ai_se_tool_duration_observations",
        help: "Tool calls with a recorded duration (sample size of ai_se_tool_duration_seconds).",
        type: "gauge",
        samples: [{ value: aggregate.toolDurationSamples }]
      },
      {
        name: "ai_se_workflow_duration_seconds",
        help: "Mean workflow run duration in seconds (started to finished).",
        type: "gauge",
        samples: meanSamples(aggregate.workflowDurationMs, aggregate.workflowDurationSamples)
      },
      {
        name: "ai_se_workflow_duration_observations",
        help: "Finished workflow runs with both timestamps (sample size of ai_se_workflow_duration_seconds).",
        type: "gauge",
        samples: [{ value: aggregate.workflowDurationSamples }]
      },
      {
        name: "ai_se_token_usage",
        help: "Total tokens recorded on agent runs.",
        type: "gauge",
        samples: optionalSamples(evaluation.tokenUsage)
      },
      {
        name: "ai_se_estimated_cost",
        help: "Total estimated model cost recorded on agent runs.",
        type: "gauge",
        samples: optionalSamples(evaluation.estimatedCost)
      },
      {
        name: "ai_se_deployments",
        help: "Deployments by status.",
        type: "gauge",
        samples: statusSamples(aggregate.deployments)
      }
    ];

    return renderPrometheusText(metrics);
  }
}

/** 值可能缺省（分母为 0 / 无数据）时不写样本。 */
function optionalSamples(value: number | undefined) {
  return value === undefined ? [] : [{ value }];
}

/** 均值（毫秒 → 秒）；样本数为 0 时不写该样本。 */
function meanSamples(totalMs: number, samples: number) {
  return samples > 0 ? [{ value: totalMs / samples / 1000 }] : [];
}
