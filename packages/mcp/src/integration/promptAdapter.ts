import {
  MCPCapabilityPolicy,
  MCPClientPort,
  MCPPromptDescriptor,
  MCPPromptResult
} from "../contracts";
import { MCPClientError } from "../client/MCPClientError";
import {
  emitCapabilityAudit,
  MCPCapabilityAuditSink,
  outcomeOf,
  toCapabilityError,
  withCapabilityTimeout
} from "./capability";

/**
 * Phase 5.5-6: MCPPromptAdapter — an INDEPENDENT bridge for prompts.
 *
 * Prompts are NOT ToolDefinitions: prompts/get returns converted messages
 * (role + content) for the caller; there is no execution step and no Tool
 * Runtime coupling. Same guard chain as the resource adapter: call-time
 * access re-check BEFORE any request, per-prompt platform policy (undefined
 * denies), classified + redacted errors, DI audit sink, timeout/cancellation.
 */

export interface MCPPromptPolicyContext {
  name: string;
}

export interface MCPPromptAdapterOptions {
  /** Call-time re-check of the platform permission/policy chain. Default: allow. */
  canAccess?: () => boolean | Promise<boolean>;
  /**
   * Platform per-prompt policy. When provided, `undefined` DENIES the prompt
   * (fail-closed, same rule as tool policy).
   */
  policy?: (prompt: MCPPromptPolicyContext) => MCPCapabilityPolicy | undefined;
  /** Optional operation timeout (ms); mirrors the Tool Runtime timeout model. */
  timeoutMs?: number;
  /** Dependency-injected audit sink (no MCP-local audit state). */
  audit?: MCPCapabilityAuditSink;
}

export interface MCPPromptAdapter {
  /** prompts/list — only prompts allowed by the platform policy. */
  listPrompts(): Promise<MCPPromptDescriptor[]>;
  /** prompts/get — re-checks access at call time; denied gets never reach the server. */
  getPrompt(
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<MCPPromptResult>;
}

export function createMCPPromptAdapter(
  client: MCPClientPort,
  serverId: string,
  options: MCPPromptAdapterOptions = {}
): MCPPromptAdapter {
  async function assertAccess(target: string): Promise<void> {
    if (options.canAccess && !(await options.canAccess())) {
      throw new MCPClientError(
        "PERMISSION_DENIED",
        `MCP prompt ${serverId}/${target} is not permitted`
      );
    }
  }

  function assertPolicy(context: MCPPromptPolicyContext): void {
    if (options.policy && options.policy(context) === undefined) {
      throw new MCPClientError(
        "PERMISSION_DENIED",
        `MCP prompt ${serverId}/${context.name} is denied by policy`
      );
    }
  }

  return {
    async listPrompts(): Promise<MCPPromptDescriptor[]> {
      const started = Date.now();
      try {
        await assertAccess("*");
        const prompts = await client.listPrompts(serverId);
        const visible = options.policy
          ? prompts.filter((prompt) => options.policy!({ name: prompt.name }) !== undefined)
          : prompts;
        await emitCapabilityAudit(options.audit, {
          capability: "prompt",
          serverId,
          target: "*",
          outcome: "succeeded",
          durationMs: Date.now() - started
        });
        return visible;
      } catch (error) {
        const normalized = toCapabilityError(error, false);
        await emitCapabilityAudit(options.audit, {
          capability: "prompt",
          serverId,
          target: "*",
          outcome: outcomeOf(error),
          durationMs: Date.now() - started,
          errorCategory: normalized.mcpErrorCategory
        });
        throw normalized;
      }
    },

    async getPrompt(
      name: string,
      args?: Record<string, string>,
      signal?: AbortSignal
    ): Promise<MCPPromptResult> {
      const started = Date.now();
      try {
        await assertAccess(name);
        assertPolicy({ name });
        const result = await withCapabilityTimeout(
          `MCP prompt ${serverId}/${name}`,
          options.timeoutMs,
          signal,
          (innerSignal) => client.getPrompt(serverId, name, args, innerSignal)
        );
        await emitCapabilityAudit(options.audit, {
          capability: "prompt",
          serverId,
          target: name,
          outcome: "succeeded",
          durationMs: Date.now() - started
        });
        return result;
      } catch (error) {
        const normalized = toCapabilityError(error, signal?.aborted ?? false);
        await emitCapabilityAudit(options.audit, {
          capability: "prompt",
          serverId,
          target: name,
          outcome: outcomeOf(error),
          durationMs: Date.now() - started,
          errorCategory: normalized.mcpErrorCategory
        });
        throw normalized;
      }
    }
  };
}
