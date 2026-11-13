import { defineStore } from "pinia";
import {
  listAutonomyRuns,
  type AutonomyRunRecord
} from "../api/autonomyRuns";

interface State {
  runs: AutonomyRunRecord[];
  current: AutonomyRunRecord | null;
  loading: boolean;
  error: string;
  /** 列表过滤：可选限定到某工作流。 */
  workflowIdFilter: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "自治记录请求失败";
}

export const useAutonomyRunsStore = defineStore("autonomyRuns", {
  state: (): State => ({
    runs: [],
    current: null,
    loading: false,
    error: "",
    workflowIdFilter: ""
  }),
  actions: {
    async load(workflowId?: string) {
      this.loading = true;
      this.error = "";
      if (workflowId !== undefined) this.workflowIdFilter = workflowId;
      try {
        this.runs = await listAutonomyRuns(
          this.workflowIdFilter ? { workflowId: this.workflowIdFilter } : undefined
        );
        if (this.current) {
          this.current = this.runs.find((row) => row.id === this.current!.id) ?? null;
        }
      } catch (error) {
        this.error = message(error);
      } finally {
        this.loading = false;
      }
    },

    select(id: string) {
      this.current = this.runs.find((row) => row.id === id) ?? null;
    },

    clearCurrent() {
      this.current = null;
    }
  }
});
