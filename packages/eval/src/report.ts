import { EvalFailure, EvalResults, EvalRunRecord, EvalSummary, EvalPolicy } from "./types";
import { summarize } from "./metrics";

export function buildResults(input: {
  generatedAt: string;
  baseUrl: string;
  policy: EvalPolicy;
  records: EvalRunRecord[];
  failures?: EvalFailure[];
}): EvalResults {
  return {
    generatedAt: input.generatedAt,
    baseUrl: input.baseUrl,
    policy: input.policy,
    records: input.records,
    failures: input.failures ?? [],
    summary: summarize(input.records)
  };
}

/**
 * `docs/189` §4.5：噪声线基线——从**同一目录**下的候选结果里挑出「上一份」。
 *
 * 修前 `cli.ts` 取的是 `results/` **根目录**下文件名最新的一份，而批次脚本把结果写进
 * `results/<批次>/run-N.json`，于是 run 2 的「噪声线」比的是根目录里的历史批次（实测比到了
 * 10 月 1 日的那一份）。
 *
 * 按 `generatedAt` 取最大而不是按文件名排序：批次内 `run-2.json` 与 `2026-10-19T….json`
 * 两类命名混用，文件名排序给不出「更晚」的语义。
 */
export function pickPreviousResults(
  candidates: readonly { path: string; results: EvalResults }[],
  excludePath: string
): EvalResults | null {
  let latest: { generatedAt: string; results: EvalResults } | null = null;
  for (const candidate of candidates) {
    if (candidate.path === excludePath) continue;
    const generatedAt = String(candidate.results.generatedAt ?? "");
    if (!latest || generatedAt > latest.generatedAt) {
      latest = { generatedAt, results: candidate.results };
    }
  }
  return latest?.results ?? null;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderSummaryMarkdown(
  results: EvalResults,
  noise?: Record<string, number>
): string {
  const { summary } = results;
  const lines: string[] = [];
  lines.push(`# P0 评测结果（${results.generatedAt}）`);
  lines.push("");
  lines.push(`- 平台：${results.baseUrl}`);
  lines.push(`- 运行数：${summary.runs}`);
  lines.push(
    `- 真成功率：${percent(summary.trueSuccessRate)} 自报成功率：${percent(
      summary.reportedSuccessRate
    )} **假阳性率：${percent(summary.falsePositiveRate)}**`
  );
  lines.push(
    `- 解析降级率：${percent(summary.parseRecoveryRate)} 人工介入：${summary.humanInterventions}`
  );
  lines.push(
    `- token：输入 ${summary.tokenUsage.input} / 输出 ${summary.tokenUsage.output} 估算成本：$${summary.estimatedCostUsd.toFixed(4)}`
  );
  // F1-8（FX-26）：冻结口径行。
  lines.push(
    `- **链完成率：${percent(summary.chainCompletedRate)} 真交付成功率：${percent(
      summary.deliveredSuccessRate
    )} 假阴性数：${summary.falseNegativeCount}** 超范围写入：${summary.scopeViolations}`
  );
  // L1-8：staging 段判据（`deliveredSuccess` 已裁定弃用，见 docs/131 后续块）。
  lines.push(
    `- **staging 段交付率：${percent(summary.stagingDeliveryRate)}**（CI ∧ staging DEPLOY ∧ staging VERIFY 三段均成功）`
  );
  lines.push(
    `- 任务级验证分歧：${summary.taskVerificationDivergence} 验证门失败码：${
      Object.entries(summary.verificationFailureCodes)
        .map(([code, count]) => `${code}×${count}`)
        .join(" ") || "（无）"
    }`
  );
  // PL-M9 9a：检查不可判定（有候选检查但工作区缺 script → 一条检查都没跑）的任务数。
  lines.push(
    `- 检查不可判定：${summary.verificationUnavailable}（${
      Object.entries(summary.verificationUnavailableByType)
        .map(([type, count]) => `${type}×${count}`)
        .join(" ") || "（无）"
    }）`
  );
  lines.push(
    `- 失败分层：规划 ${summary.failureLayers.planning} / 验证门 ${summary.failureLayers.verification} / agent ${summary.failureLayers.agent}`
  );
  lines.push(
    `- 规划修复：自动 ${summary.planningRepair.autoFixRounds} 轮 / LLM ${summary.planningRepair.llmRepairRounds} 轮 / 切片校验失败 ${summary.planningRepair.sliceValidationFailureRounds} 轮；首轮通过率 ${
      summary.planningRepair.firstPassRate === null
        ? "（无样本）"
        : percent(summary.planningRepair.firstPassRate)
    } 收敛率 ${
      summary.planningRepair.convergenceRate === null
        ? "（无样本）"
        : percent(summary.planningRepair.convergenceRate)
    }`
  );
  const reached = Object.entries(summary.sliceReachedDistribution);
  if (reached.length > 0) {
    lines.push(`- 切片到达分布：${reached.map(([key, count]) => `${key}×${count}`).join(" ")}`);
  }
  lines.push("");
  lines.push("## 分档");
  lines.push("");
  lines.push("| 档 | 运行数 | 真成功率 | 假阳性率 |");
  lines.push("| --- | --- | --- | --- |");
  for (const [tier, tierSummary] of Object.entries(summary.byTier)) {
    lines.push(
      `| ${tier} | ${tierSummary.runs} | ${percent(tierSummary.trueSuccessRate)} | ${percent(
        tierSummary.falsePositiveRate
      )} |`
    );
  }
  lines.push("");
  lines.push("## 失败原因分布");
  lines.push("");
  const errorTypes = Object.entries(summary.errorTypes);
  if (errorTypes.length === 0) {
    lines.push("（无）");
  } else {
    for (const [type, count] of errorTypes) {
      lines.push(`- ${type}: ${count}`);
    }
  }
  if (results.failures.length > 0) {
    lines.push("");
    lines.push("## 未完成夹具（失败被隔离，未中断整批）");
    lines.push("");
    for (const failure of results.failures) {
      lines.push(`- ${failure.fixtureId}（${failure.stage}）：${failure.message}`);
    }
  }
  if (noise) {
    lines.push("");
    lines.push("## 噪声线（本次 - 上次）");
    lines.push("");
    for (const [metric, delta] of Object.entries(noise)) {
      lines.push(`- ${metric}: ${delta}`);
    }
  }
  lines.push("");
  lines.push("## 逐次运行");
  lines.push("");
  lines.push(
    "| 夹具 | 档 | # | 工作流 | 任务状态 | 自报 | oracle | 假阳性 | 链完成 | 交付 | staging 段 | 降级 | 介入 | 耗时(ms) |"
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const record of results.records) {
    const staging = record.stagingSegment;
    lines.push(
      `| ${record.fixtureId} | ${record.tier} | ${record.runIndex} | ${record.workflowId} | ${Object.entries(
        record.taskStatuses
      )
        .map(([status, count]) => `${status}×${count}`)
        .join(" ")} | ${record.reportedSuccess ? "成功" : "失败"} | ${
        record.oraclePassed ? "通过" : "不通过"
      } | ${record.falsePositive ? "是" : "否"} | ${
        record.chainCompleted === undefined ? "-" : record.chainCompleted ? "是" : "否"
      } | ${
        record.deliveredSuccess === undefined ? "-" : record.deliveredSuccess ? "是" : "否"
      } | ${
        staging === undefined
          ? "-"
          : `${staging.delivered ? "是" : "否"}（${staging.ci ?? "-"}/${staging.deploy ?? "-"}/${
              staging.verify ?? "-"
            }）`
      } | ${record.parseRecoveryRuns} | ${record.humanInterventions} | ${record.durationMs ?? "-"} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function summarizeForLog(summary: EvalSummary): string {
  return `runs=${summary.runs} true=${percent(summary.trueSuccessRate)} falsePositive=${percent(
    summary.falsePositiveRate
  )}`;
}
