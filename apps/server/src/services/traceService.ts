import { redactCredentialShapedText } from "@ai-se/observability";
import {
  AgentRun,
  Deployment,
  JsonObject,
  Task,
  ToolCallAudit,
  TraceNode,
  WorkflowRun,
  WorkflowTraceCounts,
  WorkflowTraceView
} from "@ai-se/shared";

/**
 * 7-C：端到端追踪视图（只读派生）。
 *
 * 给定 `workflowRunId`，返回 `Workflow → Task → AgentRun → ToolCall` 的树；部署记录挂在
 * 产生它的任务下（`deployments.task_id`）。数据全部来自既有事实表，**不引入 span 概念、
 * 不新增埋点**（`docs/147` §3 7-C）。任务节点按执行顺序（`started_at`）排列，未开始的排最后；
 * 每层子节点按各自表的写入顺序排列。
 *
 * 红线（`docs/147` §7）：
 * - 只读——不改任务结果、状态机与审批语义；本服务不写任何表。
 * - 节点 `detail` 只收白名单标量；**不含工具输入 / 输出**，字符串一律过
 *   `redactCredentialShapedText`，明文凭据不进追踪树。
 * - 关联 ID（requestId）属附加信息：读不到（含查询异常）不影响树的其余部分。
 */

/** 追踪树的数据来源（窄接口；组合根用既有仓储接上）。 */
export interface TraceSources {
  findWorkflowById(id: string): Promise<WorkflowRun | null>;
  findTasks(workflowRunId: string): Promise<Task[]>;
  findByTaskIds(taskIds: string[]): Promise<AgentRun[]>;
  findByAgentRunIds(agentRunIds: string[]): Promise<ToolCallAudit[]>;
  findByWorkflowRunId(workflowRunId: string): Promise<Deployment[]>;
  findWorkflowStartedRequestId(workflowRunId: string): Promise<string | undefined>;
}

function isoDiff(startedAt?: string, finishedAt?: string): number | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return end - start;
}

/** 只收标量；字符串过凭据形状脱敏，其余类型直接丢弃（不递归、不搬运 JSON 载荷）。 */
function detailOf(entries: Record<string, unknown>): JsonObject {
  const detail: JsonObject = {};
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === "string") {
      if (value.length > 0) detail[key] = redactCredentialShapedText(value);
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) detail[key] = value;
    } else if (typeof value === "boolean") {
      detail[key] = value;
    }
  }
  return detail;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const bucket = grouped.get(value);
    if (bucket) bucket.push(item);
    else grouped.set(value, [item]);
  }
  return grouped;
}

/**
 * 任务节点按**执行顺序**排（`started_at` 升序）；尚未开始的任务保持仓储顺序并排在最后。
 * 仓储的 `created_at` 对同一事务里克隆出来的运行时任务是同一个值，直接用它排会退化成
 * 按 task_key 字母序（交付链会读成 CI → E2E → PRODUCTION → STAGING）。
 */
function orderTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    if (left.startedAt && right.startedAt) return left.startedAt.localeCompare(right.startedAt);
    if (left.startedAt) return -1;
    if (right.startedAt) return 1;
    return 0;
  });
}

function tokenCounts(tokenUsage: JsonObject | undefined): {
  inputTokens?: number;
  outputTokens?: number;
} {
  const input = tokenUsage?.input_tokens;
  const output = tokenUsage?.output_tokens;
  return {
    ...(typeof input === "number" ? { inputTokens: input } : {}),
    ...(typeof output === "number" ? { outputTokens: output } : {})
  };
}

/** Agent 的可读名：专业 Agent 名 > 运行时名 > "agent"。 */
function agentLabel(run: AgentRun): string {
  const name = run.input.agentName;
  if (typeof name === "string" && name.length > 0) return name;
  const runtime = run.input.runtime;
  return typeof runtime === "string" && runtime.length > 0 ? runtime : "agent";
}

function node(
  input: {
    kind: TraceNode["kind"];
    id: string;
    label: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    detail: JsonObject;
  },
  children: TraceNode[]
): TraceNode {
  return {
    kind: input.kind,
    id: input.id,
    // 标签也过一遍：它们是库里来的字符串（agentName / taskKey / environment），同样是出境文本。
    label: redactCredentialShapedText(input.label),
    status: input.status,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
    ...(typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
      ? { durationMs: input.durationMs }
      : {}),
    detail: input.detail,
    children
  };
}

function toolCallNode(call: ToolCallAudit): TraceNode {
  return node(
    {
      kind: "toolCall",
      id: call.id,
      label: call.toolName,
      status: call.status,
      startedAt: call.startedAt,
      finishedAt: call.finishedAt,
      durationMs: isoDiff(call.startedAt, call.finishedAt) ?? call.duration,
      detail: detailOf({
        toolCallId: call.toolCallId,
        iteration: call.iteration,
        errorCode: call.error?.code,
        errorMessage: call.error?.message
      })
    },
    []
  );
}

function agentRunNode(run: AgentRun, children: TraceNode[]): TraceNode {
  return node(
    {
      kind: "agentRun",
      id: run.id,
      label: agentLabel(run),
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: isoDiff(run.startedAt, run.finishedAt),
      detail: detailOf({
        agentName: run.input.agentName,
        agentType: run.input.agentType,
        runtime: run.input.runtime,
        currentIteration: run.currentIteration,
        maxIterations: run.maxIterations,
        retryCount: run.retryCount,
        ...tokenCounts(run.tokenUsage),
        estimatedCostUsd: run.estimatedCost,
        errorCode: run.error?.code,
        errorMessage: run.error?.message
      })
    },
    children
  );
}

function deploymentNode(item: Deployment): TraceNode {
  return node(
    {
      kind: "deployment",
      id: item.id,
      label: `${item.environment} ${item.operation}`,
      status: item.status,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      durationMs: isoDiff(item.startedAt, item.finishedAt),
      detail: detailOf({
        environment: item.environment,
        operation: item.operation,
        version: item.version,
        image: item.image,
        gitCommit: item.gitCommit,
        ciRunId: item.ciRunId,
        agentRunId: item.agentRunId,
        rollbackVersion: item.rollbackVersion,
        rollbackReason: item.rollbackReason,
        errorCode: item.error?.code,
        errorMessage: item.error?.message
      })
    },
    []
  );
}

function taskNode(task: Task, children: TraceNode[]): TraceNode {
  return node(
    {
      kind: "task",
      id: task.id,
      label: task.taskKey,
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      durationMs: isoDiff(task.startedAt, task.finishedAt),
      detail: detailOf({
        title: task.title,
        type: task.type,
        origin: task.origin,
        priority: task.priority,
        retryCount: task.retryCount,
        assignedAgent: task.assignedAgent,
        sliceKey: task.sliceKey,
        creationReason: task.creationReason,
        resolvedByTaskId: task.resolvedByTaskId,
        approvalRequired: task.approvalRequired
      })
    },
    children
  );
}

function workflowNode(workflow: WorkflowRun, children: TraceNode[]): TraceNode {
  return node(
    {
      kind: "workflow",
      id: workflow.id,
      label: workflow.id,
      status: workflow.status,
      startedAt: workflow.startedAt,
      finishedAt: workflow.finishedAt,
      durationMs: isoDiff(workflow.startedAt, workflow.finishedAt),
      detail: detailOf({
        projectId: workflow.projectId,
        requirementId: workflow.requirementId,
        planningVersion: workflow.planningVersion,
        errorCode: workflow.error?.code,
        errorMessage: workflow.error?.message
      })
    },
    children
  );
}

/** OB-07：按树本身计数（不是按查询结果计数）——组装漏挂节点会在这里显形。 */
function countNodes(current: TraceNode, counts: WorkflowTraceCounts): void {
  if (current.kind === "task") counts.tasks += 1;
  else if (current.kind === "agentRun") counts.agentRuns += 1;
  else if (current.kind === "toolCall") counts.toolCalls += 1;
  else if (current.kind === "deployment") counts.deployments += 1;
  for (const child of current.children) countNodes(child, counts);
}

export class TraceService {
  constructor(private readonly sources: TraceSources) {}

  /** 运行不存在 → `null`（路由层转 404）。 */
  async build(workflowRunId: string): Promise<WorkflowTraceView | null> {
    const workflow = await this.sources.findWorkflowById(workflowRunId);
    if (!workflow) return null;

    const tasks = await this.sources.findTasks(workflowRunId);
    const [agentRuns, deployments, requestId] = await Promise.all([
      this.sources.findByTaskIds(tasks.map((task) => task.id)),
      this.sources.findByWorkflowRunId(workflowRunId),
      this.sources.findWorkflowStartedRequestId(workflowRunId).catch(() => undefined)
    ]);
    const toolCalls = await this.sources.findByAgentRunIds(agentRuns.map((run) => run.id));

    const toolCallsByRun = groupBy(toolCalls, (call) => call.agentRunId);
    const agentRunsByTask = groupBy(agentRuns, (run) => run.taskId);
    const deploymentsByTask = groupBy(deployments, (item) => item.taskId);

    const root = workflowNode(
      workflow,
      orderTasks(tasks).map((task) =>
        taskNode(task, [
          ...(agentRunsByTask.get(task.id) ?? []).map((run) =>
            agentRunNode(run, (toolCallsByRun.get(run.id) ?? []).map(toolCallNode))
          ),
          ...(deploymentsByTask.get(task.id) ?? []).map(deploymentNode)
        ])
      )
    );

    const counts: WorkflowTraceCounts = { tasks: 0, agentRuns: 0, toolCalls: 0, deployments: 0 };
    countNodes(root, counts);

    return {
      workflowRunId,
      ...(requestId ? { requestId } : {}),
      generatedAt: new Date().toISOString(),
      root,
      counts
    };
  }
}
