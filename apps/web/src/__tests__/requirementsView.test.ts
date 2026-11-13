import {
  type Requirement,
  type Specification,
  type Task,
  type TaskDependencyView
} from "@ai-se/shared";
import { createPinia, type Pinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import { useRequirementsStore } from "@/stores/requirements";
import RequirementsView from "@/views/RequirementsView.vue";

/**
 * RequirementsView 页面契约测试（布局重构：表格 + 分页 + 弹窗 + 抽屉）。
 *
 * 覆盖：页头「新建需求」触发器（DialogTrigger 语义）、创建表单（弹窗内容，经 Teleport 输出）、
 * 需求列表表格（列 / 行 / 状态徽标 / 操作按钮）、Table 内置分页、分析按钮禁用条件、
 * 详情抽屉（指标 + 四个面板 + PRD / 规格 / 任务 / 依赖）与弹窗、抽屉的默认关闭态。
 *
 * SSR 下 onMounted / onUnmounted 不执行 ⇒ 不触发网络请求或 SSE；Store 状态由测试注入。
 * 弹窗与抽屉内容经 Reka DialogPortal 输出到 Teleport —— 本文件用 renderToString 的
 * ctx.teleports 收集（组件侧以 unmount-on-hide=false + portal force-mount 保证内容可见），
 * `all` = 页面主输出 + Teleport 内容。
 */

function makeRequirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: "req-1",
    projectId: "proj-1",
    title: "Todo 管理系统",
    description: "阶段 3 规划示例",
    rawContent: "# Mini PRD",
    status: "ANALYZED",
    version: 1,
    createdAt: "2026-09-14T03:04:56.701Z",
    updatedAt: "2026-09-14T03:04:56.701Z",
    ...overrides
  } as Requirement;
}

function makeSpecification(): Specification {
  return {
    id: "spec-1",
    projectId: "proj-1",
    requirementId: "req-1",
    type: "API",
    version: 1,
    status: "VALIDATED",
    content: { specKey: "api-contract", endpoints: ["/api/todos"] },
    createdAt: "2026-09-14T03:04:56.701Z"
  } as unknown as Specification;
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
    status: "WAITING_APPROVAL",
    version: 1,
    input: { sourceSpecTypes: ["API"] },
    createdAt: "2026-09-14T03:04:56.701Z",
    updatedAt: "2026-09-14T03:04:56.701Z",
    ...overrides
  } as unknown as Task;
}

const dependency: TaskDependencyView = {
  id: "dep-1",
  sourceTaskId: "task-1",
  targetTaskId: "task-2",
  sourceTaskKey: "T-001",
  targetTaskKey: "T-002"
} as TaskDependencyView;

interface RenderResult {
  /** 页面主 SSR 输出（不含 Teleport 内容） */
  html: string;
  /** 主输出 + Teleport 内容（弹窗表单 / 抽屉详情所在） */
  all: string;
}

async function renderRequirements(
  seed?: (pinia: Pinia) => void,
  path = "/requirements"
): Promise<RenderResult> {
  // W11：抽屉开合由 `?requirement=` 驱动，因此渲染时必须装一个真实的 router
  // （此前本文件不装 router，`useRoute()` 返回 undefined）。
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/requirements", component: RequirementsView }]
  });
  await router.push(path);
  await router.isReady();

  const app = createSSRApp({ render: () => h(RequirementsView) });
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  seed?.(pinia);
  const ctx: { teleports?: Record<string, string> } = {};
  const html = await renderToString(app, ctx);
  const teleports = ctx.teleports ?? {};
  return { html, all: [html, ...Object.values(teleports)].join("\n") };
}

/** 匹配文本按钮（兼容 Vue SSR 对插槽内容的 `<!--[-->…<!--]-->` 包裹与首尾空白）。 */
function textButtonPattern(text: string): RegExp {
  return new RegExp(`<button[^>]*>(?:<!--\\[-->)?\\s*${text}\\s*(?:<!--\\]-->)?</button>`, "g");
}

/** 判断按钮标签上是否存在 disabled 属性（避免命中 `disabled:` 工具类前缀）。 */
function hasDisabledAttr(button: string): boolean {
  return / disabled[\s>]/.test(button);
}

describe("RequirementsView — 布局重构（表格 + 分页 + 弹窗 + 抽屉）", () => {
  it("页头：标题为「需求」，右侧为「新建需求」触发器（button + aria 状态）", async () => {
    const { html } = await renderRequirements();
    expect(html).toMatch(/<h1[^>]*>(?:<!--\[-->)?需求/);
    expect(html).toContain("新建需求");
    expect(html).toMatch(/<button[^>]*>(?:<!--\[-->)?新建需求/);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-state="closed"');
  });

  it("创建表单位于弹窗（Teleport）内：控件、约束与既有文案原样", async () => {
    const { html, all } = await renderRequirements();
    for (const label of ["项目", "标题", "描述", "PRD"]) {
      expect(all, `应包含字段 ${label}`).toContain(label);
    }
    expect(all).toContain('for="requirement-project"');
    expect(all).toContain('id="requirement-project"');
    // 下拉选择由组件库 Select 渲染：触发器是 button[role=combobox]，无原生 <select>
    expect(all).toContain('role="combobox"');
    expect(all).toContain("选择项目");
    expect(all).not.toContain("<select");
    expect(all).toContain('for="requirement-title"');
    expect(all).toContain('maxlength="160"');
    expect(all).toContain('for="requirement-description"');
    expect(all).toContain('maxlength="1000"');
    expect(all).toContain('for="requirement-prd"');
    expect(all).toContain('maxlength="200000"');
    expect(all).toMatch(/<textarea[^>]*rows="7"/);
    // D1（docs/229）：PRD 与技术需求文档都可以以文件方式给过来，入口在创建弹窗内。
    expect(all).toContain('id="requirement-prd-file"');
    expect(all).toContain('id="requirement-trd-file"');
    expect(all).toContain('id="requirement-ui-ref-file"');
    expect(all).toContain("技术需求文档");
    expect(all).toContain("UI 参照图");
    // 未新增 required / 未启用 HTML 校验（与迁移前一致）
    expect(all).not.toMatch(/<(input|select|textarea)[^>]*\srequired/);
    expect(all).not.toContain('type="url"');
    // 表单内容经 Teleport 渲染：不在页面本体
    expect(html).not.toContain("requirement-title");
  });

  it("表单保留既有初始值，且未选项目时创建按钮 disabled", async () => {
    const { all } = await renderRequirements();
    expect(all).toContain("Todo 管理系统");
    expect(all).toContain("阶段 3 规划示例");
    expect(all).toContain("创建一个简单的 Todo 管理系统");
    // SSR 下 onMounted 不执行 ⇒ selectedProjectId 为空 ⇒ 创建按钮保持 disabled（守卫不变）
    const submit = all.match(/<button[^>]*type="submit"[^>]*>/);
    expect(submit, "应渲染提交按钮").not.toBeNull();
    expect(submit![0]).toContain("disabled");
  });

  it("列表 loading 分支：渲染骨架屏，不再用「正在加载需求…」文字", async () => {
    const { html } = await renderRequirements((pinia) => {
      useRequirementsStore(pinia).loading = true;
    });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="加载中"');
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("正在加载需求…");
    expect(html).not.toContain("暂无需求。");
    expect(html).not.toContain("<table");
  });

  it("列表 error 分支：渲染可重试错误态，且优先于空态", async () => {
    const { html } = await renderRequirements((pinia) => {
      useRequirementsStore(pinia).error = "网络请求失败：无法连接后端服务";
    });
    expect(html).toContain("网络请求失败：无法连接后端服务");
    expect(html).toContain('role="alert"');
    expect(html).toContain("bg-danger-bg");
    expect(html).toMatch(/<button[^>]*>(?:<!--\[-->)?重试(?:<!--\]-->)?<\/button>/);
    expect(html).not.toContain("暂无需求。");
  });

  it("列表空态使用 EmptyState 且保留原文案", async () => {
    const { html } = await renderRequirements();
    expect(html).toContain("暂无需求。");
    expect(html).not.toContain("<table");
  });

  it("列表表格：4 列表头、每行标题/状态徽标/时间与「详情」「分析」操作按钮", async () => {
    const { html } = await renderRequirements((pinia) => {
      const store = useRequirementsStore(pinia);
      store.requirements = [
        makeRequirement({ id: "req-1", title: "Todo 管理系统", status: "ANALYZED" }),
        makeRequirement({ id: "req-2", title: "报表系统", status: "FAILED" })
      ];
      store.selectedRequirement = store.requirements[0];
    });
    expect((html.match(/<th scope="col"/g) || []).length).toBe(4);
    for (const label of ["标题", "状态", "创建时间", "操作"]) {
      expect(html, `表头应包含 ${label}`).toContain(label);
    }
    expect((html.match(/<tr/g) || []).length).toBe(3); // 表头 1 + 数据 2
    expect(html).toContain("Todo 管理系统");
    expect(html).toContain("报表系统");
    expect(html).toContain("已分析");
    expect(html).toContain("bg-success-bg");
    expect(html).toContain("失败");
    expect(html).toContain("bg-danger-bg");
    expect(html).toMatch(/\d+月\d+日/); // 创建时间（formatDateTime 输出，形如 9月14日 …）
    // 计数徽标
    expect(html).toMatch(/rounded-full[^>]*>(?:<!--\[-->)?2(?:<!--\]-->)?</);
    // 操作列：每行「详情」+「分析」，默认均可用
    const detailButtons = html.match(textButtonPattern("详情")) ?? [];
    const analyzeButtons = html.match(textButtonPattern("分析")) ?? [];
    expect(detailButtons.length).toBe(2);
    expect(analyzeButtons.length).toBe(2);
    expect(detailButtons.every((button) => !hasDisabledAttr(button))).toBe(true);
    expect(analyzeButtons.every((button) => !hasDisabledAttr(button))).toBe(true);
  });

  it("Table 内置分页：page-size=10 只渲染第 1 页并显示「共 N 条」与页码控件", async () => {
    const { html } = await renderRequirements((pinia) => {
      const store = useRequirementsStore(pinia);
      store.requirements = Array.from({ length: 12 }, (_, index) =>
        makeRequirement({
          id: `req-${index + 1}`,
          title: `测试需求${String(index + 1).padStart(2, "0")}`
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

  it("分析按钮：行状态 ANALYZING 时禁用；分析进行中当前行显示「分析中…」", async () => {
    const { html } = await renderRequirements((pinia) => {
      const store = useRequirementsStore(pinia);
      store.requirements = [
        makeRequirement({ id: "req-1", status: "ANALYZED" }),
        makeRequirement({ id: "req-2", title: "报表系统", status: "ANALYZING" })
      ];
    });
    const analyzeButtons = html.match(textButtonPattern("分析")) ?? [];
    expect(analyzeButtons.length).toBe(2);
    expect(analyzeButtons.filter((button) => hasDisabledAttr(button)).length).toBe(1);

    const running = await renderRequirements((pinia) => {
      const store = useRequirementsStore(pinia);
      store.requirements = [makeRequirement({ id: "req-1" })];
      store.selectedRequirement = store.requirements[0];
      store.analyzing = true;
    });
    const runningButtons = running.html.match(textButtonPattern("分析中…")) ?? [];
    expect(runningButtons).toHaveLength(1);
    const runningButton = runningButtons[0] ?? "";
    expect(runningButton).not.toBe("");
    expect(hasDisabledAttr(runningButton)).toBe(true);
    expect(running.html.match(textButtonPattern("分析")) ?? []).toHaveLength(0);
  });

  it("详情抽屉：加载分支为骨架屏，空态文案保留", async () => {
    const loading = await renderRequirements((pinia) => {
      useRequirementsStore(pinia).detailLoading = true;
    });
    expect(loading.all).toContain('role="status"');
    expect(loading.all).not.toContain("正在加载需求详情…");
    expect(loading.all).not.toContain("请选择或创建需求。");

    const empty = await renderRequirements();
    expect(empty.all).toContain("请选择或创建需求。");
    expect(empty.all).not.toContain("正在加载需求详情…");
  });

  it("详情抽屉：指标 4 卡（状态/版本/规格/任务）+ 四个面板 + 详情字段全部保留", async () => {
    const { all } = await renderRequirements((pinia) => {
      const store = useRequirementsStore(pinia);
      store.selectedRequirement = makeRequirement({ status: "ANALYZED", version: 3 });
      store.taskGraph = {
        tasks: [makeTask(), makeTask({ id: "task-2", taskKey: "T-002" })],
        dependencies: [dependency]
      };
    });
    expect(all).toContain("lg:grid-cols-4");
    expect(all).not.toContain("md:grid-cols-3");
    for (const label of ["状态", "版本", "规格", "任务"]) {
      expect(all, `指标应包含 ${label}`).toContain(label);
    }
    expect((all.match(/text-metric/g) || []).length).toBe(4);
    expect(all).toContain("v3");
    expect(all).toContain("已分析");
    // 四个面板
    for (const panel of ["需求详情", "规划事件", "规格", "任务 DAG"]) {
      expect(all, `应包含面板 ${panel}`).toContain(panel);
    }
    // 详情字段（顺序未变）
    expect(all).toContain("创建时间");
    expect(all).toContain("阶段 3 规划示例");
    // W5：三行详情字段改用 DetailRow（.detail-row 组件样式），替代原先每页各写的
    // grid-cols-[110px_1fr] + divide-y
    expect((all.match(/class="detail-row"/g) || []).length).toBe(3);
    expect(all).not.toContain("grid-cols-[110px");
    // 未生成时的空态文案
    expect(all).toContain("暂无规划事件。");
    expect(all).toContain("尚未生成规格。");
    // 依赖关系胶囊（任务 DAG 面板；HTML 中 "->" 转义为 "-&gt;"）
    expect(all).toContain("依赖关系");
    expect(all).toContain("T-001 -&gt; T-002");
  });

  it("详情抽屉：PRD 为限高可滚动的独立内容块，内容一字不删", async () => {
    const { all } = await renderRequirements((pinia) => {
      useRequirementsStore(pinia).selectedRequirement = makeRequirement({
        rawContent: "# Mini PRD\n\n1. 背景\n2. 目标"
      });
    });
    // W5：PRD 作为 DetailRow 的值列，原先的 `requirement-prd` 标记类已随 scoped 块删除
    expect(all).toContain('class="detail-row"');
    expect(all).toContain("max-h-55");
    expect(all).toContain("overflow-auto");
    expect(all).toContain("whitespace-pre-wrap");
    expect(all).toContain("Mini PRD");
    expect(all).toContain("描述");
    expect(all).toContain("创建时间");
  });

  it("详情抽屉：规格 ≥900px 两列网格，7 个规格与 JSON 内容全部保留", async () => {
    const SPEC_TYPES = [
      "REQUIREMENT_ANALYSIS",
      "FUNCTIONAL",
      "TECHNICAL",
      "ARCHITECTURE",
      "API",
      "DATABASE",
      "UI"
    ] as const;
    const { all } = await renderRequirements((pinia) => {
      const store = useRequirementsStore(pinia);
      store.selectedRequirement = makeRequirement();
      store.specifications = SPEC_TYPES.map((type, index) => ({
        ...makeSpecification(),
        id: `spec-${index + 1}`,
        type,
        content: { specKey: `spec-${index + 1}` }
      })) as Specification[];
    });
    expect(all).toContain("lg:grid-cols-2");
    expect((all.match(/<pre/g) || []).length).toBe(7);
    expect((all.match(/border border-border p-3\.5/g) || []).length).toBe(7);
    for (const label of ["需求分析", "功能", "技术", "架构", "API", "数据库", "UI"]) {
      expect(all).toContain(label);
    }
    expect(all).toContain("specKey");
    expect(all).toContain("max-h-55");
  });

  it("详情抽屉：空规格（类别不适用）显示「不适用」说明而不是空 JSON", async () => {
    const { all } = await renderRequirements((pinia) => {
      const store = useRequirementsStore(pinia);
      store.selectedRequirement = makeRequirement();
      store.specifications = [
        {
          ...makeSpecification(),
          id: "spec-empty",
          type: "DATABASE",
          content: { tables: [] }
        } as unknown as Specification
      ];
    });
    expect(all).toContain("数据库");
    expect(all).toContain("不适用：该类别在本需求中没有条目");
    // 空规格不再平铺原始 JSON
    expect(all).not.toContain("tables");
  });

  it("详情抽屉：规划事件有数据时渲染事件行（标签 / 摘要 / 时间）", async () => {
    const { all } = await renderRequirements((pinia) => {
      const store = useRequirementsStore(pinia);
      store.selectedRequirement = makeRequirement();
      store.currentAgentRun = {
        run: { id: "run-1", status: "running" },
        toolCalls: [],
        events: [
          {
            id: "evt-1",
            eventType: "agent_run_started",
            payload: {},
            createdAt: "2026-09-14T03:04:56.701Z"
          }
        ]
      } as unknown as typeof store.currentAgentRun;
    });
    expect(all).not.toContain("暂无规划事件。");
    expect(all).toContain("已开始");
    expect(all).toContain("lg:grid-cols-[minmax(0,1fr)_180px]");
  });

  it("详情抽屉：任务 DAG 节点字段与任务状态徽标 tone 全部渲染", async () => {
    const { all } = await renderRequirements((pinia) => {
      const store = useRequirementsStore(pinia);
      store.selectedRequirement = makeRequirement();
      store.taskGraph = {
        tasks: [
          makeTask({ status: "WAITING_APPROVAL" }),
          makeTask({
            id: "task-2",
            taskKey: "T-002",
            status: "RUNNING",
            input: { sourceSpecTypes: [] }
          })
        ],
        dependencies: [dependency]
      };
    });
    expect(all).toContain("T-001");
    expect(all).toContain("Project service 骨架");
    expect(all).toContain("后端");
    expect(all).toContain("等待审批");
    expect(all).toContain("bg-warning-bg");
    expect(all).toContain("运行中");
    expect(all).toContain("bg-info-bg");
    expect(all).toContain("minmax(220px,1fr)");
  });

  it("详情抽屉：依赖区限高滚动，73 条依赖全部渲染", async () => {
    const tasks = Array.from({ length: 33 }, (_, index) => ({
      ...makeTask(),
      id: `task-${index + 1}`,
      taskKey: `T-${String(index + 1).padStart(3, "0")}`
    })) as Task[];
    const dependencies = Array.from({ length: 73 }, (_, index) => ({
      id: `dep-${index + 1}`,
      sourceTaskId: `task-${(index % 33) + 1}`,
      targetTaskId: `task-${((index + 1) % 33) + 1}`,
      sourceTaskKey: `T-${String((index % 33) + 1).padStart(3, "0")}`,
      targetTaskKey: `T-${String(((index + 1) % 33) + 1).padStart(3, "0")}`
    })) as TaskDependencyView[];

    const { all } = await renderRequirements((pinia) => {
      const store = useRequirementsStore(pinia);
      store.selectedRequirement = makeRequirement();
      store.taskGraph = { tasks, dependencies };
    });
    // W10：依赖关系区块改用容器自身的能力定位（`requirement-dependencies` 是无 CSS 规则的死类名，已删）
    expect(all).toContain("依赖关系");
    expect(all).toContain("max-h-45");
    expect(all).toContain("依赖关系");
    expect((all.match(/ -&gt; /g) || []).length).toBe(73);
    expect(all).toContain("73 条依赖");
    // 任务节点网格未被改动
    expect(all).toContain("minmax(220px,1fr)");
  });

  it("W11：`?requirement=<id>` 深链接直接打开该需求的详情抽屉", async () => {
    // 种入同一个需求 ⇒ `ensureRequirementLoaded` 的「已在看同一个」守卫命中，不发请求
    const seed = (pinia: Pinia) => {
      useRequirementsStore(pinia).selectedRequirement = makeRequirement({ id: "req-1" });
    };
    const closed = await renderRequirements(seed);
    const open = await renderRequirements(seed, "/requirements?requirement=req-1");
    const hidden = (html: string) => (html.match(/display:none/g) || []).length;

    // 关闭的弹层由 Reka 打上 display:none；深链接下少一个（抽屉不再隐藏）
    expect(hidden(open.all)).toBeLessThan(hidden(closed.all));
    expect(open.all).toContain("需求详情");
  });

  it("弹窗与抽屉：默认关闭（内容挂载但 display:none），标题与关闭按钮齐备", async () => {
    const { all } = await renderRequirements();
    expect((all.match(/role="dialog"/g) || []).length).toBe(2);
    expect((all.match(/aria-label="关闭"/g) || []).length).toBe(2);
    expect(all).toContain("aria-labelledby");
    expect((all.match(/display:none/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("页头「新建需求」位于「需求列表」之前（DOM 顺序）", async () => {
    const { html } = await renderRequirements();
    const triggerIndex = html.indexOf("新建需求");
    const listIndex = html.indexOf("需求列表");
    expect(triggerIndex).toBeGreaterThan(-1);
    expect(listIndex).toBeGreaterThan(-1);
    expect(triggerIndex).toBeLessThan(listIndex);
  });

  it("引入 Table 内置分页，且不引入 Tabs / Breadcrumb / 搜索 / 筛选 / 排序 / Accordion", async () => {
    const { html, all } = await renderRequirements((pinia) => {
      useRequirementsStore(pinia).requirements = [makeRequirement()];
    });
    for (const forbidden of [
      "breadcrumb",
      'class="tab',
      "mcp-tab",
      "搜索",
      "筛选",
      "排序",
      "accordion"
    ]) {
      expect(all, `不应包含 ${forbidden}`).not.toContain(forbidden);
    }
    expect(html).toContain("共 1 条");
    expect(html).toContain('aria-label="下一页"');
  });

  it("不得再出现任何 legacy 类名（含已移除的 requirement-list-item）", async () => {
    const { all } = await renderRequirements((pinia) => {
      const store = useRequirementsStore(pinia);
      store.selectedRequirement = makeRequirement();
    });
    for (const token of [
      "two-column",
      "main-column",
      "run-layout",
      "run-list",
      "run-metrics",
      "metric-grid",
      "panel-header",
      'class="panel',
      "detail-list",
      "compact-detail-list",
      "event-row",
      "event-list",
      "spec-grid",
      "result-block",
      "dag-node",
      "dependency-list",
      'class="state',
      'class="empty',
      'class="button',
      "requirement-list-item"
    ]) {
      expect(all).not.toContain(token);
    }
  });

  it("冲突区展示裁决选项与提交按钮（跟 PRD / 跟 TRD / 自定义）", async () => {
    const { all } = await renderRequirements((pinia) => {
      const store = useRequirementsStore(pinia);
      store.selectedRequirement = makeRequirement();
      store.specifications = [
        {
          id: "spec-analysis",
          projectId: "proj-1",
          requirementId: "req-1",
          type: "REQUIREMENT_ANALYSIS",
          version: 1,
          status: "VALIDATED",
          content: {
            id: "REQ-1",
            summary: "TaskFlow",
            goals: ["交付"],
            constraints: [],
            assumptions: [],
            acceptanceCriteria: ["可用"],
            risks: [],
            technicalDocumentConflicts: [
              {
                topic: "鉴权",
                prdSays: "JWT",
                documentSays: "session",
                source: "TaskFlow TRD.md"
              }
            ]
          },
          createdAt: "2026-09-14T03:04:56.701Z"
        } as unknown as Specification
      ];
      store.conflictResolutions = [];
    }, "/requirements?requirement=req-1");

    expect(all).toContain("技术文档与 PRD 的冲突（人工裁决）");
    expect(all).toContain("跟 PRD");
    expect(all).toContain("跟 TRD");
    expect(all).toContain("自定义");
    expect(all).toContain("提交裁决");
    expect(all).toContain("鉴权");
  });

});
