import {
  type Task,
  type TaskDependencyView,
  type TraceNode,
  type WorkflowDetailView,
  type WorkflowEvent,
  type WorkflowEventPage,
  type WorkflowRun,
  type WorkflowSummary,
  type WorkflowTraceView
} from "@ai-se/shared";
import { createPinia, type Pinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import { useProjectsStore } from "@/stores/projects";
import { useWorkflowsStore } from "@/stores/workflows";
import WorkflowsView from "@/views/WorkflowsView.vue";

/**
 * WorkflowsView 页面契约测试（布局重构：表格 + 分页 + 抽屉详情 + 弹窗新建；
 * 承接 Phase 7-B 结构迁移 + UX-02 Workflow Context & Timeline）。
 *
 * 覆盖：页头「新建工作流」触发器（DialogTrigger 语义）、创建表单（弹窗内容，经 Teleport 输出）、
 * 工作流列表表格（6 列 / 行数据 / 状态徽标 / 操作列「详情 + 状态主操作 + 复制 ID」）、
 * Table 内置分页（page-size=10 纯前端切片）、行内主操作的状态判定与 acting 禁用、
 * 详情抽屉（深链接 /workflows/:id 打开：状态与生命周期按钮 / 元数据与预算 / 上下文行 /
 * 审批 / 工作流图 / 事件时间线）以及弹窗、抽屉的默认关闭态。
 *
 * SSR 下 onMounted / watch（非 immediate）不执行 ⇒ 不会触发任何网络请求或 SSE/轮询；
 * Store 状态由测试注入 —— 不做 API mock。真实后端与 SSE 刷新由浏览器验证承担。
 * 弹窗与抽屉内容经 Reka DialogPortal 输出到 Teleport —— 本文件用 renderToString 的
 * ctx.teleports 收集（组件侧以 unmount-on-hide=false + portal force-mount 保证内容可见），
 * `all` = 页面主输出 + Teleport 内容。
 */

const DETAIL_PATH = "/workflows/99975877-48e3-4448-9092-2ea9b10d53fe";

function makeWorkflow(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "99975877-48e3-4448-9092-2ea9b10d53fe",
    projectId: "proj-1",
    requirementId: "req-1",
    planningVersion: 1,
    status: "PENDING",
    policy: {
      maxConcurrency: 2,
      maxRetries: 1,
      failureStrategy: "FAIL_FAST",
      allowRetry: false,
      allowReplan: false,
      approvalRequired: false
    },
    input: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  } as WorkflowRun;
}

/** UX-02：列表 DTO = WorkflowRun + 服务端解析的 Project / Requirement 名与任务进度。 */
function makeSummary(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    ...makeWorkflow(),
    projectName: "Mini Todo",
    requirementName: "Todo 管理",
    taskProgress: { total: 4, completed: 1 },
    ...overrides
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "proj-1",
    requirementId: "req-1",
    taskKey: "T-001",
    title: "Project service 骨架",
    description: "建立项目服务",
    type: "BACKEND",
    status: "RUNNING",
    version: 1,
    origin: "PLANNED",
    creationReason: "",
    assignedAgent: "backend-agent",
    input: {},
    output: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  } as unknown as Task;
}

const dependency: TaskDependencyView = {
  id: "dep-1",
  sourceTaskId: "task-0",
  targetTaskId: "task-1",
  sourceTaskKey: "T-000",
  targetTaskKey: "T-001",
  active: true
} as TaskDependencyView;

function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    id: "evt-1",
    eventType: "WORKFLOW_STARTED",
    payload: {},
    createdAt: "2026-09-14T03:04:56.701Z",
    ...overrides
  } as WorkflowEvent;
}

function eventsPage(
  items: WorkflowEvent[],
  overrides: Partial<WorkflowEventPage> = {}
): WorkflowEventPage {
  return { items, page: 1, pageSize: 20, total: items.length, totalPages: 1, ...overrides };
}

function detail(overrides: Partial<WorkflowDetailView> = {}): WorkflowDetailView {
  return {
    workflow: makeWorkflow(),
    tasks: [],
    dependencies: [],
    approvals: [],
    events: [],
    ...overrides
  } as WorkflowDetailView;
}

/**
 * SSR 输出会保留模板缩进产生的空白，并把 slot 文本包进 fragment 注释
 * （如 `<button><!--[--> 开始 <!--]--></button>`）。这里统一归一化，
 * 使 `>开始</button>` 这类断言只依赖真实文本而非缩进。
 */
function norm(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+/g, ">")
    .replace(/\s+</g, "<");
}

interface RenderResult {
  /** 页面主 SSR 输出（不含 Teleport 内容） */
  html: string;
  /** 主输出 + Teleport 内容（弹窗表单 / 详情抽屉所在） */
  all: string;
}

async function renderWorkflows(
  seed?: (pinia: Pinia) => void,
  initialPath = "/workflows"
): Promise<RenderResult> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/workflows", component: WorkflowsView },
      { path: "/workflows/:id", component: WorkflowsView },
      { path: "/agent-run", component: { render: () => null } }
    ]
  });
  await router.push(initialPath);
  await router.isReady();

  const app = createSSRApp({ render: () => h(WorkflowsView) });
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  seed?.(pinia);

  const ctx: { teleports?: Record<string, string> } = {};
  const raw = await renderToString(app, ctx);
  const teleports = Object.values(ctx.teleports ?? {}).join("\n");
  return { html: norm(raw), all: norm(`${raw}\n${teleports}`) };
}

/** 匹配文本按钮（在 norm 归一化输出上使用）。 */
function buttonPattern(text: string): RegExp {
  return new RegExp(`<button[^>]*>${text}</button>`, "g");
}

/** 判断按钮标签上是否存在 disabled 属性（避免命中 `disabled:` 工具类前缀）。 */
function hasDisabledAttr(button: string): boolean {
  return / disabled[\s>]/.test(button);
}

describe("WorkflowsView — 布局重构（表格 + 分页 + 抽屉 + 弹窗）", () => {
  it("页头：标题「工作流」+「新建工作流」触发器（aria 状态），且位于列表之前", async () => {
    const { html } = await renderWorkflows();
    expect(html).toMatch(/<h1[^>]*>工作流/);
    expect(html).toContain("新建工作流");
    expect(html).toMatch(/<button[^>]*>新建工作流/);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-state="closed"');
    const triggerIndex = html.indexOf("新建工作流");
    const listIndex = html.indexOf("工作流列表");
    expect(triggerIndex).toBeGreaterThan(-1);
    expect(listIndex).toBeGreaterThan(-1);
    expect(triggerIndex).toBeLessThan(listIndex);
  });

  it("创建表单位于弹窗（Teleport）内：控件、约束与既有文案原样", async () => {
    const { html, all } = await renderWorkflows(() => {});
    for (const label of [
      "项目",
      "需求",
      "切片键 sliceKey（可选，切片工作流必填）",
      "规划版本 planningVersion（可选）",
      "覆盖项目工作区（可选）",
      "最大并发",
      "最大重试次数",
      "失败策略",
      "预算：成本上限 USD（可空）",
      "预算：Token 上限（可空）",
      "预算：墙钟上限 ms（可空）",
      "需要人工审批"
    ]) {
      expect(all, `应包含字段 ${label}`).toContain(label);
    }
    expect(all).toContain('for="workflow-project"');
    expect(all).toContain('id="workflow-project"');
    expect(all).toContain('for="workflow-requirement"');
    expect(all).toContain('for="workflow-slice-key"');
    expect(all).toContain('for="workflow-planning-version"');
    expect(all).toContain('for="workflow-workspace"');
    expect(all).toContain('for="workflow-concurrency"');
    expect(all).toContain('for="workflow-retries"');
    expect(all).toContain('for="workflow-strategy"');
    // 下拉选择由组件库 Select 渲染：触发器是 button[role=combobox]，无原生 <select>
    expect(all).toContain('role="combobox"');
    expect(all).not.toContain("<select");
    expect(all).toContain("选择项目");
    expect(all).toContain("选择已分析的需求");
    // 两个必填下拉（组件库 Select → aria-required）
    expect((all.match(/aria-required="true"/g) || []).length).toBeGreaterThanOrEqual(2);
    // number 边界与路径长度限制
    expect(all).toContain('min="1"');
    expect(all).toContain('max="16"');
    expect(all).toContain('min="0"');
    expect(all).toContain('max="10"');
    expect(all).toContain('maxlength="1000"');
    // 失败策略默认 FAIL_FAST → SSR 回显选中项 label
    expect(all).toContain("快速失败");
    expect(all).toContain('role="checkbox"');
    expect(all).toMatch(/>创建<\/button>/);
    // 路径提示文案原样保留
    expect(all).toContain("默认继承项目的本地工作区路径");
    // 表单内容经 Teleport 渲染：不在页面本体
    expect(html).not.toContain('id="workflow-project"');
    expect(html).not.toContain("本地绝对路径（以 / 开头）");
  });

  it("工作流列表四态：loading 骨架屏 / error 可重试 / 空态，均不渲染表格", async () => {
    const loading = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).loading = true;
    });
    expect(loading.html).toContain('role="status"');
    expect(loading.html).toContain('aria-label="加载中"');
    expect(loading.html).toContain("animate-pulse");
    expect(loading.html).not.toContain("加载中…");
    expect(loading.html).not.toContain("暂无工作流。");
    expect(loading.html).not.toContain("<table");

    const errored = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).error = "无法连接后端服务";
    });
    expect(errored.html).toContain("无法连接后端服务");
    expect(errored.html).toContain('role="alert"');
    expect(errored.html).toMatch(/<button[^>]*>(?:<!--\[-->)?重试/);
    // 错误优先于空态：不再同时出现「暂无工作流。」
    expect(errored.html).not.toContain("暂无工作流。");
    expect(errored.html).not.toContain("<table");

    const empty = await renderWorkflows();
    expect(empty.html).toContain("暂无工作流。");
    expect(empty.html).not.toContain("加载中…");
    expect(empty.html).not.toContain("<table");
  });

  it("列表表格：6 列表头 + 业务上下文（Project / Requirement / 进度 / 时间）+ ID 降级与复制", async () => {
    const { html } = await renderWorkflows((pinia) => {
      useProjectsStore(pinia).projects = [{ id: "proj-1", name: "Mini Todo" }] as never;
      useWorkflowsStore(pinia).workflows = [
        makeSummary({ id: "99975877-aaaa-bbbb-cccc-ddddeeeeffff", status: "PAUSED" }),
        makeSummary({ id: "20672bc3-1111-2222-3333-444455556666", status: "FAILED" })
      ];
    });
    expect(html).not.toContain("暂无工作流。");
    expect(html).not.toContain("加载中…");
    // 表头
    expect((html.match(/<th scope="col"/g) || []).length).toBe(6);
    for (const label of ["状态", "需求", "项目", "进度", "更新时间", "操作"]) {
      expect(html, `表头应包含 ${label}`).toContain(label);
    }
    expect((html.match(/<tr/g) || []).length).toBe(3); // 表头 1 + 数据 2
    // 状态
    expect(html).toContain("已暂停");
    expect(html).toContain("bg-muted"); // PAUSED → neutral
    expect(html).toContain("失败");
    expect(html).toContain("bg-danger-bg"); // FAILED → error
    expect(html).toContain(">v1</span>"); // 规划版本（辅助 metadata）
    // 业务上下文：Requirement 名 / Project 名 / 进度 优先于 ID
    expect(html).toContain("Todo 管理");
    expect(html).toContain("Mini Todo");
    expect(html).toMatch(/进度\s+1 \/ 4/);
    expect(html).toMatch(/开始\s+—/);
    expect(html).toMatch(/用时\s+—/);
    expect(html).toMatch(/\d{2}[-/]\d{2} \d{2}:\d{2}/); // 更新时间（紧凑格式，如 01/01 08:00）
    // Workflow ID 降级为辅助 metadata + 可点复制（W7：不再是操作列里的按钮）
    expect(html).toContain("ID 99975877");
    expect(html).toContain('aria-label="复制 ID 99975877-aaaa-bbbb-cccc-ddddeeeeffff"');
    expect(html).toContain("点击复制完整 ID：99975877-aaaa-bbbb-cccc-ddddeeeeffff");
  });

  it("列表筛选控件：Project（全部项目）+ Status（全部状态）", async () => {
    const { html } = await renderWorkflows((pinia) => {
      useProjectsStore(pinia).projects = [{ id: "proj-1", name: "Mini Todo" }] as never;
      useWorkflowsStore(pinia).workflows = [makeSummary()];
    });
    expect(html).toContain("全部项目");
    expect(html).toContain("全部状态");
    expect(html).toContain('id="workflow-filter-project"');
    expect(html).toContain('id="workflow-filter-status"');
    // W11：触发器是 <button role="combobox">，而 combobox 的名称只能来自 author
    // （ARIA 规定它不支持 name from content），因此必须有 aria-label，否则 axe 报 button-name。
    expect(html).toContain('aria-label="按项目筛选"');
    expect(html).toContain('aria-label="按状态筛选"');
  });

  it("Table 内置分页：page-size=10 只渲染第 1 页并显示「共 N 条」与页码控件", async () => {
    const { html } = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).workflows = Array.from({ length: 12 }, (_, index) =>
        makeSummary({
          id: `wf-${index + 1}`,
          requirementName: `测试需求${String(index + 1).padStart(2, "0")}`
        })
      );
    });
    expect(html).toContain("共 12 条");
    expect(html).toContain('aria-label="下一页"');
    expect((html.match(/<tr/g) || []).length).toBe(11); // 表头 + 第 1 页 10 行
    expect(html).toContain("测试需求01");
    expect(html).toContain("测试需求10");
    expect(html).not.toContain("测试需求11");
  });

  it("操作列：详情 + 状态主操作（开始/暂停/继续/重试失败任务）+ 行内可点 ID；acting 时禁用", async () => {
    const { html } = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).workflows = [
        makeSummary({ id: "wf-pending", status: "PENDING" }),
        makeSummary({ id: "wf-running", status: "RUNNING" }),
        makeSummary({ id: "wf-paused", status: "PAUSED" }),
        makeSummary({ id: "wf-failed", status: "FAILED" }),
        makeSummary({ id: "wf-success", status: "SUCCESS" })
      ];
    });
    // 每行「详情」+ 一个可点 ID（W7 起 ID 不再占按钮位）；主操作与状态一一对应（SUCCESS 无主操作）
    expect((html.match(buttonPattern("详情")) || []).length).toBe(5);
    expect((html.match(/aria-label="复制 ID /g) || []).length).toBe(5);
    expect((html.match(buttonPattern("开始")) || []).length).toBe(1);
    expect((html.match(buttonPattern("暂停")) || []).length).toBe(1);
    expect((html.match(buttonPattern("继续")) || []).length).toBe(1);
    expect((html.match(buttonPattern("重试失败任务")) || []).length).toBe(1);
    for (const text of ["详情", "开始", "暂停", "继续", "重试失败任务"]) {
      for (const button of html.match(buttonPattern(text)) ?? []) {
        expect(hasDisabledAttr(button), `「${text}」默认可用`).toBe(false);
      }
    }

    const busy = await renderWorkflows((pinia) => {
      const store = useWorkflowsStore(pinia);
      store.workflows = [makeSummary({ id: "wf-pending", status: "PENDING" })];
      store.acting = true;
    });
    const startButtons = busy.html.match(buttonPattern("开始")) ?? [];
    expect(startButtons.length).toBe(1);
    const startButton = startButtons[0] ?? "";
    expect(startButton).not.toBe("");
    expect(hasDisabledAttr(startButton)).toBe(true);
  });

  it("详情抽屉（/workflows/:id 深链接）：状态徽标 + 元数据 + PENDING 生命周期按钮", async () => {
    const { all } = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail({ workflow: makeWorkflow({ status: "PENDING" }) });
    }, DETAIL_PATH);
    expect(all).toContain("工作流详情");
    expect(all).toContain("99975877-48e3-4448-9092-2ea9b10d53fe");
    expect(all).toContain("等待中");
    for (const label of ["并发", "重试", "策略"]) {
      expect(all, `元数据应包含 ${label}`).toContain(label);
    }
    expect(all).toContain("快速失败");
    expect(all).toMatch(/>开始<\/button>/);
    expect(all).toMatch(/>取消<\/button>/);
    expect(all).not.toMatch(/暂停<\/button>/);
    expect(all).not.toMatch(/继续<\/button>/);
    // 事件时间线 / 工作流图面板仍在
    expect(all).toContain("工作流图");
    expect(all).toContain("事件时间线");
  });

  it("详情抽屉：Project / Requirement / 任务进度 上下文行（UX-02）", async () => {
    const workflow = makeWorkflow({ id: "wf-ctx", status: "RUNNING" });
    const { all } = await renderWorkflows((pinia) => {
      const store = useWorkflowsStore(pinia);
      store.workflows = [
        makeSummary({ id: "wf-ctx", status: "RUNNING", taskProgress: { total: 2, completed: 1 } })
      ];
      store.current = detail({
        workflow,
        tasks: [
          makeTask({ id: "task-1", status: "SUCCESS" }),
          makeTask({ id: "task-2", taskKey: "T-002", title: "Todo API", status: "RUNNING" })
        ]
      });
    }, "/workflows/wf-ctx");
    expect(all).toContain("项目");
    expect(all).toContain("Mini Todo");
    expect(all).toContain("需求");
    expect(all).toContain("Todo 管理");
    expect(all).toContain("任务进度");
    expect(all).toContain("1 / 2");
  });

  it("详情抽屉：PAUSED → 继续 + 取消；RUNNING → 暂停 + 取消（条件与 legacy 一致）", async () => {
    const paused = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail({ workflow: makeWorkflow({ status: "PAUSED" }) });
    }, DETAIL_PATH);
    expect(paused.all).toMatch(/>继续<\/button>/);
    expect(paused.all).toMatch(/>取消<\/button>/);
    expect(paused.all).not.toMatch(/开始<\/button>/);

    const running = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail({ workflow: makeWorkflow({ status: "RUNNING" }) });
    }, DETAIL_PATH);
    expect(running.all).toMatch(/>暂停<\/button>/);
    expect(running.all).toMatch(/>取消<\/button>/);
    expect(running.all).not.toMatch(/继续<\/button>/);
  });

  it("详情抽屉：终态（SUCCESS/FAILED/CANCELLED）不渲染任何生命周期按钮", async () => {
    for (const status of ["SUCCESS", "FAILED", "CANCELLED"] as const) {
      const { all } = await renderWorkflows((pinia) => {
        useWorkflowsStore(pinia).current = detail({ workflow: makeWorkflow({ status }) });
      }, DETAIL_PATH);
      for (const action of ["开始", "暂停", "继续", "取消"]) {
        expect(all, `${status} 不应渲染 ${action} 按钮`).not.toMatch(
          new RegExp(`${action}</button>`)
        );
      }
    }
  });

  it("详情抽屉：FAILED → 重试失败任务（仅失败态显示）", async () => {
    const failed = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail({ workflow: makeWorkflow({ status: "FAILED" }) });
    }, DETAIL_PATH);
    expect(failed.all).toMatch(/>重试失败任务<\/button>/);

    for (const status of [
      "PENDING",
      "RUNNING",
      "PAUSED",
      "WAITING_APPROVAL",
      "SUCCESS",
      "CANCELLED"
    ] as const) {
      const { all } = await renderWorkflows((pinia) => {
        useWorkflowsStore(pinia).current = detail({ workflow: makeWorkflow({ status }) });
      }, DETAIL_PATH);
      expect(all, `${status} 不应渲染重试失败任务按钮`).not.toMatch(/重试失败任务<\/button>/);
    }
  });

  it("审批面板：无 PENDING 审批时不渲染；有则渲染任务标题/原因与批准拒绝按钮（无 disabled）", async () => {
    const without = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail();
    }, DETAIL_PATH);
    expect(without.all).not.toMatch(/>审批<\/h2>/);

    const withApproval = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail({
        workflow: makeWorkflow({ status: "WAITING_APPROVAL" }),
        tasks: [makeTask()],
        approvals: [
          { id: "appr-1", taskId: "task-1", status: "PENDING", reason: "需要人工确认" }
        ] as never
      });
    }, DETAIL_PATH);
    expect(withApproval.all).toMatch(/>审批<\/h2>/);
    expect(withApproval.all).toContain("Project service 骨架");
    expect(withApproval.all).toContain("需要人工确认");
    expect(withApproval.all).toMatch(/>批准<\/button>/);
    expect(withApproval.all).toMatch(/>拒绝<\/button>/);
    // approve/reject 不得新增 disabled（注意排除 Button 基础样式里的 `disabled:` 变体类）
    const approveButton = withApproval.all.match(/<button[^>]*>批准<\/button>/);
    expect(approveButton, "应渲染批准按钮").not.toBeNull();
    expect(hasDisabledAttr(approveButton![0])).toBe(false);
    const rejectButton = withApproval.all.match(/<button[^>]*>拒绝<\/button>/);
    expect(rejectButton, "应渲染拒绝按钮").not.toBeNull();
    expect(hasDisabledAttr(rejectButton![0])).toBe(false);
  });

  it("W12：审批「拒绝」走统一确认框并收集修改意见（不再是点一下直接发出）", async () => {
    const { all } = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail({
        workflow: makeWorkflow({ status: "WAITING_APPROVAL" }),
        tasks: [makeTask()],
        approvals: [
          { id: "appr-1", taskId: "task-1", status: "PENDING", reason: "需要人工确认" }
        ] as never
      });
    }, DETAIL_PATH);

    // 确认框内容常驻挂载（unmount-on-hide=false）⇒ 关闭态即可断言结构。
    // 标题里的任务名取自「待拒绝的那一条」，而 SSR 下确认框是关的 ⇒ 只断言标题模板，
    // 任务名插值由真实浏览器走查覆盖。
    expect(all).toContain("拒绝任务「");
    expect(all).toContain("拒绝后该任务不会执行");
    expect(all).toContain("修改意见（拒绝时填写）");
    expect(all).toContain('for="approval-comment"');
    expect(all).toContain('id="approval-comment"');
    expect(all).toMatch(/<textarea[^>]*maxlength="1000"/);
    // 取消按钮文案为「关闭」：本页有一个名叫「取消」的生命周期动作（下一条断言），
    // 同名两个按钮会让「取消什么」变歧义 —— 这条护栏同时钉住这两件事。
    expect(all).toMatch(/>关闭<\/button>/);
    expect(all).toMatch(/>取消<\/button>/);
  });

  it("工作流图：任务节点渲染 key/标题、类型 Badge、状态 StatusBadge、前置、执行 Agent 与 Agent Run 深链接（含锚点 id）", async () => {
    const { all } = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail({
        tasks: [
          makeTask({ id: "task-1", status: "RUNNING", output: { agentRunId: "run-42" } } as never),
          makeTask({
            id: "task-2",
            taskKey: "T-002",
            title: "动态补充任务",
            type: "TEST",
            status: "WAITING_APPROVAL",
            origin: "DYNAMIC",
            creationReason: "覆盖缺失用例",
            assignedAgent: "",
            output: {}
          } as never),
          makeTask({
            id: "task-3",
            taskKey: "T-003",
            title: "失败任务",
            type: "FRONTEND",
            status: "FAILED",
            output: { summary: "Failed to read git status" }
          } as never)
        ],
        dependencies: [dependency]
      });
    }, DETAIL_PATH);
    expect(all).toContain("T-001");
    expect(all).toContain("Project service 骨架");
    expect(all).toContain("后端"); // taskTypeLabel(BACKEND)
    expect(all).toContain("运行中");
    expect(all).toContain("bg-info-bg"); // RUNNING → running tone
    expect(all).toContain("等待审批");
    expect(all).toContain("bg-warning-bg"); // WAITING_APPROVAL → warning tone
    expect(all).toContain("前置：T-000");
    expect(all).toContain("动态任务 · 覆盖缺失用例");
    expect(all).toContain("执行 Agent：backend-agent");
    // 失败任务直接给出原因（任务失败 ≠ Agent 失败，run/task 差异可解释）
    expect(all).toContain("失败原因：Failed to read git status");
    expect(all).toContain("/agent-run?run=run-42");
    expect(all).toContain("查看 Agent 运行");
    expect(all).toContain("minmax(210px,1fr)");
    // UX-02：任务锚点（事件时间线「查看任务」的跳转目标）
    expect(all).toContain('id="task-task-1"');
    expect(all).toContain('id="task-task-2"');
  });

  it("被 REPLAN 接替的失败任务显示「已解决」与解决说明，不显示红色失败原因", async () => {
    const { all } = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail({
        tasks: [
          makeTask({
            id: "task-failed",
            taskKey: "TASK-09",
            title: "原失败任务",
            status: "FAILED",
            resolvedByTaskId: "task-replan",
            failureHandled: true,
            output: { summary: "build OOM" }
          } as never),
          makeTask({
            id: "task-replan",
            taskKey: "TASK-09-REPLAN-1",
            title: "重规划任务",
            status: "SUCCESS",
            output: {}
          } as never)
        ],
        dependencies: []
      });
    }, DETAIL_PATH);
    expect(all).toContain("已解决");
    expect(all).toContain("已由 TASK-09-REPLAN-1 解决");
    expect(all).not.toContain("失败原因：build OOM");
    expect(all).toContain("bg-success-bg");
  });

  it("任务卡：运行中的任务用事件里的运行 id 跳转，不指向已失败的旧运行", async () => {
    const { all } = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail({
        tasks: [
          makeTask({
            id: "task-1",
            status: "RUNNING",
            output: { agentRunId: "run-old-failed" }
          } as never)
        ],
        events: [
          {
            id: "e1",
            taskId: "task-1",
            agentRunId: "run-current",
            eventType: "agent_run_started",
            payload: {},
            createdAt: ""
          }
        ]
      } as never);
    }, DETAIL_PATH);

    expect(all).toContain("运行中");
    expect(all).toContain("/agent-run?run=run-current");
    expect(all).not.toContain("run-old-failed");
  });

  it("事件时间线：渲染服务端分页页数据（摘要 / 失败详情 / Task 与 AgentRun 跳转 / 页码信息）", async () => {
    const { all } = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail({
        workflow: makeWorkflow({
          status: "RUNNING",
          policy: {
            maxConcurrency: 2,
            maxRetries: 3,
            failureStrategy: "FAIL_FAST",
            allowRetry: true,
            allowReplan: false,
            approvalRequired: false
          }
        }),
        tasks: [
          makeTask({
            id: "task-1",
            title: "实现 Todo API",
            assignedAgent: "backend-agent",
            retryCount: 2,
            output: { agentRunId: "run-42", error: "POST /api/todos 返回 500" }
          } as never)
        ]
      });
      useWorkflowsStore(pinia).events = eventsPage(
        [
          makeEvent({
            id: "evt-2",
            eventType: "TASK_FAILED",
            taskId: "task-1",
            payload: { errorCode: "TEST_ERROR" }
          }),
          makeEvent({ id: "evt-1", eventType: "WORKFLOW_STARTED" })
        ],
        { total: 21, totalPages: 2 }
      );
    }, DETAIL_PATH);
    // 事件标签 + 时间（datetime 原样输出）
    expect(all).toContain("任务失败");
    expect(all).toContain("工作流已启动");
    expect(all).toContain('datetime="2026-09-14T03:04:56.701Z"');
    // Summary 是一句业务描述（非原始 eventType）；任务为主体、Agent 进明细（任务失败 ≠ Agent 失败）
    expect(all).toContain("「实现 Todo API」执行失败");
    expect(all).toContain("执行 Agent");
    // 失败详情：错误类型 / 原因 / Attempt
    expect(all).toContain("错误类型");
    expect(all).toContain("TEST_ERROR");
    expect(all).toContain("原因");
    expect(all).toContain("POST /api/todos 返回 500");
    expect(all).toContain("2 / 3"); // Attempt：task.retryCount / policy.maxRetries
    // 跳转
    expect(all).toContain('href="#task-task-1"');
    expect(all).toContain("查看任务");
    expect(all).toContain("/agent-run?run=run-42");
    // 页码信息 + 语义色调点
    expect(all).toContain("共 21 条");
    expect(all).toContain('data-tone="error"');
    expect(all).toContain('data-tone="running"');
    // 第 1 页：不显示「回到最新」
    expect(all).not.toContain("回到最新");
    // 分页组件（totalPages > 1）
    expect(all).toContain("首页");
    expect(all).toContain("下一页");
  });

  it("事件时间线：非第 1 页提供「回到最新」，有新事件时带提示", async () => {
    const onPageTwo = await renderWorkflows((pinia) => {
      const store = useWorkflowsStore(pinia);
      store.current = detail({ workflow: makeWorkflow({ status: "RUNNING" }) });
      store.events = eventsPage([makeEvent({ id: "evt-1" })], {
        page: 2,
        total: 21,
        totalPages: 2
      });
      store.eventsPage = 2;
    }, DETAIL_PATH);
    expect(onPageTwo.all).toContain("回到最新");
    expect(onPageTwo.all).not.toContain("有新事件");

    const withNew = await renderWorkflows((pinia) => {
      const store = useWorkflowsStore(pinia);
      store.current = detail({ workflow: makeWorkflow({ status: "RUNNING" }) });
      store.events = eventsPage([makeEvent({ id: "evt-1" })], {
        page: 2,
        total: 21,
        totalPages: 2
      });
      store.eventsPage = 2;
      store.hasNewEvents = true;
    }, DETAIL_PATH);
    expect(withNew.all).toContain("回到最新（有新事件）");
  });

  it("事件时间线：空态与错误态", async () => {
    const empty = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail({ workflow: makeWorkflow({ status: "RUNNING" }) });
    }, DETAIL_PATH);
    expect(empty.all).toContain("暂无事件。");

    const failed = await renderWorkflows((pinia) => {
      const store = useWorkflowsStore(pinia);
      store.current = detail({ workflow: makeWorkflow({ status: "RUNNING" }) });
      store.eventsError = "事件加载失败";
    }, DETAIL_PATH);
    expect(failed.all).toContain("事件加载失败");
    expect(failed.all).toContain("重试");
  });

  it("弹层：/workflows 下弹窗、抽屉与拒绝确认框内容挂载但隐藏；深链接下抽屉打开", async () => {
    const closed = await renderWorkflows();
    // W12 起有三层弹层：新建弹窗 + 详情抽屉 + 审批拒绝确认框（均 unmount-on-hide=false）
    expect((closed.all.match(/role="dialog"/g) || []).length).toBe(3);
    expect((closed.all.match(/aria-label="关闭"/g) || []).length).toBe(3);
    expect((closed.all.match(/aria-labelledby/g) || []).length).toBeGreaterThanOrEqual(3);
    expect((closed.all.match(/display:\s*none/g) || []).length).toBeGreaterThanOrEqual(2);
    // 抽屉关闭但内容仍挂载（关闭态安全由组件契约测试保证）
    expect(closed.all).toContain("请选择或创建工作流。");

    const open = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail({ workflow: makeWorkflow({ status: "PENDING" }) });
    }, DETAIL_PATH);
    expect(open.all).toContain("工作流详情");
    expect(open.all).not.toContain("请选择或创建工作流。");
  });

  it("不得再出现任何 legacy 列表类名（workflow-item / workflow-list-item）", async () => {
    const { all } = await renderWorkflows((pinia) => {
      const store = useWorkflowsStore(pinia);
      store.workflows = [makeSummary()];
      store.current = detail({
        workflow: makeWorkflow({ status: "RUNNING" }),
        tasks: [makeTask({ id: "task-1" })]
      });
      store.events = eventsPage([
        makeEvent({ id: "evt-1", eventType: "TASK_STARTED", taskId: "task-1", agentRunId: "run-1" })
      ]);
    }, DETAIL_PATH);
    for (const token of [
      "workflow-item",
      "workflow-list-item",
      "workflow-item-main",
      "workflow-item-meta",
      "workflow-item--active"
    ]) {
      expect(all, `不应包含 ${token}`).not.toContain(token);
    }
    // W5：色调点已从本页 scoped 提到 `@layer components` 的共享 `.tone-dot`
    // （与 AgentRunView 的执行轨迹同一条定义）
    expect(all).toContain("tone-dot");
    expect(all).not.toContain("workflow-event-dot");
  });
});

/**
 * TF-M1 ~ TF-M3 —— 详情抽屉内的「追踪」区（7-C 端到端追踪树）。
 *
 * 四态（加载中 / 失败可重试 / 空 / 有数据）在 SSR 下由注入的 store 状态驱动；
 * 真实取数与展开 / 收起的交互由浏览器走查承担（SSR 不执行 onMounted / 事件）。
 */
describe("WorkflowsView — 追踪区（TF-M3）", () => {
  const WF_ID = "99975877-48e3-4448-9092-2ea9b10d53fe";

  function traceView(overrides: Partial<WorkflowTraceView> = {}): WorkflowTraceView {
    const root: TraceNode = {
      kind: "workflow",
      id: WF_ID,
      label: WF_ID,
      status: "RUNNING",
      detail: {},
      children: [
        {
          kind: "task",
          id: "task-1",
          label: "T-001 Project service 骨架",
          status: "SUCCESS",
          detail: {},
          children: [
            {
              kind: "agentRun",
              id: "ar-1",
              label: "backend-agent",
              status: "succeeded",
              detail: {},
              children: [
                {
                  kind: "toolCall",
                  id: "tc-1",
                  label: "read_file",
                  status: "succeeded",
                  detail: {},
                  children: []
                }
              ]
            }
          ]
        }
      ]
    };
    return {
      workflowRunId: WF_ID,
      generatedAt: "2026-10-15T00:00:00.000Z",
      root,
      counts: { tasks: 1, agentRuns: 1, toolCalls: 1, deployments: 0 },
      ...overrides
    };
  }

  it("未加载：空态给出下一步动作（「加载追踪」），不自动拉树", async () => {
    const { all } = await renderWorkflows((pinia) => {
      useWorkflowsStore(pinia).current = detail({ workflow: makeWorkflow({ status: "RUNNING" }) });
    }, DETAIL_PATH);
    expect(all).toContain("追踪");
    expect(all).toContain("尚未加载追踪。");
    expect(all).toMatch(/>加载追踪<\/button>/);
    // 追踪树按需加载 ⇒ 详情打开时不该出现任何节点标签
    expect(all).not.toContain("read_file");
  });

  it("有数据：默认折叠下任务层可见、工具调用层不可见；计数取后端 counts", async () => {
    const { all } = await renderWorkflows((pinia) => {
      const store = useWorkflowsStore(pinia);
      store.current = detail({ workflow: makeWorkflow({ status: "RUNNING" }) });
      store.trace = traceView();
    }, DETAIL_PATH);
    expect(all).not.toContain("尚未加载追踪。");
    expect(all).toContain("T-001 Project service 骨架");
    expect(all).toContain("backend-agent");
    // agentRun 默认收起 ⇒ 它下面的工具调用不渲染（503 个节点的规模约束）
    expect(all).not.toContain("read_file");
    // 计数行来自后端 view.counts，不是前端自算
    expect(all).toContain("任务 1 · Agent 运行 1 · 工具调用 1 · 部署 0");
    expect(all).toMatch(/>刷新<\/button>/);
  });

  it("归属校验：树属于另一次运行时不渲染，回落到空态", async () => {
    const { all } = await renderWorkflows((pinia) => {
      const store = useWorkflowsStore(pinia);
      store.current = detail({ workflow: makeWorkflow({ status: "RUNNING" }) });
      store.trace = traceView({ workflowRunId: "another-run" });
    }, DETAIL_PATH);
    expect(all).toContain("尚未加载追踪。");
    expect(all).not.toContain("T-001 Project service 骨架");
  });

  it("加载中：显示骨架屏，不显示空态", async () => {
    const { all } = await renderWorkflows((pinia) => {
      const store = useWorkflowsStore(pinia);
      store.current = detail({ workflow: makeWorkflow({ status: "RUNNING" }) });
      store.traceLoading = true;
    }, DETAIL_PATH);
    expect(all).not.toContain("尚未加载追踪。");
    expect(all).toContain('aria-label="加载中"');
  });

  it("404（WORKFLOW_NOT_FOUND）：给专属文案，且不给无意义的重试按钮", async () => {
    const { all } = await renderWorkflows((pinia) => {
      const store = useWorkflowsStore(pinia);
      store.current = detail({ workflow: makeWorkflow({ status: "RUNNING" }) });
      store.traceNotFound = true;
      store.traceError = "该工作流不存在，可能已被删除。";
    }, DETAIL_PATH);
    expect(all).toContain("该工作流不存在，可能已被删除。");
    expect(all).not.toContain("尚未加载追踪。");
    expect(all).not.toMatch(/>重试<\/button>/);
  });

  it("网络 / 服务端失败：文案可区分，且可重试", async () => {
    const { all } = await renderWorkflows((pinia) => {
      const store = useWorkflowsStore(pinia);
      store.current = detail({ workflow: makeWorkflow({ status: "RUNNING" }) });
      store.traceError = "网络请求失败：无法连接后端服务";
    }, DETAIL_PATH);
    expect(all).toContain("网络请求失败：无法连接后端服务");
    expect(all).not.toContain("该工作流不存在");
    expect(all).toMatch(/>重试<\/button>/);
  });
});
