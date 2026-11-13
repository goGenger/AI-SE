/**
 * 7-B：Prometheus 文本格式（`text/plain; version=0.0.4`）最小导出器——零依赖。
 * 只支持本阶段需要的形态：单值 gauge 与带标签的 gauge。
 */

export interface PrometheusSample {
  labels?: Record<string, string>;
  value: number;
}

export interface PrometheusMetric {
  name: string;
  help: string;
  type: "gauge";
  samples: PrometheusSample[];
}

/** 标签值转义（反斜杠、双引号、换行）——Prometheus 文本格式的硬性要求。 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: Record<string, string> | undefined): string {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

/**
 * 数值一律十进制展开（不用指数形式），保证与直接 SQL 聚合逐位一致；
 * NaN / Infinity 跳过该样本（无数据的比率不写出来，而不是写 NaN）。
 */
function renderValue(value: number): string | null {
  return Number.isFinite(value) ? String(value) : null;
}

export function renderPrometheusText(metrics: PrometheusMetric[]): string {
  const lines: string[] = [];
  for (const metric of metrics) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    for (const sample of metric.samples) {
      const value = renderValue(sample.value);
      if (value === null) continue;
      lines.push(`${metric.name}${renderLabels(sample.labels)} ${value}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
