/**
 * P0 评测（docs/109）本地类型 —— 本包**不导入任何 workspace 包**（评测只经 REST 驱动平台）。
 */

/**
 * `docs/233` §5.1：新增 `F1`（纯前端夹具，浏览器 oracle）。分档表按记录动态生成，
 * 不需要在 `report.ts` 里再加一行。
 */
export type Tier = "S" | "M" | "L" | "E1" | "F1";

export interface EvalFixture {
  id: string;
  tier: Tier;
  title: string;
  /** 提交给平台的需求原文（规划输入）。 */
  requirementText: string;
  /** Agent 不可见的验收脚本：harness 以 cwd=本包 启动 command args… <workspacePath>。 */
  oracle: { command: string; args: string[] };
  /** 单夹具覆盖：oracle 与单次 run 的超时（缺省用 CLI 全局值；E1 建议 20 min / 120 min）。 */
  oracleTimeoutMs?: number;
  /** N-60：单切片预算的**下界**（实际预算 = max(本值, 任务数 × perTaskTimeoutMs)）。 */
  runTimeoutMs?: number;
  /** N-60：每个任务分到的预算；缺省 6 分钟（实测 4.0–4.4 min/task）。 */
  perTaskTimeoutMs?: number;
  /**
   * N-73：本夹具的交付环境声明。`static` 适配器 = 工作区优先（无 git 仓库、无 Dockerfile）：
   * harness 会在跑批前把环境 upsert 进项目，规划据此排出 CI → staging DEPLOY → staging VERIFY。
   */
  delivery?: {
    environments: Array<{
      name: "dev" | "staging" | "production";
      endpoint: string;
      adapter: "docker" | "static";
      configuration?: Record<string, unknown>;
    }>;
  };
}

/** 与平台 WorkflowFailureStrategy 取值一致的本地字面量联合（避免导入 workspace 包）。 */
export type EvalFailureStrategy = "FAIL_FAST" | "RETRY" | "REPLAN" | "HUMAN" | "CONTINUE";

/** 与平台 `AutonomyLevelSchema` 取值一致的本地字面量（自治 L1-8 批次用）。 */
export type EvalAutonomyLevel = "L1";

/** 与平台 `DeployFailureStrategySchema` 取值一致的本地字面量。 */
export type EvalDeployFailureStrategy = "ROLLBACK";

export interface EvalPolicy {
  maxConcurrency: number;
  maxRetries: number;
  failureStrategy: EvalFailureStrategy;
  allowRetry: boolean;
  allowReplan: boolean;
  approvalRequired: boolean;
  /** 自治 L1：缺省 = 非自治，策略与 P0 冻结值逐项一致（`--autonomy-l1` 才写入）。 */
  autonomyLevel?: EvalAutonomyLevel;
  /** 自治 L1-5：仅对 DEPLOY 任务生效，且优先于 `failureStrategy`。 */
  deployFailureStrategy?: EvalDeployFailureStrategy;
}

export interface EvalRunRecord {
  fixtureId: string;
  tier: Tier;
  runIndex: number;
  workflowId: string;
  /** N2：两级规划下本次运行实际执行的工作流集合（首片 + 链式/自驱后续切片）。 */
  workflowIds?: string[];
  workspacePath: string;
  taskCount: number;
  /** 本次运行实际产生的 agent run 数（降级率的分母；多次尝试会大于 taskCount）。 */
  runCount: number;
  taskStatuses: Record<string, number>;
  reportedSuccess: boolean;
  oraclePassed: boolean;
  falsePositive: boolean;
  parseRecoveryRuns: number;
  humanInterventions: number;
  tokenUsage: { input: number; output: number } | null;
  estimatedCostUsd: number | null;
  durationMs: number | null;
  /**
   * N-59（`docs/232` §10）：本轮有几个工作流在计时时**没有 finishedAt**（被超时/取消切断），
   * 它们的时长按「now − startedAt」计入。缺省（旧批次）表示未统计。
   *
   * 非零说明 `durationMs` 里含未完成片的累计时间，读数的人要按「至少这么久」理解，
   * 而不是「正好这么久」。
   */
  incompleteWorkflows?: number;
  errorTypes: Record<string, number>;
  failureSummary: string | null;
  /** F1-8（FX-26）冻结口径：链完成 = 全部切片 DONE（单级 = 工作流 SUCCESS）。旧批次缺省。 */
  chainCompleted?: boolean;
  /** F1-8：真交付成功 = `oraclePassed ∧ chainCompleted`。 */
  deliveredSuccess?: boolean;
  /** F1-8：假阴性 = `oraclePassed ∧ ¬chainCompleted`（并附超范围写入标注）。 */
  falseNegative?: boolean;
  /** F1-8：超范围写入标注（`SCOPE_VIOLATION` 事件面；F2-1 上线前恒 false——见 docs/129 口径）。 */
  scopeViolation?: boolean;
  /** F1-8：链到达的最远切片（单级 = null）。 */
  sliceReached?: string | null;
  /** F1-8：任务级验证分歧 = 自报成功后验证 FAIL 的任务数（验证门真实效果指标）。 */
  taskVerificationDivergence?: number;
  /** F1-8：验证门失败码分布（`VACUOUS_TEST` / `EVIDENCE_MISSING` / `CHECK_TIMEOUT`）。 */
  verificationFailureCodes?: Record<string, number>;
  /**
   * PL-M9 9a（`docs/166` §3）：**检查不可判定**的任务数——本类型有候选检查、但工作区缺对应 script，
   * 因此一条检查都没跑（`verification.missingChecks` 非空）。与「本类型没有客观检查」
   * （ANALYSIS/DESIGN/REVIEW，不计入）分开统计；按任务类型分列见 `verificationUnavailableByType`。
   */
  verificationUnavailable?: number;
  /** PL-M9 9a：检查不可判定的任务数按任务类型分列。 */
  verificationUnavailableByType?: Record<string, number>;
  /** F1-8：失败分布按层（规划 / 验证门 / agent 级）。 */
  failureLayers?: { planning: number; verification: number; agent: number };
  /** F1-8：规划侧修复轮数与收敛指标（无规划事件面时为 null）。 */
  planningMetrics?: PlanningMetricsSnapshot | null;
  /** L1-8（`docs/154` §3 M4）：staging 段交付判据。旧批次缺省。 */
  stagingSegment?: StagingSegmentView;
}

/**
 * L1-8（`docs/154` §3 M4）：**staging 段**交付判据 —— CI 成功 **且** staging DEPLOY 成功
 * **且** 其后的 staging VERIFY 成功。**不用 `deliveredSuccess`**（含 production 审批门，
 * 结构上不可达；2026-10-15 已裁定弃用，见 `docs/131` 后续块）。
 *
 * 三段各自留状态：`null` = 本次运行**没有该段任务**。归因时据此区分「链没走到该段」
 * 与「走到了但失败」——两者都是未交付，但原因完全不同。
 */
export interface StagingSegmentView {
  ci: string | null;
  deploy: string | null;
  verify: string | null;
  /** 三段均为 `SUCCESS`。 */
  delivered: boolean;
}

/** F1-8（FX-26）：规划侧指标快照（自规划 run 事件面采集）。 */
export interface PlanningMetricsSnapshot {
  /** `PLAN_AUTOFIXED` 次数（确定性自动修复轮数）。 */
  autoFixRounds: number;
  /** `PLANNING_REPAIR_REQUESTED` 次数（LLM 修复轮数）。 */
  llmRepairRounds: number;
  /** `SLICE_PLAN_VALIDATION_FAILED` 次数（切片级校验失败轮）。 */
  sliceValidationFailureRounds: number;
  /** 首轮通过：无任何 LLM 修复请求且无切片级校验失败。 */
  firstPass: boolean;
  /** 收敛：无 `SLICE_PLANNING_FAILED` / `REQUIREMENT_ANALYSIS_FAILED` 终败事件。 */
  converged: boolean;
  /** 规划侧错误码分布（如 `PLANNING_ERROR` / `DELIVERY_ENVIRONMENT_MISSING`）。 */
  failureCodes: Record<string, number>;
}

export interface TierSummary {
  runs: number;
  trueSuccessRate: number;
  falsePositiveRate: number;
}

export interface EvalSummary {
  runs: number;
  trueSuccessRate: number;
  reportedSuccessRate: number;
  falsePositiveRate: number;
  parseRecoveryRate: number;
  humanInterventions: number;
  tokenUsage: { input: number; output: number };
  estimatedCostUsd: number;
  errorTypes: Record<string, number>;
  byTier: Record<string, TierSummary>;
  /** F1-8（FX-26）新增冻结口径（对缺字段的旧记录按缺省降级）。 */
  chainCompletedRate: number;
  deliveredSuccessRate: number;
  falseNegativeCount: number;
  scopeViolations: number;
  taskVerificationDivergence: number;
  verificationFailureCodes: Record<string, number>;
  /** PL-M9 9a：检查不可判定的任务数（及其按任务类型分列）。 */
  verificationUnavailable: number;
  verificationUnavailableByType: Record<string, number>;
  failureLayers: { planning: number; verification: number; agent: number };
  planningRepair: {
    autoFixRounds: number;
    llmRepairRounds: number;
    sliceValidationFailureRounds: number;
    /** 有规划指标样本的运行中首轮通过占比（无样本 = null）。 */
    firstPassRate: number | null;
    /** 有规划指标样本的运行中收敛占比（无样本 = null）。 */
    convergenceRate: number | null;
  };
  sliceReachedDistribution: Record<string, number>;
  /** L1-8：staging 段交付率（缺该字段的旧记录按未交付计）。 */
  stagingDeliveryRate: number;
}

export interface EvalFailure {
  fixtureId: string;
  stage: "planning" | "run";
  message: string;
}

export interface EvalResults {
  generatedAt: string;
  baseUrl: string;
  policy: EvalPolicy;
  records: EvalRunRecord[];
  failures: EvalFailure[];
  summary: EvalSummary;
}
