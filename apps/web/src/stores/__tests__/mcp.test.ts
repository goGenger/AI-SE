import {
  MCPBindingSummary,
  MCPServerDetail,
  MCPServerSummary,
  MCPToolSummary
} from "@ai-se/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMCPBinding,
  deleteMCPBinding,
  getMCPServer,
  listMCPBindings,
  listMCPServers,
  listMCPTools,
  updateMCPBinding
} from "../../api/mcp";
import { useMCPStore } from "../mcp";

vi.mock("../../api/mcp", () => ({
  createMCPBinding: vi.fn(),
  deleteMCPBinding: vi.fn(),
  getMCPServer: vi.fn(),
  listMCPBindings: vi.fn(),
  listMCPServers: vi.fn(),
  listMCPTools: vi.fn(),
  updateMCPBinding: vi.fn()
}));

const mocked = {
  createMCPBinding: vi.mocked(createMCPBinding),
  deleteMCPBinding: vi.mocked(deleteMCPBinding),
  getMCPServer: vi.mocked(getMCPServer),
  listMCPBindings: vi.mocked(listMCPBindings),
  listMCPServers: vi.mocked(listMCPServers),
  listMCPTools: vi.mocked(listMCPTools),
  updateMCPBinding: vi.mocked(updateMCPBinding)
};

function server(overrides: Partial<MCPServerSummary> = {}): MCPServerSummary {
  return {
    id: "server-1",
    name: "fake-stdio",
    description: "fixture",
    transport: "stdio",
    enabled: true,
    status: "CONNECTED",
    toolCount: 3,
    ...overrides
  };
}

function detail(): MCPServerDetail {
  return {
    ...server(),
    command: "node",
    args: ["fake-entry.js"],
    credentialRef: "vault://mcp/demo",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z"
  };
}

function tool(): MCPToolSummary {
  return {
    id: "tool-1",
    serverId: "server-1",
    name: "echo",
    description: "Echo input",
    enabled: true,
    riskLevel: "MEDIUM",
    requiresApproval: false,
    inputSchemaSummary: "No parameters"
  };
}

function binding(overrides: Partial<MCPBindingSummary> = {}): MCPBindingSummary {
  return {
    id: "binding-1",
    projectId: "project-1",
    agentName: "dev-agent",
    serverId: "server-1",
    enabled: true,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides
  };
}

describe("mcp store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("loads the server list and surfaces failures", async () => {
    const store = useMCPStore();
    mocked.listMCPServers.mockResolvedValueOnce([server()]);
    await store.fetchServers();
    expect(store.servers).toHaveLength(1);
    expect(store.error).toBe("");
    expect(store.loading).toBe(false);

    mocked.listMCPServers.mockRejectedValueOnce(new Error("registry down"));
    await store.fetchServers();
    expect(store.error).toBe("registry down");
  });

  it("loads detail, tools and bindings together", async () => {
    const store = useMCPStore();
    mocked.getMCPServer.mockResolvedValueOnce(detail());
    mocked.listMCPTools.mockResolvedValueOnce([tool()]);
    mocked.listMCPBindings.mockResolvedValueOnce([binding()]);

    await store.fetchServerDetail("server-1");
    expect(store.selectedServer?.name).toBe("fake-stdio");
    expect(store.tools).toHaveLength(1);
    expect(store.bindings).toHaveLength(1);

    mocked.getMCPServer.mockRejectedValueOnce(new Error("MCP server not found"));
    await store.fetchServerDetail("missing");
    expect(store.selectedServer).toBeNull();
    expect(store.tools).toHaveLength(0);
    expect(store.error).toBe("MCP server not found");
  });

  it("creates a binding and refetches the scope list", async () => {
    const store = useMCPStore();
    mocked.createMCPBinding.mockResolvedValueOnce(binding({ id: "binding-2" }));
    mocked.listMCPBindings.mockResolvedValueOnce([binding(), binding({ id: "binding-2" })]);

    await store.createBinding("server-1", { projectId: "project-1", agentName: "dev-agent" });
    expect(mocked.createMCPBinding).toHaveBeenCalledWith("server-1", {
      projectId: "project-1",
      agentName: "dev-agent"
    });
    expect(store.bindings).toHaveLength(2);
  });

  it("toggles and revokes bindings, refetching the selected server scope", async () => {
    const store = useMCPStore();
    mocked.getMCPServer.mockResolvedValueOnce(detail());
    mocked.listMCPTools.mockResolvedValueOnce([]);
    mocked.listMCPBindings.mockResolvedValueOnce([binding()]);
    await store.fetchServerDetail("server-1");

    mocked.updateMCPBinding.mockResolvedValueOnce(binding({ enabled: false }));
    mocked.listMCPBindings.mockResolvedValueOnce([binding({ enabled: false })]);
    await store.setBindingEnabled("binding-1", false);
    expect(mocked.updateMCPBinding).toHaveBeenCalledWith("binding-1", { enabled: false });
    expect(store.bindings[0].enabled).toBe(false);

    mocked.deleteMCPBinding.mockResolvedValueOnce({ id: "binding-1" });
    mocked.listMCPBindings.mockResolvedValueOnce([]);
    await store.deleteBinding("binding-1");
    expect(mocked.deleteMCPBinding).toHaveBeenCalledWith("binding-1");
    expect(store.bindings).toHaveLength(0);
  });
});
