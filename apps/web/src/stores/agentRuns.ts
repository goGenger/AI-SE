import {
  AgentRun,
  AgentRunDetailView,
  AgentRunStreamPayload,
  AgentRunSummary
} from "@ai-se/shared";
import { defineStore } from "pinia";
import {
  cancelAgentRun,
  createAgentRun,
  getAgentRun,
  listAgentRuns,
  openAgentRunStream,
  runCodingAgentDemo
} from "../api/agentRuns";

interface AgentRunsState {
  runs: AgentRunSummary[];
  currentRun: AgentRunDetailView | null;
  loading: boolean;
  detailLoading: boolean;
  creating: boolean;
  cancelling: boolean;
  error: string;
}

let eventSource: EventSource | null = null;
let poller: ReturnType<typeof setInterval> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Agent 运行失败";
}

function isTerminal(status: AgentRun["status"]): boolean {
  return ["succeeded", "failed", "cancelled", "timed_out"].includes(status);
}

/**
 * UX-03: realtime snapshots / fresh creations may introduce a run before the
 * enriched list loads; keep the item shape valid (input carries taskKey /
 * agentName / workflowRunId for workflow-spawned runs) until `loadRuns` replaces
 * it with the server-resolved names.
 */
function toSummary(run: AgentRun): AgentRunSummary {
  return {
    ...run,
    projectName: null,
    workflowRunId: typeof run.input.workflowRunId === "string" ? run.input.workflowRunId : null,
    requirementName: null,
    planningVersion: null,
    taskKey: typeof run.input.taskKey === "string" ? run.input.taskKey : null,
    taskTitle: null,
    agentName: typeof run.input.agentName === "string" ? run.input.agentName : null,
    agentType: typeof run.input.agentType === "string" ? run.input.agentType : null
  };
}

function stopRealtime(): void {
  eventSource?.close();
  eventSource = null;
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
}

export const useAgentRunsStore = defineStore("agentRuns", {
  state: (): AgentRunsState => ({
    runs: [],
    currentRun: null,
    loading: false,
    detailLoading: false,
    creating: false,
    cancelling: false,
    error: ""
  }),
  actions: {
    applySnapshot(snapshot: AgentRunStreamPayload) {
      this.currentRun = snapshot;
      const index = this.runs.findIndex((run) => run.id === snapshot.run.id);
      if (index >= 0) {
        this.runs[index] = { ...this.runs[index], ...snapshot.run };
      } else {
        this.runs.unshift(toSummary(snapshot.run));
      }

      if (isTerminal(snapshot.run.status)) {
        stopRealtime();
      }
    },

    async loadRuns() {
      this.loading = true;
      this.error = "";
      try {
        this.runs = await listAgentRuns();
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.loading = false;
      }
    },

    async loadRun(id: string) {
      this.detailLoading = true;
      this.error = "";
      try {
        this.currentRun = await getAgentRun(id);
        this.startRealtime(id);
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.detailLoading = false;
      }
    },

    async create(task: string) {
      this.creating = true;
      this.error = "";
      try {
        const run = await createAgentRun({ task });
        this.runs.unshift(toSummary(run));
        await this.loadRun(run.id);
        // UX-03: refresh the list so the new item carries server-resolved context.
        void this.loadRuns();
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.creating = false;
      }
    },

    async cancelCurrentRun() {
      if (!this.currentRun) {
        return;
      }

      this.cancelling = true;
      this.error = "";
      try {
        const run = await cancelAgentRun(this.currentRun.run.id);
        this.currentRun.run = run;
        const index = this.runs.findIndex((entry) => entry.id === run.id);
        if (index >= 0) {
          this.runs[index] = { ...this.runs[index], ...run };
        }
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.cancelling = false;
      }
    },

    startRealtime(id: string) {
      stopRealtime();
      if (typeof EventSource === "undefined") {
        this.startPolling(id);
        return;
      }

      eventSource = openAgentRunStream(
        id,
        (snapshot) => this.applySnapshot(snapshot),
        () => {
          eventSource?.close();
          eventSource = null;
          this.startPolling(id);
        }
      );
    },

    startPolling(id: string) {
      if (poller) {
        return;
      }

      poller = setInterval(() => {
        void getAgentRun(id)
          .then((detail) => {
            this.applySnapshot(detail);
          })
          .catch((error: unknown) => {
            this.error = errorMessage(error);
          });
      }, 2_000);
    },

    stopRealtime() {
      stopRealtime();
    },

    async runDemo(task: string) {
      this.creating = true;
      this.error = "";
      try {
        const view = await runCodingAgentDemo(task);
        await this.loadRun(view.agentRunId);
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.creating = false;
      }
    }
  }
});
