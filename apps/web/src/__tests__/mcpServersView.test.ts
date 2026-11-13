import type { MCPServerSummary } from "@ai-se/shared";
import { createPinia, type Pinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import { useMCPStore } from "@/stores/mcp";
import MCPServersView from "@/views/MCPServersView.vue";

/**
 * /mcp（MCP 服务器列表）页面契约测试 —— Phase 10-B 布局重构后。
 *
 * 覆盖：PageHeader / 注册表边界说明 / loading → error → empty → 列表 四分支、
 * 行内真实字段（名称链接、描述、传输·工具数·最近连接）、状态与启用态 tone、
 * 目标链接，以及"不得再出现任何 legacy 类名"的护栏。
 *
 * 不测业务 API（SSR 下 onMounted 不会触发请求）：store 状态由测试直接注入，
 * 不调用后端、不创建任何 MCP 注册表数据。
 */

const Blank = { render: () => null };

/** SSR 输出含换行与缩进（whitespace 折叠 + slot 被 fragment 注释包裹），统一归一化后再断言。 */
function norm(html: string): string {
  return html.replace(/<!--[^>]*-->/g, "").replace(/\s+/g, " ").trim();
}

function makeServer(
  id: string,
  name: string,
  overrides: Partial<MCPServerSummary> = {}
): MCPServerSummary {
  return {
    id,
    name,
    description: "",
    transport: "stdio",
    enabled: true,
    status: "CONNECTED",
    toolCount: 0,
    ...overrides
  };
}

async function renderList(seed?: (pinia: Pinia) => void): Promise<string> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/mcp", component: MCPServersView },
      { path: "/mcp/:serverId", component: Blank },
      { path: "/mcp/:serverId/app", component: Blank }
    ]
  });
  await router.push("/mcp");
  await router.isReady();

  const app = createSSRApp({ render: () => h(MCPServersView) });
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  seed?.(pinia);

  return norm(await renderToString(app));
}

/** legacy class 护栏：迁移后新 markup 不得再出现这些类名（原 styles.css 中的定义，该文件已在 W2 删除）。 */
const LEGACY_TOKENS = [
  "page-header",
  "project-list",
  "project-row",
  "project-title",
  "row-actions",
  "mcp-status-",
  "mcp-risk-",
  "mcp-disabled",
  "mcp-note",
  "mcp-summary",
  "mcp-detail-grid",
  "mcp-app-frame",
  "mcp-app-log",
  // W5：列表项的 scoped 类全部改为工具类，这些标记类随之删除
  "mcp-server-item",
  "mcp-server-link",
  "mcp-server-desc",
  "mcp-server-meta",
  "mcp-action-link",
  "tab-bar",
  "compact-list",
  "stacked-form",
  'class="panel',
  'class="button',
  'class="state',
  'class="empty'
];

describe("MCPServersView — 页头与边界说明", () => {
  it("渲染 PageHeader（标题）与刷新按钮", async () => {
    const html = await renderList();
    expect(html).toMatch(/<h1[^>]*>MCP 服务器/);
    expect(html).toMatch(/<button[^>]*>.*刷新/);
    // 边界说明逐字保留
    expect(html).toContain("注册表数据由 AI-SE 后端提供");
    expect(html).toContain("浏览器不会直接连接 MCP 服务器，也不会持有 MCP 凭据。");
  });

  it("loading 期间刷新按钮禁用", async () => {
    const html = await renderList((pinia) => {
      useMCPStore(pinia).loading = true;
    });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*刷新/);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="加载中"');
  });
});

describe("MCPServersView — 状态分支", () => {
  it("loading 分支渲染骨架屏，不渲染列表或空态", async () => {
    const html = await renderList((pinia) => {
      useMCPStore(pinia).loading = true;
    });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("正在加载 MCP 服务器…");
    expect(html).not.toContain("暂无已注册的 MCP 服务器。");
    expect(html).not.toMatch(/<li[\s>]/);
  });

  it("error 分支渲染可重试错误态（含后端原文），且优先级高于空态", async () => {
    const html = await renderList((pinia) => {
      useMCPStore(pinia).error = "MCP registry unavailable";
    });
    expect(html).toContain("MCP registry unavailable");
    expect(html).toContain('role="alert"');
    expect(html).toContain("bg-danger-bg");
    expect(html).toMatch(/<button[^>]*>(?:<!--\[-->)?重试/);
    expect(html).not.toContain("暂无已注册的 MCP 服务器。");
  });

  it("空注册表显示 EmptyState + 刷新动作，不渲染列表", async () => {
    const html = await renderList();
    expect(html).toContain("暂无已注册的 MCP 服务器。");
    // 本页无 create API ⇒ 空态动作是「刷新」而非假的创建按钮
    expect((html.match(/刷新/g) || []).length).toBe(2); // 页头 + 空态
    expect(html).not.toMatch(/<li[\s>]/);
  });
});

describe("MCPServersView — 服务器列表", () => {
  const seed = (pinia: Pinia) => {
    useMCPStore(pinia).servers = [
      makeServer("srv-1", "Echo 服务", {
        description: "本地回显",
        toolCount: 3,
        status: "CONNECTED",
        lastConnectedAt: "2026-09-10T00:00:00.000Z"
      }),
      makeServer("srv-2", "外部工具集", {
        transport: "streamable-http",
        enabled: false,
        status: "DEGRADED",
        toolCount: 7
      })
    ];
  };

  it("按真实字段渲染行内容与两个入口链接", async () => {
    const html = await renderList(seed);
    expect(html).toContain("Echo 服务");
    expect(html).toContain("本地回显");
    expect(html).toContain('href="/mcp/srv-1"');
    expect(html).toContain('href="/mcp/srv-2"');
    // 传输 · 工具数 · 最近连接
    expect(html).toContain("stdio");
    expect(html).toContain("3 个工具");
    expect(html).toContain("最近连接");
    expect(html).toContain("2026");
    expect(html).toContain("流式 HTTP");
    expect(html).toContain("7 个工具");
    // 空描述使用占位符，不编造内容
    expect(html).toContain("—");
    // 「打开」入口（norm 已折叠空白，故允许标签间空白）
    expect((html.match(/>\s*打开\s*</g) || []).length).toBe(2);
  });

  it("状态与启用态使用 StatusBadge tone，并把状态说明挂在 title 上", async () => {
    const html = await renderList(seed);
    // CONNECTED → success，DEGRADED → warning
    expect(html).toContain("bg-success-bg");
    expect(html).toContain("bg-warning-bg");
    expect(html).toContain("已连接");
    expect(html).toContain("降级");
    // enabled success / neutral
    expect(html).toContain("已启用");
    expect(html).toContain("已禁用");
    expect(html).toContain("bg-muted text-muted-foreground");
    // title = serverStatusHint（后端状态说明原文）
    expect(html).toContain("已连接。工具由后端注册表发现并强制执行治理。");
    expect(html).toContain("服务器当前不可用 — 已发现的工具仍被保留。");
  });

  it("不得再出现任何 legacy 类名", async () => {
    const html = await renderList(seed);
    for (const token of LEGACY_TOKENS) {
      expect(html).not.toContain(token);
    }
  });
});
