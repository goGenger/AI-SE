import { createPinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import { MCP_APP_SANDBOX } from "@/viewmodels/mcpAppBridge";
import MCPAppView from "@/views/MCPAppView.vue";

/**
 * /mcp/:serverId/app（沙箱化 UI 应用）页面契约测试 —— Phase 10-B 布局重构后。
 *
 * 覆盖：PageHeader / 沙箱说明（含 MCP_APP_SANDBOX 字面值）/ 加载表单（字段、required、
 * 占位符、提交按钮）/ `?projectId=&agentName=` 查询预填 / 未加载时的空态与"无 iframe"，
 * 以及 legacy 类名护栏。
 *
 * 安全边界：本测试只断言**页面骨架**；iframe 的 sandbox / srcdoc 绑定、Host Bridge 的
 * 来源校验与体积上限、allowedTools 单工具策略由 mcpAppBridge.test.ts 与 mcpSecurity.test.ts
 * 守护。SSR 下 onMounted 不执行 ⇒ 不注册 message 监听、不调用后端。
 */

const Blank = { render: () => null };

function norm(html: string): string {
  return html.replace(/<!--[^>]*-->/g, "").replace(/\s+/g, " ").trim();
}

async function renderApp(url = "/mcp/srv-1/app"): Promise<string> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/mcp", component: Blank },
      { path: "/mcp/:serverId", component: Blank },
      { path: "/mcp/:serverId/app", component: MCPAppView }
    ]
  });
  await router.push(url);
  await router.isReady();

  const app = createSSRApp({ render: () => h(MCPAppView) });
  app.use(createPinia());
  app.use(router);

  return norm(await renderToString(app));
}

const LEGACY_TOKENS = [
  "page-header",
  'class="panel',
  "stacked-form",
  "compact-list",
  "row-actions",
  "mcp-note",
  "mcp-app-frame",
  "mcp-app-log",
  'class="button',
  'class="state',
  'class="empty'
];

describe("MCPAppView — 页头与沙箱说明", () => {
  it("渲染 PageHeader 与「返回服务器」入口", async () => {
    const html = await renderApp();
    expect(html).toMatch(/<h1[^>]*>沙箱化 UI 应用/);
    expect(html).toContain('href="/mcp/srv-1"');
    expect(html).toContain("返回服务器");
  });

  it("沙箱说明逐字保留，并渲染 MCP_APP_SANDBOX 的实际取值", async () => {
    const html = await renderApp();
    expect(MCP_APP_SANDBOX).toBe("allow-scripts");
    expect(html).toContain("allow-scripts");
    expect(html).toContain("使用不透明源");
    expect(html).toContain("无 Cookie、无父页面 DOM、无凭据。");
    expect(html).toContain("Host Bridge → 后端 Tool Runtime");
    expect(html).toContain("权限 / 策略 / 审批 / 审计");
  });
});

describe("MCPAppView — 加载表单", () => {
  it("两个字段保留 required 与占位符，提交按钮沿用既有文案", async () => {
    const html = await renderApp();
    expect(html).toContain("项目 ID");
    expect(html).toContain("Agent 名称");
    expect((html.match(/required/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('placeholder="项目 UUID"');
    expect(html).toContain('placeholder="dev-agent"');
    expect(html).toMatch(/<button[^>]*>.*加载应用/);
  });

  it("未满足 canLoad 时不渲染空态，也不渲染 iframe 或桥接日志", async () => {
    const html = await renderApp();
    expect(html).not.toContain("当前项目 / Agent 下没有可见的 MCP 应用。");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("srcdoc");
    expect(html).not.toContain("桥接日志");
  });

  it("支持 ?projectId=&agentName= 查询预填，并在可加载状态显示空态", async () => {
    const html = await renderApp(
      "/mcp/srv-1/app?projectId=11111111-1111-4111-8111-111111111111&agentName=dev-agent"
    );
    expect(html).toContain('value="11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('value="dev-agent"');
    expect(html).toContain("当前项目 / Agent 下没有可见的 MCP 应用。");
    // 仍未加载应用 ⇒ 没有 iframe
    expect(html).not.toContain("<iframe");
  });

  it("不得再出现任何 legacy 类名", async () => {
    const html = await renderApp(
      "/mcp/srv-1/app?projectId=11111111-1111-4111-8111-111111111111&agentName=dev-agent"
    );
    for (const token of LEGACY_TOKENS) {
      expect(html).not.toContain(token);
    }
  });
});
