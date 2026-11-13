import { ProjectRepository } from "@ai-se/database";
import cors from "cors";
import express, { Express } from "express";
import { Logger } from "pino";
import { AppError, asyncHandler, errorHandler, notFoundHandler } from "./http/errors";
import { apiTokenGuard } from "./http/apiToken";
import { requestLogger } from "./http/requestLogger";
import { sendSuccess } from "./http/response";
import { createAgentRunsRouter } from "./routes/agentRuns";
import { createAgentsRouter } from "./routes/agents";
import { createDeploymentsRouter } from "./routes/deployments";
import { createDocumentRouter } from "./routes/documents";
import { createEvidenceRouter } from "./routes/evidence";
import { createAlertIngestRouter, createIncidentsRouter } from "./routes/incidents";
import { createMCPRouter } from "./routes/mcp";
import { createMetricsRouter } from "./routes/metrics";
import { createModelConfigRouter } from "./routes/modelConfig";
import { createPlanningRouter } from "./routes/planning";
import { createProjectRouter } from "./routes/projects";
import { createAutonomyRunsRouter } from "./routes/autonomyRuns";
import { createWorkflowsRouter } from "./routes/workflows";
import { AutonomyRunsService } from "./services/autonomyRunsService";
import { AgentRunService } from "./services/agentRunService";
import { AgentRegistryService } from "./services/agentRegistryService";
import { DeploymentOrchestrator } from "./services/deploymentOrchestrator";
import { DocumentService } from "./services/documentService";
import { EvidenceService } from "./services/evidenceService";
import { IncidentService } from "./services/incidentService";
import { MCPAppService } from "./services/mcpAppService";
import { MCPConsoleService } from "./services/mcpService";
import { MetricsService } from "./services/metricsService";
import { ModelConfigService } from "./services/modelConfigService";
import { PlanningService } from "./services/planningService";
import { TraceService } from "./services/traceService";
import { WorkflowService } from "./services/workflowService";

interface AppDependencies {
  logger: Logger;
  projectRepository: ProjectRepository;
  agentRunService: AgentRunService;
  /**
   * N-39：本进程的**全局**验证门模式（L1/L2 策略仍会强制 enforce）。
   * 对外暴露在 `/health` 上，批次脚本可在起跑前断言口径——此前口径只由
   * 「平台怎么启动」决定，脚本只查 dist 时间，两批读数因此不可比。
   */
  verificationGate?: "off" | "observe" | "enforce";
  /**
   * `docs/235` §6.5：本进程的能力 profile id。与 `verificationGate` 同一用途——**对外暴露
   * 口径**，批次脚本在起跑前断言「这一批到底在什么能力面上跑」，跑完不必再猜。
   */
  capabilityProfile?: string;
  planningService?: PlanningService;
  /** D1（`docs/229`）：需求文档入口（PRD 文件、技术需求文档）。 */
  documentService?: DocumentService;
  workflowService?: WorkflowService;
  /** 7-C：工作流端到端追踪（只读派生）。 */
  traceService?: TraceService;
  agentRegistryService?: AgentRegistryService;
  deploymentOrchestrator?: DeploymentOrchestrator;
  mcpService?: MCPConsoleService;
  mcpAppService?: MCPAppService;
  evidenceService?: EvidenceService;
  incidentService?: IncidentService;
  autonomyRunsService?: AutonomyRunsService;
  modelConfigService?: ModelConfigService;
  metricsService?: MetricsService;
  checkDatabase: () => Promise<void>;
  checkRedis: () => Promise<void>;
  corsOrigin: string;
  /** D-3（T8-c）：部署面 API 最小 Token 鉴权；未设置 = 关闭（默认）。 */
  apiToken?: string;
  /** Phase 8-A：告警入站独立 shared secret（可选）。 */
  alertIngestToken?: string;
  /** 用于告警入站 production 裸奔拒绝。 */
  nodeEnv?: string;
  /** Local workspace allowlist root (AGENT_WORKSPACE_ROOT). */
  agentWorkspaceRoot?: string;
}

export function createApp({
  logger,
  projectRepository,
  agentRunService,
  planningService,
  documentService,
  agentWorkspaceRoot = process.cwd(),
  workflowService,
  traceService,
  agentRegistryService,
  deploymentOrchestrator,
  mcpService,
  mcpAppService,
  evidenceService,
  incidentService,
  autonomyRunsService,
  modelConfigService,
  metricsService,
  checkDatabase,
  checkRedis,
  corsOrigin,
  apiToken,
  alertIngestToken,
  nodeEnv = "development",
  verificationGate,
  capabilityProfile
}: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: "1mb" }));
  app.use(requestLogger(logger));

  app.get("/health", (_req, res) => {
    // N-39：把**运行时**的验证门口径暴露出来。L1/L2 策略仍会强制 enforce，
    // 所以这里是「全局默认」，不是「这一批实际用的是什么」的全部答案。
    sendSuccess(res, {
      status: "ok",
      ...(verificationGate !== undefined ? { verificationGate } : {}),
      ...(capabilityProfile !== undefined ? { capabilityProfile } : {})
    });
  });

  app.get(
    "/ready",
    asyncHandler(async (_req, res) => {
      const [database, redis] = await Promise.allSettled([checkDatabase(), checkRedis()]);
      const checks = {
        database: database.status === "fulfilled" ? "ok" : "error",
        redis: redis.status === "fulfilled" ? "ok" : "error"
      };

      if (checks.database !== "ok" || checks.redis !== "ok") {
        throw new AppError(
          503,
          "DEPENDENCY_UNAVAILABLE",
          "Service dependencies unavailable",
          checks
        );
      }

      sendSuccess(res, { status: "ready", checks });
    })
  );

  // Phase 8-A：告警入站使用独立鉴权，挂在全局 API_TOKEN 之前，
  // 这样配置了 ALERT_INGEST_TOKEN 时 webhook 不必再带 API_TOKEN。
  if (incidentService) {
    app.use(
      "/api",
      createAlertIngestRouter(incidentService, {
        alertIngestToken,
        apiToken,
        nodeEnv
      })
    );
  }

  // D-3（T8-c）：可选 API Token（默认关）。仅覆盖 /api/*；/health 与 /ready 豁免。
  app.use("/api", apiTokenGuard(apiToken));

  app.use(
    "/api/projects",
    createProjectRouter(projectRepository, { agentWorkspaceRoot })
  );
  if (planningService) {
    app.use("/api", createPlanningRouter(planningService));
  }
  if (documentService) {
    app.use("/api", createDocumentRouter(documentService));
  }
  if (workflowService) {
    app.use("/api", createWorkflowsRouter(workflowService, traceService));
  }
  if (agentRegistryService) {
    app.use("/api", createAgentsRouter(agentRegistryService));
  }
  if (deploymentOrchestrator) {
    app.use("/api", createDeploymentsRouter(deploymentOrchestrator));
  }
  if (mcpService) {
    app.use("/api/mcp", createMCPRouter(mcpService, mcpAppService));
  }
  if (evidenceService) {
    app.use("/api", createEvidenceRouter(evidenceService));
  }
  if (incidentService) {
    app.use("/api", createIncidentsRouter(incidentService));
  }
  if (autonomyRunsService) {
    app.use("/api", createAutonomyRunsRouter(autonomyRunsService));
  }
  if (modelConfigService) {
    app.use("/api", createModelConfigRouter(modelConfigService));
  }
  if (metricsService) {
    app.use("/api", createMetricsRouter(metricsService));
  }
  app.use("/api/agent-runs", createAgentRunsRouter({ service: agentRunService }));
  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
