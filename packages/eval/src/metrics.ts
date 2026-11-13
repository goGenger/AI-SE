import { EvalRunRecord, EvalSummary, Tier, TierSummary } from "./types";

/** 固定档位顺序（S/M/L）；E1 等其它档位按记录动态追加——旧批次汇总保持不变。 */
const BASE_TIERS: Tier[] = ["S", "M", "L"];

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function summarize(records: EvalRunRecord[]): EvalSummary {
  const runs = records.length;
  const trueSuccess = records.filter((record) => record.oraclePassed).length;
  const reportedSuccess = records.filter((record) => record.reportedSuccess).length;
  const falsePositive = records.filter((record) => record.falsePositive).length;
  const parseRecoveryRuns = records.reduce((sum, record) => sum + record.parseRecoveryRuns, 0);
  const agentRuns = records.reduce((sum, record) => sum + record.runCount, 0);
  const humanInterventions = records.reduce((sum, record) => sum + record.humanInterventions, 0);

  const tokenUsage = records.reduce(
    (sum, record) => ({
      input: sum.input + (record.tokenUsage?.input ?? 0),
      output: sum.output + (record.tokenUsage?.output ?? 0)
    }),
    { input: 0, output: 0 }
  );
  const estimatedCostUsd = records.reduce((sum, record) => sum + (record.estimatedCostUsd ?? 0), 0);

  const errorTypes: Record<string, number> = {};
  for (const record of records) {
    for (const [type, count] of Object.entries(record.errorTypes)) {
      errorTypes[type] = (errorTypes[type] ?? 0) + count;
    }
  }

  const tierOrder: Tier[] = [
    ...BASE_TIERS,
    ...[...new Set(records.map((record) => record.tier))].filter(
      (tier) => !BASE_TIERS.includes(tier)
    )
  ];
  const byTier = Object.fromEntries(
    tierOrder.map((tier) => {
      const tierRecords = records.filter((record) => record.tier === tier);
      const tierSummary: TierSummary = {
        runs: tierRecords.length,
        trueSuccessRate: rate(tierRecords.filter((r) => r.oraclePassed).length, tierRecords.length),
        falsePositiveRate: rate(
          tierRecords.filter((r) => r.falsePositive).length,
          tierRecords.length
        )
      };
      return [tier, tierSummary];
    })
  ) as Record<Tier, TierSummary>;

  // F1-8（FX-26）：新增冻结口径聚合（缺字段的旧记录按缺省降级：布尔 false / 计数 0）。
  const verificationFailureCodes: Record<string, number> = {};
  // PL-M9 9a（`docs/166` §3）：检查不可判定的任务数按任务类型聚合（旧记录缺字段 → 0）。
  const verificationUnavailableByType: Record<string, number> = {};
  const sliceReachedDistribution: Record<string, number> = {};
  const planningSamples = records.filter((record) => record.planningMetrics);
  let autoFixRounds = 0;
  let llmRepairRounds = 0;
  let sliceValidationFailureRounds = 0;
  let firstPassCount = 0;
  let convergedCount = 0;
  const failureLayers = { planning: 0, verification: 0, agent: 0 };
  for (const record of records) {
    for (const [code, count] of Object.entries(record.verificationFailureCodes ?? {})) {
      verificationFailureCodes[code] = (verificationFailureCodes[code] ?? 0) + count;
    }
    for (const [type, count] of Object.entries(record.verificationUnavailableByType ?? {})) {
      verificationUnavailableByType[type] = (verificationUnavailableByType[type] ?? 0) + count;
    }
    if (record.sliceReached) {
      sliceReachedDistribution[record.sliceReached] =
        (sliceReachedDistribution[record.sliceReached] ?? 0) + 1;
    }
    if (record.planningMetrics) {
      autoFixRounds += record.planningMetrics.autoFixRounds;
      llmRepairRounds += record.planningMetrics.llmRepairRounds;
      sliceValidationFailureRounds += record.planningMetrics.sliceValidationFailureRounds;
      if (record.planningMetrics.firstPass) firstPassCount += 1;
      if (record.planningMetrics.converged) convergedCount += 1;
    }
    if (record.failureLayers) {
      failureLayers.planning += record.failureLayers.planning;
      failureLayers.verification += record.failureLayers.verification;
      failureLayers.agent += record.failureLayers.agent;
    }
  }

  return {
    runs,
    trueSuccessRate: rate(trueSuccess, runs),
    reportedSuccessRate: rate(reportedSuccess, runs),
    falsePositiveRate: rate(falsePositive, runs),
    parseRecoveryRate: rate(parseRecoveryRuns, agentRuns),
    humanInterventions,
    tokenUsage,
    estimatedCostUsd,
    errorTypes,
    byTier,
    chainCompletedRate: rate(records.filter((r) => r.chainCompleted === true).length, runs),
    deliveredSuccessRate: rate(records.filter((r) => r.deliveredSuccess === true).length, runs),
    falseNegativeCount: records.filter((r) => r.falseNegative === true).length,
    scopeViolations: records.filter((r) => r.scopeViolation === true).length,
    taskVerificationDivergence: records.reduce(
      (sum, record) => sum + (record.taskVerificationDivergence ?? 0),
      0
    ),
    verificationFailureCodes,
    verificationUnavailable: records.reduce(
      (sum, record) => sum + (record.verificationUnavailable ?? 0),
      0
    ),
    verificationUnavailableByType,
    failureLayers,
    planningRepair: {
      autoFixRounds,
      llmRepairRounds,
      sliceValidationFailureRounds,
      firstPassRate:
        planningSamples.length === 0 ? null : rate(firstPassCount, planningSamples.length),
      convergenceRate:
        planningSamples.length === 0 ? null : rate(convergedCount, planningSamples.length)
    },
    sliceReachedDistribution,
    // L1-8：staging 段（CI ∧ staging DEPLOY ∧ staging VERIFY）。缺该字段的旧记录不计入分子。
    stagingDeliveryRate: rate(
      records.filter((record) => record.stagingSegment?.delivered === true).length,
      runs
    )
  };
}

/** 两次评测的指标差值（噪声线：判断后续改进是否超过波动）。 */
export function noiseLine(previous: EvalSummary, next: EvalSummary): Record<string, number> {
  return {
    trueSuccessRate: next.trueSuccessRate - previous.trueSuccessRate,
    reportedSuccessRate: next.reportedSuccessRate - previous.reportedSuccessRate,
    falsePositiveRate: next.falsePositiveRate - previous.falsePositiveRate,
    parseRecoveryRate: next.parseRecoveryRate - previous.parseRecoveryRate,
    humanInterventions: next.humanInterventions - previous.humanInterventions,
    estimatedCostUsd: next.estimatedCostUsd - previous.estimatedCostUsd
  };
}
