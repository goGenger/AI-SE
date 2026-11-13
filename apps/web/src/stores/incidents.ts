import type { Incident } from "@ai-se/shared";
import { defineStore } from "pinia";
import { diagnoseIncident, getIncident, listIncidents, remediateIncident } from "../api/incidents";

interface State {
  incidents: Incident[];
  current: Incident | null;
  loading: boolean;
  error: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "事件请求失败";
}

export const useIncidentsStore = defineStore("incidents", {
  state: (): State => ({
    incidents: [],
    current: null,
    loading: false,
    error: ""
  }),
  actions: {
    async load(projectId?: string) {
      this.loading = true;
      this.error = "";
      try {
        this.incidents = await listIncidents(projectId ? { projectId } : undefined);
      } catch (error) {
        this.error = message(error);
      } finally {
        this.loading = false;
      }
    },

    async select(id: string) {
      this.loading = true;
      this.error = "";
      try {
        this.current = await getIncident(id);
      } catch (error) {
        this.error = message(error);
        this.current = null;
      } finally {
        this.loading = false;
      }
    },

    clearCurrent() {
      this.current = null;
    },

    /** 8-B：触发只读诊断并刷新当前详情 / 列表行。 */
    async diagnose(id: string) {
      this.loading = true;
      this.error = "";
      try {
        const incident = await diagnoseIncident(id);
        this.current = incident;
        const index = this.incidents.findIndex((row) => row.id === id);
        if (index >= 0) this.incidents[index] = incident;
        else this.incidents.unshift(incident);
      } catch (error) {
        this.error = message(error);
      } finally {
        this.loading = false;
      }
    },

    /** 8-C：白名单受控修复（默认只创建工作流，不自动 start）。 */
    async remediate(id: string, startWorkflow = false) {
      this.loading = true;
      this.error = "";
      try {
        const result = await remediateIncident(id, { startWorkflow });
        this.current = result.incident;
        const index = this.incidents.findIndex((row) => row.id === id);
        if (index >= 0) this.incidents[index] = result.incident;
        else this.incidents.unshift(result.incident);
      } catch (error) {
        this.error = message(error);
      } finally {
        this.loading = false;
      }
    }
  }
});
