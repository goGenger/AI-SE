import {
  AgentLifecycleHooks,
  CodingAgent,
  ScriptedCodingLLMProvider,
  type LLMProvider
} from "@ai-se/agent-core";
import {
  PgAgentArtifactRepository,
  PgAgentRunStore,
  PgEvidenceRepository,
  PgToolCallStore,
  PgWorkflowEventStore,
  PgWorkflowRepository,
  ProjectRepository
} from "@ai-se/database";
import { createLogger, sanitizeLogData } from "@ai-se/observability";
import { DEFAULT_SANDBOX_MEMORY, DEFAULT_SANDBOX_PIDS_LIMIT, DockerSandbox } from "@ai-se/sandbox";
import {
  AgentArtifact,
  AgentRun,
  AgentRunContext,
  AgentRunDetailView,
  AgentRunRecoveryView,
  AgentRunStreamPayload,
  AgentRunSummary,
  ApiErrorBody,
  CreateAgentRunData,
  EvidenceRecord,
  JsonObject,
  WorkflowEvent
} from "@ai-se/shared";
import { ToolCallRecorder, ToolRuntime, createPhase1Tools } from "@ai-se/tool-runtime";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Logger } from "pino";
import { CancellationStore } from "./cancellationStore";
import { AppError } from "../http/errors";

const DEFAULT_TASK = "修复项目中的测试失败问题，并确保所有测试通过。";
const DEFAULT_MAX_ITERATIONS = 16;
const DEFAULT_TIMEOUT_MS = 180_000;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

interface ActiveRun {
  controller: AbortController;
  promise: Promise<void>;
}

export interface AgentRunServiceDependencies {
  agentRuns: Pick<
    PgAgentRunStore,
    "create" | "findMany" | "findById" | "update" | "markCancellationRequested" | "findContext"
  >;
  toolCalls: Pick<PgToolCallStore, "start" | "finish" | "findByAgentRunId">;
  workflowEvents: Pick<
    PgWorkflowEventStore,
    "create" | "findByAgentRunId" | "findTaskFailureEvents"
  >;
  projects: ProjectRepository;
  cancellationStore: CancellationStore;
  /** UX-03: optional context readers — absent in minimal constructions (degrade to empty). */
  artifacts?: Pick<PgAgentArtifactRepository, "findByAgentRunId">;
  evidence?: Pick<PgEvidenceRepository, "findMany">;
  tasks?: Pick<PgWorkflowRepository, "findTaskBySourceTaskId">;
  /** LLM provider for the bug-fix coding agent; defaults to the scripted stand-in. */
  llmProvider?: LLMProvider;
  logger?: Logger;
}

function workspaceRoot(): string {
  const candidates = [process.cwd(), path.resolve(process.cwd(), "../..")];
  const root = candidates.find((candidate) =>
    existsSync(path.join(candidate, "examples/coding-agent-test-project/package.json"))
  );

  if (!root) {
    throw new Error("Cannot locate AI-SE workspace root");
  }

  return root;
}

function terminal(status: AgentRun["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}

function sanitizeObject(value: JsonObject): JsonObject {
  const sanitized = sanitizeLogData(value);
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
    ? (sanitized as JsonObject)
    : {};
}

function apiError(code: string, message: string, details?: unknown): ApiErrorBody {
  return {
    code,
    message,
    details: sanitizeLogData(details)
  };
}

function durationFrom(run: AgentRun): number | undefined {
  if (!run.startedAt || !run.finishedAt) {
    return undefined;
  }

  return Date.parse(run.finishedAt) - Date.parse(run.startedAt);
}

async function prepareWorkspace(tempRoot: string): Promise<string> {
  const source = path.join(workspaceRoot(), "examples/coding-agent-test-project");
  const target = path.join(tempRoot, "coding-agent-test-project");
  await cp(source, target, { recursive: true });
  return target;
}

export class AgentRunService {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly events = new EventEmitter();
  private readonly logger: Logger;

  constructor(private readonly dependencies: AgentRunServiceDependencies) {
    this.logger = dependencies.logger ?? createLogger();
  }

  async create(input: CreateAgentRunData, requestId: string): Promise<AgentRun> {
    if (input.projectId) {
      const project = await this.dependencies.projects.findById(input.projectId);
      if (!project) {
        throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      }
    }

    const run = await this.dependencies.agentRuns.create({
      projectId: input.projectId,
      taskId: input.taskId ?? randomUUID(),
      input: sanitizeObject({
        task: input.task,
        runtime: "coding-agent",
        workspace: "examples/coding-agent-test-project"
      }),
      maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS
    });

    await this.recordEvent(run.id, "agent_run_created", {
      taskId: run.taskId,
      projectId: run.projectId,
      maxIterations: run.maxIterations
    });
    this.startBackgroundRun(run, input, requestId);
    return run;
  }

  async list(): Promise<AgentRunSummary[]> {
    return await this.dependencies.agentRuns.findMany();
  }

  /**
   * UX-03: detail = run + toolCall/event trace + readable context chain +
   * derived recovery state + existing artifacts/evidence. No new data models —
   * every field comes from the existing entities.
   */
  async getDetail(id: string): Promise<AgentRunDetailView | null> {
    const run = await this.dependencies.agentRuns.findById(id);
    if (!run) {
      return null;
    }

    const [toolCalls, events, context, artifacts, evidence] = await Promise.all([
      this.dependencies.toolCalls.findByAgentRunId(id),
      this.dependencies.workflowEvents.findByAgentRunId(id),
      this.dependencies.agentRuns.findContext(id),
      this.dependencies.artifacts
        ? this.dependencies.artifacts.findByAgentRunId(id)
        : Promise.resolve<AgentArtifact[]>([]),
      this.dependencies.evidence
        ? this.dependencies.evidence.findMany({ agentRunId: id })
        : Promise.resolve<EvidenceRecord[]>([])
    ]);

    return {
      run,
      toolCalls,
      events,
      context: context ?? {
        projectName: null,
        workflow: null,
        task: null,
        agentName: null,
        agentType: null,
        maxRetries: null
      },
      recovery: await this.buildRecovery(run, context),
      artifacts,
      evidence
    };
  }

  /**
   * UX-03: recovery state derived from the task the run executed and the
   * engine's existing failure events (FAILURE_ROUTED / FAILURE_HUMAN_REQUIRED)
   * plus the diagnostic task spawned from the failed task, when any. Returns
   * null when nothing recovered (standalone runs, or no recovery happened).
   */
  private async buildRecovery(
    run: AgentRun,
    context: AgentRunContext | null
  ): Promise<AgentRunRecoveryView | null> {
    const workflowId = context?.workflow?.id;
    if (!workflowId) {
      return null;
    }

    const [failureEvents, recoveryTask] = await Promise.all([
      this.dependencies.workflowEvents.findTaskFailureEvents(workflowId, run.taskId),
      this.dependencies.tasks
        ? this.dependencies.tasks.findTaskBySourceTaskId(run.taskId)
        : Promise.resolve(null)
    ]);

    const routed = failureEvents.find((event) => event.eventType === "FAILURE_ROUTED");
    const human = failureEvents.find((event) => event.eventType === "FAILURE_HUMAN_REQUIRED");
    if (!routed && !human && !recoveryTask) {
      return null;
    }

    const payload = (routed?.payload ?? human?.payload ?? {}) as JsonObject;
    return {
      taskRetryCount: context?.task?.retryCount ?? 0,
      maxRetries: context?.maxRetries ?? null,
      strategy: typeof payload.strategy === "string" ? payload.strategy : null,
      reason: typeof payload.reason === "string" ? payload.reason : null,
      humanRequired: Boolean(human),
      stalled: payload.stalled === true,
      recoveryTask: recoveryTask
        ? {
            id: recoveryTask.id,
            taskKey: recoveryTask.taskKey,
            title: recoveryTask.title,
            type: recoveryTask.type
          }
        : null
    };
  }

  async getEvents(id: string): Promise<WorkflowEvent[] | null> {
    const run = await this.dependencies.agentRuns.findById(id);
    if (!run) {
      return null;
    }

    return await this.dependencies.workflowEvents.findByAgentRunId(id);
  }

  async cancel(id: string): Promise<AgentRun | null> {
    const existing = await this.dependencies.agentRuns.findById(id);
    if (!existing) {
      return null;
    }

    if (terminal(existing.status)) {
      return existing;
    }

    await this.dependencies.cancellationStore.requestCancel(id);
    const run = await this.dependencies.agentRuns.markCancellationRequested(id);
    await this.recordEvent(id, "agent_run_cancel_requested", { status: run?.status ?? "unknown" });

    const activeRun = this.activeRuns.get(id);
    if (activeRun) {
      activeRun.controller.abort();
      return run;
    }

    return await this.dependencies.agentRuns.update(id, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      error: apiError("CANCELLED_ERROR", "Agent run cancelled before active execution")
    });
  }

  async snapshot(id: string): Promise<AgentRunStreamPayload | null> {
    const detail = await this.getDetail(id);
    if (!detail) {
      return null;
    }

    return detail;
  }

  onRunEvent(id: string, listener: () => void): () => void {
    this.events.on(id, listener);
    return () => this.events.off(id, listener);
  }

  notifyRunChanged(id: string): void {
    this.events.emit(id);
  }

  async waitForTerminalRun(id: string, timeoutMs: number): Promise<AgentRunDetailView | null> {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const detail = await this.getDetail(id);
      if (detail && terminal(detail.run.status)) {
        return detail;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return await this.getDetail(id);
  }

  async recoverInterruptedRuns(): Promise<number> {
    const runs = await this.dependencies.agentRuns.findMany();
    const interrupted = runs.filter((run) =>
      ["created", "running", "cancelling"].includes(run.status)
    );

    for (const run of interrupted) {
      await this.dependencies.agentRuns.update(run.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: apiError(
          "UNKNOWN_ERROR",
          "Agent run was interrupted before this server process started"
        )
      });
      await this.recordEvent(run.id, "agent_run_recovered", {
        previousStatus: run.status,
        status: "failed"
      });
    }

    return interrupted.length;
  }

  private startBackgroundRun(run: AgentRun, input: CreateAgentRunData, requestId: string): void {
    const controller = new AbortController();
    const promise = this.executeRun(run, input, requestId, controller).catch((error: unknown) => {
      this.logger.error(
        sanitizeLogData({ agentRunId: run.id, error }),
        "agent run background execution failed"
      );
    });

    this.activeRuns.set(run.id, { controller, promise });
  }

  private async executeRun(
    run: AgentRun,
    input: CreateAgentRunData,
    requestId: string,
    controller: AbortController
  ): Promise<void> {
    const logger = this.logger.child({ requestId, agentRunId: run.id });
    let tempRoot = "";
    const cancellationMonitor = setInterval(() => {
      this.dependencies.cancellationStore
        .isCancellationRequested(run.id)
        .then((cancelled) => {
          if (cancelled) {
            controller.abort();
          }
        })
        .catch((error: unknown) => {
          logger.warn(sanitizeLogData({ error }), "failed to check cancellation flag");
        });
    }, 500);

    try {
      if (await this.dependencies.cancellationStore.isCancellationRequested(run.id)) {
        controller.abort();
      }

      tempRoot = await mkdtemp(path.join(tmpdir(), "ai-se-agent-run-"));
      const workspacePath = await prepareWorkspace(tempRoot);
      const sandbox = new DockerSandbox({
        allowedWorkspaceRoot: tempRoot,
        logger,
        limits: {
          timeoutMs: 45_000,
          // `docs/236` 第 4 步：这条运行链（单任务 agent run）不是夹具/项目交付，保持无网。
          // 出网只在配置层按 capability profile 打开的那条链上（`apps/server/src/index.ts`）。
          network: "none",
          cpus: 1,
          memory: DEFAULT_SANDBOX_MEMORY,
          pidsLimit: DEFAULT_SANDBOX_PIDS_LIMIT
        }
      });
      const toolRuntime = new ToolRuntime({ tools: createPhase1Tools() });
      const recorder = this.createToolCallRecorder();

      const initGit = await toolRuntime.execute(
        "run_command",
        {
          command:
            "git init && git config user.email phase2@example.local && git config user.name 'AI-SE Phase2' && git add . && git commit -m initial",
          timeoutMs: 30_000
        },
        {
          requestId,
          projectId: run.projectId,
          taskId: run.taskId,
          agentRunId: run.id,
          toolCallId: randomUUID(),
          iteration: 0,
          actor: "system",
          workspacePath,
          sandbox,
          logger,
          timeoutMs: 30_000,
          signal: controller.signal,
          toolCallRecorder: recorder
        }
      );

      if (!initGit.success) {
        const cancelled =
          controller.signal.aborted ||
          (await this.dependencies.cancellationStore.isCancellationRequested(run.id));
        await this.failBeforeAgent(
          run,
          cancelled
            ? apiError("CANCELLED_ERROR", "Agent run cancelled")
            : (initGit.error ?? apiError("SANDBOX_ERROR", "Setup failed"))
        );
        return;
      }

      const agent = new CodingAgent({
        llmProvider: this.dependencies.llmProvider ?? new ScriptedCodingLLMProvider(),
        toolRuntime,
        defaultMaxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        defaultTimeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        defaultMaxRetries: 1,
        lifecycle: this.createLifecycleHooks(),
        toolCallRecorder: recorder
      });

      await agent.run(
        input.task || DEFAULT_TASK,
        {
          requestId,
          projectId: run.projectId,
          taskId: run.taskId,
          agentRunId: run.id,
          actor: "user",
          workspacePath,
          sandbox,
          logger
        },
        {
          maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: controller.signal
        }
      );
    } finally {
      clearInterval(cancellationMonitor);
      this.activeRuns.delete(run.id);
      await this.dependencies.cancellationStore.clear(run.id);
      if (tempRoot) {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }
  }

  private createLifecycleHooks(): AgentLifecycleHooks {
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
      onRetry: async (record) => {
        await this.dependencies.agentRuns.update(record.agentRunId, {
          retryCount: record.retryCount
        });
      },
      onRunFinished: async (record) => {
        await this.dependencies.agentRuns.update(record.agentRunId, {
          status: record.status,
          output: sanitizeObject(record.output),
          currentIteration: record.currentIteration,
          retryCount: record.retryCount,
          error: record.error,
          tokenUsage: record.tokenUsage,
          estimatedCost: record.estimatedCost,
          finishedAt: record.finishedAt
        });
      },
      onEvent: async (record) => {
        await this.recordEvent(record.agentRunId, record.eventType, record.payload);
      }
    };
  }

  private createToolCallRecorder(): ToolCallRecorder {
    return {
      recordToolCallStarted: async (record) => {
        await this.dependencies.toolCalls.start({
          agentRunId: record.agentRunId,
          iteration: record.iteration,
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          input: sanitizeObject(record.input),
          startedAt: record.startedAt
        });
      },
      recordToolCallFinished: async (record) => {
        await this.dependencies.toolCalls.finish({
          agentRunId: record.agentRunId,
          toolCallId: record.toolCallId,
          output: record.output ? sanitizeObject(record.output) : undefined,
          status: record.status,
          error: record.error,
          duration: record.duration,
          finishedAt: record.finishedAt
        });
      }
    };
  }

  private async recordEvent(
    agentRunId: string,
    eventType: string,
    payload: JsonObject
  ): Promise<void> {
    await this.dependencies.workflowEvents.create({
      agentRunId,
      eventType,
      payload: sanitizeObject(payload)
    });
    this.events.emit(agentRunId);
  }

  private async failBeforeAgent(run: AgentRun, error: ApiErrorBody): Promise<void> {
    const normalized = apiError(error.code, error.message, error.details);
    const status =
      normalized.code === "CANCELLED_ERROR"
        ? "cancelled"
        : normalized.code === "TIMEOUT_ERROR"
          ? "timed_out"
          : "failed";
    await this.dependencies.agentRuns.update(run.id, {
      status,
      error: normalized,
      output: { finalResult: "", status, toolCallCount: 1 },
      finishedAt: new Date().toISOString()
    });
    await this.recordEvent(run.id, "agent_run_finished", {
      status,
      errorCode: normalized.code
    });
  }
}

export function runDuration(run: AgentRun): number | undefined {
  return durationFrom(run);
}
