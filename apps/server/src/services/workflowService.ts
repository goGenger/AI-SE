import { PgWorkflowRepository, ProjectRepository } from "@ai-se/database";
import {
  Approval,
  ApprovalDecisionData,
  CreateWorkflowData,
  DEFAULT_WORKFLOW_POLICY,
  enforceSerialWorkflowPolicy,
  Task,
  TaskDependencyView,
  UpdateWorkflowPolicyData,
  WorkflowDetailView,
  WorkflowEvent,
  WorkflowEventPage,
  WorkflowPolicy,
  WorkflowRun,
  WorkflowStreamPayload,
  WorkflowSummary,
  type CapabilityProfile
} from "@ai-se/shared";
import { WorkflowEngine, WorkflowTaskExecutor, type FailureRouter } from "@ai-se/workflow-engine";
import { EventEmitter } from "node:events";
import { AppError } from "../http/errors";
import {
  ensureWorkspacePathUnderRoot,
  resolveProjectWorkspacePath
} from "./projectWorkspacePath";

/** Workspace path resolution lives in projectWorkspacePath.ts (project-owned + workflow override). */

/** T6：把预算 PATCH 输入合并进现有 policy（`null` = 清除；缺省 = 保持不变）。 */
function applyWorkflowPolicyPatch(
  policy: WorkflowPolicy,
  input: UpdateWorkflowPolicyData
): WorkflowPolicy {
  const next: WorkflowPolicy = { ...policy };
  for (const key of ["maxCostUsd", "maxTokens", "maxWallClockMs"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export class WorkflowService {
  private readonly events = new EventEmitter();
  private readonly engine: WorkflowEngine;

  constructor(
    private readonly dependencies: {
      workflows: PgWorkflowRepository;
      projects: ProjectRepository;
      /** AGENT_WORKSPACE_ROOT — used to inherit / validate workspace paths. */
      agentWorkspaceRoot?: string;
      executor: WorkflowTaskExecutor;
      /** Phase 5.7-5: optional failure routing hook (recovery wiring). */
      failureRouter?: FailureRouter;
      /** `docs/235` §6.5：能力 profile（组合根注入；缺省 `backend-node` ⇒ 零行为变化）。 */
      profile?: CapabilityProfile;
      /** N2：切片编排钩子（索引层注入；缺省=全关，保持旧行为零影响）。 */
      sliceHooks?: {
        onSliceWorkflowCreated?: (
          requirementId: string,
          sliceKey: string,
          workflowRunId: string
        ) => Promise<void>;
        onSliceApprovalDecided?: (approval: Approval) => Promise<void>;
        onWorkflowTerminal?: (
          workflowRunId: string,
          status: "SUCCESS" | "FAILED" | "CANCELLED"
        ) => void;
      };
    }
  ) {
    this.engine = new WorkflowEngine({
      store: dependencies.workflows,
      executor: dependencies.executor,
      onChanged: (id) => this.events.emit(id),
      ...(dependencies.failureRouter ? { failureRouter: dependencies.failureRouter } : {}),
      onTerminal: (id, status) => this.dependencies.sliceHooks?.onWorkflowTerminal?.(id, status),
      ...(dependencies.profile ? { profile: dependencies.profile } : {})
    });
  }

  async create(input: CreateWorkflowData): Promise<WorkflowRun> {
    const project = await this.dependencies.projects.findById(input.projectId);
    if (!project) {
      throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    }

    const root = this.dependencies.agentWorkspaceRoot ?? process.cwd();
    let workspacePath = input.workspacePath?.trim() || undefined;
    if (workspacePath) {
      // Explicit override: must stay under AGENT_WORKSPACE_ROOT (mkdir if missing).
      workspacePath = await ensureWorkspacePathUnderRoot(workspacePath, root);
    } else if (project.workspacePath) {
      workspacePath = await ensureWorkspacePathUnderRoot(project.workspacePath, root);
    } else {
      // Legacy project with null path: allocate + persist so we never fall back to cwd.
      workspacePath = await resolveProjectWorkspacePath({
        projectName: project.name,
        projectId: project.id,
        agentWorkspaceRoot: root
      });
      await this.dependencies.projects.updateWorkspacePath(project.id, workspacePath);
    }

    try {
      // F1-7（FX-23）：T3 未做前不开放并行——创建期钳制 maxConcurrency 为 1 并留痕。
      const enforced = enforceSerialWorkflowPolicy(input.policy ?? DEFAULT_WORKFLOW_POLICY);
      const workflow = await this.dependencies.workflows.create({
        ...input,
        workspacePath,
        policy: enforced.policy
      });
      await this.dependencies.workflows.createEvent({
        workflowRunId: workflow.id,
        eventType: "WORKFLOW_CREATED",
        payload: {
          requirementId: workflow.requirementId,
          planningVersion: workflow.planningVersion,
          ...(input.sliceKey ? { sliceKey: input.sliceKey } : {})
        }
      });
      if (enforced.clamped) {
        await this.dependencies.workflows.createEvent({
          workflowRunId: workflow.id,
          eventType: "WORKFLOW_MAX_CONCURRENCY_CLAMPED",
          payload: {
            requestedMaxConcurrency: enforced.requestedMaxConcurrency,
            appliedMaxConcurrency: 1,
            reason: "serial-only until T3 (parallel task execution)"
          }
        });
      }
      if (input.sliceKey) {
        await this.dependencies.sliceHooks?.onSliceWorkflowCreated?.(
          workflow.requirementId,
          input.sliceKey,
          workflow.id
        );
      }
      this.events.emit(workflow.id);
      return workflow;
    } catch (error) {
      throw new AppError(
        400,
        "WORKFLOW_CREATE_ERROR",
        error instanceof Error ? error.message : "Workflow cannot be created"
      );
    }
  }

  async list(): Promise<WorkflowSummary[]> {
    return await this.dependencies.workflows.findMany();
  }

  async get(id: string): Promise<WorkflowRun | null> {
    return await this.dependencies.workflows.findWorkflowById(id);
  }

  async getDetail(id: string): Promise<WorkflowDetailView | null> {
    const workflow = await this.get(id);
    if (!workflow) return null;
    const [tasks, dependencies, approvals, events] = await Promise.all([
      this.getTasks(id),
      this.getGraph(id).then((graph) => graph.dependencies),
      this.getApprovals(id),
      this.getEvents(id)
    ]);
    return { workflow, tasks, dependencies, approvals, events };
  }

  /** 7-A：`options.requestId` 是触发本次启动的 HTTP 请求 ID，随 WORKFLOW_STARTED 落库。 */
  async start(id: string, options?: { requestId?: string }): Promise<WorkflowRun> {
    return await this.runTransition(() => this.engine.start(id, options));
  }

  async pause(id: string): Promise<WorkflowRun> {
    return await this.runTransition(() => this.engine.pause(id));
  }

  async resume(id: string): Promise<WorkflowRun> {
    return await this.runTransition(() => this.engine.resume(id));
  }

  /**
   * T6：调整工作流级预算（PATCH /api/workflows/:id/policy）。
   * 仅 RUNNING/PAUSED 可改；`null` = 清除该上限，缺省 = 保持不变；
   * 调整后走既有 resume 恢复（超限暂停的工作流在放宽后继续）。
   */
  async updatePolicy(id: string, input: UpdateWorkflowPolicyData): Promise<WorkflowRun> {
    const workflow = await this.dependencies.workflows.findWorkflowById(id);
    if (!workflow) throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
    if (workflow.status !== "RUNNING" && workflow.status !== "PAUSED") {
      throw new AppError(
        409,
        "WORKFLOW_NOT_ADJUSTABLE",
        `仅 RUNNING/PAUSED 的工作流可调整预算（当前 ${workflow.status}）`
      );
    }
    const updated = await this.dependencies.workflows.updateWorkflowPolicy(
      id,
      applyWorkflowPolicyPatch(workflow.policy, input)
    );
    if (!updated) {
      throw new AppError(409, "WORKFLOW_NOT_ADJUSTABLE", "Workflow state changed before update");
    }
    return updated;
  }

  async cancel(id: string): Promise<WorkflowRun> {
    return await this.runTransition(() => this.engine.cancel(id));
  }

  /** 人工重试失败工作流(Retry Failed Workflow):重排未解决失败任务并继续执行。 */
  async retry(id: string): Promise<WorkflowRun> {
    return await this.runTransition(() => this.engine.retry(id));
  }

  async getTasks(id: string): Promise<Task[]> {
    return await this.dependencies.workflows.findTasks(id);
  }

  async getEvents(id: string): Promise<WorkflowEvent[]> {
    return await this.dependencies.workflows.findEvents(id);
  }

  /**
   * UX-02: newest-first paginated timeline. Ordering lives in the query
   * (`findEventsPage`); this method only shapes the page envelope.
   */
  async getEventsPage(id: string, page: number, pageSize: number): Promise<WorkflowEventPage> {
    const offset = (page - 1) * pageSize;
    const { items, total } = await this.dependencies.workflows.findEventsPage(id, pageSize, offset);
    return {
      items,
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize)
    };
  }

  async getGraph(id: string): Promise<{ tasks: Task[]; dependencies: TaskDependencyView[] }> {
    const [tasks, dependencies] = await Promise.all([
      this.dependencies.workflows.findTasks(id),
      this.dependencies.workflows.findDependencies(id)
    ]);
    return { tasks, dependencies };
  }

  async getApprovals(id: string): Promise<Approval[]> {
    return await this.dependencies.workflows.findApprovals(id);
  }

  async approve(id: string, input: ApprovalDecisionData): Promise<void> {
    if (await this.isRequirementApproval(id)) {
      await this.runTransition(async () => {
        const decided = await this.dependencies.workflows.decideApproval(
          id,
          "APPROVED",
          input.comment
        );
        if (!decided) throw new Error("Approval is not pending");
        await this.dependencies.sliceHooks?.onSliceApprovalDecided?.(decided);
      });
      return;
    }
    await this.runTransition(() => this.engine.approve(id, input.comment));
  }

  async reject(id: string, input: ApprovalDecisionData): Promise<void> {
    if (await this.isRequirementApproval(id)) {
      await this.runTransition(async () => {
        const decided = await this.dependencies.workflows.decideApproval(
          id,
          "REJECTED",
          input.comment
        );
        if (!decided) throw new Error("Approval is not pending");
        await this.dependencies.sliceHooks?.onSliceApprovalDecided?.(decided);
      });
      return;
    }
    await this.runTransition(() => this.engine.reject(id, input.comment));
  }

  /** N2：需求级审批（关口 1）走 planning 侧决策通道，任务级仍走既有引擎通道。 */
  private async isRequirementApproval(id: string): Promise<boolean> {
    const approval = await this.dependencies.workflows.findApprovalById(id);
    return Boolean(approval?.requirementId);
  }

  async snapshot(id: string): Promise<WorkflowStreamPayload | null> {
    return await this.getDetail(id);
  }

  onWorkflowEvent(id: string, listener: () => void): () => void {
    this.events.on(id, listener);
    return () => this.events.off(id, listener);
  }

  async recover(): Promise<number> {
    return await this.engine.recover();
  }

  async waitForTerminal(id: string, timeoutMs: number): Promise<WorkflowDetailView | null> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const detail = await this.getDetail(id);
      const terminalEvent =
        detail?.workflow.status === "SUCCESS"
          ? "WORKFLOW_COMPLETED"
          : detail?.workflow.status === "FAILED"
            ? "WORKFLOW_FAILED"
            : detail?.workflow.status === "CANCELLED"
              ? "WORKFLOW_CANCELLED"
              : undefined;
      if (
        detail &&
        terminalEvent &&
        detail.events.some((event) => event.eventType === terminalEvent)
      ) {
        return detail;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await this.getDetail(id);
  }

  private async runTransition<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Workflow transition failed";
      if (message === "Workflow not found") throw new AppError(404, "WORKFLOW_NOT_FOUND", message);
      if (message === "Approval is not pending")
        throw new AppError(409, "APPROVAL_NOT_PENDING", message);
      if (message === "Workflow is not failed")
        throw new AppError(409, "INVALID_WORKFLOW_TRANSITION", "当前工作流不是失败状态，无法重试");
      if (message === "No retryable tasks")
        throw new AppError(409, "NO_RETRYABLE_TASKS", "没有可重试的失败任务");
      if (
        message === "Workflow state changed before retry" ||
        message === "Task state changed before retry"
      )
        throw new AppError(409, "INVALID_WORKFLOW_TRANSITION", "工作流状态已变化，本次重试未执行");
      if (message.startsWith("Retry blocked by rejected approval"))
        throw new AppError(
          409,
          "RETRY_BLOCKED_BY_APPROVAL",
          `以下任务的审批已被拒绝，无法重试：${message.split(":").slice(1).join(":").trim()}；请新建工作流或重新发起审批`
        );
      throw new AppError(409, "INVALID_WORKFLOW_TRANSITION", message);
    }
  }
}
