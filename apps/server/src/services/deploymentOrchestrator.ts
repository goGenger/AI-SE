import {
  PgAgentRunStore,
  PgDeploymentRepository,
  PgProjectRepository,
  PgToolCallStore,
  PgWorkflowRepository
} from "@ai-se/database";
import { sanitizeLogData } from "@ai-se/observability";
import { Sandbox } from "@ai-se/sandbox";
import {
  ApiErrorBody,
  CiRun,
  DeliveryTaskSchema,
  Deployment,
  DeploymentDetailView,
  JsonObject,
  RollbackDeploymentData,
  Task,
  UpsertDeploymentEnvironmentData,
  WorkflowRun
} from "@ai-se/shared";
import { DeliveryOperations, ToolRuntime, createDeliveryTools } from "@ai-se/tool-runtime";
import { TaskExecutionResult, WorkflowTaskExecutor } from "@ai-se/workflow-engine";
import { randomUUID } from "node:crypto";
import { Logger } from "pino";
import { AppError } from "../http/errors";
import {
  CONTRADICTORY_TEST_EXPECTATIONS,
  contradictoryCiReplanHint
} from "./contradictoryTestExpectations";
import { WorkflowRequestIdResolver } from "./workflowCorrelation";

function apiError(code: string, message: string, details?: unknown): ApiErrorBody {
  return { code, message, details: sanitizeLogData(details) };
}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/** F1-5（FX-18）：CI 全量测试的逐条结果透传（未知形状 → undefined）。 */
function plainTestResults(value: unknown): Record<string, "passed" | "failed"> | undefined {
  const record = object(value);
  const entries = Object.entries(record).filter(
    (entry): entry is [string, "passed" | "failed"] =>
      entry[1] === "passed" || entry[1] === "failed"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function imageRepository(repository: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(repository);
  return match ? `ghcr.io/${match[1].toLowerCase()}/${match[2].toLowerCase()}` : "ai-se-app";
}

/** N-73：环境声明 `adapter: "static"` 就是工作区优先的前端；其余一律按 docker 处理。 */
function adapterOf(environment: { adapter?: string }): "docker" | "static" {
  return environment.adapter === "static" ? "static" : "docker";
}

export class DeploymentOrchestrator implements WorkflowTaskExecutor {
  private readonly runtime: ToolRuntime;
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly dependencies: {
      deployments: PgDeploymentRepository;
      projects: PgProjectRepository;
      workflows: PgWorkflowRepository;
      agentRuns: PgAgentRunStore;
      toolCalls: PgToolCallStore;
      /** 7-A：工作流 requestId 解析（WORKFLOW_STARTED 事件为准）。 */
      requestId: WorkflowRequestIdResolver;
      operations: DeliveryOperations;
      ciProvider: CiRun["provider"];
      sandbox: Sandbox;
      logger: Logger;
    }
  ) {
    this.runtime = new ToolRuntime({ tools: createDeliveryTools(dependencies.operations) });
  }

  /**
   * N-31（`docs/215`）：**按 `input.delivery` 分派，不按 `task.type`。**
   *
   * 此前要求三个类型各自配对（`BUILD`+`CI` / `DEPLOY`+`DEPLOY|ROLLBACK` / `TEST`+`VERIFY`），
   * 而规划器会把 `VERIFY` 挂在 **`REVIEW`** 上——实测 `l1-m4s` run 1 与 run 2 的 `TP-12`
   * 都是 `REVIEW` + `action=VERIFY`。于是本方法返回 false，任务落到职业 agent 手里变成
   * **一次代码评审**（原话：「Reviewed the staging slice … without modifying any file」），
   * 而 `input.delivery` 还在但没人再读——与 N-23 同一失效：契约字段变成装饰。
   *
   * 后果**不是失败，是假成功**：验证从未执行，任务却自报 SUCCESS，而批次指标
   * （`harness.ts:150-160` 的 `collectStagingSegment`）只看任务状态与 `input.delivery`
   * ⇒ 直接把「staging VERIFY」读成成功。这条 L1-8 判据会因此永久不可信。
   *
   * 交付块本身就是契约：只要它通过 `DeliveryTaskSchema`（该 schema 已把 action 限死在
   * `CI|DEPLOY|VERIFY|ROLLBACK`，且非 CI 必须带 environment），就该由本编排器执行。
   */
  canHandle(task: Task): boolean {
    return DeliveryTaskSchema.safeParse(task.input.delivery).success;
  }

  async execute(workflow: WorkflowRun, task: Task): Promise<TaskExecutionResult> {
    const delivery = DeliveryTaskSchema.parse(task.input.delivery);
    const controller = new AbortController();
    const run = await this.dependencies.agentRuns.create({
      projectId: workflow.projectId,
      taskId: task.id,
      input: {
        runtime: "delivery-orchestrator",
        workflowRunId: workflow.id,
        taskKey: task.taskKey,
        delivery
      },
      maxIterations: 1
    });
    await this.dependencies.agentRuns.update(run.id, {
      status: "running",
      startedAt: new Date().toISOString()
    });
    this.active.set(task.id, controller);
    try {
      const result =
        delivery.action === "CI"
          ? await this.runCi(workflow, task, delivery, run.id, controller.signal)
          : delivery.action === "VERIFY"
            ? await this.verifyDeployment(workflow, task, delivery, run.id, controller.signal)
            : await this.runDeployment(workflow, task, delivery, run.id, controller.signal);
      await this.dependencies.agentRuns.update(run.id, {
        status: result.status,
        output: result.output,
        error: result.error,
        currentIteration: 1,
        finishedAt: new Date().toISOString()
      });
      return { ...result, agentRunId: run.id, assignedAgent: "DeliveryOrchestrator" };
    } catch (error) {
      const normalized = apiError(
        "DELIVERY_ERROR",
        error instanceof Error ? error.message : "Delivery failed"
      );
      await this.dependencies.agentRuns.update(run.id, {
        status: controller.signal.aborted ? "cancelled" : "failed",
        error: normalized,
        currentIteration: 1,
        finishedAt: new Date().toISOString()
      });
      return {
        status: controller.signal.aborted ? "cancelled" : "failed",
        agentRunId: run.id,
        assignedAgent: "DeliveryOrchestrator",
        error: normalized
      };
    } finally {
      this.active.delete(task.id);
    }
  }

  async cancel(task: Task): Promise<void> {
    this.active.get(task.id)?.abort();
  }

  async list(projectId?: string): Promise<Deployment[]> {
    return await this.dependencies.deployments.findMany(projectId);
  }

  async get(id: string): Promise<DeploymentDetailView | null> {
    const deployment = await this.dependencies.deployments.findById(id);
    if (!deployment) return null;
    const [logs, ciRun, environment] = await Promise.all([
      this.dependencies.deployments.findLogs(id),
      deployment.ciRunId
        ? this.dependencies.deployments.findCiRun(deployment.ciRunId)
        : Promise.resolve(null),
      this.dependencies.deployments.findEnvironment(deployment.projectId, deployment.environment)
    ]);
    return {
      deployment,
      logs,
      ciRun: ciRun ?? undefined,
      environment: environment ?? undefined
    };
  }

  async environments(projectId?: string) {
    return await this.dependencies.deployments.findEnvironments(projectId);
  }

  async upsertEnvironment(input: UpsertDeploymentEnvironmentData) {
    if (!(await this.dependencies.projects.findById(input.projectId))) {
      throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    return await this.dependencies.deployments.upsertEnvironment(input);
  }

  async rollback(id: string, input: RollbackDeploymentData): Promise<Deployment> {
    const current = await this.dependencies.deployments.findById(id);
    if (!current) throw new AppError(404, "DEPLOYMENT_NOT_FOUND", "Deployment not found");
    if (current.operation === "ROLLBACK") return current;
    if (current.status === "ROLLED_BACK" && current.rollbackDeploymentId) {
      return (
        (await this.dependencies.deployments.findById(current.rollbackDeploymentId)) ?? current
      );
    }
    if (current.environment === "production") {
      const approved = (
        await this.dependencies.workflows.findApprovals(current.workflowRunId)
      ).some((approval) => approval.taskId === current.taskId && approval.status === "APPROVED");
      if (!approved) {
        throw new AppError(
          409,
          "PRODUCTION_APPROVAL_REQUIRED",
          "Production rollback requires an approved deployment task"
        );
      }
    }
    const previous = await this.dependencies.deployments.findPreviousSuccessful(
      current.projectId,
      current.environment,
      current.id
    );
    if (!previous) {
      throw new AppError(409, "ROLLBACK_VERSION_NOT_FOUND", "No previous successful version");
    }
    const environment = await this.requiredEnvironment(current.projectId, current.environment);
    const rollback = await this.dependencies.deployments.createDeployment({
      projectId: current.projectId,
      workflowRunId: current.workflowRunId,
      taskId: current.taskId,
      agentRunId: current.agentRunId,
      ciRunId: previous.ciRunId,
      version: previous.version,
      environment: current.environment,
      image: previous.image,
      gitCommit: previous.gitCommit,
      operation: "ROLLBACK",
      endpoint: environment.endpoint,
      rollbackVersion: previous.version,
      rollbackDeploymentId: current.id,
      rollbackReason: input.reason,
      idempotencyKey: `manual-rollback:${current.id}`
    });
    if (["SUCCESS", "ROLLED_BACK"].includes(rollback.status)) return rollback;
    await this.dependencies.deployments.updateDeployment(current.id, {
      status: "ROLLING_BACK",
      rollbackVersion: previous.version,
      rollbackDeploymentId: rollback.id,
      rollbackReason: input.reason,
      rollbackAt: new Date().toISOString()
    });
    const result = await this.executeReleaseTool(
      "rollback_release",
      rollback,
      environment.configuration,
      current.agentRunId,
      undefined,
      current.environment === "production",
      adapterOf(environment)
    );
    await this.persistLogs(rollback.id, result.logs);
    const status = result.status === "SUCCESS" ? "SUCCESS" : "ROLLBACK_FAILED";
    const finished = await this.dependencies.deployments.updateDeployment(rollback.id, {
      status,
      healthCheck: result.healthCheck,
      error: result.error ? apiError("ROLLBACK_FAILED", result.error) : undefined,
      startedAt: rollback.startedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString()
    });
    await this.dependencies.deployments.updateDeployment(current.id, {
      status: result.status === "SUCCESS" ? "ROLLED_BACK" : "ROLLBACK_FAILED",
      healthCheck: result.healthCheck,
      error: result.error ? apiError("ROLLBACK_FAILED", result.error) : undefined,
      finishedAt: new Date().toISOString()
    });
    await this.event(
      current.workflowRunId,
      current.taskId,
      current.agentRunId,
      "DEPLOYMENT_ROLLBACK_FINISHED",
      {
        deploymentId: current.id,
        rollbackDeploymentId: rollback.id,
        rollbackVersion: previous.version,
        status
      }
    );
    return finished ?? rollback;
  }

  private async runCi(
    workflow: WorkflowRun,
    task: Task,
    delivery: ReturnType<typeof DeliveryTaskSchema.parse>,
    agentRunId: string,
    signal: AbortSignal
  ): Promise<TaskExecutionResult> {
    const project = await this.dependencies.projects.findById(workflow.projectId);
    if (!project)
      return { status: "failed", error: apiError("PROJECT_NOT_FOUND", "Project not found") };
    // N-73：适配器由项目环境声明决定——`static`（工作区优先的前端）不需要 git 仓库。
    const adapter = await this.deliveryAdapter(workflow.projectId);
    // UX-01: CI needs a Git repository; a workspace-first project must bind one first.
    if (adapter === "docker" && !project.repository)
      return {
        status: "failed",
        error: apiError("REPOSITORY_NOT_CONFIGURED", "Project has no repository configured")
      };
    const ciRun = await this.dependencies.deployments.createCiRun({
      projectId: workflow.projectId,
      workflowRunId: workflow.id,
      taskId: task.id,
      agentRunId,
      provider: this.dependencies.ciProvider,
      workflowFile: delivery.workflowFile ?? "ci.yml"
    });
    if (ciRun.status === "SUCCESS") return this.ciSuccess(ciRun);
    await this.dependencies.deployments.updateCiRun(ciRun.id, {
      status: "RUNNING",
      startedAt: new Date().toISOString()
    });
    await this.event(workflow.id, task.id, agentRunId, "CI_STARTED", { ciRunId: ciRun.id });
    const result = await this.runtime.execute(
      "run_ci",
      {
        adapter,
        ...(project.repository ? { repository: project.repository } : {}),
        workflowFile: delivery.workflowFile ?? "ci.yml",
        ref: delivery.ref ?? "main",
        imageRepository: project.repository ? imageRepository(project.repository) : "ai-se-app"
      },
      await this.context(workflow, task, agentRunId, signal)
    );
    const data = object(result.data);
    const testResults = plainTestResults(data.testResults);
    const status = result.success ? String(data.status) : "FAILED";
    const errorMessage = String(data.error ?? result.error?.message ?? "CI failed");
    // 门禁 P1：互斥期望早停 → 明确错误码 + fixTaskType=TEST，驱动 REPLAN 改测而非盲目重跑 CI。
    const replanHint =
      contradictoryCiReplanHint(errorMessage) ??
      (data.errorType === CONTRADICTORY_TEST_EXPECTATIONS
        ? { fixTaskType: "TEST" as const, errorType: CONTRADICTORY_TEST_EXPECTATIONS }
        : undefined);
    const contradictory = replanHint !== undefined;
    const ciErrorCode = contradictory ? CONTRADICTORY_TEST_EXPECTATIONS : "CI_FAILED";
    const finished = await this.dependencies.deployments.updateCiRun(ciRun.id, {
      providerRunId: typeof data.providerRunId === "string" ? data.providerRunId : undefined,
      status: status === "SUCCESS" ? "SUCCESS" : status === "CANCELLED" ? "CANCELLED" : "FAILED",
      url: typeof data.url === "string" ? data.url : undefined,
      gitCommit: typeof data.gitCommit === "string" ? data.gitCommit : undefined,
      pullRequest: typeof data.pullRequest === "number" ? data.pullRequest : undefined,
      image: typeof data.image === "string" ? data.image : undefined,
      error: status === "SUCCESS" ? undefined : apiError(ciErrorCode, errorMessage),
      finishedAt: new Date().toISOString()
    });
    await this.event(workflow.id, task.id, agentRunId, "CI_FINISHED", {
      ciRunId: ciRun.id,
      status,
      providerRunId: data.providerRunId,
      gitCommit: data.gitCommit,
      pullRequest: data.pullRequest,
      image: data.image,
      logs: Array.isArray(data.logs) ? data.logs.slice(-20) : [],
      ...(replanHint
        ? { errorType: replanHint.errorType, fixTaskType: replanHint.fixTaskType }
        : {})
    });
    if (!finished || finished.status !== "SUCCESS") {
      // F1-5（FX-18/19）：失败的交付前全量也留证（逐条 AC 结果 + commit），供追溯表显示失败。
      // 门禁 P1：矛盾期望命中时即使没有 testResults，也要写出 fixTaskType=TEST，供 replan 派发键使用。
      const output: JsonObject = {
        ...(typeof data.gitCommit === "string" ? { gitCommit: data.gitCommit } : {}),
        ...(testResults
          ? {
              testResults,
              testCommand: "pnpm test"
            }
          : {}),
        ...(replanHint
          ? {
              errorType: replanHint.errorType,
              fixTaskType: replanHint.fixTaskType
            }
          : {})
      };
      return {
        status: status === "CANCELLED" ? "cancelled" : "failed",
        error: finished?.error,
        ...(Object.keys(output).length > 0 ? { output } : {})
      };
    }
    return this.ciSuccess(finished, testResults);
  }

  private ciSuccess(
    ciRun: CiRun,
    testResults?: Record<string, "passed" | "failed">
  ): TaskExecutionResult {
    return {
      status: "succeeded",
      assignedAgent: "DeliveryOrchestrator",
      agentRunId: ciRun.agentRunId,
      output: {
        ciRunId: ciRun.id,
        providerRunId: ciRun.providerRunId,
        gitCommit: ciRun.gitCommit,
        pullRequest: ciRun.pullRequest,
        image: ciRun.image,
        url: ciRun.url,
        // F1-5（FX-18）：交付前全量测试（最终集成的 commit）逐条结果——追溯表以这一次为准。
        ...(testResults && Object.keys(testResults).length > 0
          ? { testResults, testCommand: "pnpm test" }
          : {})
      }
    };
  }

  private async runDeployment(
    workflow: WorkflowRun,
    task: Task,
    delivery: ReturnType<typeof DeliveryTaskSchema.parse>,
    agentRunId: string,
    signal: AbortSignal
  ): Promise<TaskExecutionResult> {
    if (!delivery.environment) {
      return {
        status: "failed",
        error: apiError("ENVIRONMENT_REQUIRED", "Environment is required")
      };
    }
    const ci = await this.dependencies.deployments.findLatestSuccessfulCi(workflow.id);
    if (!ci?.image || !ci.gitCommit) {
      return {
        status: "failed",
        error: apiError("CI_RELEASE_NOT_FOUND", "No successful CI release found")
      };
    }
    const environment = await this.requiredEnvironment(workflow.projectId, delivery.environment);
    const approved =
      delivery.environment !== "production" ||
      (await this.dependencies.workflows.findApprovals(workflow.id)).some(
        (approval) => approval.taskId === task.id && approval.status === "APPROVED"
      );
    if (!approved) {
      return {
        status: "failed",
        error: apiError("PRODUCTION_APPROVAL_REQUIRED", "Production deployment requires approval")
      };
    }
    let release = ci;
    let sourceDeployment: Deployment | null = null;
    if (delivery.action === "ROLLBACK") {
      const sourceId =
        typeof task.input.rollbackDeploymentId === "string" ? task.input.rollbackDeploymentId : "";
      sourceDeployment = sourceId ? await this.dependencies.deployments.findById(sourceId) : null;
      const previous = sourceDeployment
        ? await this.dependencies.deployments.findPreviousSuccessful(
            workflow.projectId,
            delivery.environment,
            sourceDeployment.id
          )
        : null;
      if (!previous) {
        return {
          status: "failed",
          error: apiError("ROLLBACK_VERSION_NOT_FOUND", "No previous successful version")
        };
      }
      release = {
        ...ci,
        id: previous.ciRunId ?? ci.id,
        image: previous.image,
        gitCommit: previous.gitCommit
      };
    }
    const operation = delivery.action === "ROLLBACK" ? "ROLLBACK" : "DEPLOY";
    const version = release.gitCommit!;
    const deployment = await this.dependencies.deployments.createDeployment({
      projectId: workflow.projectId,
      workflowRunId: workflow.id,
      taskId: task.id,
      agentRunId,
      ciRunId: release.id,
      version,
      environment: delivery.environment,
      image: release.image!,
      gitCommit: release.gitCommit!,
      operation,
      endpoint: environment.endpoint,
      rollbackVersion: operation === "ROLLBACK" ? version : undefined,
      rollbackDeploymentId: sourceDeployment?.id,
      rollbackReason: operation === "ROLLBACK" ? "Workflow deployment recovery" : undefined,
      idempotencyKey: `${workflow.id}:${task.id}:${operation}`
    });
    if (["SUCCESS", "ROLLED_BACK"].includes(deployment.status))
      return this.deploymentSuccess(deployment);
    await this.dependencies.deployments.updateDeployment(deployment.id, {
      status: operation === "ROLLBACK" ? "ROLLING_BACK" : "RUNNING",
      startedAt: new Date().toISOString()
    });
    await this.event(workflow.id, task.id, agentRunId, "DEPLOYMENT_STARTED", {
      deploymentId: deployment.id,
      environment: delivery.environment,
      image: release.image,
      version,
      operation
    });
    const action = operation === "ROLLBACK" ? "rollback_release" : "deploy_release";
    const deployed = await this.executeReleaseTool(
      action,
      deployment,
      environment.configuration,
      agentRunId,
      signal,
      approved,
      adapterOf(environment)
    );
    await this.persistLogs(deployment.id, deployed.logs);
    const verified =
      deployed.status === "SUCCESS"
        ? await this.executeReleaseTool(
            "verify_release",
            deployment,
            environment.configuration,
            agentRunId,
            signal,
            false,
            adapterOf(environment)
          )
        : deployed;
    if (verified !== deployed) await this.persistLogs(deployment.id, verified.logs);
    const success = deployed.status === "SUCCESS" && verified.status === "SUCCESS";
    const updated = await this.dependencies.deployments.updateDeployment(deployment.id, {
      status: success ? "SUCCESS" : operation === "ROLLBACK" ? "ROLLBACK_FAILED" : "FAILED",
      healthCheck: verified.healthCheck,
      error: success
        ? undefined
        : apiError(
            operation === "ROLLBACK" ? "ROLLBACK_FAILED" : "DEPLOYMENT_FAILED",
            verified.error ?? deployed.error ?? "Deployment failed"
          ),
      rollbackAt: operation === "ROLLBACK" ? new Date().toISOString() : undefined,
      finishedAt: new Date().toISOString()
    });
    if (sourceDeployment && success) {
      await this.dependencies.deployments.updateDeployment(sourceDeployment.id, {
        status: "ROLLED_BACK",
        rollbackVersion: version,
        rollbackDeploymentId: deployment.id,
        rollbackReason: "Workflow deployment recovery",
        rollbackAt: new Date().toISOString()
      });
    }
    await this.event(workflow.id, task.id, agentRunId, "DEPLOYMENT_FINISHED", {
      deploymentId: deployment.id,
      status: updated?.status,
      healthCheck: verified.healthCheck,
      operation
    });
    return success && updated
      ? this.deploymentSuccess(updated)
      : {
          status: "failed",
          assignedAgent: "DeliveryOrchestrator",
          agentRunId,
          output: {
            deploymentId: deployment.id,
            environment: deployment.environment,
            version: deployment.version,
            image: deployment.image,
            rollbackRecommended: operation === "DEPLOY"
          },
          error: updated?.error
        };
  }

  private async verifyDeployment(
    workflow: WorkflowRun,
    task: Task,
    delivery: ReturnType<typeof DeliveryTaskSchema.parse>,
    agentRunId: string,
    signal: AbortSignal
  ): Promise<TaskExecutionResult> {
    if (!delivery.environment) {
      return {
        status: "failed",
        error: apiError("ENVIRONMENT_REQUIRED", "Environment is required")
      };
    }
    const deployment = await this.dependencies.deployments.findLatestSuccessful(
      workflow.projectId,
      delivery.environment
    );
    if (!deployment) {
      return {
        status: "failed",
        error: apiError("DEPLOYMENT_NOT_FOUND", "No successful deployment to verify")
      };
    }
    const environment = await this.requiredEnvironment(workflow.projectId, delivery.environment);
    const result = await this.executeReleaseTool(
      "verify_release",
      deployment,
      environment.configuration,
      agentRunId,
      signal,
      false,
      adapterOf(environment)
    );
    await this.persistLogs(deployment.id, result.logs);
    await this.event(workflow.id, task.id, agentRunId, "RELEASE_VERIFIED", {
      deploymentId: deployment.id,
      environment: delivery.environment,
      status: result.status,
      healthCheck: result.healthCheck
    });
    return result.status === "SUCCESS"
      ? {
          status: "succeeded",
          output: {
            deploymentId: deployment.id,
            environment: deployment.environment,
            version: deployment.version,
            healthCheck: result.healthCheck
          }
        }
      : {
          status: "failed",
          error: apiError("RELEASE_VERIFICATION_FAILED", result.error ?? "Verification failed")
        };
  }

  private deploymentSuccess(deployment: Deployment): TaskExecutionResult {
    return {
      status: "succeeded",
      assignedAgent: "DeliveryOrchestrator",
      agentRunId: deployment.agentRunId,
      output: {
        deploymentId: deployment.id,
        ciRunId: deployment.ciRunId,
        environment: deployment.environment,
        version: deployment.version,
        gitCommit: deployment.gitCommit,
        image: deployment.image,
        endpoint: deployment.endpoint,
        healthCheck: deployment.healthCheck,
        operation: deployment.operation
      }
    };
  }

  private async executeReleaseTool(
    toolName: "deploy_release" | "verify_release" | "rollback_release",
    deployment: Deployment,
    configuration: JsonObject,
    agentRunId?: string,
    signal?: AbortSignal,
    approved = false,
    // N-73：`static` = 工作区优先的前端（起静态预览 + 浏览器探页面）。
    adapter: "docker" | "static" = "docker"
  ) {
    // N-73 / F1 round17：DEPLOY/VERIFY/ROLLBACK 必须落在工作流声明的工作区。
    // 旧实现写死 `process.cwd()`（平台进程在 apps/server），static 适配器就会在
    // 平台目录跑 `npm start`（起的是 API server，不是夹具的 vite preview），
    // 30s 内 :18900 无应答 → DEPLOYMENT_FAILED（stderr 还常为空，因为 node 日志走 stdout）。
    // 与同文件 `context()` / `runCi` 口径对齐：优先 `workflow.input.workspacePath`。
    const workflow = await this.dependencies.workflows.findWorkflowById(deployment.workflowRunId);
    const workspacePath =
      typeof workflow?.input?.workspacePath === "string"
        ? workflow.input.workspacePath
        : process.cwd();
    const result = await this.runtime.execute(
      toolName,
      {
        adapter,
        deploymentId: deployment.id,
        environment: deployment.environment,
        endpoint: deployment.endpoint,
        image: deployment.image,
        version: deployment.version,
        configuration
      },
      {
        // 7-A：沿用工作流的 requestId（源自触发启动的 HTTP 请求）。
        requestId: await this.dependencies.requestId(deployment.workflowRunId),
        projectId: deployment.projectId,
        workflowRunId: deployment.workflowRunId,
        taskId: deployment.taskId,
        agentRunId: agentRunId ?? randomUUID(),
        toolCallId: randomUUID(),
        actor: "DeploymentOrchestrator",
        workspacePath,
        sandbox: this.dependencies.sandbox,
        logger: this.dependencies.logger,
        timeoutMs: 10 * 60_000,
        signal,
        metadata: {
          workflowRunId: deployment.workflowRunId,
          deploymentId: deployment.id,
          approved
        },
        toolCallRecorder: this.toolCallRecorder()
      }
    );
    if (!result.success) {
      return { status: "FAILED" as const, healthCheck: {}, logs: [], error: result.error?.message };
    }
    return result.data as {
      status: "SUCCESS" | "FAILED";
      healthCheck: JsonObject;
      logs: string[];
      error?: string;
    };
  }

  private async context(
    workflow: WorkflowRun,
    task: Task,
    agentRunId: string | undefined,
    signal: AbortSignal
  ) {
    return {
      // 7-A：沿用工作流的 requestId（源自触发启动的 HTTP 请求）。
      requestId: await this.dependencies.requestId(workflow.id),
      projectId: workflow.projectId,
      workflowRunId: workflow.id,
      taskId: task.id,
      agentRunId: agentRunId ?? randomUUID(),
      toolCallId: randomUUID(),
      actor: "DeploymentOrchestrator",
      workspacePath:
        typeof workflow.input.workspacePath === "string"
          ? workflow.input.workspacePath
          : process.cwd(),
      sandbox: this.dependencies.sandbox,
      logger: this.dependencies.logger,
      timeoutMs: 30 * 60_000,
      signal,
      metadata: { workflowRunId: workflow.id },
      toolCallRecorder: this.toolCallRecorder()
    };
  }

  /**
   * N-73：项目声明的环境适配器决定 CI 走哪条路。
   * 只要有一个 `static` 环境，就按工作区优先的前端项目处理（无仓库、无 Dockerfile）。
   */
  private async deliveryAdapter(projectId: string): Promise<"docker" | "static"> {
    const environments = await this.dependencies.deployments.findEnvironments(projectId);
    return environments.some((entry) => entry.adapter === "static") ? "static" : "docker";
  }

  private async requiredEnvironment(projectId: string, name: Deployment["environment"]) {    const environment = await this.dependencies.deployments.findEnvironment(projectId, name);
    if (!environment) {
      throw new AppError(
        409,
        "ENVIRONMENT_NOT_CONFIGURED",
        `${name} environment is not configured`
      );
    }
    return environment;
  }

  private toolCallRecorder() {
    return {
      recordToolCallStarted: async (record: Parameters<PgToolCallStore["start"]>[0]) => {
        await this.dependencies.toolCalls.start(record);
      },
      recordToolCallFinished: async (record: Parameters<PgToolCallStore["finish"]>[0]) => {
        await this.dependencies.toolCalls.finish(record);
      }
    };
  }

  private async persistLogs(deploymentId: string, logs: string[]): Promise<void> {
    for (const message of logs.slice(-100)) {
      await this.dependencies.deployments.appendLog(
        deploymentId,
        "info",
        String(sanitizeLogData(message))
      );
    }
  }

  private async event(
    workflowRunId: string,
    taskId: string,
    agentRunId: string | undefined,
    eventType: string,
    payload: JsonObject
  ): Promise<void> {
    await this.dependencies.workflows.createEvent({
      workflowRunId,
      taskId,
      agentRunId,
      eventType,
      payload: object(sanitizeLogData(payload))
    });
  }
}

export class RoutingWorkflowTaskExecutor implements WorkflowTaskExecutor {
  constructor(
    private readonly delivery: DeploymentOrchestrator,
    private readonly agent: WorkflowTaskExecutor
  ) {}

  execute(workflow: WorkflowRun, task: Task): Promise<TaskExecutionResult> {
    return this.delivery.canHandle(task)
      ? this.delivery.execute(workflow, task)
      : this.agent.execute(workflow, task);
  }

  cancel(task: Task): Promise<void> {
    return this.delivery.canHandle(task) ? this.delivery.cancel(task) : this.agent.cancel(task);
  }
}
