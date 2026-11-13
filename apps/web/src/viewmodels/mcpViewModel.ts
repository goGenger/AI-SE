import {
  CreateMCPServerInputData,
  MCPBindingSummary,
  MCPServerStatus,
  MCPToolRisk,
  MCPTransportKind
} from "@ai-se/shared";

const STATUS_LABELS: Record<MCPServerStatus, string> = {
  REGISTERED: "已注册",
  CONNECTING: "连接中",
  CONNECTED: "已连接",
  DEGRADED: "降级",
  RECONNECTING: "重连中",
  DISCONNECTED: "未连接",
  REVOKED: "已撤销"
};

const STATUS_HINTS: Record<MCPServerStatus, string> = {
  REGISTERED: "已注册 — 尚未连接。",
  CONNECTING: "正在连接 MCP 服务器。",
  CONNECTED: "已连接。工具由后端注册表发现并强制执行治理。",
  DEGRADED: "服务器当前不可用 — 已发现的工具仍被保留。",
  RECONNECTING: "后端正在重连（有界重试）。",
  DISCONNECTED: "当前不可用。",
  REVOKED: "已撤销（终态）。"
};

const RISK_LABELS: Record<MCPToolRisk, string> = {
  LOW: "低",
  MEDIUM: "中",
  HIGH: "高",
  CRITICAL: "严重"
};

export function serverStatusLabel(status: MCPServerStatus): string {
  return STATUS_LABELS[status];
}

/** Status text always comes from the backend registry — never inferred here. */
export function serverStatusHint(status: MCPServerStatus): string {
  return STATUS_HINTS[status];
}

export function serverStatusClass(status: MCPServerStatus): string {
  return `status mcp-status-${status.toLowerCase()}`;
}

export function transportLabel(transport: "stdio" | "streamable-http"): string {
  return transport === "stdio" ? "stdio" : "流式 HTTP";
}

export function riskLabel(risk: MCPToolRisk): string {
  return RISK_LABELS[risk];
}

export function riskClass(risk: MCPToolRisk): string {
  return `status mcp-risk-${risk.toLowerCase()}`;
}

export function approvalLabel(requiresApproval: boolean): string {
  return requiresApproval ? "需要审批" : "无需审批";
}

export function bindingScopeLabel(binding: MCPBindingSummary): string {
  return binding.agentName ? `Agent: ${binding.agentName}` : "项目级";
}

export function bindingTargetLabel(binding: MCPBindingSummary): string {
  return binding.toolName ?? "全部工具";
}

export function enabledLabel(enabled: boolean): string {
  return enabled ? "已启用" : "已禁用";
}

export function formatMCPTimestamp(value?: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

/* ---------------------------------------------------------------------------
 * Phase 10-B：状态 → StatusBadge tone 的**纯展示映射**（与 Phase 4/6-B/7-B/8-B/9-B
 * 的 projectStatusTone / requirementStatusTone / workflowStatusTone /
 * agentStatusTone / deploymentStatusTone 同一模式）。
 *
 * 只读取既有业务枚举，**不修改**任何 label / hint / class 函数语义，也不改后端判定：
 * 状态值一律来自 MCP 注册表（后端），此处仅决定"用哪种语义色显示"。
 * 与 StatusBadge 之间通过字符串字面量联合类型关联，viewmodel 不依赖 UI 层类型。
 * 保留 `serverStatusClass` / `riskClass`（既有导出与测试契约不变），但页面模板不再调用。
 * ------------------------------------------------------------------------- */

export type MCPServerStatusTone = "success" | "pending" | "running" | "warning" | "neutral";

export function serverStatusTone(status: MCPServerStatus): MCPServerStatusTone {
  switch (status) {
    case "CONNECTED":
      return "success";
    case "REGISTERED":
    case "CONNECTING":
      return "pending";
    case "RECONNECTING":
      return "running";
    case "DEGRADED":
      return "warning";
    default:
      // DISCONNECTED / REVOKED：当前不可用或终态，均为中性灰。
      return "neutral";
  }
}

export type MCPToolRiskTone = "success" | "running" | "warning" | "error";

export function riskTone(risk: MCPToolRisk): MCPToolRiskTone {
  switch (risk) {
    case "LOW":
      return "success";
    case "MEDIUM":
      return "running";
    case "HIGH":
      return "warning";
    default:
      // CRITICAL
      return "error";
  }
}

export type MCPApprovalTone = "warning" | "neutral";

export function approvalTone(requiresApproval: boolean): MCPApprovalTone {
  return requiresApproval ? "warning" : "neutral";
}

export type MCPEnabledTone = "success" | "neutral";

export function enabledTone(enabled: boolean): MCPEnabledTone {
  return enabled ? "success" : "neutral";
}

// ── T2：控制台注册服务器（表单 → API 载荷） ─────────────────────────────────

/** 表单的原始状态：全部是字符串，`transport` 决定哪几项有意义。 */
export interface MCPServerFormState {
  name: string;
  description: string;
  transport: MCPTransportKind;
  /** stdio：可执行文件。 */
  command: string;
  /** stdio：命令行参数，空白或换行分隔（界面不要求用户懂 JSON 数组）。 */
  argsText: string;
  /** stdio：工作目录，可留空。 */
  cwd: string;
  /** streamable-http：MCP endpoint。 */
  endpoint: string;
  /** streamable-http：凭据**引用**，不是凭据本身。 */
  credentialRef: string;
  enabled: boolean;
}

export function emptyMCPServerForm(): MCPServerFormState {
  return {
    name: "",
    description: "",
    transport: "stdio",
    command: "",
    argsText: "",
    cwd: "",
    endpoint: "",
    credentialRef: "",
    enabled: true
  };
}

/** 参数串按空白/换行切分；空串得到空数组（而不是 `[""]`）。 */
export function parseCommandArgs(argsText: string): string[] {
  return argsText
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * 表单 → 创建载荷。必填项缺失返回 `null`，由调用方显示对应提示。
 *
 * 传输方式决定字段：stdio 只带 command/args/cwd，http 只带 endpoint/credentialRef——
 * 把另一侧的残值一起发过去会被 `CreateMCPServerSchema.strict()` 拒绝。
 */
export function toCreateMCPServerInput(form: MCPServerFormState): CreateMCPServerInputData | null {
  const name = form.name.trim();
  if (name === "") return null;
  const description = form.description.trim();

  const base: CreateMCPServerInputData = {
    name,
    transport: form.transport,
    enabled: form.enabled,
    ...(description !== "" ? { description } : {})
  };

  if (form.transport === "stdio") {
    const command = form.command.trim();
    if (command === "") return null;
    const args = parseCommandArgs(form.argsText);
    const cwd = form.cwd.trim();
    return {
      ...base,
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(cwd !== "" ? { cwd } : {})
    };
  }

  const endpoint = form.endpoint.trim();
  if (endpoint === "") return null;
  const credentialRef = form.credentialRef.trim();
  return {
    ...base,
    endpoint,
    ...(credentialRef !== "" ? { credentialRef } : {})
  };
}
