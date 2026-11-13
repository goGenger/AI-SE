import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  MCPClientPort,
  MCPPromptDescriptor,
  MCPPromptResult,
  MCPResourceDescriptor,
  MCPResourceReadResult,
  MCPServerDefinition,
  MCPToolDefinition,
  validateMCPServerDefinition
} from "../contracts";
import { MCPErrorCategory } from "../errors";
import { MCPCredentialResolver, redactCredentialShapedText } from "../security/credentials";
import { MCPClientError } from "./MCPClientError";
import {
  normalizePromptDescriptor,
  normalizePromptResult,
  normalizeResourceContents,
  normalizeResourceDescriptor,
  toolUiResourceUri
} from "./normalize";

/**
 * Phase 5.5-4: Remote MCP client over the standard Streamable HTTP transport
 * (official SDK; NOT the legacy HTTP+SSE session model).
 *
 * Responsibilities are transport-lifecycle ONLY:
 *   connect / disconnect / listTools / callTool  (MCPClientPort)
 *   bounded reconnect with exponential backoff   (single-flight, cancellable)
 *   connection state events                      (for the Registry)
 *   credential REFERENCE resolution + header injection (controlled path only)
 *
 * Tool Runtime semantics (validation, audit, timeout mapping, approval) stay
 * where they are — this client never bypasses the adapter/ToolRuntime chain.
 */

export type MCPRemoteConnectionState =
  | "CONNECTING"
  | "CONNECTED"
  | "DEGRADED"
  | "RECONNECTING"
  | "DISCONNECTED";

export interface MCPRemoteStateEvent {
  serverId: string;
  state: MCPRemoteConnectionState;
  /** Present for RECONNECTING: the 1-based attempt number. */
  attempt?: number;
  /** Redacted human-readable reason (never contains credential material). */
  error?: string;
}

export interface MCPRemoteReconnectPolicy {
  /** Bounded retry: total attempts per reconnect cycle. */
  maxAttempts: number;
  initialDelayMs: number;
  /** Exponential backoff factor. */
  factor: number;
  maxDelayMs: number;
}

export interface RemoteMCPClientOptions {
  /** Platform-supplied credential resolver; required only when a definition carries a ref. */
  credentialResolver?: MCPCredentialResolver;
  /** Bounded reconnect policy. Defaults: 3 attempts, 250ms * 2^n, cap 4s. */
  reconnect?: Partial<MCPRemoteReconnectPolicy>;
  /** Per-connect-attempt timeout (initialize round-trip included). */
  connectionTimeoutMs?: number;
  /** Static non-secret headers (e.g. routing/tenant headers). Never credentials. */
  requestHeaders?: Record<string, string>;
  /** Connection state listener (used by the Registry to persist status). */
  onStateChange?: (event: MCPRemoteStateEvent) => void;
}

interface RemoteConnection {
  definition: MCPServerDefinition;
  transport: StreamableHTTPClientTransport;
  client: Client;
}

interface ReconnectTask {
  promise: Promise<void>;
  controller: AbortController;
}

const CLIENT_INFO = { name: "ai-se-remote-mcp-client", version: "0.1.0" };

const DEFAULT_RECONNECT: MCPRemoteReconnectPolicy = {
  maxAttempts: 3,
  initialDelayMs: 250,
  factor: 2,
  maxDelayMs: 4000
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text payload of a CallToolResult error: concat of text content entries. */
function toolErrorText(result: { content: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter(
      (entry): entry is { type: string; text: string } =>
        isRecord(entry) && entry.type === "text" && typeof entry.text === "string"
    )
    .map((entry) => entry.text)
    .join("\n");
}

/**
 * Pure mapping from Remote MCP failures onto the frozen MCPErrorCategory.
 * Declared categories (MCPClientError) always win; SDK protocol errors are
 * classified like the stdio client; HTTP transport errors add status mapping:
 *   401/403 → PERMISSION_DENIED, 404/405/5xx → CONNECTION, network → CONNECTION.
 */
export function classifyRemoteMCPClientError(error: unknown, aborted: boolean): MCPErrorCategory {
  if (aborted) return "CANCELLED";
  if (error instanceof MCPClientError) return error.mcpErrorCategory;
  if (error instanceof McpError) {
    switch (error.code) {
      case ErrorCode.RequestTimeout:
        return "TIMEOUT";
      case ErrorCode.ConnectionClosed:
        return "CONNECTION";
      case ErrorCode.MethodNotFound:
      case ErrorCode.InvalidParams:
      case ErrorCode.InternalError:
        return "REMOTE_TOOL";
      default:
        return "INTERNAL";
    }
  }
  if (error instanceof Error && error.name === "AbortError") return "CANCELLED";

  // HTTP transport errors (StreamableHTTPError carries the status code).
  const code = isRecord(error) && typeof error.code === "number" ? error.code : undefined;
  if (typeof code === "number") {
    if (code === 401 || code === 403) return "PERMISSION_DENIED";
    if (code === 404 || code === 405 || code >= 500) return "CONNECTION";
    return "INTERNAL";
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  if (
    /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|other side closed|terminated/i.test(
      message
    )
  ) {
    return "CONNECTION";
  }
  if (
    /boundary|Unexpected token|JSON/i.test(message) &&
    /parse|Invalid|Unexpected/i.test(message)
  ) {
    return "CONNECTION";
  }
  return "INTERNAL";
}

export class RemoteMCPClient implements MCPClientPort {
  private readonly connections = new Map<string, RemoteConnection>();
  private readonly definitions = new Map<string, MCPServerDefinition>();
  private readonly states = new Map<string, MCPRemoteConnectionState>();
  private readonly reconnectTasks = new Map<string, ReconnectTask>();
  private readonly closing = new Set<string>();
  /** Resolved secret values kept ONLY to scrub them from outgoing messages. */
  private readonly knownSecrets = new Set<string>();
  private readonly reconnectPolicy: MCPRemoteReconnectPolicy;

  constructor(private readonly options: RemoteMCPClientOptions = {}) {
    this.reconnectPolicy = { ...DEFAULT_RECONNECT, ...options.reconnect };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async connect(server: MCPServerDefinition): Promise<void> {
    const definition = validateMCPServerDefinition(server);
    if (definition.transport !== "streamable-http") {
      throw new MCPClientError(
        "CONNECTION",
        `RemoteMCPClient requires transport "streamable-http", got "${definition.transport}"`
      );
    }
    if (!definition.enabled) {
      throw new MCPClientError("CONNECTION", `Server ${definition.id} is disabled`);
    }
    if (this.connections.has(definition.id)) {
      throw new MCPClientError("CONNECTION", `Server ${definition.id} is already connected`);
    }

    this.setState(definition.id, "CONNECTING");
    this.definitions.set(definition.id, definition);
    try {
      await this.openTransport(definition);
      this.setState(definition.id, "CONNECTED");
    } catch (error) {
      this.definitions.delete(definition.id);
      this.setState(definition.id, "DISCONNECTED", this.redact(messageOf(error, "connect failed")));
      throw this.wrapError(error);
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    const task = this.reconnectTasks.get(serverId);
    if (!connection && !task) {
      throw new MCPClientError("CONNECTION", `Not connected: ${serverId}`);
    }
    this.closing.add(serverId);
    this.cancelReconnect(serverId);
    try {
      // Let an in-flight reconnect cycle wind down before closing, so it
      // cannot re-establish a connection after this deliberate disconnect.
      if (task) await task.promise.catch(() => undefined);
      const current = this.connections.get(serverId);
      if (current) {
        this.connections.delete(serverId);
        await closeQuietly(current.client, current.transport);
      }
      this.definitions.delete(serverId);
    } finally {
      this.closing.delete(serverId);
      this.setState(serverId, "DISCONNECTED");
    }
  }

  async listTools(serverId: string): Promise<MCPToolDefinition[]> {
    const connection = this.requireConnection(serverId);
    try {
      const result = await connection.client.listTools();
      return result.tools.map((tool) => ({
        serverId,
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        uiResourceUri: toolUiResourceUri(tool)
      }));
    } catch (error) {
      const wrapped = this.wrapError(error, false);
      if (wrapped.mcpErrorCategory === "CONNECTION") this.noteConnectionFailure(serverId);
      throw wrapped;
    }
  }

  async callTool(
    serverId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const connection = this.requireConnection(serverId);
    try {
      const result = await connection.client.callTool(
        { name, arguments: isRecord(input) ? input : { input } },
        undefined,
        { signal }
      );
      if (result.isError) {
        const content = "content" in result ? result.content : [];
        throw new MCPClientError("REMOTE_TOOL", toolErrorText({ content }));
      }
      return result;
    } catch (error) {
      const wrapped = this.wrapError(error, signal?.aborted ?? false);
      if (wrapped.mcpErrorCategory === "CONNECTION") this.noteConnectionFailure(serverId);
      throw wrapped;
    }
  }

  // ── Phase 5.5-6: resource / prompt protocol surface ──────────────────────

  async listResources(serverId: string): Promise<MCPResourceDescriptor[]> {
    const connection = this.requireConnection(serverId);
    try {
      const result = await connection.client.listResources();
      return result.resources.map((resource) => normalizeResourceDescriptor(serverId, resource));
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async readResource(
    serverId: string,
    uri: string,
    signal?: AbortSignal
  ): Promise<MCPResourceReadResult> {
    const connection = this.requireConnection(serverId);
    try {
      const result = await connection.client.readResource({ uri }, { signal });
      return { serverId, contents: normalizeResourceContents(serverId, result.contents) };
    } catch (error) {
      const wrapped = this.wrapError(error, signal?.aborted ?? false);
      if (wrapped.mcpErrorCategory === "CONNECTION") this.noteConnectionFailure(serverId);
      throw wrapped;
    }
  }

  async listPrompts(serverId: string): Promise<MCPPromptDescriptor[]> {
    const connection = this.requireConnection(serverId);
    try {
      const result = await connection.client.listPrompts();
      return result.prompts.map((prompt) => normalizePromptDescriptor(serverId, prompt));
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<MCPPromptResult> {
    const connection = this.requireConnection(serverId);
    try {
      const result = await connection.client.getPrompt({ name, arguments: args }, { signal });
      return normalizePromptResult(serverId, name, result);
    } catch (error) {
      const wrapped = this.wrapError(error, signal?.aborted ?? false);
      if (wrapped.mcpErrorCategory === "CONNECTION") this.noteConnectionFailure(serverId);
      throw wrapped;
    }
  }

  // ── Reconnect (bounded, single-flight, cancellable) ─────────────────────

  /**
   * Controlled reconnect for a server whose connection was lost. Runs at most
   * ONE cycle per server (concurrent calls share the in-flight cycle), with
   * bounded attempts and exponential backoff. Exhaustion ends in DISCONNECTED.
   */
  reconnect(serverId: string): Promise<void> {
    const existing = this.reconnectTasks.get(serverId);
    if (existing) return existing.promise; // single-flight: no concurrent cycle
    const definition = this.definitions.get(serverId);
    if (!definition) {
      return Promise.reject(
        new MCPClientError("CONNECTION", `No stored definition for ${serverId}; not connected`)
      );
    }
    const controller = new AbortController();
    const promise = this.runReconnectCycle(serverId, definition, controller.signal).finally(() => {
      this.reconnectTasks.delete(serverId);
    });
    this.reconnectTasks.set(serverId, { promise, controller });
    return promise;
  }

  /** Cancels an in-flight reconnect cycle (e.g. deliberate disconnect). */
  cancelReconnect(serverId: string): void {
    this.reconnectTasks.get(serverId)?.controller.abort();
  }

  getConnectionState(serverId: string): MCPRemoteConnectionState | undefined {
    return this.states.get(serverId);
  }

  private async runReconnectCycle(
    serverId: string,
    definition: MCPServerDefinition,
    signal: AbortSignal
  ): Promise<void> {
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= this.reconnectPolicy.maxAttempts; attempt += 1) {
      if (signal.aborted) {
        this.setState(serverId, "DISCONNECTED", "reconnect cancelled");
        return;
      }
      this.setState(serverId, "RECONNECTING", undefined, attempt);
      const delay = Math.min(
        this.reconnectPolicy.initialDelayMs * this.reconnectPolicy.factor ** (attempt - 1),
        this.reconnectPolicy.maxDelayMs
      );
      if (!(await sleep(delay, signal))) {
        this.setState(serverId, "DISCONNECTED", "reconnect cancelled");
        return;
      }
      try {
        await this.openTransport(definition);
        this.setState(serverId, "CONNECTED");
        return;
      } catch (error) {
        lastError = this.redact(messageOf(error, "reconnect attempt failed"));
      }
    }
    this.setState(serverId, "DISCONNECTED", lastError ?? "reconnect attempts exhausted");
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async openTransport(definition: MCPServerDefinition): Promise<void> {
    const headers = await this.resolveHeaders(definition);
    const transport = new StreamableHTTPClientTransport(new URL(definition.endpoint!), {
      requestInit: headers ? { headers } : undefined
    });
    // Handlers are set BEFORE connect so the SDK's protocol chains (not
    // replaces) them — a lost connection flips the server to DEGRADED and
    // starts a bounded reconnect.
    transport.onclose = () => this.handleConnectionLost(definition.id, transport);
    transport.onerror = (error) => {
      if (this.connections.get(definition.id)?.transport === transport) {
        this.setState(definition.id, "DEGRADED", this.redact(messageOf(error, "transport error")));
      }
    };

    const client = new Client(CLIENT_INFO);
    try {
      await this.connectWithTimeout(client, transport);
    } catch (error) {
      await closeQuietly(undefined, transport);
      throw error;
    }
    this.connections.set(definition.id, { definition, transport, client });
  }

  private async connectWithTimeout(
    client: Client,
    transport: StreamableHTTPClientTransport
  ): Promise<void> {
    const timeoutMs = this.options.connectionTimeoutMs;
    if (!timeoutMs) {
      await client.connect(transport);
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void transport.close().catch(() => undefined);
    }, timeoutMs);
    try {
      await client.connect(transport);
    } catch (error) {
      if (timedOut) {
        throw new MCPClientError("TIMEOUT", `MCP connection timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private handleConnectionLost(serverId: string, transport: StreamableHTTPClientTransport): void {
    const connection = this.connections.get(serverId);
    if (connection?.transport !== transport) return; // connect-time noise or stale transport
    this.noteConnectionFailure(serverId);
  }

  /**
   * Marks the connection lost AFTER a failed request (stateless HTTP has no
   * standing socket, so a request failure is the loss signal): the server goes
   * DEGRADED and a bounded, single-flight reconnect starts.
   */
  private noteConnectionFailure(serverId: string): void {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    this.connections.delete(serverId);
    if (this.closing.has(serverId)) return;
    this.setState(serverId, "DEGRADED", "connection lost");
    void this.reconnect(serverId); // bounded, single-flight
  }

  private async resolveHeaders(
    definition: MCPServerDefinition
  ): Promise<Record<string, string> | undefined> {
    const reference = definition.credentialRef ?? definition.authRef;
    const kind = definition.credentialRef ? "credentialRef" : "authRef";
    const staticHeaders = this.options.requestHeaders;
    if (!reference) {
      return staticHeaders ? { ...staticHeaders } : undefined;
    }
    if (!this.options.credentialResolver) {
      throw new MCPClientError(
        "CONNECTION",
        `Server ${definition.id} references credential "${reference}" but no credential resolver is configured`
      );
    }
    let resolved;
    try {
      resolved = await this.options.credentialResolver({
        serverId: definition.id,
        kind,
        reference
      });
    } catch {
      // Never propagate resolver internals (they may include secret material).
      throw new MCPClientError("CONNECTION", `Credential resolution failed for "${reference}"`);
    }
    if (resolved === undefined || resolved === null) {
      throw new MCPClientError(
        "CONNECTION",
        `Credential resolution returned no value for "${reference}"`
      );
    }
    const headers: Record<string, string> = { ...(staticHeaders ?? {}) };
    if (typeof resolved === "string") {
      this.knownSecrets.add(resolved);
      headers.Authorization = `Bearer ${resolved}`;
    } else {
      for (const [key, value] of Object.entries(resolved.headers)) {
        this.knownSecrets.add(value.replace(/^Bearer\s+/i, ""));
        headers[key] = value;
      }
    }
    return headers;
  }

  private requireConnection(serverId: string): RemoteConnection {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new MCPClientError("CONNECTION", `Not connected: ${serverId}`);
    }
    return connection;
  }

  private wrapError(error: unknown, aborted = false): MCPClientError {
    if (error instanceof MCPClientError) return error;
    const category = classifyRemoteMCPClientError(error, aborted);
    return new MCPClientError(
      category,
      this.redact(messageOf(error, `MCP ${category.toLowerCase()} error`)),
      error
    );
  }

  /** Scrubs credential-shaped material and any resolved secret from a message. */
  private redact(message: string): string {
    return redactCredentialShapedText(message, this.knownSecrets);
  }

  private setState(
    serverId: string,
    state: MCPRemoteConnectionState,
    error?: string,
    attempt?: number
  ): void {
    this.states.set(serverId, state);
    try {
      this.options.onStateChange?.({
        serverId,
        state,
        ...(attempt !== undefined ? { attempt } : {}),
        ...(error ? { error: this.redact(error) } : {})
      });
    } catch {
      // State listeners must never break the client.
    }
  }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

async function closeQuietly(
  client: Client | undefined,
  transport: StreamableHTTPClientTransport
): Promise<void> {
  try {
    await client?.close();
  } catch {
    // Cleanup-phase failures are swallowed; the connection is dropped either way.
  }
  try {
    await transport.close();
  } catch {
    // The transport may already be closed.
  }
}

/** Abortable sleep; resolves false when aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
