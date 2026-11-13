import { ToolExecutionContext, ToolResult, ToolRiskLevel } from "@ai-se/tool-runtime";
import { z } from "zod";

/**
 * Phase 5.5-0 Contract Freeze
 *
 * This module freezes the platform boundary for MCP Tool Federation:
 *
 *   Agent → Agent Runtime → Tool Runtime → MCP Adapter → MCP SDK → MCP Server
 *
 * MCPClientPort owns protocol-layer capability ONLY. It must never be responsible
 * for permission, approval, audit, workflow, task scheduling, agent planning, or
 * secret policy. Those capabilities stay in the existing Tool Runtime / Workflow /
 * Agent layers. MCP is just one Tool Source of the existing Tool Runtime.
 *
 * Frozen transports: "stdio" (5.5-1) and "streamable-http" (5.5-4, the current
 * MCP standard HTTP transport — NOT the legacy HTTP+SSE session model).
 */

export type MCPTransport = "stdio" | "streamable-http";

/** Configuration for a local stdio MCP server process. */
export interface MCPStdioConfig {
  command: string;
  args?: string[];
  /** Key names must not be credential-shaped; values travel only to the MCP process. */
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Platform-side definition of one registered MCP server.
 *
 * authRef / credentialRef are REFERENCES into a Secret Provider; plaintext
 * credentials are forbidden in this object (enforced by
 * validateMCPServerDefinition).
 */
export interface MCPServerDefinition {
  id: string;
  name: string;
  description?: string;
  transport: MCPTransport;
  /** Required iff transport === "stdio". */
  stdio?: MCPStdioConfig;
  /** Required iff transport === "streamable-http". http/https URL, no embedded credentials. */
  endpoint?: string;
  enabled: boolean;
  authRef?: string;
  credentialRef?: string;
}

/**
 * A tool discovered from an MCP server (tools/list result, normalized).
 * inputSchema is the JSON Schema object as reported by the MCP protocol;
 * JSON-Schema-to-Zod conversion is owned by Phase 5.5-2 (Tool Runtime Integration).
 */
export interface MCPToolDefinition {
  serverId: string;
  name: string;
  description: string;
  inputSchema: unknown;
  /**
   * Phase 5.5-7: UI app link from tool metadata (`_meta.ui.resourceUri`,
   * to the extent the current SDK/protocol supports it). Undefined when the
   * tool has no UI app.
   */
  uiResourceUri?: string;
}

/**
 * Phase 5.5-7: one UI-app link (tool → `ui://` resource) on a server.
 * UI resources are ordinary MCP resources; this is only the discovery link.
 */
export interface MCPToolUiLink {
  serverId: string;
  toolName: string;
  resourceUri: string;
}

/**
 * Phase 5.5-6: stable resource/prompt structures.
 *
 * Resources and prompts are normalized into these types by the clients; MCP
 * SDK objects never leave the client layer. Resources/prompts are deliberately
 * NOT ToolDefinitions (no execution semantics).
 */

/** A resource discovered from an MCP server (resources/list, normalized). */
export interface MCPResourceDescriptor {
  serverId: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** One contents entry of a resources/read result: text XOR base64 blob. */
export interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  /** base64-encoded binary payload exactly as transferred by the protocol. */
  blob?: string;
}

export interface MCPResourceReadResult {
  serverId: string;
  contents: MCPResourceContent[];
}

/** One declared prompt argument (prompts/list, normalized). */
export interface MCPPromptArgument {
  name: string;
  description?: string;
  required: boolean;
}

/** A prompt discovered from an MCP server (prompts/list, normalized). */
export interface MCPPromptDescriptor {
  serverId: string;
  name: string;
  description?: string;
  arguments: MCPPromptArgument[];
}

export type MCPPromptMessageRole = "user" | "assistant";

/** One converted prompt message content block. */
export type MCPPromptMessageContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: MCPResourceContent }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string };

export interface MCPPromptMessage {
  role: MCPPromptMessageRole;
  content: MCPPromptMessageContent;
}

export interface MCPPromptResult {
  serverId: string;
  name: string;
  description?: string;
  messages: MCPPromptMessage[];
}

/**
 * Risk policy for read-only capabilities (resource reads / prompt gets),
 * decided by the PLATFORM, never by the MCP server. `undefined` from a policy
 * provider DENIES the capability (fail-closed, same rule as tool policy).
 */
export interface MCPCapabilityPolicy {
  riskLevel: ToolRiskLevel;
}

/**
 * Protocol-layer port. Implementations (Phase 5.5-1) use the official MCP SDK.
 * The port exposes no policy, credential, or audit capability.
 *
 * Phase 5.5-6 extends the port with the resource/prompt protocol surface
 * (listResources / readResource / listPrompts / getPrompt). The tool surface
 * is unchanged; no second MCP client exists.
 */
export interface MCPClientPort {
  connect(server: MCPServerDefinition): Promise<void>;
  disconnect(serverId: string): Promise<void>;
  listTools(serverId: string): Promise<MCPToolDefinition[]>;
  callTool(serverId: string, name: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
  /** resources/list — normalized; MCP SDK objects never leave the client. */
  listResources(serverId: string): Promise<MCPResourceDescriptor[]>;
  /** resources/read — normalized contents (text XOR blob). */
  readResource(serverId: string, uri: string, signal?: AbortSignal): Promise<MCPResourceReadResult>;
  /** prompts/list — normalized; MCP SDK objects never leave the client. */
  listPrompts(serverId: string): Promise<MCPPromptDescriptor[]>;
  /** prompts/get — normalized messages (role + converted content). */
  getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<MCPPromptResult>;
}

/**
 * Adapter between the unified Tool Runtime and one MCP tool.
 *
 * The adapter only bridges MCP Tool → MCP Client → MCP Server → Result.
 * Schema validation, permission, risk, approval, timeout, cancellation, audit,
 * secret redaction, and error classification remain Tool Runtime concerns and
 * must NOT be re-implemented here.
 */
export interface MCPToolAdapter {
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}

/** Wires one adapter to one tool of one server. Implementation lands in 5.5-2. */
export type MCPToolAdapterFactory = (
  client: MCPClientPort,
  serverId: string,
  toolName: string
) => MCPToolAdapter;

/** Risk/approval policy decided by the PLATFORM, never by the MCP server. */
export interface MCPToolPolicy {
  riskLevel: ToolRiskLevel;
  requiresApproval: boolean;
}

export type UnifiedToolSource = "native" | "mcp" | "browser" | "sandbox";

/**
 * Frozen mapping layer from MCPToolDefinition to the existing unified
 * ToolDefinition (packages/tool-runtime/src/types.ts).
 *
 * The current ToolDefinition carries { name, description, riskLevel,
 * inputSchema (Zod), execute }. It has no `source` / `requiresApproval` fields,
 * so this metadata type carries the MCP-specific extras that Phase 5.5-2 will
 * attach when it assembles the full unified ToolDefinition
 * (Zod-converted schema + adapter-backed execute).
 */
export interface UnifiedToolMetadata {
  name: string;
  description: string;
  source: UnifiedToolSource;
  riskLevel: ToolRiskLevel;
  requiresApproval: boolean;
  mcpServerId?: string;
  mcpToolName?: string;
}

/** Maps one MCP tool plus platform policy to unified tool metadata. */
export function toUnifiedToolMetadata(
  tool: Pick<MCPToolDefinition, "name" | "description" | "serverId">,
  policy: MCPToolPolicy
): UnifiedToolMetadata {
  return {
    name: tool.name,
    description: tool.description,
    source: "mcp",
    riskLevel: policy.riskLevel,
    requiresApproval: policy.requiresApproval,
    mcpServerId: tool.serverId,
    mcpToolName: tool.name
  };
}

export class MCPContractError extends Error {}

/**
 * Heuristic for credential-shaped values: JWT payloads and common token
 * prefixes. References like "secret:mcp/servers/github" pass; actual tokens fail.
 */
const CREDENTIAL_VALUE_PATTERN = /^(eyJ|sk-|ghp_|gho_|ghu_|ghs_|xox[baprs]-|Bearer\s)/i;

/**
 * Key names that must never appear as plaintext config keys. Substring-based
 * parts, aligned with the sensitive-key convention of @ai-se/observability.
 */
const CREDENTIAL_KEY_PARTS = [
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "token",
  "password",
  "secret",
  "private_key",
  "access_key",
  "credential"
];

function isCredentialKey(key: string): boolean {
  const normalized = key.replace(/[-\s]/g, "_").toLowerCase();
  return CREDENTIAL_KEY_PARTS.some((part) => normalized.includes(part));
}

function credentialReferenceSchema(field: string): z.ZodType<string> {
  return z
    .string()
    .trim()
    .min(1, `${field} must not be empty`)
    .max(300)
    .refine(
      (value) => !CREDENTIAL_VALUE_PATTERN.test(value),
      `${field} must be a credential reference, not a plaintext credential`
    );
}

const MCPStdioConfigSchema = z
  .object({
    command: z.string().trim().min(1).max(1000),
    args: z.array(z.string().trim().min(1).max(500)).max(64).optional(),
    env: z
      .record(
        z
          .string()
          .refine(
            (key) => !isCredentialKey(key),
            "plaintext credential keys are forbidden in stdio env; use credentialRef"
          ),
        z.string()
      )
      .optional(),
    cwd: z.string().trim().min(1).max(1000).optional()
  })
  .strict();

const MCPServerDefinitionSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).optional(),
    transport: z.enum(["stdio", "streamable-http"]),
    stdio: MCPStdioConfigSchema.optional(),
    endpoint: z.string().trim().min(1).max(2000).optional(),
    enabled: z.boolean(),
    authRef: credentialReferenceSchema("authRef").optional(),
    credentialRef: credentialReferenceSchema("credentialRef").optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.transport === "stdio" && !value.stdio) {
      context.addIssue({
        code: "custom",
        path: ["stdio"],
        message: "stdio config is required for stdio transport"
      });
    }
    if (value.transport === "streamable-http") {
      if (!value.endpoint) {
        context.addIssue({
          code: "custom",
          path: ["endpoint"],
          message: "endpoint is required for streamable-http transport"
        });
      } else {
        try {
          const url = new URL(value.endpoint);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            context.addIssue({
              code: "custom",
              path: ["endpoint"],
              message: "endpoint must be an http or https URL"
            });
          }
          if (url.username || url.password) {
            context.addIssue({
              code: "custom",
              path: ["endpoint"],
              message: "endpoint must not embed credentials; use credentialRef"
            });
          }
        } catch {
          context.addIssue({
            code: "custom",
            path: ["endpoint"],
            message: "endpoint must be a valid URL"
          });
        }
      }
      if (value.stdio) {
        context.addIssue({
          code: "custom",
          path: ["stdio"],
          message: "stdio config is not allowed for streamable-http transport"
        });
      }
    }
  });

/**
 * Validates a server definition against the frozen contract and throws
 * MCPContractError on the first problem. Guarantees no plaintext credential
 * field or credential-shaped reference can enter the MCP layer.
 */
export function validateMCPServerDefinition(input: unknown): MCPServerDefinition {
  const parsed = MCPServerDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    throw new MCPContractError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "definition"}: ${issue.message}`)
        .join("; ")
    );
  }
  return parsed.data;
}
