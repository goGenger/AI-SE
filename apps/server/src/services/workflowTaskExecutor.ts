import {
  AgentLifecycleHooks,
  AgentRegistry,
  ProfessionalAgent,
  ProfessionalModel,
  ProfessionalOutcome,
  ScriptedAgentStep,
  ScriptedDeepAgentModel,
  SUBMIT_RESULT_TOOL_NAME,
  createOpenAIChatModel,
  createSubmitResultTool,
  type ModelPricing,
  type OpenAILLMProviderOptions
} from "@ai-se/agent-core";
import {
  PgAgentArtifactRepository,
  PgAgentRunStore,
  PgToolCallStore,
  PgWorkflowEventStore
} from "@ai-se/database";
import { createLogger, sanitizeLogData } from "@ai-se/observability";
import { Sandbox } from "@ai-se/sandbox";
import {
  ApiErrorBody,
  DEFAULT_CAPABILITY_PROFILE,
  JsonObject,
  Task,
  TaskType,
  WorkflowRun,
  isUsableTargetTaskType,
  type CapabilityProfile
} from "@ai-se/shared";
import { classifyAutonomyFailure, hasActionableFailureEvidence, resolveRepairFixTaskType } from "./gateFailureRepair";
import {
  ToolCallRecorder,
  ToolDefinition,
  ToolResult,
  ToolRuntime,
  createPhase1Tools
} from "@ai-se/tool-runtime";
import { TaskExecutionResult, WorkflowTaskExecutor } from "@ai-se/workflow-engine";
import { Logger } from "pino";
import { CancellationStore } from "./cancellationStore";
import type { MCPTaskToolSource } from "./mcpTaskToolSource";
import {
  compareVisualEvidence,
  type VisualEvidenceService,
  type VisualMetrics
} from "./visualEvidenceService";
import { TaskContextBuilder } from "./taskContextBuilder";
import { WorkflowRequestIdResolver } from "./workflowCorrelation";

interface ActiveTask {
  agentRunId: string;
  controller: AbortController;
}

interface WorkflowTaskExecutorDependencies {
  agentRuns: PgAgentRunStore;
  toolCalls: PgToolCallStore;
  workflowEvents: Pick<PgWorkflowEventStore, "create">;
  artifacts: PgAgentArtifactRepository;
  contextBuilder: TaskContextBuilder;
  registry: AgentRegistry;
  cancellationStore: CancellationStore;
  sandbox: Sandbox;
  /**
   * `docs/236` 第 4 步：本执行器产生的 agent 运行**是否允许装依赖出网**。
   *
   * 由组合根按 capability profile 的 `dependencyNetwork` 计算后注入；缺省（不传）=
   * 不允许，与第 4 步之前完全一致。
   */
  dependencyInstallAllowed?: boolean;
  /** 7-A：工作流 requestId 解析（WORKFLOW_STARTED 事件为准）。 */
  requestId: WorkflowRequestIdResolver;
  llmProvider: "mock" | "openai";
  /** Model API configuration (model / apiKey / baseUrl) for the "openai" provider. */
  llmOptions?: OpenAILLMProviderOptions;
  /** 任务级 Agent 运行预算默认值(ms);任务输入 execution.timeoutMs 优先。 */
  taskTimeoutMs?: number;
  /** G3（GX-09）：按任务类型的超时预算覆盖（缺省 = 未配置）；任务输入 execution.timeoutMs 仍最优先。 */
  taskTimeoutByType?: Partial<Record<TaskType, number>>;
  /** C-1（T2）：submit_result 结构化提交模式；缺省 tool。 */
  submitResultMode?: "tool" | "text";
  modelFactory?: (task: Task) => ProfessionalModel;
  /** PL-C2：每百万 token 的美元单价；未配置 → `estimated_cost` 维持 NULL。 */
  modelPricing?: ModelPricing;
  /** 功能清点 T2：MCP 任务工具来源；缺省 = 不带任何 MCP 工具（既有行为不变）。 */
  mcpTools?: MCPTaskToolSource;
  /** 功能清点 T3：UI 交付物的截图证据；缺省 = 不取证（既有行为不变）。 */
  visualEvidence?: VisualEvidenceService;
  logger?: Logger;
}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * G3（GX-09）：任务超时预算解析——任务输入 execution.timeoutMs > 按任务类型表 > 全局默认（120s 兜底）。
 * 类型表缺省 = 零行为变化（全局 TASK_TIMEOUT_MS 生效）。
 */
export function resolveTaskTimeoutMs(
  task: Task,
  deps: { taskTimeoutByType?: Partial<Record<TaskType, number>>; taskTimeoutMs?: number }
): number {
  const execution = object(task.input.execution);
  return number(
    execution.timeoutMs,
    deps.taskTimeoutByType?.[task.type] ?? deps.taskTimeoutMs ?? 120_000
  );
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * N-22（`docs/199`）：`REPLAN` 时 agent 要求创建的任务类型——**根字段优先**，
 * `metadata.fixTaskType` 仍被容忍（历史任务与未更新提示词的 agent 都还在用它）。
 * 该值经 `output.fixTaskType` 交给 `WorkflowEngine.debugTargetType` 的第 1 步。
 */
export function resolveOutcomeFixTaskType(
  outcome: ProfessionalOutcome,
  options: {
    taskType?: Task["type"] | undefined;
    profile?: CapabilityProfile | undefined;
  } = {}
): string | undefined {
  const explicit = string(outcome.fixTaskType) ?? string(outcome.metadata.fixTaskType);
  if (explicit) return explicit;
  // QA / REVIEW / TEST 给出 FAILED/REPLAN 且摘要里带门禁报错时，补上 fixFallback，
  // 避免「Approval withheld」只变成 FAILED 却没有修复目标（N-11 同类死胡同）。
  if (outcome.status !== "FAILED" && outcome.status !== "REPLAN") return undefined;
  if (
    !hasActionableFailureEvidence({
      errorType: string(outcome.metadata.errorType),
      summary: outcome.summary,
      issues: outcome.issues,
      recommendations: outcome.recommendations
    })
  ) {
    return undefined;
  }
  return resolveRepairFixTaskType({
    profile: options.profile ?? DEFAULT_CAPABILITY_PROFILE,
    taskType: options.taskType,
    failureClass: classifyAutonomyFailure({
      errorType: string(outcome.metadata.errorType),
      summary: outcome.summary,
      issues: outcome.issues,
      recommendations: outcome.recommendations
    }),
    evidenceText: outcome.summary
  });
}

/**
 * N-22（`docs/199` 判据 25e）：失败任务的错误码。
 *
 * `REPLAN` 结果的失败此前**无错误码、无 `verification` 记录** ⇒ 批次归因里完全看不见
 * （L1-M4n run 2：4 个失败只报出 1 个）。agent 自己给了码就用它的（更具体），否则标
 * `REPLAN_REQUESTED`——「这是 agent 主动请求重规划」，不是一次普通的验证失败。
 */
export function resolveOutcomeErrorType(outcome: ProfessionalOutcome): string | undefined {
  const explicit = string(outcome.metadata.errorType);
  if (explicit) return explicit;
  if (outcome.status === "REPLAN") return "REPLAN_REQUESTED";
  // QA/REVIEW 「Approval withheld」+ 门禁报错：给可归因错误码，便于 FAILURE 路由与 UI 展示。
  if (
    outcome.status === "FAILED" &&
    hasActionableFailureEvidence({
      summary: outcome.summary,
      issues: outcome.issues,
      recommendations: outcome.recommendations
    })
  ) {
    return "GATE_FAILURE";
  }
  return undefined;
}

/** AFC-M3：把执行器终态映射为可进自治的 errorType（超时 / 瞬时耗尽）。 */
export function resolveRunFailureErrorType(
  runStatus: string,
  outcome: ProfessionalOutcome,
  errorCode?: string | undefined
): string | undefined {
  if (runStatus === "timed_out" || errorCode === "TIMEOUT_ERROR") {
    return "AGENT_TIMEOUT";
  }
  if (
    errorCode === "INFRA_RETRY_EXHAUSTED" ||
    errorCode === "SANDBOX_ERROR" ||
    errorCode === "ECONNRESET"
  ) {
    return "INFRA_RETRY_EXHAUSTED";
  }
  return resolveOutcomeErrorType(outcome);
}

/**
 * N-29（`docs/211`）：**DEBUG 任务的 `REPLAN` 是「交接」，不是失败。**
 *
 * `replan()` 造的重试任务（`-REPLAN-N`）**依赖**诊断任务（`-DEBUG-N`）成功
 * （`WorkflowEngine.ts:1034`）。而诊断 agent 的职责就是诊断——当它查出「问题不在我这个
 * 类型里」时，**唯一诚实的回答就是 `REPLAN`**。此前那被判成失败 ⇒ **兄弟重试恒 PENDING、
 * 从不运行**，平台还在诊断任务上继续 replan，嵌套出 `Diagnose Diagnose …` 直到预算耗尽
 * （L1-M4q 三次运行全部如此；2026-10-21 的 `-REPLAN-` 任务 **13/28 从未运行**）。
 *
 * 判据：任务是 DEBUG 且结果为 `REPLAN`，**并且**给了可执行的交接信息——
 * 合法的 `fixTaskType` **或**非空的 `fixSteps`。
 * **两者都空 = 纯喊话**（既没说该谁修、也没给步骤）⇒ 仍按失败处理，**不收养懒**。
 *
 * 非 DEBUG 源的 `REPLAN` 语义**不变**（那里确实是「我修不了，换人」⇒ 造 DEBUG+重试是对的）。
 */
export function isDebugHandoff(task: Task, outcome: ProfessionalOutcome): boolean {
  if (task.type !== "DEBUG" || outcome.status !== "REPLAN") return false;
  const fixType = resolveOutcomeFixTaskType(outcome);
  if (fixType !== undefined && isUsableTargetTaskType(fixType)) return true;
  const steps = outcome.metadata.fixSteps;
  return Array.isArray(steps) && steps.length > 0;
}

/**
 * N-29（`docs/211`）：一次 run 的最终**任务状态**。
 *
 * 既有规则：run 成功但 outcome 不是 `SUCCESS`（`REPLAN` / `FAILED`）⇒ 任务失败。
 * N-29 的例外：`handoff`（DEBUG 任务的诚实交接，见 `isDebugHandoff`）**不翻成失败**——
 * 否则依赖它的 `-REPLAN-N` 永远 PENDING。
 *
 * 抽成纯函数是为了让这条**接线**本身可测：去掉 `!handoff` 会让所有 `isDebugHandoff`
 * 的单测照样通过，却把修复整个退回去。
 */
export function resolveOutcomeTaskStatus(
  runStatus: string,
  outcome: ProfessionalOutcome,
  handoff: boolean
): TaskExecutionResult["status"] {
  if (runStatus === "succeeded") {
    return outcome.status !== "SUCCESS" && !handoff ? "failed" : "succeeded";
  }
  return runStatus === "failed" || runStatus === "cancelled" || runStatus === "timed_out"
    ? runStatus
    : "failed";
}

function apiError(error: TaskExecutionResult["error"]): ApiErrorBody | undefined {
  if (!error) return undefined;
  return { code: error.code, message: error.message, details: sanitizeLogData(error.details) };
}

function scriptedSteps(value: unknown): ScriptedAgentStep[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const data = object(entry);
        const toolName = string(data.toolName);
        if (!toolName) return [];
        const input = object(data.input);
        if (toolName === "edit_file") {
          return [
            {
              toolName,
              input: {
                file_path: input.path,
                old_string: input.search,
                new_string: input.replace,
                replace_all: input.replaceAll ?? false
              }
            }
          ];
        }
        if (toolName === "write_file" || toolName === "read_file") {
          return [{ toolName, input: { ...input, file_path: input.path } }];
        }
        if (toolName === "list_directory") {
          return [{ toolName: "ls", input: { path: input.path } }];
        }
        if (toolName === "search_code") {
          return [{ toolName: "grep", input: { pattern: input.query, path: input.path ?? "." } }];
        }
        return [{ toolName, input }];
      })
    : [];
}

function scriptedOutcome(task: Task, execution: JsonObject): ProfessionalOutcome {
  const attempt = number(task.input.executionAttempt, task.retryCount);
  if (attempt < number(execution.failuresBeforeSuccess, 0)) {
    return {
      status: "FAILED",
      summary: `Failed ${task.taskKey}: scripted task failure`,
      artifacts: [],
      issues: [
        {
          severity: "HIGH",
          description: "Scripted task failure",
          recommendation: "Create a fix task and retry."
        }
      ],
      recommendations: [],
      metadata: {
        fixTaskType: string(execution.fixTaskType) ?? task.type,
        fixSteps: execution.fixSteps
      }
    };
  }
  const supplied = object(execution.outcome);
  if (["SUCCESS", "FAILED", "RETRY", "REPLAN"].includes(String(supplied.status))) {
    return supplied as unknown as ProfessionalOutcome;
  }
  return {
    status: "SUCCESS",
    summary: `Completed ${task.taskKey}: ${task.title}`,
    artifacts: [],
    issues: [],
    recommendations: [],
    metadata:
      task.type === "TEST"
        ? { tests: 1, passed: 1, failed: 0, errors: [], summary: "Tests passed" }
        : task.type === "REVIEW"
          ? { approved: true, findings: [] }
          : {}
  };
}

function inferredArtifact(toolResult: ToolResult) {
  const type =
    toolResult.toolName === "git_diff"
      ? ("CODE_DIFF" as const)
      : toolResult.toolName === "run_unit_test"
        ? ("TEST_RESULT" as const)
        : toolResult.toolName === "run_build"
          ? ("BUILD_RESULT" as const)
          : ["write_file", "edit_file"].includes(toolResult.toolName)
            ? ("GENERATED_FILE" as const)
            : undefined;
  return type
    ? {
        type,
        name: toolResult.toolName,
        content: object(
          sanitizeLogData(toolResult.success ? toolResult.data : toolResult.error?.details)
        ),
        metadata: { toolCallId: toolResult.toolCallId, duration: toolResult.duration }
      }
    : undefined;
}

/** 功能清点 T3（基线回归）：截图基线的 `metadata.kind`。 */
const BASELINE_KIND = "ui_screenshot_baseline";

/** 基线工件 → 参与比较的指标；形状不对就当没有基线（重新开始记基线）。 */
function metricsFromMetadata(metadata: JsonObject): VisualMetrics | null {
  const { consoleErrors, networkErrors, bytes, settled } = metadata;
  if (
    typeof consoleErrors !== "number" ||
    typeof networkErrors !== "number" ||
    typeof bytes !== "number" ||
    (settled !== "networkidle" && settled !== "timeout")
  ) {
    return null;
  }
  return { consoleErrors, networkErrors, bytes, settled };
}

export class PersistentWorkflowTaskExecutor implements WorkflowTaskExecutor {  private readonly active = new Map<string, ActiveTask>();
  private readonly logger: Logger;

  constructor(private readonly dependencies: WorkflowTaskExecutorDependencies) {
    this.logger = dependencies.logger ?? createLogger();
  }

  async execute(workflow: WorkflowRun, task: Task): Promise<TaskExecutionResult> {
    const definition = this.dependencies.registry.resolveTask(task);
    const taskContext = await this.dependencies.contextBuilder.build(definition, workflow, task);
    // N-40（`docs/231` §8）：校验器按 `[AC-xx]` 标记选测试，而编号此前从未告诉 agent——
    // agent 写出的测试没有标记，选择结果为零，任务被判「没有证据」。这里把编号写进提示词。
    const acScope = await this.dependencies.contextBuilder
      .acceptanceScope(workflow, task)
      .catch(() => []);
    const acInstruction =
      acScope.length > 0
        ? `\n\nAcceptance criteria this task must cover: ${acScope.join(", ")}.\n` +
          `Name every test you add with the matching marker, exactly like test("[${acScope[0]}] ..."). ` +
          "Tests without a marker are not counted as evidence."
        : "";
    // 7-A：沿用工作流的 requestId（源自触发启动的 HTTP 请求），不再每次执行新生成。
    const requestId = await this.dependencies.requestId(workflow.id);
    const run = await this.dependencies.agentRuns.create({
      projectId: workflow.projectId,
      taskId: task.id,
      input: {
        runtime: "professional-deep-agent",
        workflowRunId: workflow.id,
        taskKey: task.taskKey,
        taskType: task.type,
        agentName: definition.name,
        agentType: definition.type
      },
      maxIterations: 50
    });
    await this.recordEvent(workflow.id, task.id, run.id, "agent_run_created", {
      taskId: task.id,
      taskKey: task.taskKey,
      agentName: definition.name,
      agentType: definition.type
    });
    await this.recordEvent(workflow.id, task.id, run.id, "agent_resolved", {
      taskType: task.type,
      agentName: definition.name,
      capabilities: definition.capabilities
    });

    const controller = new AbortController();
    this.active.set(task.id, { agentRunId: run.id, controller });
    const logger = this.logger.child({
      requestId,
      workflowRunId: workflow.id,
      taskId: task.id,
      agentRunId: run.id,
      agentName: definition.name
    });
    const monitor = setInterval(() => {
      this.dependencies.cancellationStore
        .isCancellationRequested(run.id)
        .then((cancelled) => {
          if (cancelled) controller.abort();
        })
        .catch((error: unknown) =>
          logger.warn(sanitizeLogData({ error }), "workflow task cancellation check failed")
        );
    }, 250);

    try {
      const execution = object(task.input.execution);
      const timeoutMs = resolveTaskTimeoutMs(task, this.dependencies);
      const model = this.dependencies.modelFactory
        ? this.dependencies.modelFactory(task)
        : this.dependencies.llmProvider === "openai"
          ? createOpenAIChatModel({ ...this.dependencies.llmOptions, sessionId: task.id })
          : new ScriptedDeepAgentModel({
              steps: scriptedSteps(execution.deepAgentSteps),
              outcome: scriptedOutcome(task, execution),
              delayMs: number(execution.delayMs, 0)
            });
      // C-1（T2）：工具模式下注册 submit_result（经 Tool Runtime 校验/审计）并把
      // outcomeTool 交给职业 Agent——提交被接受即终止；text 模式 = 旧行为不变。
      const submitResultEnabled = (this.dependencies.submitResultMode ?? "tool") === "tool";
      const tools = createPhase1Tools().filter((tool) => definition.tools.includes(tool.name));
      // 功能清点 T2（`docs/231` §3）：绑定可见的 MCP 工具与本机工具并集进同一个 ToolRuntime。
      // 授权仍是绑定（fail-closed）；这里只负责把快照取来，取不到就当没有。
      const mcpTools = await this.loadMCPTools(
        workflow.id,
        task.id,
        run.id,
        workflow.projectId,
        definition.name
      );
      const agent = new ProfessionalAgent({
        definition,
        model,
        toolRuntime: new ToolRuntime({
          tools: [
            ...tools,
            ...mcpTools,
            ...(submitResultEnabled ? [createSubmitResultTool()] : [])
          ]
        }),
        lifecycle: this.lifecycle(workflow.id, task.id),
        toolCallRecorder: this.toolCallRecorder(),
        defaultTimeoutMs: timeoutMs,
        outcomeTool: submitResultEnabled ? SUBMIT_RESULT_TOOL_NAME : undefined,
        ...(this.dependencies.modelPricing !== undefined
          ? { modelPricing: this.dependencies.modelPricing }
          : {})
      });
      const workspacePath =
        string(task.input.workspacePath) ?? string(workflow.input.workspacePath) ?? process.cwd();
      const result = await agent.run(
        `${task.title}\n\n${task.description}\n\nTaskContext:\n${JSON.stringify(sanitizeLogData(taskContext))}${acInstruction}`,
        {
          requestId,
          projectId: workflow.projectId,
          workflowRunId: workflow.id,
          taskId: task.id,
          agentRunId: run.id,
          actor: definition.name,
          workspacePath,
          sandbox: this.dependencies.sandbox,
          // `docs/236` 第 4 步：能力面声明允许装依赖出网时才置真。缺省 false ⇒ 零行为变化。
          ...(this.dependencies.dependencyInstallAllowed === undefined
            ? {}
            : { dependencyInstallAllowed: this.dependencies.dependencyInstallAllowed }),
          logger,
          metadata: {
            workflowRunId: workflow.id,
            taskKey: task.taskKey,
            agentName: definition.name
          }
        },
        {
          maxIterations: 50,
          timeoutMs,
          maxRetries: 1,
          signal: controller.signal
        }
      );
      const outcome = result.professionalResult ?? scriptedOutcome(task, execution);
      const artifacts = [
        ...outcome.artifacts,
        ...result.toolResults.flatMap((toolResult) => {
          const artifact = inferredArtifact(toolResult);
          return artifact ? [artifact] : [];
        })
      ];
      if (
        definition.type === "QA" &&
        !artifacts.some((artifact) => artifact.type === "TEST_RESULT")
      ) {
        artifacts.push({
          type: "TEST_RESULT",
          name: "QA Result",
          content: object(outcome.metadata),
          metadata: {}
        });
      }
      if (
        definition.type === "REVIEWER" &&
        !artifacts.some((artifact) => artifact.type === "REVIEW_RESULT")
      ) {
        artifacts.push({
          type: "REVIEW_RESULT",
          name: "Code Review",
          content: { summary: outcome.summary, issues: outcome.issues, ...outcome.metadata },
          metadata: {}
        });
      }
      for (const artifact of artifacts) {
        const created = await this.dependencies.artifacts.create({
          projectId: workflow.projectId,
          taskId: task.id,
          agentRunId: run.id,
          agentName: definition.name,
          type: artifact.type,
          name: artifact.name,
          content: object(sanitizeLogData(artifact.content)),
          metadata: object(sanitizeLogData(artifact.metadata))
        });
        await this.recordEvent(workflow.id, task.id, run.id, "agent_artifact_created", {
          artifactId: created.id,
          type: created.type,
          name: created.name
        });
      }
      // 功能清点 T3：UI 交付物的截图证据（附加证据，绝不阻断任务）。
      if (outcome.status === "SUCCESS") {
        await this.captureVisualEvidence(
          workflow,
          task,
          run.id,
          definition.name,
          workspacePath,
          result.toolResults
        );
      }
      // N-29（`docs/211`）：见 `isDebugHandoff` —— 诚实交接按成功记，否则它的重试永远跑不了。
      const handoff = isDebugHandoff(task, outcome);
      const output: JsonObject = {
        agentName: definition.name,
        agentType: definition.type,
        agentRunId: run.id,
        summary: outcome.summary,
        outcome: outcome.status,
        // N-22（`docs/199` 判据 25e）：见 `resolveOutcomeErrorType`。
        // N-29（`docs/211`）：**交接**不落失败码——它不是一次失败。
        // AFC-M3：timed_out / TIMEOUT_ERROR → AGENT_TIMEOUT，进入自治而非仅人工重试。
        errorType: handoff
          ? undefined
          : resolveRunFailureErrorType(result.status, outcome, result.error?.code),
        // N-61（`docs/232` §10）：上游不可用的标记。这里必须点名——本对象是显式白名单
        // （不铺开 `outcome.metadata`），漏了它 `WorkflowEngine` 就永远读不到。
        errorReason: string(outcome.metadata.errorReason),
        answerLength:
          typeof outcome.metadata.answerLength === "number"
            ? outcome.metadata.answerLength
            : undefined,
        answerHead: string(outcome.metadata.answerHead),
        answerTail: string(outcome.metadata.answerTail),
        answerText: string(outcome.metadata.answerText),
        parseRecovery: string(outcome.metadata.parseRecovery),
        // C-1（T2）：结构化提交模式（tool / text-fallback / text）——降级率数据来源。
        outcomeMode: string(outcome.metadata.outcomeMode),
        issues: outcome.issues,
        recommendations: outcome.recommendations,
        artifactCount: artifacts.length,
        iterations: result.iterations,
        duration: result.duration,
        // N-22（`docs/199`）：见 `resolveOutcomeFixTaskType`。
        fixTaskType: resolveOutcomeFixTaskType(outcome, { taskType: task.type }),
        fixSteps: outcome.metadata.fixSteps
      };
      await this.dependencies.agentRuns.update(run.id, {
        status: result.status,
        output,
        currentIteration: result.iterations,
        retryCount: result.retryCount,
        error: result.error ? apiError(result.error) : undefined,
        tokenUsage: result.tokenUsage,
        estimatedCost: result.estimatedCost,
        finishedAt: result.finishedAt
      });
      // N-29（`docs/211`）：`handoff` 时 `REPLAN` 不再翻成 failed——诊断已经完成，
      // 依赖它的重试任务（`-REPLAN-N`）必须能跑起来。
      const status = resolveOutcomeTaskStatus(result.status, outcome, handoff);
      return {
        status,
        output,
        error: apiError(result.error),
        agentRunId: run.id,
        assignedAgent: definition.name
      };
    } finally {
      clearInterval(monitor);
      this.active.delete(task.id);
      await this.dependencies.cancellationStore.clear(run.id);
    }
  }

  async cancel(task: Task): Promise<void> {
    const active = this.active.get(task.id);
    if (!active) return;
    await this.dependencies.cancellationStore.requestCancel(active.agentRunId);
    active.controller.abort();
  }

  private toolCallRecorder(): ToolCallRecorder {
    return {
      recordToolCallStarted: async (record) => {
        await this.dependencies.toolCalls.start(record);
      },
      recordToolCallFinished: async (record) => {
        await this.dependencies.toolCalls.finish(record);
      }
    };
  }

  private lifecycle(workflowRunId: string, taskId: string): AgentLifecycleHooks {
    return {
      onRunStarted: async (record) => {
        await this.dependencies.agentRuns.update(record.agentRunId, {
          status: "running",
          startedAt: record.startedAt,
          currentIteration: 0
        });
      },
      onIteration: async (record) => {
        await this.dependencies.agentRuns.update(record.agentRunId, {
          status: record.status,
          currentIteration: record.iteration
        });
      },
      onRunFinished: async (record) => {
        await this.dependencies.agentRuns.update(record.agentRunId, {
          status: record.status,
          output: object(sanitizeLogData(record.output)),
          currentIteration: record.currentIteration,
          retryCount: record.retryCount,
          error: record.error,
          tokenUsage: record.tokenUsage,
          estimatedCost: record.estimatedCost,
          finishedAt: record.finishedAt
        });
      },
      onEvent: async (record) => {
        await this.recordEvent(
          workflowRunId,
          taskId,
          record.agentRunId,
          record.eventType,
          record.payload
        );
      }
    };
  }

  private async recordEvent(
    workflowRunId: string,
    taskId: string,
    agentRunId: string,
    eventType: string,
    payload: JsonObject
  ): Promise<void> {
    await this.dependencies.workflowEvents.create({
      workflowRunId,
      taskId,
      agentRunId,
      eventType,
      payload: object(sanitizeLogData(payload))
    });
  }

  /**
   * 功能清点 T2（`docs/231` §3.3）：任务开始时的 MCP 工具快照。
   *
   * 快照取一次、任务期间不重算；掉线工具的调用由 registry 的 `canExecute`
   * 逐次判定并 DENY。取不到工具**不阻断任务**——MCP 是可选能力来源，
   * 不是任务的前置条件；失败与截断都以事件留痕，避免「悄悄少了一批工具」。
   */
  private async loadMCPTools(
    workflowRunId: string,
    taskId: string,
    agentRunId: string,
    projectId: string,
    agentName: string
  ): Promise<ToolDefinition<unknown, unknown>[]> {
    const source = this.dependencies.mcpTools;
    if (!source) return [];
    try {
      const toolset = await source.forTask({ projectId, agentName });
      if (toolset.truncated) {
        await this.recordEvent(workflowRunId, taskId, agentRunId, "mcp_tools_truncated", {
          visibleCount: toolset.visibleCount,
          injectedCount: toolset.tools.length
        });
      }
      return toolset.tools;
    } catch (error) {
      await this.recordEvent(workflowRunId, taskId, agentRunId, "mcp_tools_unavailable", {
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
      return [];
    }
  }

  /**
   * 功能清点 T3（`docs/231` §4.2）：任务成功后给 UI 交付物拍一张。
   *
   * 三条边界：①只在任务写出 UI 扩展名文件时触发；②无入口页 / 浏览器起不来
   * 一律记 `unavailable`，**不判任务失败**；③截图是附加证据，不参与验证门判据。
   */
  private async captureVisualEvidence(
    workflow: WorkflowRun,
    task: Task,
    agentRunId: string,
    agentName: string,
    workspacePath: string,
    toolResults: ToolResult[]
  ): Promise<void> {
    const service = this.dependencies.visualEvidence;
    if (!service) return;

    const writtenPaths = toolResults
      .filter(
        (toolResult) =>
          toolResult.success && ["write_file", "edit_file"].includes(toolResult.toolName)
      )
      .map((toolResult) => string(object(toolResult.data).path))
      .filter((path): path is string => path !== undefined);
    if (writtenPaths.length === 0) return;

    try {
      const outcome = await service.capture({ workspacePath, writtenPaths });
      if (outcome.status === "unavailable") {
        await this.recordEvent(workflow.id, task.id, agentRunId, "visual_evidence_unavailable", {
          reason: outcome.reason,
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {})
        });
        return;
      }

      // 基线回归（用户 2026-10-23 裁定 ②）：同一项目、同一入口页的**第一次**截图即基线。
      // 之后每次都比「是否比上次更糟」。入口页不同则不比较（那是另一个页面）。
      const metrics: VisualMetrics = {
        consoleErrors: outcome.consoleErrors,
        networkErrors: outcome.networkErrors,
        settled: outcome.settled,
        bytes: outcome.bytes
      };
      const baselineArtifact = await this.dependencies.artifacts
        .findLatestByMetadataKind(workflow.projectId, BASELINE_KIND)
        .catch(() => null);
      const baselineMetrics =
        baselineArtifact && baselineArtifact.metadata.entry === outcome.entry
          ? metricsFromMetadata(baselineArtifact.metadata)
          : null;
      const isBaseline = baselineMetrics === null;
      const regression = baselineMetrics ? compareVisualEvidence(baselineMetrics, metrics) : null;
      const created = await this.dependencies.artifacts.create({
        projectId: workflow.projectId,
        taskId: task.id,
        agentRunId,
        agentName,
        // `agent_artifacts.type` 是带 CHECK 的封闭集合（迁移 005），没有 SCREENSHOT；
        // 截图确实是本任务生成的文件，用 GENERATED_FILE + metadata.kind 区分，
        // 不为一条证据行加迁移。
        type: "GENERATED_FILE",
        name: isBaseline ? "UI Screenshot (baseline)" : "UI Screenshot",
        content: object({
          assetRef: outcome.assetRef,
          entry: outcome.entry,
          base64: outcome.storedBytes ? outcome.base64 : null
        }),
        metadata: object({
          kind: isBaseline ? BASELINE_KIND : "ui_screenshot",
          entry: outcome.entry,
          bytes: outcome.bytes,
          storedBytes: outcome.storedBytes,
          consoleErrors: outcome.consoleErrors,
          networkErrors: outcome.networkErrors,
          settled: outcome.settled,
          viewport: outcome.viewport
        })
      });
      await this.recordEvent(workflow.id, task.id, agentRunId, "visual_evidence_captured", {
        artifactId: created.id,
        assetRef: outcome.assetRef,
        bytes: outcome.bytes,
        consoleErrors: outcome.consoleErrors,
        networkErrors: outcome.networkErrors,
        baseline: isBaseline
      });
      if (regression) {
        await this.recordEvent(workflow.id, task.id, agentRunId, "visual_regression_detected", {
          artifactId: created.id,
          baselineArtifactId: baselineArtifact?.id ?? null,
          signals: regression.signals,
          baseline: object({ ...regression.baseline }),
          candidate: object({ ...regression.candidate })
        });
      }
    } catch (error) {
      await this.recordEvent(workflow.id, task.id, agentRunId, "visual_evidence_unavailable", {
        reason: "capture-failed",
        detail: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
    }
  }
}
