import { describe, expect, it } from "vitest";
import { buildResults, pickPreviousResults, renderSummaryMarkdown } from "../report";
import { EvalPolicy, EvalRunRecord } from "../types";

const policy: EvalPolicy = {
  maxConcurrency: 1,
  maxRetries: 1,
  failureStrategy: "RETRY",
  allowRetry: true,
  allowReplan: false,
  approvalRequired: false
};

function record(overrides: Partial<EvalRunRecord> = {}): EvalRunRecord {
  return {
    fixtureId: "S1",
    tier: "S",
    runIndex: 1,
    workflowId: "wf-1",
    workspacePath: "/tmp/ws",
    taskCount: 2,
    runCount: 2,
    taskStatuses: { SUCCESS: 2 },
    reportedSuccess: true,
    oraclePassed: true,
    falsePositive: false,
    parseRecoveryRuns: 0,
    humanInterventions: 0,
    tokenUsage: { input: 10, output: 2 },
    estimatedCostUsd: 0.001,
    durationMs: 4200,
    errorTypes: {},
    failureSummary: null,
    ...overrides
  };
}

describe("buildResults", () => {
  it("汇总随记录一起产出", () => {
    const results = buildResults({
      generatedAt: "2026-09-29T00:00:00.000Z",
      baseUrl: "http://127.0.0.1:3000",
      policy,
      records: [record()]
    });

    expect(results.summary.runs).toBe(1);
    expect(results.policy).toEqual(policy);
  });
});

describe("renderSummaryMarkdown", () => {
  it("包含关键指标、分档表与逐次运行行", () => {
    const results = buildResults({
      generatedAt: "2026-09-29T00:00:00.000Z",
      baseUrl: "http://127.0.0.1:3000",
      policy,
      records: [record(), record({ runIndex: 2, oraclePassed: false, falsePositive: true })]
    });

    const markdown = renderSummaryMarkdown(results);

    expect(markdown).toContain("假阳性率");
    expect(markdown).toContain("| S1 | S | 1 | wf-1 |");
    expect(markdown).toContain("50.0%");
  });

  it("带噪声线时渲染差值段落", () => {
    const results = buildResults({
      generatedAt: "2026-09-29T00:00:00.000Z",
      baseUrl: "http://127.0.0.1:3000",
      policy,
      records: [record()]
    });

    const markdown = renderSummaryMarkdown(results, { trueSuccessRate: 0.25 });

    expect(markdown).toContain("噪声线");
    expect(markdown).toContain("trueSuccessRate: 0.25");
  });
});

describe("未完成夹具", () => {
  it("failures 会渲染到汇总的「未完成夹具」小节", () => {
    const results = buildResults({
      generatedAt: "2026-09-29T00:00:00.000Z",
      baseUrl: "http://127.0.0.1:3000",
      policy,
      records: [record()],
      failures: [{ fixtureId: "L1", stage: "planning", message: "规划超时：x" }]
    });

    const markdown = renderSummaryMarkdown(results);

    expect(markdown).toContain("未完成夹具");
    expect(markdown).toContain("L1（planning）：规划超时：x");
    expect(results.failures).toHaveLength(1);
  });
});

describe("pickPreviousResults（docs/189 §4.5：噪声线基线的读取面）", () => {
  function results(generatedAt: string) {
    return buildResults({
      generatedAt,
      baseUrl: "http://localhost:1",
      policy,
      records: [record()]
    });
  }

  it("取候选里 generatedAt 最大的一份", () => {
    const picked = pickPreviousResults(
      [
        { path: "/r/run-1.json", results: results("2026-10-19T08:00:00.000Z") },
        { path: "/r/run-2.json", results: results("2026-10-19T09:00:00.000Z") }
      ],
      "/r/run-3.json"
    );
    expect(picked?.generatedAt).toBe("2026-10-19T09:00:00.000Z");
  });

  it("排除本次输出——即使它的时间戳最大", () => {
    const picked = pickPreviousResults(
      [
        { path: "/r/run-1.json", results: results("2026-10-19T08:00:00.000Z") },
        { path: "/r/run-2.json", results: results("2026-10-19T09:00:00.000Z") }
      ],
      "/r/run-2.json"
    );
    expect(picked?.generatedAt).toBe("2026-10-19T08:00:00.000Z");
  });

  it("候选为空、或只剩本次输出 ⇒ null（本次是目录里的第一份）", () => {
    expect(pickPreviousResults([], "/r/run-1.json")).toBeNull();
    expect(
      pickPreviousResults(
        [{ path: "/r/run-1.json", results: results("2026-10-19T08:00:00.000Z") }],
        "/r/run-1.json"
      )
    ).toBeNull();
  });

  it("按 generatedAt 取最新，不按文件名排序（批次内两类命名混用）", () => {
    // 文件名上 `run-2.json` 排在 `2026-10-19T…` 之后，但它其实更早。
    const picked = pickPreviousResults(
      [
        { path: "/r/run-2.json", results: results("2026-10-19T08:00:00.000Z") },
        { path: "/r/2026-10-19T09-00-00-000Z.json", results: results("2026-10-19T09:00:00.000Z") }
      ],
      "/r/out.json"
    );
    expect(picked?.generatedAt).toBe("2026-10-19T09:00:00.000Z");
  });
});
