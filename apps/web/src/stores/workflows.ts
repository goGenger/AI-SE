import {
  CreateWorkflowInput,
  UpdateWorkflowPolicyInput,
  WorkflowDetailView,
  WorkflowEventPage,
  WorkflowRun,
  WorkflowSummary,
  WorkflowTraceView
} from "@ai-se/shared";
import { defineStore } from "pinia";
import { type ApiError } from "../api/workflows";
import {
  createWorkflow,
  decideApproval,
  getWorkflow,
  getWorkflowTrace,
  listWorkflowEvents,
  listWorkflows,
  openWorkflowStream,
  updateWorkflowPolicy,
  workflowAction
} from "../api/workflows";

/** UX-02: timeline page size (server-side pagination keeps the raw list off the client). */
export const WORKFLOW_EVENTS_PAGE_SIZE = 20;

interface State {
  workflows: WorkflowSummary[];
  current: WorkflowDetailView | null;
  loading: boolean;
  creating: boolean;
  acting: boolean;
  error: string;
  /** UX-02 timeline: current page from `GET /api/workflows/:id/events` (created_at DESC). */
  events: WorkflowEventPage | null;
  eventsPage: number;
  eventsLoading: boolean;
  eventsError: string;
  /** Newer events arrived while the user is not on page 1. */
  hasNewEvents: boolean;
  /** Snapshot-newest event id when the current page data was fetched (freshness baseline). */
  eventsLatestId: string;
  /** TF-01 端到端追踪树。按需加载（不在 `loadWorkflow` 里拉），`workflowRunId` 标明它属于哪次运行。 */
  trace: WorkflowTraceView | null;
  traceLoading: boolean;
  traceError: string;
  /** 追踪取数失败是因为该工作流不存在（404 `WORKFLOW_NOT_FOUND`）——重试无意义，文案也不同。 */
  traceNotFound: boolean;
}

let source: EventSource | null = null;
let poller: ReturnType<typeof setInterval> | null = null;

function stopRealtime(): void {
  source?.close();
  source = null;
  if (poller) clearInterval(poller);
  poller = null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "工作流请求失败";
}

function terminal(status: WorkflowRun["status"]): boolean {
  return ["SUCCESS", "FAILED", "CANCELLED"].includes(status);
}

/**
 * UX-02: realtime snapshots (stream / polling) may introduce a workflow before
 * the enriched list loads; keep the item shape valid until `loadWorkflows`
 * replaces it with the server-resolved names and progress.
 */
function toSummary(workflow: WorkflowRun): WorkflowSummary {
  return {
    ...workflow,
    projectName: null,
    requirementName: null,
    taskProgress: { total: 0, completed: 0 }
  };
}

export const useWorkflowsStore = defineStore("workflows", {
  state: (): State => ({
    workflows: [],
    current: null,
    loading: false,
    creating: false,
    acting: false,
    error: "",
    events: null,
    eventsPage: 1,
    eventsLoading: false,
    eventsError: "",
    hasNewEvents: false,
    eventsLatestId: "",
    trace: null,
    traceLoading: false,
    traceError: "",
    traceNotFound: false
  }),
  actions: {
    applySnapshot(snapshot: WorkflowDetailView) {
      this.current = snapshot;
      const index = this.workflows.findIndex((workflow) => workflow.id === snapshot.workflow.id);
      if (index >= 0) {
        this.workflows[index] = { ...this.workflows[index], ...snapshot.workflow };
      } else {
        this.workflows.unshift(toSummary(snapshot.workflow));
      }
      this.trackTimelineFreshness(snapshot);
      if (terminal(snapshot.workflow.status)) stopRealtime();
    },

    /**
     * UX-02: realtime keeps the timeline fresh without breaking pagination.
     * On page 1 a new event refreshes the page; on older pages it only raises
     * the「回到最新」hint so the user's reading position is never yanked away.
     */
    trackTimelineFreshness(snapshot: WorkflowDetailView) {
      const latestEvent = snapshot.events[snapshot.events.length - 1];
      if (!latestEvent || !this.events) return;
      if (this.eventsPage === 1) {
        if (!this.eventsLoading && latestEvent.id !== this.events.items[0]?.id) {
          void this.loadEventsPage(1);
        }
        return;
      }
      if (latestEvent.id !== this.eventsLatestId) this.hasNewEvents = true;
    },

    async loadWorkflows() {
      this.loading = true;
      this.error = "";
      try {
        this.workflows = await listWorkflows();
      } catch (error) {
        this.error = message(error);
      } finally {
        this.loading = false;
      }
    },

    async loadWorkflow(id: string) {
      this.loading = true;
      this.error = "";
      this.events = null;
      this.eventsPage = 1;
      this.eventsError = "";
      this.hasNewEvents = false;
      // 切到别的工作流时丢掉上一棵追踪树；同一次运行的刷新（act / decide / 预算调整）保留——
      // 树是按需拉的，重建代价高（真实运行 500+ 工具调用节点，`docs/153`）。
      if (this.trace?.workflowRunId !== id) this.clearTrace();
      try {
        this.applySnapshot(await getWorkflow(id));
        if (!terminal(this.current?.workflow.status ?? "FAILED")) this.startRealtime(id);
        void this.loadEventsPage(1);
      } catch (error) {
        this.error = message(error);
      } finally {
        this.loading = false;
      }
    },

    async loadEventsPage(page: number) {
      const id = this.current?.workflow.id;
      if (!id) return;
      this.eventsLoading = true;
      this.eventsError = "";
      try {
        this.events = await listWorkflowEvents(id, page, WORKFLOW_EVENTS_PAGE_SIZE);
        this.eventsPage = page;
        const latest = this.current?.events[this.current.events.length - 1];
        this.eventsLatestId = latest?.id ?? "";
        this.hasNewEvents = false;
      } catch (error) {
        this.eventsError = message(error);
      } finally {
        this.eventsLoading = false;
      }
    },

    jumpToLatest() {
      return this.loadEventsPage(1);
    },

    clearTrace() {
      this.trace = null;
      this.traceLoading = false;
      this.traceError = "";
      this.traceNotFound = false;
    },

    /**
     * TF-01：按需拉取端到端追踪树（默认作用于 `current`）。
     *
     * 与其它取数不同，失败时**保留上一次成功的树**没有意义（树与运行一一对应），所以失败即清空。
     * 404 与网络 / 服务端故障分开记：前者重试无意义，页面给的是另一套文案。
     */
    async loadTrace(id?: string) {
      const target = id ?? this.current?.workflow.id;
      if (!target) return;
      this.traceLoading = true;
      this.traceError = "";
      this.traceNotFound = false;
      try {
        this.trace = await getWorkflowTrace(target);
      } catch (error) {
        this.trace = null;
        this.traceNotFound = (error as ApiError).code === "WORKFLOW_NOT_FOUND";
        this.traceError = this.traceNotFound
          ? "该工作流不存在，可能已被删除。"
          : message(error);
      } finally {
        this.traceLoading = false;
      }
    },

    async create(input: CreateWorkflowInput) {
      this.creating = true;
      this.error = "";
      try {
        const workflow = await createWorkflow(input);
        this.workflows.unshift(toSummary(workflow));
        await this.loadWorkflow(workflow.id);
        void this.loadWorkflows();
        return workflow;
      } catch (error) {
        this.error = message(error);
        return null;
      } finally {
        this.creating = false;
      }
    },

    async act(action: "start" | "pause" | "resume" | "cancel" | "retry") {
      if (!this.current) return;
      this.acting = true;
      this.error = "";
      try {
        await workflowAction(this.current.workflow.id, action);
        await this.loadWorkflow(this.current.workflow.id);
      } catch (error) {
        this.error = message(error);
      } finally {
        this.acting = false;
      }
    },

    /** T6：调整工作流级预算（仅 RUNNING/PAUSED；超限暂停后放宽再走 act('resume')）。 */
    async updatePolicy(input: UpdateWorkflowPolicyInput) {
      if (!this.current) return;
      this.acting = true;
      this.error = "";
      try {
        await updateWorkflowPolicy(this.current.workflow.id, input);
        await this.loadWorkflow(this.current.workflow.id);
      } catch (error) {
        this.error = message(error);
      } finally {
        this.acting = false;
      }
    },

    /**
     * 审批决定（approve / reject）。`comment` 是拒绝时填写的修改意见
     * （`ApprovalDecisionSchema` 允许 ≤1000 字；空串 = 不带该字段，请求体与改动前逐字节一致）。
     * 返回值告诉调用方**这次决定是否成功** —— 页面据此决定关不关确认框；
     * 失败原因仍走 `this.error`（与 loadWorkflow / act / updatePolicy 同一条错误通道，未改）。
     */
    async decide(approvalId: string, action: "approve" | "reject", comment = ""): Promise<boolean> {
      if (!this.current) return false;
      this.acting = true;
      this.error = "";
      try {
        // 无意见时用两参调用：approve 路径的调用参数与改动前逐字节一致
        // （既有 store 测试断言的正是这一点，故保留三参调用只在有意见时发生）。
        await (comment
          ? decideApproval(approvalId, action, { comment })
          : decideApproval(approvalId, action));
        await this.loadWorkflow(this.current.workflow.id);
        return true;
      } catch (error) {
        this.error = message(error);
        return false;
      } finally {
        this.acting = false;
      }
    },

    startRealtime(id: string) {
      stopRealtime();
      if (typeof EventSource === "undefined") {
        this.startPolling(id);
        return;
      }
      source = openWorkflowStream(
        id,
        (snapshot) => this.applySnapshot(snapshot),
        () => {
          source?.close();
          source = null;
          this.startPolling(id);
        }
      );
    },

    startPolling(id: string) {
      if (poller) return;
      poller = setInterval(() => {
        void getWorkflow(id)
          .then((snapshot) => this.applySnapshot(snapshot))
          .catch((error: unknown) => {
            this.error = message(error);
          });
      }, 2_000);
    },

    stopRealtime() {
      stopRealtime();
    }
  }
});
