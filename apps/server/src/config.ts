import { z } from "zod";
import {
  TaskTypeSchema,
  resolveCapabilityProfile,
  type CapabilityProfile,
  type TaskType
} from "@ai-se/shared";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().default("postgres://aise@localhost:5432/aise"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  LOG_LEVEL: z.string().default("info"),
  LLM_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
  OPENAI_API_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional()
  ),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.4-mini"),
  OPENAI_BASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional()
  ),
  OPENAI_STRUCTURED_OUTPUT_METHOD: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["jsonSchema", "functionCalling", "jsonMode"]).optional()
  ),
  /**
   * PL-C2（`docs/162` §4 裁定 2）：每百万 token 的美元单价。**两个都配**才生效；
   * 未配置 → 不产出 `estimatedCost`（`agent_runs.estimated_cost` 维持 NULL）。
   * 不写代码内静态价表：部署的模型是网关别名（`OPENAI_MODEL` 可随时更换），静态表换模型即失准。
   */
  MODEL_INPUT_PRICE_PER_MTOK: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().nonnegative().optional()
  ),
  MODEL_OUTPUT_PRICE_PER_MTOK: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().nonnegative().optional()
  ),
  AGENT_WORKSPACE_ROOT: z.string().min(1).default(process.cwd()),
  /**
   * F1-7（FX-24a）：沙箱镜像（默认 = 本地构建的预置 pnpm 镜像；构建：`pnpm --filter @ai-se/sandbox run build:image`）。
   */
  SANDBOX_IMAGE: z.string().min(1).default("ai-se-sandbox:22-pnpm9"),
  /**
   * `docs/235` §6.5 补步：**能力 profile 的选择**。缺省 `frontend-vue`（产品默认：不做后端
   * 开发任务；2026-11-04 起）。遗留 E1 须显式 `CAPABILITY_PROFILE=backend-node`。
   * 未知 id 启动即失败——静默退回默认会让整批读数记到错误的口径下。
   */
  CAPABILITY_PROFILE: z.string().min(1).default("frontend-vue"),
  /**
   * F2-1（FX-29/31）：写范围审计模式。
   * observe（默认）：只记录 + SCOPE_VIOLATION 事件，不覆盖任务结果；
   * enforce：越界 → 验证失败（启用前需 observe 数据齐备——FX-31 门槛，见 docs/129）。
   */
  WRITE_SCOPE_AUDIT: z.enum(["off", "observe", "enforce"]).default("observe"),
  /** F1-7（FX-22）：监听地址（默认回环；绑定非回环地址必须配置 API_TOKEN，否则拒绝启动）。 */
  HOST: z.string().min(1).default("127.0.0.1"),
  /**
   * 任务级 Agent 运行预算(ms);任务输入 execution.timeoutMs 优先于它。
   * 1800s（原 900s / 再早 600s）：frontend-vue 切片里 FRONTEND/TEST/DEBUG 多次撞 900s 墙钟
   * （taskflow-vue v8：T-01 / T-02 / T-03 及多轮 REPLAN/DEBUG），而成功长尾已超过 15 分钟。
   * 900s 会把「本来做得完的任务」截断成 AGENT_TIMEOUT；超时任务的工具执行往往只占一小段（其余是模型回合）。
   * 历史依据见 docs/197（600→900）与 docs/101 勘误；本次依 v8 实测抬到 30 分钟。
   */
  TASK_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  /**
   * G3（GX-09）：按任务类型的超时预算覆盖（JSON 对象，如 {"BACKEND":900000,"TEST":900000}）。
   * 缺省/空串 = 未配置（全局 TASK_TIMEOUT_MS 生效，零行为变化）；非法值启动即失败。
   */
  TASK_TIMEOUT_MS_BY_TYPE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().optional()
  ),
  /** N2 规划模式：two-level（默认，两级规划）/ single（旧一次性路径，S 档回归用）。 */
  PLANNING_MODE: z.enum(["single", "two-level"]).default("two-level"),
  /** N2 阶段级墙钟上限与重试（N1 决策：150s / 1 次）。 */
  PLANNING_STAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(150_000),
  PLANNING_STAGE_RETRIES: z.coerce.number().int().min(0).default(1),
  /** N2 第一级总预算与第二级单切片总预算（N1 决策：300s / 600s；N-51 起单切片为 900s）。 */
  PLANNING_LEVEL1_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  PLANNING_SLICE_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  /**
   * N-52（`docs/232` §9.22）：`task_planning` 单独一档阶段预算——这一阶段产出整片任务 DAG，
   * 输出最大；150s 在实测里连续六次不够，而其余阶段维持原值即可。
   */
  PLANNING_TASK_PLANNING_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  /**
   * F1-4（FX-15c）：最终切片任务数上限（enforce 开关，缺省 = 关/observe）。
   * 校准口径：不低于 18（高于 E1 已观测 slice-2 三轮计划 17/15/17）；校准值写入 docs/129。
   */
  PLANNING_FINAL_SLICE_MAX_TASKS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().positive().optional()
  ),
  /** C-1（T2）结构化提交模式：tool（默认，submit_result 控制类工具）/ text（旧文本解析路径）。 */
  SUBMIT_RESULT_MODE: z.enum(["tool", "text"]).default("tool"),
  /** C-3（T1）确定性验证门：observe（默认，只记录不覆盖）/ off（关闭，旧行为）/ enforce（失败覆盖自报）。 */
  VERIFICATION_GATE: z.enum(["off", "observe", "enforce"]).default("observe"),
  CI_PROVIDER: z.enum(["local", "github"]).default("local"),
  GITHUB_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional()
  ),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  DELIVERY_DOCKER_COMMAND: z.string().min(1).default("docker"),
  /** D-3（T8-c）：部署面 API 最小 Token 鉴权；未设置 = 关闭（默认）。 */
  API_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional()
  ),
  /**
   * Phase 8-A：告警入站独立 shared secret。
   * 配置后 POST /api/alerts 必须 Bearer 匹配；未配置则回退 API_TOKEN / 本地放行。
   */
  ALERT_INGEST_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional()
  ),
  /**
   * Phase 8-D：可选自动修复开关（默认关闭）。
   * true/1/on/yes → 白名单 faultType 在 remediate 时默认 WorkflowService.start，
   * 以便自动跑完 staging VERIFY；生产 DEPLOY 仍经 approvalTaskKeys / Policy。
   * false/空/其它关闭值 → 与 8-C 相同（创建工作流但不自动 start，除非请求显式 startWorkflow）。
   */
  INCIDENT_AUTO_REMEDIATE: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return false;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "on", "yes"].includes(normalized)) return true;
    if (["0", "false", "off", "no"].includes(normalized)) return false;
    return value;
  }, z.boolean().default(false))
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  redisUrl: string;
  corsOrigin: string;
  logLevel: string;
  llmProvider: "mock" | "openai";
  /** Model API configuration shared by every real-model path (planning / agents / coding agent). */
  llmModel: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmStructuredOutputMethod?: "jsonSchema" | "functionCalling" | "jsonMode";
  /**
   * PL-C2：每百万 token 的美元单价（两个 env 都配置时才存在）。形状与
   * `@ai-se/agent-core` 的 `ModelPricing` 结构一致。
   */
  modelPricing?: { inputPerMTok: number; outputPerMTok: number };
  agentWorkspaceRoot: string;
  /** F1-7（FX-24a）：沙箱镜像（默认 = 预置 pnpm 的本地镜像）。 */
  sandboxImage: string;
  /** `docs/235` §6.5：本进程的能力 profile（启动时解析一次，显式注入各接缝）。 */
  capabilityProfile: CapabilityProfile;
  /** F2-1（FX-29/31）：写范围审计模式（observe 默认；enforce 需 observe 数据齐备后开启）。 */
  writeScopeAudit: "off" | "observe" | "enforce";
  /** F1-7（FX-22）：监听地址（默认 127.0.0.1）；非回环且未配置 API_TOKEN → 启动即拒绝。 */
  host: string;
  /** 任务级 Agent 运行预算默认值(ms),任务输入 execution.timeoutMs 可覆盖。 */
  taskTimeoutMs: number;
  /** G3（GX-09）：按任务类型的超时预算覆盖（缺省 = 未配置）；解析顺序：任务输入 > 本表 > 全局。 */
  taskTimeoutByType?: Partial<Record<TaskType, number>>;
  /** N2：规划模式与阶段/级别预算（config-first，env 覆盖）。 */
  planningMode: "single" | "two-level";
  planningStageTimeoutMs: number;
  planningStageRetries: number;
  planningLevel1TimeoutMs: number;
  planningSliceTimeoutMs: number;
  planningTaskPlanningTimeoutMs: number;
  /** F1-4（FX-15c）：最终切片任务数上限（enforce；缺省 = observe 只记录不判失败）。 */
  planningFinalSliceMaxTasks?: number;
  /** C-1（T2）：submit_result 结构化提交模式（tool 默认 / text 旧文本解析路径）。 */
  submitResultMode: "tool" | "text";
  /** C-3（T1）：确定性验证门（observe 默认 / off 关闭 / enforce 覆盖）。 */
  verificationGate: "off" | "observe" | "enforce";
  ciProvider: "local" | "github";
  githubToken?: string;
  githubApiUrl: string;
  deliveryDockerCommand: string;
  /** D-3（T8-c）：API Token（可选；未设置 = 鉴权关闭）。 */
  apiToken?: string;
  /** Phase 8-A：告警入站 token（可选）。 */
  alertIngestToken?: string;
  /**
   * Phase 8-D：白名单 incident 是否在 remediate 时自动 start 工作流（默认 false）。
   * 永不绕过生产审批。
   */
  incidentAutoRemediate: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"]);

/**
 * F1-7（FX-22）：启动防护——监听非回环地址且未配置 `API_TOKEN` 时拒绝启动并给出明确提示。
 * 回环地址（默认 `127.0.0.1`）不需要令牌（本地开发零行为变化）。
 */
export function assertListenSecurity(config: { host: string; apiToken?: string }): void {
  const host = config.host.trim().toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
  if (!loopback && !config.apiToken) {
    throw new Error(
      `Refusing to start: HOST=${config.host} is not a loopback address and API_TOKEN is not configured. ` +
        "Bind to a loopback address (e.g. HOST=127.0.0.1) or configure API_TOKEN before exposing the API on a network-reachable address."
    );
  }
}

/**
 * G3（GX-09）：按任务类型超时表解析（JSON 对象；缺省/空串 = 未配置）。
 * 非法 JSON / 未知任务类型 / 非正整数值 → 抛出（启动即失败，配置错误不放行）。
 */
function parseTaskTimeoutByType(
  raw: string | undefined
): Partial<Record<TaskType, number>> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TASK_TIMEOUT_MS_BY_TYPE must be valid JSON (e.g. {"BACKEND":900000})');
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("TASK_TIMEOUT_MS_BY_TYPE must be a JSON object mapping taskType -> ms");
  }
  const result: Partial<Record<TaskType, number>> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(TaskTypeSchema.options as readonly string[]).includes(key)) {
      throw new Error(`TASK_TIMEOUT_MS_BY_TYPE has unknown task type: ${key}`);
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`TASK_TIMEOUT_MS_BY_TYPE value for ${key} must be a positive integer (ms)`);
    }
    result[key as TaskType] = value;
  }
  return result;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    corsOrigin: parsed.CORS_ORIGIN,
    logLevel: parsed.LOG_LEVEL,
    llmProvider: parsed.LLM_PROVIDER,
    llmModel: parsed.OPENAI_MODEL,
    llmApiKey: parsed.OPENAI_API_KEY,
    llmBaseUrl: parsed.OPENAI_BASE_URL,
    llmStructuredOutputMethod: parsed.OPENAI_STRUCTURED_OUTPUT_METHOD,
    ...(parsed.MODEL_INPUT_PRICE_PER_MTOK !== undefined &&
    parsed.MODEL_OUTPUT_PRICE_PER_MTOK !== undefined
      ? {
          modelPricing: {
            inputPerMTok: parsed.MODEL_INPUT_PRICE_PER_MTOK,
            outputPerMTok: parsed.MODEL_OUTPUT_PRICE_PER_MTOK
          }
        }
      : {}),
    agentWorkspaceRoot: parsed.AGENT_WORKSPACE_ROOT,
    sandboxImage: parsed.SANDBOX_IMAGE,
    // `docs/235`：未知 id 在这里抛错 → 启动失败（fail-closed，不静默退回默认 profile）。
    capabilityProfile: resolveCapabilityProfile(parsed.CAPABILITY_PROFILE),
    writeScopeAudit: parsed.WRITE_SCOPE_AUDIT,
    host: parsed.HOST,
    taskTimeoutMs: parsed.TASK_TIMEOUT_MS,
    taskTimeoutByType: parseTaskTimeoutByType(parsed.TASK_TIMEOUT_MS_BY_TYPE),
    planningMode: parsed.PLANNING_MODE,
    planningStageTimeoutMs: parsed.PLANNING_STAGE_TIMEOUT_MS,
    planningStageRetries: parsed.PLANNING_STAGE_RETRIES,
    planningLevel1TimeoutMs: parsed.PLANNING_LEVEL1_TIMEOUT_MS,
    planningSliceTimeoutMs: parsed.PLANNING_SLICE_TIMEOUT_MS,
    planningTaskPlanningTimeoutMs: parsed.PLANNING_TASK_PLANNING_TIMEOUT_MS,
    ...(parsed.PLANNING_FINAL_SLICE_MAX_TASKS !== undefined
      ? { planningFinalSliceMaxTasks: parsed.PLANNING_FINAL_SLICE_MAX_TASKS }
      : {}),
    submitResultMode: parsed.SUBMIT_RESULT_MODE,
    verificationGate: parsed.VERIFICATION_GATE,
    ciProvider: parsed.CI_PROVIDER,
    githubToken: parsed.GITHUB_TOKEN,
    githubApiUrl: parsed.GITHUB_API_URL,
    deliveryDockerCommand: parsed.DELIVERY_DOCKER_COMMAND,
    apiToken: parsed.API_TOKEN,
    alertIngestToken: parsed.ALERT_INGEST_TOKEN,
    incidentAutoRemediate: parsed.INCIDENT_AUTO_REMEDIATE
  };
}
