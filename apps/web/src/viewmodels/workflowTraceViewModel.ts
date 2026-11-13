import type {
  AgentRunStatus,
  DeploymentStatus,
  JsonObject,
  TaskStatus,
  ToolCallStatus,
  TraceNode,
  TraceNodeKind,
  WorkflowStatus,
  WorkflowTraceCounts
} from "@ai-se/shared";
import {
  AgentRunStatusSchema,
  DeploymentStatusSchema,
  TaskStatusSchema,
  ToolCallStatusSchema,
  WorkflowStatusSchema
} from "@ai-se/shared";
import {
  agentStatusLabel,
  agentStatusTone,
  toolCallStatusLabel,
  toolStatusTone
} from "./agentRunViewModel";
import { deploymentStatusLabel, deploymentStatusTone } from "./deploymentViewModel";
import { taskStatusLabel, taskStatusTone } from "./requirementViewModel";
import { durationLabel, workflowDurationLabel, workflowStatusLabel, workflowStatusTone } from "./workflowViewModel";

/**
 * 追踪视图（TF-M1）—— `GET /api/workflows/:id/trace` 返回的 `WorkflowTraceView` 的**纯展示逻辑**。
 *
 * 全部是纯函数，不发起请求、不持有状态（组件侧只负责把结果渲染出来）。
 *
 * 两条硬约束（`docs/156` §7）：
 *   · **不新增第二套口径**：界面上显示的节点计数一律取后端 `view.counts`（它由后端遍历组装好的树得出，
 *     `docs/150` §Implementation 8）。本文件的 `collectTraceCounts` 只用于**校验**与单测断言，
 *     不作为展示数据源。状态词同理——中文标签与配色全部复用各事实表既有的 `*StatusLabel` / `*StatusTone`，
 *     不在这里另立一份枚举。
 *   · **只呈现后端已给的东西**：`detail` 按后端白名单标量原样渲染，不补工具输入 / 输出
 *     （那正是 7-C 刻意剥掉的东西，`docs/150` §Implementation 7）。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 节点标识与折叠
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 展开态的主键。各事实表的 ID 由各自的表生成，**跨表可能撞号**（任务与 Agent 运行都是 uuid，
 * 理论上同值），所以主键必须带 `kind`。
 */
export function traceNodeKey(node: Pick<TraceNode, "kind" | "id">): string {
  return `${node.kind}:${node.id}`;
}

/**
 * 默认展开策略（TF-03 规模可控）。真实运行实测 `toolCalls: 503`（`docs/153`），
 * 全部展开会淹没页面，所以只展开承载结构的 `workflow` 与 `task` 两层，
 * `agentRun` / `toolCall` / `deployment` 默认收起。
 */
const DEFAULT_EXPANDED_KINDS: readonly TraceNodeKind[] = ["workflow", "task"];

/** 默认展开的节点主键（前序遍历顺序）。 */
export function defaultExpandedTraceNodeIds(root: TraceNode): string[] {
  const expanded: string[] = [];
  const walk = (node: TraceNode): void => {
    if (DEFAULT_EXPANDED_KINDS.includes(node.kind)) expanded.push(traceNodeKey(node));
    node.children.forEach(walk);
  };
  walk(root);
  return expanded;
}

/** 展开 / 收起单个节点（纯函数，返回新数组；不修改入参）。 */
export function toggleTraceNodeId(expanded: readonly string[], key: string): string[] {
  return expanded.includes(key) ? expanded.filter((id) => id !== key) : [...expanded, key];
}

/** 当前折叠状态下可见的节点数（含根节点）。折叠节点的子树整体不计入。 */
export function visibleTraceNodeCount(root: TraceNode, expanded: readonly string[]): number {
  const open = new Set(expanded);
  let count = 0;
  const walk = (node: TraceNode): void => {
    count += 1;
    if (!open.has(traceNodeKey(node))) return;
    node.children.forEach(walk);
  };
  walk(root);
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// 计数（校验用，非展示数据源）
// ─────────────────────────────────────────────────────────────────────────────

/** 遍历树统计逐类节点数。用于单测断言与「树与 `counts` 是否一致」的核对。 */
export function collectTraceCounts(root: TraceNode): WorkflowTraceCounts {
  const counts: WorkflowTraceCounts = { tasks: 0, agentRuns: 0, toolCalls: 0, deployments: 0 };
  const walk = (node: TraceNode): void => {
    if (node.kind === "task") counts.tasks += 1;
    else if (node.kind === "agentRun") counts.agentRuns += 1;
    else if (node.kind === "toolCall") counts.toolCalls += 1;
    else if (node.kind === "deployment") counts.deployments += 1;
    node.children.forEach(walk);
  };
  walk(root);
  return counts;
}

/** 后端 `view.counts` → 一行摘要文案。展示的唯一来源就是这个对象。 */
export function traceCountsLabel(counts: WorkflowTraceCounts): string {
  return [
    `${traceNodeKindLabel("task")} ${counts.tasks}`,
    `${traceNodeKindLabel("agentRun")} ${counts.agentRuns}`,
    `${traceNodeKindLabel("toolCall")} ${counts.toolCalls}`,
    `${traceNodeKindLabel("deployment")} ${counts.deployments}`
  ].join(" · ");
}

// ─────────────────────────────────────────────────────────────────────────────
// 节点展示
// ─────────────────────────────────────────────────────────────────────────────

const TRACE_NODE_KIND_LABELS: Record<TraceNodeKind, string> = {
  workflow: "工作流",
  task: "任务",
  agentRun: "Agent 运行",
  toolCall: "工具调用",
  deployment: "部署"
};

export function traceNodeKindLabel(kind: TraceNodeKind): string {
  return TRACE_NODE_KIND_LABELS[kind];
}

export type TraceNodeTone = "pending" | "running" | "warning" | "success" | "error" | "neutral";

/**
 * `TraceNode.status` 在契约里是 `string`（各事实表自己的状态词），但取值必然来自下表四个枚举之一。
 * 用共享 schema 的 `options` 判成员，**不另抄一份枚举**——未知取值原样显示，不渲染 `undefined`。
 */
const KNOWN_STATUSES: Record<TraceNodeKind, readonly string[]> = {
  workflow: WorkflowStatusSchema.options,
  task: TaskStatusSchema.options,
  agentRun: AgentRunStatusSchema.options,
  toolCall: ToolCallStatusSchema.options,
  deployment: DeploymentStatusSchema.options
};

function statusView(kind: TraceNodeKind, status: string): { label: string; tone: TraceNodeTone } {
  if (!KNOWN_STATUSES[kind].includes(status)) return { label: status, tone: "neutral" };
  switch (kind) {
    case "workflow":
      return {
        label: workflowStatusLabel(status as WorkflowStatus),
        tone: workflowStatusTone(status as WorkflowStatus)
      };
    case "task":
      return {
        label: taskStatusLabel(status as TaskStatus),
        tone: taskStatusTone(status as TaskStatus)
      };
    case "agentRun":
      return {
        label: agentStatusLabel(status as AgentRunStatus),
        tone: agentStatusTone(status as AgentRunStatus)
      };
    case "toolCall":
      return {
        label: toolCallStatusLabel(status),
        tone: toolStatusTone(status as ToolCallStatus)
      };
    case "deployment":
      return {
        label: deploymentStatusLabel(status as DeploymentStatus),
        tone: deploymentStatusTone(status as DeploymentStatus)
      };
  }
}

export function traceNodeStatusLabel(node: Pick<TraceNode, "kind" | "status">): string {
  return statusView(node.kind, node.status).label;
}

export function traceNodeStatusTone(node: Pick<TraceNode, "kind" | "status">): TraceNodeTone {
  return statusView(node.kind, node.status).tone;
}

/**
 * 节点用时。契约优先给 `durationMs`（工具调用回落到记录的 `duration`）；
 * 没有时再退回两端时间戳的差（未结束 → 「进行中」）。
 */
export function traceNodeDurationLabel(
  node: Pick<TraceNode, "startedAt" | "finishedAt" | "durationMs">
): string {
  if (node.durationMs !== undefined) return durationLabel(node.durationMs);
  return workflowDurationLabel(node.startedAt, node.finishedAt);
}

export interface TraceDetailRow {
  label: string;
  value: string;
}

/**
 * `detail` → 「字段名 / 值」行。后端只放白名单标量（`docs/150`），这里不展开嵌套值、
 * 不做任何二次加工——字符串已经过后端 `redactCredentialShapedText`。
 */
export function traceDetailRows(detail: JsonObject): TraceDetailRow[] {
  const rows: TraceDetailRow[] = [];
  for (const [label, value] of Object.entries(detail)) {
    if (value === null) {
      rows.push({ label, value: "—" });
      continue;
    }
    if (typeof value === "object") continue;
    rows.push({ label, value: String(value) });
  }
  return rows;
}
