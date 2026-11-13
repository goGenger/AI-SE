import type { MCPBindingSummary, MCPServerDetail, MCPToolSummary } from "@ai-se/shared";
import { createPinia, type Pinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import { useMCPStore } from "@/stores/mcp";
import MCPServerDetailView from "@/views/MCPServerDetailView.vue";

/**
 * /mcp/:serverId（MCP 服务器详情）页面契约测试 —— Phase 10-B 布局重构后。
 *
 * 覆盖：PageHeader（名称回退 + 两个入口）/ loading → error → 详情 分支、
 * 状态摘要、三个内嵌 Tab 的标签与计数、概览三组信息（连接 / 元数据 / 传输配置）、
 * 凭据说明文案，以及 legacy 类名护栏。
 *
 * 说明：三个 Tab 的切换是运行时本地状态；SSR 只能覆盖默认激活的「概览」面板
 * （工具 / 绑定面板的渲染由浏览器验证覆盖，注册表当前无数据，未创建测试数据）。
 * 不调用后端：store 状态由测试直接注入。
 */

const Blank = { render: () => null };

function norm(html: string): string {
  return html.replace(/<!--[^>]*-->/g, "").replace(/\s+/g, " ").trim();
}

function makeServer(overrides: Partial<MCPServerDetail> = {}): MCPServerDetail {
  return {
    id: "srv-1",
    name: "Echo 服务",
    description: "本地回显",
    transport: "stdio",
    enabled: true,
    status: "CONNECTED",
    toolCount: 2,
    lastConnectedAt: "2026-09-10T00:00:00.000Z",
    command: "node",
    args: ["echo-server.js"],
    authRef: "ref://auth/echo",
    credentialRef: "ref://credential/echo",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

function makeTool(id: string, name: string, overrides: Partial<MCPToolSummary> = {}): MCPToolSummary {
  return {
    id,
    serverId: "srv-1",
    name,
    description: "",
    enabled: true,
    riskLevel: "LOW",
    requiresApproval: false,
    inputSchemaSummary: "{ }",
    ...overrides
  };
}

function makeBinding(id: string, overrides: Partial<MCPBindingSummary> = {}): MCPBindingSummary {
  return {
    id,
    projectId: "11111111-1111-4111-8111-111111111111",
    projectName: "Mini Todo",
    serverId: "srv-1",
    enabled: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

async function renderDetail(seed?: (pinia: Pinia) => void): Promise<string> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/mcp", component: Blank },
      { path: "/mcp/:serverId", component: MCPServerDetailView },
      { path: "/mcp/:serverId/app", component: Blank }
    ]
  });
  await router.push("/mcp/srv-1");
  await router.isReady();

  const app = createSSRApp({ render: () => h(MCPServerDetailView) });
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  seed?.(pinia);

  return norm(await renderToString(app));
}

function seedServer(pinia: Pinia, server = makeServer()): void {
  const store = useMCPStore(pinia);
  store.selectedServer = server;
  store.tools = [makeTool("t1", "echo"), makeTool("t2", "add")];
  store.bindings = [makeBinding("b1"), makeBinding("b2", { agentName: "dev-agent" })];
}

const LEGACY_TOKENS = [
  "page-header",
  "panel",
  "tab-bar",
  'class="tab',
  "compact-list",
  "stacked-form",
  "mcp-detail-grid",
  "mcp-status-",
  "mcp-risk-",
  "mcp-summary",
  "mcp-note",
  "mcp-disabled",
  "row-actions",
  'class="button',
  'class="state',
  'class="empty'
];

describe("MCPServerDetailView — 页头与分支", () => {
  it("加载中渲染骨架屏，标题回退为「服务器」", async () => {
    const html = await renderDetail((pinia) => {
      useMCPStore(pinia).loading = true;
    });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="加载中"');
    expect(html).not.toContain("正在加载 MCP 服务器…");
    expect(html).toMatch(/<h1[^>]*>服务器/);
    expect(html).not.toContain("概览");
  });

  it("error 分支渲染可重试错误态（后端原文），且不渲染 Tab", async () => {
    const html = await renderDetail((pinia) => {
      useMCPStore(pinia).error = "MCP server not found";
    });
    expect(html).toContain("MCP server not found");
    expect(html).toContain('role="alert"');
    expect(html).toContain("bg-danger-bg");
    expect(html).toMatch(/<button[^>]*>(?:<!--\[-->)?重试/);
    expect(html).not.toContain("概览");
    expect(html).not.toContain("连接");
  });

  it("W5 补上的空态：未找到服务器时给出返回列表的动作（改造前整页白屏）", async () => {
    const html = await renderDetail();
    expect(html).toContain("未找到该 MCP 服务器。");
    expect(html).toContain('href="/mcp"');
    expect(html).toContain("返回服务器列表");
    expect(html).not.toContain("概览");
  });

  it("页头使用服务器名称，并提供「MCP 应用」与「返回列表」两个既有入口", async () => {
    const html = await renderDetail((pinia) => seedServer(pinia));
    expect(html).toMatch(/<h1[^>]*>Echo 服务/);
    expect(html).toContain('href="/mcp/srv-1/app"');
    expect(html).toContain('href="/mcp"');
    expect(html).toContain("MCP 应用");
    expect(html).toContain("返回列表");
    // W10：两个入口的定位改用 href（`mcp-action-link` 是无 CSS 规则的死类名，已删）
    expect((html.match(/<a[^>]*href="\/mcp/g) || []).length).toBe(2);
  });
});

describe("MCPServerDetailView — 状态摘要与 Tab", () => {
  it("状态摘要使用 StatusBadge tone + 后端状态说明原文", async () => {
    const html = await renderDetail((pinia) => seedServer(pinia));
    expect(html).toContain("已连接");
    expect(html).toContain("bg-success-bg");
    expect(html).toContain("已连接。工具由后端注册表发现并强制执行治理。");
  });

  it("降级状态使用 warning tone", async () => {
    const html = await renderDetail((pinia) => seedServer(pinia, makeServer({ status: "DEGRADED" })));
    expect(html).toContain("bg-warning-bg");
    expect(html).toContain("降级");
  });

  it("三个内嵌 Tab 保留既有标签与实时计数（本地切换，非路由）", async () => {
    const html = await renderDetail((pinia) => seedServer(pinia));
    expect(html).toContain("概览");
    expect(html).toContain("工具（2）");
    expect(html).toContain("绑定（2）");
    // W5：Tab 的 scoped 类已改为工具类，激活态用 Primary 体系表示
    expect((html.match(/bg-primary-light/g) || []).length).toBe(1);
    expect(html).not.toContain("mcp-tab");
    // 不是路由链接：三个 Tab 均为 <button>（class 里带 Tab 专用的卡片外观）
    expect(
      (html.match(/<button[^>]*rounded-md border border-border bg-card/g) || []).length
    ).toBe(3);
  });
});

describe("MCPServerDetailView — 概览面板", () => {
  it("按 连接 / 元数据 / 传输配置 三组渲染真实字段", async () => {
    const html = await renderDetail((pinia) => seedServer(pinia));
    expect(html).toContain("连接");
    expect(html).toContain("元数据");
    expect(html).toContain("传输配置");
    for (const label of [
      "状态",
      "最近连接",
      "最近错误",
      "名称",
      "描述",
      "传输方式",
      "启用状态",
      "命令",
      "参数",
      "authRef",
      "credentialRef"
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Echo 服务");
    expect(html).toContain("本地回显");
    expect(html).toContain("stdio");
    expect(html).toContain("已启用");
    expect(html).toContain("node");
    expect(html).toContain("echo-server.js");
    expect(html).toContain("ref://auth/echo");
    expect(html).toContain("ref://credential/echo");
    // 凭据说明逐字保留
    expect(html).toContain("仅展示凭据引用。凭据值永远不会到达浏览器。");
  });

  it("streamable-http 传输显示端点而非命令/参数", async () => {
    const html = await renderDetail((pinia) =>
      seedServer(
        pinia,
        makeServer({
          transport: "streamable-http",
          endpoint: "https://mcp.example.com/rpc",
          command: undefined,
          args: undefined
        })
      )
    );
    expect(html).toContain("端点");
    expect(html).toContain("https://mcp.example.com/rpc");
    expect(html).not.toContain("命令");
    expect(html).not.toContain("参数");
  });

  it("默认仅渲染概览面板：工具 / 绑定面板不出现", async () => {
    const html = await renderDetail((pinia) => seedServer(pinia));
    expect(html).not.toContain("尚未发现工具。");
    expect(html).not.toContain("项目绑定");
    expect(html).not.toContain("创建绑定");
  });

  it("不得再出现任何 legacy 类名", async () => {
    const html = await renderDetail((pinia) => seedServer(pinia));
    for (const token of LEGACY_TOKENS) {
      expect(html).not.toContain(token);
    }
  });
});
