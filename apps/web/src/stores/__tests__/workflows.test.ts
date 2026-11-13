import {
  WorkflowDetailView,
  WorkflowEvent,
  WorkflowEventPage,
  WorkflowRun,
  WorkflowSummary
} from "@ai-se/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflow,
  decideApproval,
  getWorkflow,
  listWorkflowEvents,
  listWorkflows,
  updateWorkflowPolicy,
  workflowAction
} from "../../api/workflows";
import { useWorkflowsStore } from "../workflows";

vi.mock("../../api/workflows", () => ({
  createWorkflow: vi.fn(),
  decideApproval: vi.fn(),
  getWorkflow: vi.fn(),
  listWorkflowEvents: vi.fn(),
  listWorkflows: vi.fn(),
  openWorkflowStream: vi.fn(),
  updateWorkflowPolicy: vi.fn(),
  workflowAction: vi.fn()
}));

function run(status: WorkflowRun["status"] = "PENDING"): WorkflowRun {
  return {
    id: "workflow-1",
    projectId: "project-1",
    requirementId: "requirement-1",
    planningVersion: 1,
    status,
    policy: {
      maxConcurrency: 2,
      maxRetries: 1,
      failureStrategy: "FAIL_FAST",
      allowRetry: true,
      allowReplan: false,
      approvalRequired: false
    },
    input: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

/** UX-02：列表 DTO = WorkflowRun + 服务端解析的业务上下文。 */
function summary(status: WorkflowRun["status"] = "PENDING"): WorkflowSummary {
  return {
    ...run(status),
    projectName: "Mini Todo",
    requirementName: "Todo 管理",
    taskProgress: { total: 4, completed: 1 }
  };
}

function event(id: string, createdAt = "2026-01-01T00:00:00.000Z"): WorkflowEvent {
  return { id, eventType: "TASK_STARTED", payload: {}, createdAt };
}

function page(
  items: WorkflowEvent[],
  overrides: Partial<WorkflowEventPage> = {}
): WorkflowEventPage {
  return { items, page: 1, pageSize: 20, total: items.length, totalPages: 1, ...overrides };
}

function detail(workflow = run(), events: WorkflowEvent[] = []): WorkflowDetailView {
  return { workflow, tasks: [], dependencies: [], approvals: [], events };
}

describe("workflows store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("loads and creates workflows", async () => {
    vi.mocked(listWorkflows).mockResolvedValue([summary()]);
    vi.mocked(createWorkflow).mockResolvedValue(run());
    vi.mocked(getWorkflow).mockResolvedValue(detail());
    vi.mocked(listWorkflowEvents).mockResolvedValue(page([]));
    const store = useWorkflowsStore();
    await store.loadWorkflows();
    expect(store.workflows).toHaveLength(1);
    expect(store.workflows[0].projectName).toBe("Mini Todo");
    await store.create({ projectId: "project-1", requirementId: "requirement-1" });
    expect(store.current?.workflow.id).toBe("workflow-1");
    store.stopRealtime();
  });

  it("runs lifecycle and approval actions", async () => {
    vi.mocked(workflowAction).mockResolvedValue(run("RUNNING"));
    vi.mocked(getWorkflow).mockResolvedValue(detail(run("RUNNING")));
    vi.mocked(decideApproval).mockResolvedValue({ id: "approval", status: "APPROVED" });
    vi.mocked(listWorkflowEvents).mockResolvedValue(page([]));
    const store = useWorkflowsStore();
    store.current = detail();
    await store.act("start");
    expect(workflowAction).toHaveBeenCalledWith("workflow-1", "start");
    await store.decide("approval", "approve");
    expect(decideApproval).toHaveBeenCalledWith("approval", "approve");
    // W12：拒绝时把修改意见传下去（仅在**有**意见时用三参调用，见 store 注释）
    await store.decide("approval-2", "reject", "请补充错误处理");
    expect(decideApproval).toHaveBeenLastCalledWith("approval-2", "reject", {
      comment: "请补充错误处理"
    });
    store.stopRealtime();
  });

  it("W12：decide 返回本次决定是否成功（页面据此决定关不关确认框）", async () => {
    vi.mocked(getWorkflow).mockResolvedValue(detail());
    vi.mocked(listWorkflowEvents).mockResolvedValue(page([]));
    vi.mocked(decideApproval).mockResolvedValue({ id: "approval", status: "REJECTED" });
    const store = useWorkflowsStore();
    store.current = detail();
    await expect(store.decide("approval", "reject", "理由")).resolves.toBe(true);
    expect(store.error).toBe("");

    vi.mocked(decideApproval).mockRejectedValue(new Error("拒绝失败"));
    await expect(store.decide("approval", "reject", "理由")).resolves.toBe(false);
    // 失败原因仍走既有的 store.error 通道（未新增第二条错误通道）
    expect(store.error).toBe("拒绝失败");
    store.stopRealtime();
  });

  it("runs the manual retry action through the existing action endpoint", async () => {
    vi.mocked(workflowAction).mockResolvedValue(run("RUNNING"));
    vi.mocked(getWorkflow).mockResolvedValue(detail(run("RUNNING")));
    vi.mocked(listWorkflowEvents).mockResolvedValue(page([]));
    const store = useWorkflowsStore();
    store.current = detail(run("FAILED"));
    await store.act("retry");
    expect(workflowAction).toHaveBeenCalledWith("workflow-1", "retry");
    expect(store.current?.workflow.status).toBe("RUNNING");
    store.stopRealtime();
  });

  it("T6: updates the workflow policy and reloads the detail", async () => {
    vi.mocked(updateWorkflowPolicy).mockResolvedValue(run("PAUSED"));
    vi.mocked(getWorkflow).mockResolvedValue(detail(run("PAUSED")));
    vi.mocked(listWorkflowEvents).mockResolvedValue(page([]));
    const store = useWorkflowsStore();
    store.current = detail(run("PAUSED"));

    await store.updatePolicy({ maxTokens: 1000 });

    expect(updateWorkflowPolicy).toHaveBeenCalledWith("workflow-1", { maxTokens: 1000 });
    expect(store.error).toBe("");
    store.stopRealtime();
  });

  it("UX-02: loads the timeline page and follows new events while on page 1", async () => {
    vi.mocked(getWorkflow).mockResolvedValue(detail(run("RUNNING")));
    vi.mocked(listWorkflowEvents).mockResolvedValue(
      page([event("e2", "2026-01-01T00:00:02.000Z"), event("e1", "2026-01-01T00:00:01.000Z")])
    );
    const store = useWorkflowsStore();
    await store.loadWorkflow("workflow-1");
    expect(listWorkflowEvents).toHaveBeenCalledWith("workflow-1", 1, 20);
    expect(store.events?.items.map((item) => item.id)).toEqual(["e2", "e1"]);
    expect(store.eventsPage).toBe(1);

    vi.mocked(listWorkflowEvents).mockClear();
    store.applySnapshot(
      detail(run("RUNNING"), [
        event("e1", "2026-01-01T00:00:01.000Z"),
        event("e2", "2026-01-01T00:00:02.000Z"),
        event("e3", "2026-01-01T00:00:03.000Z")
      ])
    );
    await vi.waitFor(() => expect(listWorkflowEvents).toHaveBeenCalledWith("workflow-1", 1, 20));
    expect(store.hasNewEvents).toBe(false);
    store.stopRealtime();
  });

  it("UX-02: older pages are never yanked — the hint only fires for genuinely new events", async () => {
    vi.mocked(listWorkflowEvents).mockResolvedValue(
      page([event("e4", "2026-01-01T00:00:04.000Z"), event("e3", "2026-01-01T00:00:03.000Z")], {
        total: 40,
        totalPages: 2
      })
    );
    const store = useWorkflowsStore();
    store.current = detail(run("RUNNING"), [
      event("e3", "2026-01-01T00:00:03.000Z"),
      event("e4", "2026-01-01T00:00:04.000Z")
    ]);
    store.events = page(
      [event("e2", "2026-01-01T00:00:02.000Z"), event("e1", "2026-01-01T00:00:01.000Z")],
      { page: 2, total: 40, totalPages: 2 }
    );
    store.eventsPage = 2;
    store.eventsLatestId = "e4"; // 浏览第 2 页时记下的“最新事件”基线
    vi.mocked(listWorkflowEvents).mockClear();

    // 同一批事件重复到达（无新事件）→ 不提示、不刷新
    store.applySnapshot(
      detail(run("RUNNING"), [
        event("e3", "2026-01-01T00:00:03.000Z"),
        event("e4", "2026-01-01T00:00:04.000Z")
      ])
    );
    expect(listWorkflowEvents).not.toHaveBeenCalled();
    expect(store.hasNewEvents).toBe(false);

    // 真正的新事件 → 提示（仍不刷新当前页）
    store.applySnapshot(
      detail(run("RUNNING"), [
        event("e4", "2026-01-01T00:00:04.000Z"),
        event("e5", "2026-01-01T00:00:05.000Z")
      ])
    );
    expect(listWorkflowEvents).not.toHaveBeenCalled();
    expect(store.hasNewEvents).toBe(true);

    await store.jumpToLatest();
    expect(listWorkflowEvents).toHaveBeenCalledWith("workflow-1", 1, 20);
    expect(store.eventsPage).toBe(1);
    expect(store.hasNewEvents).toBe(false);
    expect(store.events?.items[0].id).toBe("e4");
    store.stopRealtime();
  });
});
