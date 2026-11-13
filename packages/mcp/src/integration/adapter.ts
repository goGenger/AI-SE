import {
  ToolAuditInfo,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionError,
  ToolResult,
  ToolRiskLevel
} from "@ai-se/tool-runtime";
import { MCPClientPort, MCPToolAdapter, MCPToolDefinition, MCPToolPolicy } from "../contracts";
import { classifyMCPError, mapMCPErrorToRuntimeError } from "../errors";
import { jsonSchemaToZod } from "./jsonSchemaToZod";

/**
 * Phase 5.5-2: MCPToolAdapter.
 *
 * The adapter is a pure bridge: MCP Tool → MCP Client → MCP Server → Result.
 * Every platform capability (schema validation, permission, risk, approval,
 * timeout, cancellation, audit, secret redaction, error classification) stays
 * with the existing Tool Runtime. The adapter receives:
 *  - canExecute:   platform re-check of the visibility chain AT CALL TIME so a
 *                  revoked binding can never reach the MCP server.
 *  - approvalGate: platform-supplied approval decision (only consulted when
 *                  the platform policy marks the tool as requiring approval).
 * Both gates run BEFORE any request is sent to the MCP client; a denied call
 * produces a ToolExecutionError without touching the server.
 */

export interface MCPToolAdapterGuards {
  /** Call-time re-check of the platform visibility/policy chain. Default: allow. */
  canExecute?: (context: ToolExecutionContext) => boolean | Promise<boolean>;
  /** Platform policy: does this tool require approval before execution? */
  requiresApproval?: boolean;
  /** Platform-supplied approval decision. Consulted only when requiresApproval. */
  approvalGate?: (context: ToolExecutionContext) => boolean | Promise<boolean>;
  /** Risk level for the adapter's own audit info (Tool Runtime overrides it). */
  riskLevel?: ToolRiskLevel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts an MCP CallToolResult into plain data for the unified ToolResult.
 * structuredContent wins when present; otherwise the protocol content blocks
 * are returned under a `content` key. MCP protocol objects never leak further:
 * _meta / isError / annotations are dropped.
 */
export function mcpCallToolResultToData(result: unknown): unknown {
  if (!isRecord(result)) {
    return result;
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  if (Array.isArray(result.content)) {
    return { content: result.content };
  }
  return result;
}

function adapterAudit(
  context: ToolExecutionContext,
  toolName: string,
  riskLevel: ToolRiskLevel
): ToolAuditInfo {
  return {
    requestId: context.requestId,
    projectId: context.projectId,
    workflowRunId: context.workflowRunId,
    taskId: context.taskId,
    agentRunId: context.agentRunId,
    toolCallId: context.toolCallId,
    toolName,
    riskLevel,
    actor: context.actor
  };
}

/**
 * Creates an MCPToolAdapter for one tool of one server. The returned adapter
 * satisfies the frozen MCPToolAdapterFactory contract.
 */
export function createMCPToolAdapter(
  client: MCPClientPort,
  serverId: string,
  toolName: string,
  guards: MCPToolAdapterGuards = {}
): MCPToolAdapter {
  const label = `${serverId}/${toolName}`;

  return {
    async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
      const started = Date.now();

      // Permission / binding guard (platform policy, call-time re-check).
      if (guards.canExecute) {
        const allowed = await guards.canExecute(context);
        if (!allowed) {
          throw new ToolExecutionError(`TOOL_ERROR`, `MCP tool ${label} is not permitted`, {
            mcpErrorCategory: "PERMISSION_DENIED",
            serverId,
            toolName
          });
        }
      }

      // Approval gate (platform policy). Fail closed when no gate is wired.
      if (guards.requiresApproval) {
        if (!guards.approvalGate) {
          throw new ToolExecutionError(
            `TOOL_ERROR`,
            `MCP tool ${label} requires approval but no approval gate is configured`,
            { mcpErrorCategory: "APPROVAL_REQUIRED", serverId, toolName }
          );
        }
        const approved = await guards.approvalGate(context);
        if (!approved) {
          throw new ToolExecutionError(`TOOL_ERROR`, `MCP tool ${label} was not approved`, {
            mcpErrorCategory: "APPROVAL_REQUIRED",
            serverId,
            toolName
          });
        }
      }

      try {
        const raw = await client.callTool(serverId, toolName, input, context.signal);
        return {
          success: true,
          data: mcpCallToolResultToData(raw),
          duration: Date.now() - started,
          toolName,
          toolCallId: context.toolCallId,
          audit: adapterAudit(context, toolName, guards.riskLevel ?? "LOW")
        };
      } catch (error) {
        const category = classifyMCPError({ error, aborted: context.signal?.aborted ?? false });
        const normalized = mapMCPErrorToRuntimeError(category, error);
        throw new ToolExecutionError(normalized.code, normalized.message, {
          ...(isRecord(normalized.details) ? normalized.details : {}),
          serverId,
          toolName,
          cause: error instanceof Error ? error.message : undefined
        });
      }
    }
  };
}

/**
 * Maps one MCP tool (plus platform policy and adapter) onto the EXISTING
 * unified ToolDefinition so the current Tool Runtime executes it like any
 * native tool: schema validation, audit, timeout, cancellation, and error
 * normalization all happen inside ToolRuntime.execute.
 */
export function toUnifiedToolDefinition(
  tool: Pick<MCPToolDefinition, "name" | "description" | "inputSchema">,
  policy: MCPToolPolicy,
  adapter: MCPToolAdapter
): ToolDefinition<unknown, unknown> {
  return {
    name: tool.name,
    description: tool.description.trim() ? tool.description.trim() : `MCP tool ${policy.riskLevel}`,
    riskLevel: policy.riskLevel,
    inputSchema: jsonSchemaToZod(tool.inputSchema),
    execute: async (input: unknown, context: ToolExecutionContext) => {
      const result = await adapter.execute(input, context);
      if (!result.success) {
        throw new ToolExecutionError(
          result.error?.code ?? "TOOL_ERROR",
          result.error?.message ?? "MCP tool execution failed",
          result.error?.details
        );
      }
      return result.data;
    }
  };
}
