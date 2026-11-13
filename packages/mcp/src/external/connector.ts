import { ToolDefinition, ToolExecutionContext } from "@ai-se/tool-runtime";
import { ActionPolicy, defaultActionPolicy } from "@ai-se/action-policy";
import { MCPClientPort } from "../contracts";
import { createMCPToolAdapter, toUnifiedToolDefinition } from "../integration/adapter";
import { MCPToolRegistry, MCPVisibilityQuery } from "../integration/registry";
import { ExternalSystemEntry, ExternalToolCatalog, ExternalToolEntry } from "./catalog";
import {
  buildCancelledOutcome,
  buildFailedOutcome,
  buildSuccessOutcome,
  externalActionRef,
  isGovernanceLevelFailure,
  newExternalResultId,
  type ExternalToolOutcome
} from "./outcome";

/**
 * Phase 5.7-2: MCP connector for external engineering systems.
 *
 *   Agent → ToolRuntime → ExternalToolDefinition → MCPToolAdapter
 *        → MCPClientPort → MCP Server → External System
 *
 * The connector adds NO transport and NO policy of its own: connections and
 * discovery run through the existing MCPToolRegistry (frozen visibility chain),
 * schema conversion + error normalization stay in the 5.5-2 MCPToolAdapter,
 * and execution/validation/audit stay in the ToolRuntime. What this layer owns
 * is the external-action OUTPUT: every mapped tool returns the unified
 * ExternalToolOutcome (frozen 5.7-0 ActionResult + untrusted result data).
 */

export interface ExternalConnectorOptions {
  client: MCPClientPort;
  catalog: ExternalToolCatalog;
  /** Registry built over the catalog's servers (visibility chain owner). */
  registry: MCPToolRegistry;
  /** Platform approval gate, consulted only when a declared tool requires it. */
  approvalGate?: (context: ToolExecutionContext) => boolean | Promise<boolean>;
  /**
   * Phase 5.7-3: the unified Action Policy is the FINAL authority for every
   * external action's {riskLevel, requiresApproval}. The catalog stays the
   * declarative metadata INPUT. Default: the frozen platform policy.
   */
  actionPolicy?: ActionPolicy;
}

export interface ExternalToolDescriptor {
  systemId: string;
  displayName: string;
  category: ExternalSystemEntry["category"];
  serverId: string;
  serverName: string;
  toolName: string;
  riskLevel: string;
  requiresApproval: boolean;
}

/** Builds the registry over the catalog's servers (platform composition root). */
export function createExternalToolRegistry(options: {
  client: MCPClientPort;
  catalog: ExternalToolCatalog;
  approvalGate?: (context: ToolExecutionContext) => boolean | Promise<boolean>;
  /** Phase 5.7-3: unified Action Policy (final decision maker). */
  actionPolicy?: ActionPolicy;
}): MCPToolRegistry {
  const policy = options.actionPolicy ?? defaultActionPolicy;
  return new MCPToolRegistry({
    client: options.client,
    servers: options.catalog.servers(),
    policyProvider: (server, tool) =>
      resolveEntryPolicy(options.catalog, policy, server.id, tool.name),
    approvalGate: options.approvalGate
  });
}

/**
 * Phase 5.7-3: the platform catalog declares; the unified Action Policy
 * decides. A tool without a catalog declaration or without a policy decision
 * resolves to undefined → the frozen visibility chain treats it as DENY.
 */
function resolveEntryPolicy(
  catalog: ExternalToolCatalog,
  policy: ActionPolicy,
  serverId: string,
  toolName: string
): { riskLevel: ExternalToolEntry["riskLevel"]; requiresApproval: boolean } | undefined {
  const entry = catalog.toolEntry(serverId, toolName);
  if (!entry) return undefined;
  const decision = policy.resolveExternal(entry.name, entry);
  return decision
    ? { riskLevel: decision.riskLevel, requiresApproval: decision.requiresApproval }
    : undefined;
}

export class ExternalEngineeringConnector {
  constructor(private readonly options: ExternalConnectorOptions) {}

  /** Registers any catalog server the registry does not know yet. */
  ensureRegistered(): void {
    for (const server of this.options.catalog.servers()) {
      if (!this.options.registry.getServer(server.id)) {
        this.options.registry.registerServer(server);
      }
    }
  }

  /** Connects every declared system and discovers its tools (real MCP round-trips). */
  async connectAll(): Promise<void> {
    this.ensureRegistered();
    for (const entry of this.options.catalog.list()) {
      await this.options.registry.connectAndDiscover(entry.server.id);
    }
  }

  /** Credential REFERENCE for a system — resolution is the MCP client's (5.5-4). */
  credentialRefFor(systemId: string): string | undefined {
    return this.options.catalog.credentialRefFor(systemId);
  }

  /** Metadata view of the external tools visible for one query (no execution). */
  descriptors(query: MCPVisibilityQuery): ExternalToolDescriptor[] {
    const policy = this.options.actionPolicy ?? defaultActionPolicy;
    const descriptors: ExternalToolDescriptor[] = [];
    for (const entry of this.options.catalog.list()) {
      for (const tool of entry.tools) {
        if (!this.options.registry.isToolVisible(entry.server.id, tool.name, query)) continue;
        const decision = policy.resolveExternal(tool.name, tool);
        if (!decision) continue; // action policy DENY
        descriptors.push({
          systemId: entry.id,
          displayName: entry.displayName,
          category: entry.category,
          serverId: entry.server.id,
          serverName: entry.server.name,
          toolName: tool.name,
          riskLevel: decision.riskLevel,
          requiresApproval: decision.requiresApproval
        });
      }
    }
    return descriptors;
  }

  /**
   * External tools visible for the query, mapped onto the existing unified
   * ToolDefinition with the external-action output shape. Ready to compose
   * into the current ToolRuntime.
   */
  toolDefinitions(query: MCPVisibilityQuery): ToolDefinition<unknown, ExternalToolOutcome>[] {
    const policy = this.options.actionPolicy ?? defaultActionPolicy;
    const definitions: ToolDefinition<unknown, ExternalToolOutcome>[] = [];
    for (const entry of this.options.catalog.list()) {
      for (const toolEntry of entry.tools) {
        if (!this.options.registry.isToolVisible(entry.server.id, toolEntry.name, query)) continue;
        const discovered = this.options.registry
          .listDiscoveredTools(entry.server.id)
          .find((tool) => tool.name === toolEntry.name);
        if (!discovered) continue; // declared but not discovered → invisible
        // Phase 5.7-3: the unified Action Policy is the final authority — the
        // catalog entry is the declarative input, and a DENY (undefined) here
        // keeps the tool unmapped.
        const decision = policy.resolveExternal(toolEntry.name, toolEntry);
        if (!decision) continue;
        const adapter = createMCPToolAdapter(this.options.client, entry.server.id, toolEntry.name, {
          riskLevel: decision.riskLevel,
          canExecute: () =>
            this.options.registry.isToolVisible(entry.server.id, toolEntry.name, query),
          requiresApproval: decision.requiresApproval,
          approvalGate: this.options.approvalGate
        });
        const inner = toUnifiedToolDefinition(discovered, decision, adapter);
        definitions.push(toExternalToolDefinition(entry, inner));
      }
    }
    return definitions;
  }
}

/**
 * Wraps one mapped MCP ToolDefinition into the external-action output
 * contract. The inner definition already carries the JSON Schema → Zod input
 * schema and the MCPToolAdapter guards (call-time visibility re-check,
 * approval); this wrapper only reshapes the execution OUTCOME: governance
 * failures (cancellation / timeout / permission / approval) rethrow so the
 * ToolRuntime envelope owns them, everything else becomes a frozen 5.7-0
 * ActionResult with the untrusted payload under `result`.
 */
export function toExternalToolDefinition(
  entry: ExternalSystemEntry,
  inner: ToolDefinition<unknown, unknown>
): ToolDefinition<unknown, ExternalToolOutcome> {
  return {
    name: inner.name,
    description: renderExternalDescription(entry, inner.name),
    riskLevel: inner.riskLevel,
    inputSchema: inner.inputSchema,
    async execute(input: unknown, context: ToolExecutionContext): Promise<ExternalToolOutcome> {
      const startedAtMs = Date.now();
      const timing = {
        startedAtMs,
        occurredAt: new Date().toISOString(),
        resultId: newExternalResultId(),
        actionRef: externalActionRef(entry.server.name, inner.name, context.toolCallId)
      };
      if (context.signal?.aborted) {
        return buildCancelledOutcome(timing);
      }
      try {
        const raw = await inner.execute(input, context);
        return buildSuccessOutcome(timing, raw);
      } catch (error) {
        if (isGovernanceLevelFailure(error)) throw error;
        return buildFailedOutcome(timing, error);
      }
    }
  };
}

function renderExternalDescription(entry: ExternalSystemEntry, toolName: string): string {
  const base = `External ${entry.category} action "${toolName}" on ${entry.displayName} (via MCP).`;
  return entry.description ? `${base} ${entry.description}` : base;
}
