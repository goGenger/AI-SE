import {
  MCPCapabilityPolicy,
  MCPClientPort,
  MCPResourceDescriptor,
  MCPResourceReadResult
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
 * Phase 5.5-6: MCPResourceAdapter — an INDEPENDENT bridge for resources.
 *
 * Resources are NOT ToolDefinitions: no execution semantics, no Tool Runtime
 * coupling. The adapter provides:
 *  - resources/list  → normalized descriptors (per-resource platform policy
 *    filters the list; a denied resource never reaches the caller);
 *  - resources/read  → normalized contents (text XOR base64 blob).
 *
 * Every operation runs the platform access re-check BEFORE any request is
 * sent to the MCP server (default deny; a revoked binding produces zero
 * server requests), and failures are classified onto the existing error set
 * with credential-shaped text scrubbed. Audit events are emitted through the
 * injected sink; the adapter itself stores nothing.
 */

export interface MCPResourcePolicyContext {
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface MCPResourceAdapterOptions {
  /** Call-time re-check of the platform permission/policy chain. Default: allow. */
  canAccess?: () => boolean | Promise<boolean>;
  /**
   * Platform per-resource policy. When provided, `undefined` DENIES the
   * resource (fail-closed, same rule as tool policy).
   */
  policy?: (resource: MCPResourcePolicyContext) => MCPCapabilityPolicy | undefined;
  /** Optional operation timeout (ms); mirrors the Tool Runtime timeout model. */
  timeoutMs?: number;
  /** Dependency-injected audit sink (no MCP-local audit state). */
  audit?: MCPCapabilityAuditSink;
}

export interface MCPResourceAdapter {
  /** resources/list — only resources allowed by the platform policy. */
  listResources(): Promise<MCPResourceDescriptor[]>;
  /** resources/read — re-checks access at call time; denied reads never reach the server. */
  readResource(uri: string, signal?: AbortSignal): Promise<MCPResourceReadResult>;
}

export function createMCPResourceAdapter(
  client: MCPClientPort,
  serverId: string,
  options: MCPResourceAdapterOptions = {}
): MCPResourceAdapter {
  async function assertAccess(target: string): Promise<void> {
    if (options.canAccess && !(await options.canAccess())) {
      throw new MCPClientError(
        "PERMISSION_DENIED",
        `MCP resource ${serverId}/${target} is not permitted`
      );
    }
  }

  function assertPolicy(context: MCPResourcePolicyContext): void {
    if (options.policy && options.policy(context) === undefined) {
      throw new MCPClientError(
        "PERMISSION_DENIED",
        `MCP resource ${serverId}/${context.uri} is denied by policy`
      );
    }
  }

  return {
    async listResources(): Promise<MCPResourceDescriptor[]> {
      const started = Date.now();
      try {
        await assertAccess("*");
        const resources = await client.listResources(serverId);
        const visible = options.policy
          ? resources.filter(
              (resource) =>
                options.policy!({
                  uri: resource.uri,
                  name: resource.name,
                  mimeType: resource.mimeType
                }) !== undefined
            )
          : resources;
        await emitCapabilityAudit(options.audit, {
          capability: "resource",
          serverId,
          target: "*",
          outcome: "succeeded",
          durationMs: Date.now() - started
        });
        return visible;
      } catch (error) {
        const normalized = toCapabilityError(error, false);
        await emitCapabilityAudit(options.audit, {
          capability: "resource",
          serverId,
          target: "*",
          outcome: outcomeOf(error),
          durationMs: Date.now() - started,
          errorCategory: normalized.mcpErrorCategory
        });
        throw normalized;
      }
    },

    async readResource(uri: string, signal?: AbortSignal): Promise<MCPResourceReadResult> {
      const started = Date.now();
      try {
        await assertAccess(uri);
        assertPolicy({ uri });
        const result = await withCapabilityTimeout(
          `MCP resource ${serverId}/${uri}`,
          options.timeoutMs,
          signal,
          (innerSignal) => client.readResource(serverId, uri, innerSignal)
        );
        await emitCapabilityAudit(options.audit, {
          capability: "resource",
          serverId,
          target: uri,
          outcome: "succeeded",
          durationMs: Date.now() - started
        });
        return result;
      } catch (error) {
        const normalized = toCapabilityError(error, signal?.aborted ?? false);
        await emitCapabilityAudit(options.audit, {
          capability: "resource",
          serverId,
          target: uri,
          outcome: outcomeOf(error),
          durationMs: Date.now() - started,
          errorCategory: normalized.mcpErrorCategory
        });
        throw normalized;
      }
    }
  };
}
