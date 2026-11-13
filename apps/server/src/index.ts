import {
  AgentRegistry,
  PROFESSIONAL_AGENT_DEFINITIONS,
  LangChainLLMProvider,
  LangChainPlanningModel,
  ScriptedPlanningModel
} from "@ai-se/agent-core";
import {
  checkDatabase,
  createPool,
  PgAgentArtifactRepository,
  PgAgentRunStore,
  PgDeploymentRepository,
  PgEvidenceRepository,
  PgIncidentRepository,
  PgMCPRegistryStore,
  PgMetricsRepository,
  PgPlanningRepository,
  PgConflictResolutionRepository,
  PgRequirementDocumentRepository,
  PgProjectRepository,
  PgToolCallStore,
  PgWorkflowEventStore,
  PgWorkflowRepository
} from "@ai-se/database";
import { createRealPlaywright } from "@ai-se/browser";
import { PersistentMCPRegistry, RemoteMCPClient, StdioMCPClient } from "@ai-se/mcp";
import { createLogger, sanitizeLogData } from "@ai-se/observability";
import { DockerSandbox } from "@ai-se/sandbox";
import { createClient } from "redis";
import { createApp } from "./app";
import { assertListenSecurity, loadConfig } from "./config";
import { AgentRunService } from "./services/agentRunService";
import { AgentRegistryService } from "./services/agentRegistryService";
import { RedisCancellationStore } from "./services/cancellationStore";
import { EvidenceService } from "./services/evidenceService";
import { IncidentAgent } from "./services/incidentAgent";
import { IncidentEvidenceCollector } from "./services/incidentEvidenceCollector";
import { createPlanningFixWorkflowOpener } from "./services/incidentFixWorkflowOpener";
import { IncidentService } from "./services/incidentService";
import { createEnvCredentialResolver } from "./services/envCredentialResolver";
import { LiveLLMProvider, LivePlanningModel } from "./services/liveModel";
import { ModelConfigService } from "./services/modelConfigService";
import {
  DeploymentOrchestrator,
  RoutingWorkflowTaskExecutor
} from "./services/deploymentOrchestrator";
import {
  GitHubActionsOperations,
  LocalCiOperations,
  LocalDockerOperations,
  createDeliveryOperations
} from "./services/deliveryAdapters";
import { MCPAppService } from "./services/mcpAppService";
import { MCPConsoleService } from "./services/mcpService";
import { MCPTaskToolSource } from "./services/mcpTaskToolSource";
import { VisualEvidenceService } from "./services/visualEvidenceService";
import { MetricsService } from "./services/metricsService";
import { DocumentService } from "./services/documentService";
import { PlanningService } from "./services/planningService";
import { TraceService } from "./services/traceService";
import { AutonomyRunsService } from "./services/autonomyRunsService";
import { WorkflowService } from "./services/workflowService";
import { createWorkflowRequestIdResolver } from "./services/workflowCorrelation";
import { PersistentWorkflowTaskExecutor } from "./services/workflowTaskExecutor";
import { TaskContextBuilder } from "./services/taskContextBuilder";
import { TaskVerifier } from "./services/taskVerifier";
import { createAutonomyFailureRouter } from "./services/gateFailureRepair";
import { VerifyingWorkflowTaskExecutor } from "./services/verifyingTaskExecutor";
import { RedactingWorkflowTaskExecutor } from "./services/redactingTaskExecutor";

async function main(): Promise<void> {
  const config = loadConfig();
  // F1-7（FX-22）：非回环监听必须配置 API_TOKEN，否则拒绝启动（明确提示）。
  assertListenSecurity(config);
  const logger = createLogger({ level: config.logLevel });
  const pool = createPool(config.databaseUrl);
  const redis = createClient({ url: config.redisUrl });

  redis.on("error", (error: Error) => {
    logger.error(sanitizeLogData({ message: error.message }), "redis client error");
  });

  await redis.connect();

  const projectRepository = new PgProjectRepository(pool);
  const agentRuns = new PgAgentRunStore(pool);
  const toolCalls = new PgToolCallStore(pool);
  const workflowEvents = new PgWorkflowEventStore(pool);
  const planningRepository = new PgPlanningRepository(pool);
  const requirementDocuments = new PgRequirementDocumentRepository(pool);
  const conflictResolutions = new PgConflictResolutionRepository(pool);
  const workflowRepository = new PgWorkflowRepository(pool);
  const artifacts = new PgAgentArtifactRepository(pool);
  const deployments = new PgDeploymentRepository(pool);
  // `docs/235` §6.5：注册表按本进程的能力 profile 装配（缺省 `backend-node` ⇒ 七个 agent 全可用）。
  const registry = new AgentRegistry(PROFESSIONAL_AGENT_DEFINITIONS, config.capabilityProfile);
  const cancellationStore = new RedisCancellationStore(redis);
  // Model API configuration — the single source for every real-model path
  // (planning / professional workflow agents / bug-fix coding agent).
  // `llmOptions` 是 ModelConfigService 持有的那个**活**对象：控制台改配置时就地改它，于是
  // 按任务现构造 provider 的执行器下次调用即用新值（为什么必须是同一个引用见 modelConfigService.ts）。
  const modelConfig = new ModelConfigService({
    provider: config.llmProvider,
    model: config.llmModel,
    apiKey: config.llmApiKey,
    baseUrl: config.llmBaseUrl
  });
  const llmOptions = modelConfig.getOptions();
  const agentRunService = new AgentRunService({
    agentRuns,
    toolCalls,
    workflowEvents,
    projects: projectRepository,
    cancellationStore,
    // UX-03: context readers for the AgentRun detail (existing entities only).
    artifacts,
    evidence: new PgEvidenceRepository(pool),
    tasks: workflowRepository,
    // AgentRunService 启动时只拿到一个 provider 实例，包一层才能在配置变更后重建。
    ...(config.llmProvider === "openai"
      ? {
          llmProvider: new LiveLLMProvider(modelConfig, () =>
            LangChainLLMProvider.fromOpenAI({
              ...modelConfig.getOptions(),
              ...(config.modelPricing ? { pricing: config.modelPricing } : {})
            })
          )
        }
      : {}),
    logger
  });
  // N2：切片编排用闭包解耦 planning ↔ workflow 的构造顺序（planning 先建）。
  let workflowServiceRef: WorkflowService | null = null;
  const planningService = new PlanningService({
    planning: planningRepository,
    documents: requirementDocuments,
    conflictResolutions,
    agentRuns,
    workflowEvents,
    projects: projectRepository,
    cancellationStore,
    notifyRunChanged: (agentRunId) => agentRunService.notifyRunChanged(agentRunId),
    mode: config.planningMode,
    // `docs/235` §6.5：规划器的可规划类型清单与任务 input.profile 口径。
    capabilityProfile: config.capabilityProfile,
    ...(config.planningFinalSliceMaxTasks !== undefined
      ? { finalSliceMaxTasks: config.planningFinalSliceMaxTasks }
      : {}),
    budgets: {
      stageTimeoutMs: config.planningStageTimeoutMs,
      stageRetries: config.planningStageRetries,
      level1TimeoutMs: config.planningLevel1TimeoutMs,
      sliceTimeoutMs: config.planningSliceTimeoutMs,
      taskPlanningTimeoutMs: config.planningTaskPlanningTimeoutMs
    },
    approvals: workflowRepository,
    workflows: workflowRepository,
    deployments,
    startSliceWorkflow: async (input) => {
      const service = workflowServiceRef;
      if (!service) {
        throw new Error("Workflow service is not ready");
      }
      const workflow = await service.create(input);
      await service.start(workflow.id);
      return workflow;
    },
    model:
      config.llmProvider === "openai"
        ? new LivePlanningModel(
            modelConfig,
            () =>
              new LangChainPlanningModel({
                ...modelConfig.getOptions(),
                structuredOutputMethod: config.llmStructuredOutputMethod,
                sessionId: "ai-se-planning"
              })
          )
        : new ScriptedPlanningModel(),
    logger
  });
  const contextBuilder = new TaskContextBuilder({
    projects: projectRepository,
    planning: planningRepository,
    workflows: workflowRepository,
    agentRuns,
    artifacts,
    documents: requirementDocuments
  });
  const sandbox = new DockerSandbox({
    allowedWorkspaceRoot: config.agentWorkspaceRoot,
    image: config.sandboxImage,
    // `docs/236` 第 4 步：出网能力由 **capability profile** 声明。
    // `network` 是构造级上限，`"none"` 时任何命令都无法请求 registry（`resolveNetwork` 会抛错）。
    limits: { network: config.capabilityProfile.dependencyNetwork ?? "none" },
    logger
  });
  // ── MCP Console wiring (Phase 5.5-5) ─────────────────────────────────────
  // One store, one registry per frozen transport; the console service selects
  // the registry by the server row's transport. MCP execution stays out of
  // this process's request path: the browser only talks to /api/mcp.
  //
  // （功能清点 T2：store 与 registry 的构造上移到任务执行器之前——任务期需要
  //  `MCPTaskToolSource` 读同一批 registry。console / app 两个服务仍在原处。）
  const mcpStore = new PgMCPRegistryStore(pool);
  const mcpStdioRegistry = new PersistentMCPRegistry({
    client: new StdioMCPClient(),
    store: mcpStore
  });
  const mcpRemoteClient = new RemoteMCPClient({
    // 平台侧的 Credential Resolver（5.5-4 只定义了类型，这里补上第一个实现与接线）。
    // 不接的话，任何带 credentialRef/authRef 的服务器都会在连接时抛 CONNECTION 错。
    credentialResolver: createEnvCredentialResolver(),
    onStateChange: (event) => {
      // Remote lifecycle (5.5-4) persists status through the registry; the
      // callback runs out-of-band after boot, so the forward reference to
      // `mcpRemoteRegistry` is initialized before any event can fire.
      void mcpRemoteRegistry.applyConnectionState(event).catch(() => undefined);
    }
  });
  const mcpRemoteRegistry = new PersistentMCPRegistry({
    client: mcpRemoteClient,
    store: mcpStore
  });
  const mcpTaskTools = new MCPTaskToolSource({
    store: mcpStore,
    registries: { stdio: mcpStdioRegistry, "streamable-http": mcpRemoteRegistry }
  });

  // 功能清点 T3：UI 交付物的截图证据（真实 Chromium；取证失败只记 unavailable）。
  const visualEvidence = new VisualEvidenceService({ playwright: createRealPlaywright() });

  // 7-A：工作流 requestId 解析（WORKFLOW_STARTED 事件为准；查询失败回落新 ID）。
  const resolveRequestId = createWorkflowRequestIdResolver(workflowEvents, logger);
  const agentExecutor = new PersistentWorkflowTaskExecutor({
    agentRuns,
    toolCalls,
    workflowEvents,
    artifacts,
    contextBuilder,
    registry,
    cancellationStore,
    sandbox,
    // `docs/236` 第 4 步：出网能力来自 capability profile 的声明。`backend-node` 声明
    // `"none"` ⇒ 与第 4 步之前完全一致；`frontend-vue` 声明 `"registry"` ⇒ install 类命令
    // 可以走 registry（其余命令仍无网）。
    ...(config.capabilityProfile.dependencyNetwork === "registry"
      ? { dependencyInstallAllowed: true }
      : {}),
    requestId: resolveRequestId,
    llmProvider: config.llmProvider,
    llmOptions,
    taskTimeoutMs: config.taskTimeoutMs,
    // G3（GX-09）：按任务类型超时表（缺省未配置 = 零行为变化）。
    ...(config.taskTimeoutByType ? { taskTimeoutByType: config.taskTimeoutByType } : {}),
    submitResultMode: config.submitResultMode,
    // PL-C2：未配置价目 → 不传（`estimated_cost` 维持 NULL，不编造数字）。
    ...(config.modelPricing ? { modelPricing: config.modelPricing } : {}),
    // 功能清点 T2：任务期 MCP 工具来源（绑定即授权，fail-closed）。
    mcpTools: mcpTaskTools,
    // 功能清点 T3：UI 交付物的截图证据（附加证据，不参与验证门判据）。
    visualEvidence,
    logger
  });
  // C-3（T1）：验证门包装（off = 不装配，行为与旧版一致；observe/enforce 生效）。
  const verifiedExecutor =
    config.verificationGate === "off"
      ? agentExecutor
      : new VerifyingWorkflowTaskExecutor(
          new TaskVerifier({
            sandbox,
            mode: config.verificationGate,
            toolCalls: {
              recordToolCallStarted: async (record) => {
                await toolCalls.start(record);
              },
              recordToolCallFinished: async (record) => {
                await toolCalls.finish(record);
              }
            },
            events: workflowEvents,
            workflowTasks: (workflowRunId) => workflowRepository.findTasks(workflowRunId),
            // `docs/235` §6.5：检查候选与边界门按本进程的能力 profile 选。
            profile: config.capabilityProfile,
            // G1（GX-01/02）：红灯翻转证据面 = 同需求全部运行时任务（N5 既有 finder；经 workflow_runs.requirement_id 关联）。
            requirementTasks: (requirementId) =>
              planningRepository.findRuntimeTasksByRequirementId(requirementId),
            // N-64（`docs/232` §10）：testid 命名契约的唯一来源是需求原文（PRD 第四节的定值表）。
            requirementText: async (requirementId) => {
              const requirement = await planningRepository.findRequirementById(requirementId);
              return requirement?.rawContent ?? undefined;
            },
            // docs/265：把需求上已挂的 UI 图升级为官方视觉基线（不是像素级规格）。
            visualBaselines: async (requirementId) => {
              const rows = await requirementDocuments.findUiReferencesByRequirementId(requirementId);
              return rows.map((row) => ({
                fileName: row.fileName,
                mimeType: row.mimeType,
                note: row.note
              }));
            },
            writeScope: {
              mode: config.writeScopeAudit,
              // F2-2（FX-33）：该 agent run 被策略拦截的命令尝试数（POLICY_EVASION_SUSPECTED 判据）。
              blockedCommandAttempts: async (agentRunId) => {
                if (!agentRunId) return 0;
                const calls = await toolCalls.findByAgentRunId(agentRunId);
                return calls.filter((call) => (call.error?.message ?? "").includes("blocked"))
                  .length;
              },
              // N-19（`docs/191`）：被**写权限**拒绝的写入尝试——按 `input.denied = 'write'` 结构化
              // 检索（`ToolRuntimeBackend.recordDeniedCall` 写入），不靠 `error.message` 的子串匹配。
              // 与 `blockedCommandAttempts` 是两条不同的通道：后者的消息形态是 `… is blocked by …`，
              // 写权限拒绝是 `Path is not writable: …`——原先这一类**一次都没被计过**。
              deniedWriteAttempts: async (agentRunId) => {
                if (!agentRunId) return { attempts: 0, paths: [] };
                const calls = await toolCalls.findByAgentRunId(agentRunId);
                const denied = calls.filter((call) => call.input.denied === "write");
                const paths = [
                  ...new Set(
                    denied
                      .map((call) => call.input.path)
                      .filter((path): path is string => typeof path === "string" && path !== "")
                  )
                ].sort();
                return { attempts: denied.length, paths };
              }
            },
            logger
          }),
          agentExecutor,
          config.verificationGate,
          config.capabilityProfile
        );
  if (config.ciProvider === "github" && !config.githubToken) {
    throw new Error("GITHUB_TOKEN is required when CI_PROVIDER=github");
  }
  const deliveryOrchestrator = new DeploymentOrchestrator({
    deployments,
    projects: projectRepository,
    workflows: workflowRepository,
    agentRuns,
    toolCalls,
    requestId: resolveRequestId,
    operations: createDeliveryOperations({
      ci:
        config.ciProvider === "github"
          ? new GitHubActionsOperations({
              token: config.githubToken!,
              apiUrl: config.githubApiUrl
            })
          : new LocalCiOperations(),
      docker: new LocalDockerOperations(config.deliveryDockerCommand)
    }),
    ciProvider: config.ciProvider,
    sandbox,
    logger
  });
  const workflowService = new WorkflowService({
    workflows: workflowRepository,
    projects: projectRepository,
    agentWorkspaceRoot: config.agentWorkspaceRoot,
    executor: new RedactingWorkflowTaskExecutor(
      new RoutingWorkflowTaskExecutor(deliveryOrchestrator, verifiedExecutor)
    ),
    // 门禁/QA 有报错证据 → FAILURE_ROUTED(REPLAN)；耗尽 → FAIL；生产 DEPLOY 不绕过。
    failureRouter: createAutonomyFailureRouter(config.capabilityProfile),
    // `docs/235` §6.5：修复任务的回退类型（`backend-node` ⇒ BACKEND，零行为变化）。
    profile: config.capabilityProfile,
    sliceHooks: {
      onSliceWorkflowCreated: async (requirementId, sliceKey, workflowRunId) => {
        await planningService.handleSliceWorkflowCreated(requirementId, sliceKey, workflowRunId);
      },
      onSliceApprovalDecided: async (approval) => {
        await planningService.handleSliceApprovalDecided(approval);
      },
      onWorkflowTerminal: (workflowRunId, status) => {
        planningService.handleWorkflowTerminal(workflowRunId, status);
      }
    }
  });
  workflowServiceRef = workflowService;
  const agentRegistryService = new AgentRegistryService({ registry, agentRuns, artifacts });
  const evidenceService = new EvidenceService(new PgEvidenceRepository(pool));
  // incidentService wired after traceService (8-B evidence uses the same read ports)
  // 7-C：追踪树的数据来源（只读派生，全部来自既有仓储）。
  const traceService = new TraceService({
    findWorkflowById: (id) => workflowRepository.findWorkflowById(id),
    findTasks: (workflowRunId) => workflowRepository.findTasks(workflowRunId),
    findByTaskIds: (taskIds) => agentRuns.findByTaskIds(taskIds),
    findByAgentRunIds: (agentRunIds) => toolCalls.findByAgentRunIds(agentRunIds),
    findByWorkflowRunId: (workflowRunId) => deployments.findByWorkflowRunId(workflowRunId),
    findWorkflowStartedRequestId: (workflowRunId) =>
      workflowEvents.findWorkflowStartedRequestId(workflowRunId)
  });
  const incidentRepository = new PgIncidentRepository(pool);
  const incidentService = new IncidentService(
    incidentRepository,
    {
      collector: new IncidentEvidenceCollector({
        metricsAggregate: () => new PgMetricsRepository(pool).aggregate(),
        buildWorkflowTrace: (workflowRunId) => traceService.build(workflowRunId),
        listRecentDeployments: async (limit) => {
          const rows = await deployments.findMany();
          return rows.slice(0, limit).map((row) => ({
            id: row.id,
            status: row.status,
            environment: row.environment,
            version: row.version,
            createdAt: row.createdAt,
            workflowRunId: row.workflowRunId
          }));
        },
        listRecentWorkflowSummaries: async (limit) => {
          const rows = await workflowRepository.findMany();
          return rows.slice(0, limit).map((row) => ({
            id: row.id,
            status: row.status,
            updatedAt: row.updatedAt,
            ...(row.requirementName ? { name: row.requirementName } : {})
          }));
        }
      }),
      agent: new IncidentAgent()
    },
    {
      // 8-C/8-D: reuse planning + WorkflowService (no second runtime).
      // autoRemediateEnabled defaults false via INCIDENT_AUTO_REMEDIATE.
      openFixWorkflow: createPlanningFixWorkflowOpener({
        planning: planningRepository,
        workflows: workflowService
      }),
      autoRemediateEnabled: config.incidentAutoRemediate
    }
  );

  // ── MCP Console wiring (Phase 5.5-5) ─────────────────────────────────────
  // store 与 registry 已在任务执行器之前构造（功能清点 T2）；这里只装服务。
  const mcpService = new MCPConsoleService({
    store: mcpStore,
    registries: { stdio: mcpStdioRegistry, "streamable-http": mcpRemoteRegistry },
    projects: projectRepository
  });
  const mcpAppService = new MCPAppService({
    store: mcpStore,
    registries: { stdio: mcpStdioRegistry, "streamable-http": mcpRemoteRegistry }
  });

  const recovered = await agentRunService.recoverInterruptedRuns();
  if (recovered > 0) {
    logger.warn({ recovered }, "agent run recovery boundary marked interrupted runs");
  }
  const recoveredRequirements = await planningService.recoverInterruptedRequirements();
  if (recoveredRequirements > 0) {
    logger.warn(
      { recoveredRequirements },
      "planning recovery boundary marked interrupted requirements"
    );
  }
  const recoveredWorkflows = await workflowService.recover();
  if (recoveredWorkflows > 0) {
    logger.warn({ recoveredWorkflows }, "workflow recovery resumed persisted workflows");
  }
  const mcpInit = await mcpService.initialize();
  if (mcpInit.connected.length > 0 || mcpInit.failed.length > 0) {
    logger.info(
      { connected: mcpInit.connected, failed: mcpInit.failed },
      "mcp registry initialized"
    );
  }

  const app = createApp({
    logger,
    corsOrigin: config.corsOrigin,
    agentWorkspaceRoot: config.agentWorkspaceRoot,
    apiToken: config.apiToken,
    alertIngestToken: config.alertIngestToken,
    nodeEnv: config.nodeEnv,
    // N-39：把本进程的验证门口径暴露到 `/health`，供批次脚本起跑前断言。
    verificationGate: config.verificationGate,
    // `docs/235` §6.5：能力 profile 同因——批次脚本要能断言「这一批在什么能力面上跑」。
    capabilityProfile: config.capabilityProfile.id,
    projectRepository,
    agentRunService,
    planningService,
    documentService: new DocumentService({
      documents: requirementDocuments,
      planning: planningRepository
    }),
    workflowService,
    traceService,
    agentRegistryService,
    deploymentOrchestrator: deliveryOrchestrator,
    mcpService,
    mcpAppService,
    evidenceService,
    incidentService,
    autonomyRunsService: new AutonomyRunsService(workflowRepository),
    modelConfigService: modelConfig,
    metricsService: new MetricsService({ artifacts, metrics: new PgMetricsRepository(pool) }),
    checkDatabase: () => checkDatabase(pool),
    checkRedis: async () => {
      await redis.ping();
    }
  });

  const server = app.listen(config.port, config.host, () => {
    logger.info({ port: config.port, host: config.host }, "server started");
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, "server shutting down");
    server.close(async () => {
      await mcpService.shutdown();
      await redis.quit();
      await pool.end();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error: unknown) => {
  const logger = createLogger();
  const payload =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : error;
  logger.error(sanitizeLogData(payload), "server failed to start");
  process.exit(1);
});
