import {
  CreateMCPBindingInput,
  CreateMCPServerInputData,
  MCPBindingSummary,
  MCPServerDetail,
  MCPServerSummary,
  MCPToolSummary
} from "@ai-se/shared";
import { defineStore } from "pinia";
import {
  createMCPBinding as createBindingRequest,
  createMCPServer as createServerRequest,
  deleteMCPBinding as deleteBindingRequest,
  getMCPServer,
  listMCPBindings,
  listMCPServers,
  listMCPTools,
  updateMCPBinding as updateBindingRequest,
  updateMCPTool as updateToolRequest
} from "../api/mcp";

interface MCPState {
  servers: MCPServerSummary[];
  selectedServer: MCPServerDetail | null;
  tools: MCPToolSummary[];
  bindings: MCPBindingSummary[];
  loading: boolean;
  error: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

export const useMCPStore = defineStore("mcp", {
  state: (): MCPState => ({
    servers: [],
    selectedServer: null,
    tools: [],
    bindings: [],
    loading: false,
    error: ""
  }),
  actions: {
    async fetchServers() {
      this.loading = true;
      this.error = "";
      try {
        this.servers = await listMCPServers();
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.loading = false;
      }
    },
    async fetchServerDetail(serverId: string) {
      this.loading = true;
      this.error = "";
      try {
        const [server, tools, bindings] = await Promise.all([
          getMCPServer(serverId),
          listMCPTools(serverId),
          listMCPBindings(serverId)
        ]);
        this.selectedServer = server;
        this.tools = tools;
        this.bindings = bindings;
      } catch (error) {
        this.selectedServer = null;
        this.tools = [];
        this.bindings = [];
        this.error = errorMessage(error);
      } finally {
        this.loading = false;
      }
    },
    async fetchBindings(serverId: string) {
      this.bindings = await listMCPBindings(serverId);
    },
    /** T2：注册服务器；成功后刷新列表（新行的状态可能是「降级」，需要在列表里可见）。 */
    async createServer(input: CreateMCPServerInputData) {
      const server = await createServerRequest(input);
      await this.fetchServers();
      return server;
    },
    async createBinding(serverId: string, input: CreateMCPBindingInput) {
      const binding = await createBindingRequest(serverId, input);
      await this.fetchBindings(serverId);
      return binding;
    },
    async setBindingEnabled(bindingId: string, enabled: boolean) {
      const binding = await updateBindingRequest(bindingId, { enabled });
      if (this.selectedServer) {
        await this.fetchBindings(this.selectedServer.id);
      }
      return binding;
    },
    /** T2：工具启停；就地替换 `tools` 里的那一行，不重新拉整页。 */
    async setToolEnabled(serverId: string, toolId: string, enabled: boolean) {
      const updated = await updateToolRequest(serverId, toolId, { enabled });
      const index = this.tools.findIndex((tool) => tool.id === toolId);
      if (index >= 0) this.tools[index] = updated;
      return updated;
    },
    async deleteBinding(bindingId: string) {
      await deleteBindingRequest(bindingId);
      if (this.selectedServer) {
        await this.fetchBindings(this.selectedServer.id);
      }
    }
  }
});
