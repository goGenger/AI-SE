import { ToolRiskLevel } from "@ai-se/tool-runtime";
import { z } from "zod";
import { MCPServerDefinition, MCPToolPolicy, validateMCPServerDefinition } from "../contracts";

/**
 * Phase 5.7-2: External Engineering Tool Catalog.
 *
 * A DECLARATION of external engineering systems (source control / issue
 * tracker / project / documentation / CI-CD) as carried over MCP. The catalog
 * is platform-owned metadata:
 *
 *  - external system identity: id, displayName, category
 *  - transport binding: the system's MCP server definition (the ONLY connector
 *    — no direct external API surface exists or may be added)
 *  - tool allowlist with PLATFORM-declared risk metadata (riskLevel /
 *    requiresApproval). Remote tool metadata is never consulted: resolvePolicy
 *    only looks at (serverId, toolName), so a remote server cannot influence
 *    its own risk. Unknown / undeclared tools resolve to `undefined`, which the
 *    frozen visibility chain treats as DENY (fail-closed).
 *  - credentialRef (reference only) — resolution happens inside the existing
 *    MCP client credential-resolver path (5.5-4); plaintext credentials are
 *    rejected by the frozen server-definition guard.
 */

export type ExternalSystemCategory =
  | "source-control"
  | "issue-tracker"
  | "project-management"
  | "documentation"
  | "ci-cd";

const EXTERNAL_SYSTEM_CATEGORIES: readonly ExternalSystemCategory[] = [
  "source-control",
  "issue-tracker",
  "project-management",
  "documentation",
  "ci-cd"
];

const RISK_LEVELS: readonly ToolRiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export interface ExternalToolEntry {
  /** Tool name as exposed by the system's MCP server. */
  name: string;
  /** Platform-declared risk. NEVER trusted from the remote server. */
  riskLevel: ToolRiskLevel;
  requiresApproval: boolean;
}

export interface ExternalSystemEntry {
  /** External system identity, e.g. "github". */
  id: string;
  displayName: string;
  category: ExternalSystemCategory;
  description?: string;
  /** The system's MCP server definition (validated by the frozen 5.5-0 guard). */
  server: MCPServerDefinition;
  /** Declared tool allowlist. Tools outside this list are invisible. */
  tools: ExternalToolEntry[];
}

export class ExternalToolCatalogError extends Error {}

const ExternalToolEntrySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    riskLevel: z.enum(RISK_LEVELS as [ToolRiskLevel, ...ToolRiskLevel[]]),
    requiresApproval: z.boolean()
  })
  .strict();

const ExternalSystemEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    displayName: z.string().trim().min(1).max(200),
    category: z.enum(
      EXTERNAL_SYSTEM_CATEGORIES as [ExternalSystemCategory, ...ExternalSystemCategory[]]
    ),
    description: z.string().trim().max(1000).optional(),
    server: z.unknown(),
    tools: z.array(ExternalToolEntrySchema).min(1).max(200)
  })
  .strict();

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`)
    .join("; ");
}

export class ExternalToolCatalog {
  private readonly systems = new Map<string, ExternalSystemEntry>();
  private readonly byServer = new Map<string, string>();

  constructor(entries: unknown[] = []) {
    for (const entry of entries) {
      this.add(entry);
    }
  }

  /** Validates one external system declaration and registers it. */
  add(input: unknown): ExternalSystemEntry {
    const parsed = ExternalSystemEntrySchema.safeParse(input);
    if (!parsed.success) {
      throw new ExternalToolCatalogError(formatIssues(parsed.error));
    }
    // The system's transport binding is the frozen MCP server definition; its
    // validator rejects plaintext credentials and non-reference credentialRefs.
    const server = validateMCPServerDefinition(parsed.data.server);
    if (this.systems.has(parsed.data.id)) {
      throw new ExternalToolCatalogError(`external system already registered: ${parsed.data.id}`);
    }
    if (this.byServer.has(server.id)) {
      throw new ExternalToolCatalogError(`MCP server already bound to a system: ${server.id}`);
    }
    const toolNames = new Set<string>();
    for (const tool of parsed.data.tools) {
      if (toolNames.has(tool.name)) {
        throw new ExternalToolCatalogError(
          `duplicate tool ${tool.name} on system ${parsed.data.id}`
        );
      }
      toolNames.add(tool.name);
    }
    const entry: ExternalSystemEntry = { ...parsed.data, server };
    this.systems.set(entry.id, entry);
    this.byServer.set(server.id, entry.id);
    return entry;
  }

  list(): ExternalSystemEntry[] {
    return [...this.systems.values()];
  }

  get(systemId: string): ExternalSystemEntry | undefined {
    return this.systems.get(systemId);
  }

  systemForServer(serverId: string): ExternalSystemEntry | undefined {
    const systemId = this.byServer.get(serverId);
    return systemId ? this.systems.get(systemId) : undefined;
  }

  /** The declared tool entry for a server's tool; undefined = not declared. */
  toolEntry(serverId: string, toolName: string): ExternalToolEntry | undefined {
    return this.systemForServer(serverId)?.tools.find((tool) => tool.name === toolName);
  }

  /**
   * Platform risk policy for one (serverId, toolName). Deliberately ignores
   * every remote-provided field: the remote server cannot raise or lower its
   * own risk. `undefined` = DENY (the frozen visibility chain fails closed).
   */
  resolvePolicy(serverId: string, toolName: string): MCPToolPolicy | undefined {
    const entry = this.toolEntry(serverId, toolName);
    if (!entry) return undefined;
    return { riskLevel: entry.riskLevel, requiresApproval: entry.requiresApproval };
  }

  /**
   * Ready-made provider for MCPToolRegistry's `policyProvider` slot. The
   * discovered tool object is intentionally dropped — only ids cross into
   * the policy decision (untrusted-remote principle, 5.5-5).
   */
  policyProvider(): (
    server: MCPServerDefinition,
    tool: { name: string }
  ) => MCPToolPolicy | undefined {
    return (server, tool) => this.resolvePolicy(server.id, tool.name);
  }

  /** All bound MCP server definitions (for registry construction). */
  servers(): MCPServerDefinition[] {
    return this.list().map((entry) => entry.server);
  }

  /** Credential REFERENCE for a system (never a secret; resolution is 5.5-4's). */
  credentialRefFor(systemId: string): string | undefined {
    return this.systems.get(systemId)?.server.credentialRef;
  }
}
