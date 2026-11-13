import { createPinia, type Pinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import { useAgentsStore } from "@/stores/agents";
import AgentsView from "@/views/AgentsView.vue";

/**
 * AgentsView 页面契约测试（布局重构：表格 + 分页 + 抽屉详情，承接 Phase 8-B）。
 *
 * 覆盖：PageHeader 文案、6 张指标卡（文案/顺序/取值）、注册表表格三态（列 / 行 / 类型 /
 * 可用性 / 操作按钮）、Table 内置分页、详情抽屉（可用性 StatusBadge、描述、4 项 dl 字段、
 * 运行列表深链接、产出物、计数 Badge）、error 语义色、empty、弹层默认关闭态与 legacy 类名清除。
 *
 * SSR 下 onMounted 不执行 ⇒ 不触发任何网络请求；Store 状态由测试注入（不做 API mock）。
 * 详情抽屉内容经 Reka DialogPortal 输出到 Teleport（组件侧 unmount-on-hide=false +
 * portal force-mount ⇒ 关闭态内容仍挂载），`all` = 页面主输出 + Teleport 内容。
 * 真实 API / 交互由浏览器验证承担（见 docs/79）。
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
  /** 主输出 + Teleport 内容（详情抽屉所在） */
  all: string;
}

async function renderAgents(
  seed?: (pinia: Pinia) => void,
  path = "/agents"
): Promise<RenderResult> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/agents", component: AgentsView },
      { path: "/agent-run", component: { render: () => null } }
    ]
  });
  await router.push(path);
  await router.isReady();

  const app = createSSRApp({ render: () => h(AgentsView) });
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

function makeAgent(name: string, type: string) {
  return {
    name,
    type,
    status: "available",
    description: `负责 ${name}`,
    capabilities: ["PLAN"],
    tools: ["read_file"],
    permissions: { pathPrefixes: ["."], readOnly: true }
  };
}

function seedAgents(pinia: Pinia, overrides: Record<string, unknown> = {}) {
  const store = useAgentsStore(pinia);
  store.agents = [
    makeAgent("planner-agent", "PLANNER"),
    makeAgent("backend-agent", "BACKEND")
  ] as never;
  store.metrics = {
    agentSuccessRate: 0.875,
    taskSuccessRate: 0.5,
    toolSuccessRate: 1,
    testPassRate: 0.25,
    reviewPassRate: 0.75,
    repairSuccessRate: 0.9
  } as never;
  store.current = {
    definition: {
      name: "planner-agent",
      type: "PLANNER",
      status: "available",
      description: "负责把需求拆解为可执行任务",
      capabilities: ["PLAN", "REVIEW"],
      tools: ["read_file", "write_file"],
      permissions: { pathPrefixes: ["."], readOnly: true }
    },
    runs: [
      { id: "run-1", status: "succeeded", input: { taskKey: "T-001" } },
      { id: "run-2", status: "timed_out", input: {}, taskId: "task-9" }
    ],
    artifacts: [
      { id: "art-1", type: "CODE_DIFF", name: "diff.patch", createdAt: "2026-09-14T03:04:05.000Z" }
    ],
    ...overrides
  } as never;
}

describe("AgentsView — 布局重构（表格 + 分页 + 抽屉）", () => {
  it("PageHeader 与 6 张指标卡（文案、顺序、取值）", async () => {
    const { html } = await renderAgents((pinia) => seedAgents(pinia));
    expect(html).toMatch(/<h1[^>]*>专业 Agent/);
    const labels = [
      "Agent 成功率",
      "任务成功率",
      "工具成功率",
      "测试通过率",
      "评审通过率",
      "修复成功率"
    ];
    for (const label of labels) {
      expect(html, `应包含指标 ${label}`).toContain(label);
    }
    // 顺序与取值
    expect(labels.map((l) => html.indexOf(l))).toEqual(
      [...labels.map((l) => html.indexOf(l))].sort((a, b) => a - b)
    );
    for (const value of ["88%", "50%", "100%", "25%", "75%", "90%"]) {
      expect(html, `应包含指标值 ${value}`).toContain(value);
    }
    expect((html.match(/text-metric/g) || []).length).toBe(6);
  });

  it("指标无数据时显示「暂无数据」（metrics = null）", async () => {
    const { html } = await renderAgents();
    expect((html.match(/暂无数据/g) || []).length).toBe(6);
  });

  it("注册表四态 + 表格 4 列（名称/类型/状态/操作）+ 可用性与「详情」按钮", async () => {
    const loading = await renderAgents((pinia) => {
      const store = useAgentsStore(pinia);
      store.loading = true;
    });
    expect(loading.html).toContain('role="status"');
    expect(loading.html).toContain('aria-label="加载中"');
    expect(loading.html).not.toContain("加载中…");
    expect(loading.html).not.toContain("暂无已注册的 Agent。");
    expect(loading.html).not.toContain("<table");

    const errored = await renderAgents((pinia) => {
      useAgentsStore(pinia).error = "注册表读取失败";
    });
    expect(errored.html).toContain("注册表读取失败");
    expect(errored.html).toContain('role="alert"');
    expect(errored.html).toMatch(/<button[^>]*>(?:<!--\[-->)?重试/);
    // 错误优先于空态
    expect(errored.html).not.toContain("暂无已注册的 Agent。");

    const empty = await renderAgents();
    expect(empty.html).toContain("暂无已注册的 Agent。");
    // 本页无 create API ⇒ 空态的下一步动作是「刷新」而非假的创建按钮
    expect(empty.html).toMatch(/<button[^>]*>(?:<!--\[-->)?刷新/);
    expect(empty.html).not.toContain("<table");

    const list = await renderAgents((pinia) => seedAgents(pinia));
    expect(list.html).not.toContain("暂无已注册的 Agent。");
    expect((list.html.match(/<th scope="col"/g) || []).length).toBe(4);
    for (const label of ["名称", "类型", "状态", "操作"]) {
      expect(list.html, `表头应包含 ${label}`).toContain(label);
    }
    expect((list.html.match(/<tr/g) || []).length).toBe(3); // 表头 1 + 数据 2
    expect(list.html).toContain("planner-agent");
    expect(list.html).toContain("backend-agent");
    expect(list.html).toContain("规划"); // agentTypeLabel(PLANNER) → Badge
    expect(list.html).toContain("后端"); // agentTypeLabel(BACKEND)
    expect((list.html.match(/可用/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((list.html.match(buttonPattern("详情")) || []).length).toBe(2);
    // 不得复用 legacy class
    expect(list.html).not.toContain("agent-item");
    expect(list.html).not.toContain("workflow-list-item");
    expect(list.html).not.toContain('class="metric');
    expect(list.html).not.toContain("detail-list");
  });

  it("Table 内置分页：page-size=10 只渲染第 1 页并显示「共 N 条」与页码控件", async () => {
    const { html } = await renderAgents((pinia) => {
      useAgentsStore(pinia).agents = Array.from({ length: 12 }, (_, index) =>
        makeAgent(`agent-${String(index + 1).padStart(2, "0")}`, "BACKEND")
      ) as never;
    });
    expect(html).toContain("共 12 条");
    expect(html).toContain('aria-label="下一页"');
    expect((html.match(/<tr/g) || []).length).toBe(11); // 表头 + 第 1 页 10 行
    expect(html).toContain("agent-01");
    expect(html).toContain("agent-10");
    expect(html).not.toContain("agent-11");
  });

  it("详情抽屉：可用性 StatusBadge（success tone）、描述、4 项 dl 字段与顺序", async () => {
    const { all } = await renderAgents((pinia) => seedAgents(pinia));
    expect(all).toContain("Agent 详情");
    expect(all).toContain("负责把需求拆解为可执行任务");
    expect(all).toContain("bg-success-bg"); // available → success
    expect(all).toContain("可用");
    for (const field of ["能力", "工具", "路径", "模式"]) {
      expect(all, `应包含字段 ${field}`).toContain(field);
    }
    expect(all).toContain("规划、评审"); // capabilityLabel 串联
    expect(all).toContain("read_file, write_file");
    expect(all).toContain("只读");
    // W5：4 项字段改用 DetailRow（`.detail-row` 组件样式），
    // 不再逐行书写 grid-cols-[110px_minmax(0,1fr)] + 边框/内距工具类
    expect((all.match(/class="detail-row"/g) || []).length).toBe(4);
    expect(all).not.toContain("grid-cols-[110px_minmax(0,1fr)]");
  });

  it("详情抽屉：运行列表（状态 tone、任务键、深链接 URL 与计数 Badge）", async () => {
    const { all } = await renderAgents((pinia) => seedAgents(pinia));
    expect(all).toContain("已成功");
    expect(all).toContain("bg-success-bg");
    expect(all).toContain("已超时");
    expect(all).toContain("bg-warning-bg");
    expect(all).toContain("T-001");
    expect(all).toContain("task-9");
    expect(all).toContain('href="/agent-run?run=run-1"');
    expect(all).toContain('href="/agent-run?run=run-2"');
    expect(all).toContain(">打开<");
    // 计数 Badge（2 个 run / 1 个产出物）
    expect((all.match(/>2</g) || []).length).toBeGreaterThanOrEqual(1);
    expect((all.match(/>1</g) || []).length).toBeGreaterThanOrEqual(1);
  });

  it("详情抽屉：产出物列表（类型文案 + 名称 + 时间）；无数据时 empty", async () => {
    const { all } = await renderAgents((pinia) => seedAgents(pinia));
    expect(all).toContain("代码差异");
    expect(all).toContain("diff.patch");

    const noArtifacts = await renderAgents((pinia) =>
      seedAgents(pinia, { artifacts: [], runs: [] })
    );
    expect(noArtifacts.all).toContain("暂无运行记录。");
    expect(noArtifacts.all).toContain("暂无产出物。");
  });

  it("无选中 Agent 时显示 EmptyState；error 使用 danger 语义色", async () => {
    const empty = await renderAgents((pinia) => {
      const store = useAgentsStore(pinia);
      store.current = null;
      store.agents = [makeAgent("planner-agent", "PLANNER")] as never;
    });
    expect(empty.all).toContain("请选择 Agent。");

    const withError = await renderAgents((pinia) => {
      const store = useAgentsStore(pinia);
      store.error = "Agent 请求失败";
    });
    expect(withError.html).toContain("Agent 请求失败");
    expect(withError.html).toContain("text-danger");
    expect(withError.html).not.toContain("error-banner");
  });

  it("弹层默认状态：抽屉挂载但隐藏（display:none），关闭态内容仍可经 Teleport 断言", async () => {
    const { all } = await renderAgents((pinia) => seedAgents(pinia));
    expect((all.match(/role="dialog"/g) || []).length).toBe(1); // 本页仅抽屉
    expect((all.match(/aria-label="关闭"/g) || []).length).toBe(1);
    expect((all.match(/aria-labelledby/g) || []).length).toBeGreaterThanOrEqual(1);
    expect((all.match(/display:\s*none/g) || []).length).toBeGreaterThanOrEqual(1);
    // 抽屉关闭但内容仍挂载（详情内容可断言）
    expect(all).toContain("负责把需求拆解为可执行任务");
  });

  it("W11：`?agent=<name>` 深链接直接打开该 Agent 的详情抽屉", async () => {
    const hidden = (html: string) => (html.match(/display:\s*none/g) || []).length;
    const closed = await renderAgents((pinia) => seedAgents(pinia));
    const open = await renderAgents((pinia) => seedAgents(pinia), "/agents?agent=planner-agent");

    // 抽屉不再隐藏（关闭态由 Reka 打上 display:none）；内容仍是同一个 Agent
    expect(hidden(open.all)).toBeLessThan(hidden(closed.all));
    expect(open.all).toContain("负责把需求拆解为可执行任务");
  });

  it("不得再出现 legacy 类名（agent-item 等），既有 agent-link 保留", async () => {
    const { all } = await renderAgents((pinia) => seedAgents(pinia));
    for (const legacy of [
      "agent-item",
      "workflow-list-item",
      "panel-header",
      "agent-list-panel",
      "agent-detail-column",
      "event-row",
      "tool-call-row",
      "compact-empty"
    ]) {
      expect(all, `不应出现 legacy 类 ${legacy}`).not.toContain(legacy);
    }
    // W10：跳转链接改用 `href` 定位（原先依赖的 `agent-link` 是一个无 CSS 规则的死类名，已删）
    expect(all).toContain('href="/agent-run?run=');
  });
});
