/**
 * Phase 5.5-4: credential REFERENCE resolution for Remote MCP.
 *
 * This module is an interface + redaction utility ONLY. It is deliberately not
 * a secret store: the platform supplies a resolver (or nothing at all when no
 * remote server carries a reference). Resolved values exist solely inside the
 * controlled execution path (building HTTP request headers) and are never
 * persisted, logged, echoed into results, or attached to errors.
 */

export interface MCPCredentialResolutionRequest {
  serverId: string;
  /** Which reference field triggered the resolution. */
  kind: "authRef" | "credentialRef";
  /** The reference itself (e.g. "secret:mcp/servers/github"); never the secret. */
  reference: string;
}

/**
 * A resolved credential: either a bearer token string (convenience) or an
 * explicit set of HTTP headers the platform wants injected.
 */
export type MCPCredentialValue = string | { headers: Record<string, string> };

export type MCPCredentialResolver = (
  request: MCPCredentialResolutionRequest
) => MCPCredentialValue | undefined | Promise<MCPCredentialValue | undefined>;

import { redactCredentialShapedText as redactCredentialShapedTextShared } from "@ai-se/observability";

/**
 * Redacts credential-shaped substrings plus any explicitly known secret value
 * from a text. Used before a message is stored (lastError), thrown, or logged.
 *
 * Phase 5.6: implementation sank to `@ai-se/observability` (single source of
 * truth); this re-export keeps every 5.5 caller unchanged.
 */
export const redactCredentialShapedText = redactCredentialShapedTextShared;
