import { ToolDefinition, ToolResult } from "@ai-se/tool-runtime";
import { describe, expect, it } from "vitest";
import {
  MCPClientPort,
  MCPContractError,
  MCPToolAdapter,
  MCPServerDefinition,
  UnifiedToolMetadata,
  toUnifiedToolMetadata,
  validateMCPServerDefinition
} from "../contracts";

const stdioServer: MCPServerDefinition = {
  id: "srv-github",
  name: "GitHub MCP",
  description: "GitHub tools",
  transport: "stdio",
  stdio: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { HOME: "/tmp" }
  },
  enabled: true,
  credentialRef: "secret:mcp/servers/github"
};

function validate(input: unknown): MCPServerDefinition {
  return validateMCPServerDefinition(input);
}

describe("MCPClientPort contract", () => {
  it("freezes the port surface (type contract)", () => {
    // `satisfies` enforces the frozen shape at compile time (checked by typecheck).
    const port = {
      connect: async (_server: MCPServerDefinition): Promise<void> => undefined,
      disconnect: async (_serverId: string): Promise<void> => undefined,
      listTools: async (_serverId: string) => [],
      callTool: async (
        _serverId: string,
        _name: string,
        _input: unknown,
        _signal?: AbortSignal
      ): Promise<unknown> => undefined,
      // Phase 5.5-6 resource/prompt surface.
      listResources: async (_serverId: string) => [],
      readResource: async (_serverId: string, _uri: string) => ({
        serverId: _serverId,
        contents: []
      }),
      listPrompts: async (_serverId: string) => [],
      getPrompt: async (_serverId: string, name: string) => ({
        serverId: _serverId,
        name,
        messages: []
      })
    } satisfies MCPClientPort;

    expect(typeof port.connect).toBe("function");
    expect(typeof port.disconnect).toBe("function");
    expect(typeof port.listTools).toBe("function");
    expect(typeof port.callTool).toBe("function");
    expect(typeof port.listResources).toBe("function");
    expect(typeof port.readResource).toBe("function");
    expect(typeof port.listPrompts).toBe("function");
    expect(typeof port.getPrompt).toBe("function");
  });
});

describe("MCPToolAdapter contract", () => {
  it("freezes the adapter surface (type contract)", () => {
    const adapter = {
      execute: async (): Promise<ToolResult> => {
        const result: ToolResult = {
          success: true,
          data: {},
          duration: 1,
          toolName: "echo",
          toolCallId: "call-1",
          audit: {
            requestId: "req-1",
            taskId: "task-1",
            agentRunId: "run-1",
            toolCallId: "call-1",
            toolName: "echo",
            riskLevel: "LOW",
            actor: "test"
          }
        };
        return result;
      }
    } satisfies MCPToolAdapter;

    expect(typeof adapter.execute).toBe("function");
  });
});

describe("Unified Tool mapping contract", () => {
  it("maps an MCP tool plus platform policy to unified metadata", () => {
    const metadata = toUnifiedToolMetadata(
      { name: "create_issue", description: "Creates an issue", serverId: "srv-github" },
      { riskLevel: "HIGH", requiresApproval: true }
    );

    expect(metadata).toEqual({
      name: "create_issue",
      description: "Creates an issue",
      source: "mcp",
      riskLevel: "HIGH",
      requiresApproval: true,
      mcpServerId: "srv-github",
      mcpToolName: "create_issue"
    });
  });

  it("takes risk/approval from platform policy, never from the MCP server", () => {
    const metadata = toUnifiedToolMetadata(
      { name: "dangerous", description: "d", serverId: "srv" },
      { riskLevel: "CRITICAL", requiresApproval: true }
    );
    expect(metadata.riskLevel).toBe("CRITICAL");
    expect(metadata.requiresApproval).toBe(true);
  });

  it("stays assignable to the existing ToolDefinition core fields", () => {
    const metadata: UnifiedToolMetadata = toUnifiedToolMetadata(
      { name: "t", description: "d", serverId: "s" },
      { riskLevel: "LOW", requiresApproval: false }
    );
    // Compile-time check: unified metadata must fit the existing ToolDefinition
    // contract so 5.5-2 can assemble ToolDefinition instances without a second
    // tool-definition system.
    const _core: Pick<ToolDefinition<unknown, unknown>, "name" | "description" | "riskLevel"> = {
      name: metadata.name,
      description: metadata.description,
      riskLevel: metadata.riskLevel
    };
    expect(_core.name).toBe("t");
  });
});

describe("MCPServerDefinition contract", () => {
  it("accepts a valid stdio definition and returns it unchanged", () => {
    expect(validate(stdioServer)).toEqual(stdioServer);
  });

  it("rejects stdio transport without stdio config", () => {
    expect(() => validate({ ...stdioServer, stdio: undefined })).toThrow(MCPContractError);
  });

  it("rejects unknown transports", () => {
    expect(() => validate({ ...stdioServer, transport: "http", stdio: undefined })).toThrow(
      MCPContractError
    );
  });

  it("accepts a streamable-http definition with a valid endpoint", () => {
    const remote = {
      id: "srv-remote",
      name: "Remote MCP",
      transport: "streamable-http",
      endpoint: "https://mcp.example.com/mcp",
      enabled: true,
      credentialRef: "secret:mcp/servers/remote"
    };
    expect(validate(remote)).toEqual(remote);
  });

  it("requires an endpoint for streamable-http and validates it", () => {
    const base = {
      id: "srv-remote",
      name: "Remote MCP",
      transport: "streamable-http",
      enabled: true
    };
    expect(() => validate(base)).toThrow(MCPContractError);
    expect(() => validate({ ...base, endpoint: "not a url" })).toThrow(MCPContractError);
    expect(() => validate({ ...base, endpoint: "ftp://mcp.example.com/mcp" })).toThrow(
      MCPContractError
    );
    expect(() => validate({ ...base, endpoint: "https://user:pass@mcp.example.com/mcp" })).toThrow(
      MCPContractError
    );
  });

  it("rejects stdio config on streamable-http transport", () => {
    expect(() =>
      validate({
        id: "srv-remote",
        name: "Remote MCP",
        transport: "streamable-http",
        endpoint: "https://mcp.example.com/mcp",
        stdio: { command: "node" },
        enabled: true
      })
    ).toThrow(MCPContractError);
  });

  it("rejects unknown top-level fields (no second credential system)", () => {
    expect(() => validate({ ...stdioServer, accessToken: "plain-secret" })).toThrow(
      MCPContractError
    );
  });

  it("rejects plaintext credential keys in stdio env", () => {
    expect(() =>
      validate({
        ...stdioServer,
        stdio: { ...stdioServer.stdio, env: { GITHUB_TOKEN: "ghp_abc" } }
      })
    ).toThrow(MCPContractError);
  });

  it("accepts non-credential env keys", () => {
    const server = validate({
      ...stdioServer,
      stdio: { ...stdioServer.stdio, env: { HOME: "/tmp", NODE_ENV: "test" } }
    });
    expect(server.stdio?.env).toEqual({ HOME: "/tmp", NODE_ENV: "test" });
  });

  it("rejects token-shaped credentialRef values (references only)", () => {
    expect(() => validate({ ...stdioServer, credentialRef: "eyJhbGciOiJIUzI1NiJ9.fake" })).toThrow(
      MCPContractError
    );
    expect(() => validate({ ...stdioServer, credentialRef: "ghp_ABC123def456" })).toThrow(
      MCPContractError
    );
  });

  it("accepts reference-shaped credentialRef / authRef", () => {
    const server = validate({
      ...stdioServer,
      authRef: "auth:oidc/github-app"
    });
    expect(server.authRef).toBe("auth:oidc/github-app");
    expect(server.credentialRef).toBe("secret:mcp/servers/github");
  });

  it("rejects bearer-token-shaped authRef values", () => {
    expect(() => validate({ ...stdioServer, authRef: "Bearer eyJhbGciOiJIUzI1NiJ9.fake" })).toThrow(
      MCPContractError
    );
  });
});
