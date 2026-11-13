import { describe, expect, it } from "vitest";
import { renderPrometheusText } from "../services/prometheusText";

/** 最小 Prometheus 文本解析器：只认 # HELP / # TYPE / `name{labels} value` 三种行。 */
function parse(text: string) {
  const families = new Map<
    string,
    { help: string; type: string; samples: Array<{ labels: Record<string, string>; value: number }> }
  >();
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const help = /^# HELP (\S+) (.+)$/.exec(line);
    if (help) {
      const family = families.get(help[1]) ?? { help: "", type: "", samples: [] };
      family.help = help[2];
      families.set(help[1], family);
      continue;
    }
    const type = /^# TYPE (\S+) (\S+)$/.exec(line);
    if (type) {
      const family = families.get(type[1]) ?? { help: "", type: "", samples: [] };
      family.type = type[2];
      families.set(type[1], family);
      continue;
    }
    const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? (\S+)$/.exec(line);
    if (!sample) throw new Error(`unparsable line: ${line}`);
    const labels: Record<string, string> = {};
    for (const pair of sample[3]?.split(",") ?? []) {
      const [key, value] = pair.split("=");
      labels[key] = value.slice(1, -1);
    }
    const family = families.get(sample[1]);
    if (!family) throw new Error(`sample without family: ${line}`);
    family.samples.push({ labels, value: Number(sample[4]) });
  }
  return families;
}

describe("prometheus text exporter (7-B)", () => {
  it("emits HELP/TYPE once per family and parsable sample lines", () => {
    const text = renderPrometheusText([
      {
        name: "ai_se_agent_runs",
        help: "Agent runs by status.",
        type: "gauge",
        samples: [
          { labels: { status: "succeeded" }, value: 2 },
          { labels: { status: "failed" }, value: 1 }
        ]
      },
      {
        name: "ai_se_tool_success_rate",
        help: "Tool success rate.",
        type: "gauge",
        samples: [{ value: 0.5 }]
      }
    ]);

    expect(text.endsWith("\n")).toBe(true);
    const families = parse(text);
    expect(families.get("ai_se_agent_runs")).toEqual({
      help: "Agent runs by status.",
      type: "gauge",
      samples: [
        { labels: { status: "succeeded" }, value: 2 },
        { labels: { status: "failed" }, value: 1 }
      ]
    });
    expect(families.get("ai_se_tool_success_rate")?.samples).toEqual([
      { labels: {}, value: 0.5 }
    ]);
    expect(text).toContain("# TYPE ai_se_agent_runs gauge");
  });

  it("escapes label values and skips non-finite samples", () => {
    const text = renderPrometheusText([
      {
        name: "ai_se_deployments",
        help: "Deployments by status.",
        type: "gauge",
        samples: [
          { labels: { status: 'quo"te\\back' }, value: 1 },
          { value: Number.NaN }
        ]
      }
    ]);

    expect(text).toContain('ai_se_deployments{status="quo\\"te\\\\back"} 1');
    // NaN 不写出：只声明家族，不写样本。
    expect(text.split("\n").filter((line) => line.startsWith("ai_se_deployments"))).toHaveLength(1);
    expect(() => parse(text)).not.toThrow();
  });

  it("declares a family with no samples when there is no data", () => {
    const text = renderPrometheusText([
      { name: "ai_se_task_success_rate", help: "Task success rate.", type: "gauge", samples: [] }
    ]);
    expect(text).toBe(
      "# HELP ai_se_task_success_rate Task success rate.\n# TYPE ai_se_task_success_rate gauge\n"
    );
  });
});
