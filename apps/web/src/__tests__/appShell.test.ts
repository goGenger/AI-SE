import type { WorkflowSummary } from "@ai-se/shared";
import { createPinia, type Pinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import AppShell from "@/components/layout/AppShell.vue";
import { useWorkflowsStore } from "@/stores/workflows";

/**
 * AppShell 布局契约测试（W4 重建后的版本）。
 *
 * 覆盖：侧栏为 sticky 固定栏、导航图标与选中态、工作流失败数徽标、折叠开关、
 * 顶栏面包屑与搜索入口、Header / Main 骨架、RouterView 渲染、导航项顺序与 active 归属。
 *
 * 数据依赖：侧栏为「工作流失败数」读取 `useWorkflowsStore`（W4 新增），因此这里给
 * pinia 播种；SSR 不触发 `onMounted`，**不会发起任何请求**。折叠的 localStorage 持久化
 * 是客户端行为，SSR 下不可测，由浏览器实测承担（见 docs/136 §验证）。
 */

function norm(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+/g, ">")
    .replace(/\s+</g, "<");
}

function makeWorkflow(id: string, status: WorkflowSummary["status"]): WorkflowSummary {
  return {
    id,
    projectId: "p1",
    requirementId: "r1",
    planningVersion: 1,
    status,
    policy: {
      maxConcurrency: 1,
      maxRetries: 3,
      failureStrategy: "RETRY",
      allowRetry: true,
      allowReplan: false,
      approvalRequired: false
    },
    input: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    projectName: "Mini Todo",
    requirementName: "登录流程",
    taskProgress: { total: 4, completed: 2 }
  };
}

async function renderShell(
  path = "/workflows",
  seed?: (pinia: Pinia) => void
): Promise<string> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { render: () => h("div", "dashboard-stub") }, meta: { title: "仪表盘" } },
      {
        path: "/workflows",
        component: { render: () => h("div", "workflows-stub") },
        meta: { group: "构建" }
      },
      {
        path: "/agents",
        component: { render: () => h("div", "agents-stub") },
        meta: { group: "运行" }
      }
    ]
  });
  await router.push(path);
  await router.isReady();

  const app = createSSRApp({ render: () => h(AppShell) });
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  seed?.(pinia);
  return norm(await renderToString(app));
}

/** 取出侧栏 HTML（aside 开标签到 </aside>）。 */
function asideHtml(html: string): string {
  return html.slice(html.indexOf("<aside"), html.indexOf("</aside>") + "</aside>".length);
}

describe("AppShell — 固定侧栏", () => {
  it("侧栏为 sticky 固定栏：sticky / top-0 / h-screen / self-start / overflow-y-auto", async () => {
    const html = await renderShell();
    const aside = html.match(/<aside[^>]*>/);
    expect(aside, "应渲染侧栏 aside").not.toBeNull();
    const tag = aside![0];
    for (const token of ["sticky", "top-0", "h-screen", "self-start", "overflow-y-auto"]) {
      expect(tag, `侧栏应包含 ${token}`).toContain(token);
    }
    // 宽度与视觉不变（折叠态由 :class 切换，SSR 默认展开）
    expect(tag).toContain("w-[var(--app-sidebar-width)]");
    expect(tag).toContain("bg-card");
    // Header 与 Main 骨架保留
    expect(html).toContain("h-[var(--app-header-height)]");
    expect((html.match(/<main[^>]*>/) || [""])[0]).toContain("p-[var(--app-main-padding)]");
    // RouterView 渲染当前路由组件
    expect(html).toContain("workflows-stub");
  });

  it("结构：侧栏位于滚动列（Header + Main 所在列）之外，主内容不承载侧栏", async () => {
    const html = await renderShell();
    const asideEnd = html.indexOf("</aside>");
    const headerStart = html.indexOf("<header");
    const mainStart = html.indexOf("<main");
    const stubStart = html.indexOf("workflows-stub");
    expect(asideEnd).toBeGreaterThan(-1);
    expect(headerStart).toBeGreaterThan(asideEnd); // Header 在侧栏之后（滚动列内）
    expect(mainStart).toBeGreaterThan(headerStart);
    expect(stubStart).toBeGreaterThan(mainStart); // 路由内容在 Main 内
    // 侧栏为空骨架 + 品牌 + 导航：不包含任何路由内容
    const aside = asideHtml(html);
    expect(aside).not.toContain("workflows-stub");
  });

  it("导航项顺序、文案与路由驱动 active 归属保持（/workflows → 工作流；/agents → Agent）", async () => {
    const workflows = await renderShell("/workflows");
    const labels = [
      "仪表盘",
      "项目",
      "需求",
      "工作流",
      "部署",
      "Agent",
      "Agent 运行",
      "MCP 服务器"
    ];
    const positions = labels.map((label) => workflows.indexOf(`>${label}</span>`));
    for (const [index, position] of positions.entries()) {
      expect(position, `导航项「${labels[index]}」应存在`).toBeGreaterThan(-1);
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // 唯一 active 归属为「工作流」
    // W10：active 归属改用 `aria-current="page"`（真实的语义属性；原 `nav-link--active` 是无 CSS 规则的死类名）
    const activeLinks = workflows.match(/<a[^>]*aria-current="page"[^>]*>[\s\S]*?<\/a>/g) || [];
    expect(activeLinks.length).toBe(1);
    expect(activeLinks[0]).toContain("工作流");

    const agents = await renderShell("/agents");
    const agentsActive = agents.match(/<a[^>]*aria-current="page"[^>]*>[\s\S]*?<\/a>/g) || [];
    expect(agentsActive.length).toBe(1);
    expect(agentsActive[0]).toContain(">Agent</span>");
  });
});

describe("AppShell — W4 侧栏：图标 / 选中态 / 折叠 / 失败计数", () => {
  it("每个导航项都渲染图标（11 个项目 = 11 个 svg，不再是死代码）", async () => {
    const html = await renderShell();
    // W10：改用 `<nav>` 作用域定位（原先依赖的 `nav-link` 是无 CSS 规则的死类名，已删；
    // 侧栏里除了导航项还有一个品牌链接，按 `<a>` 直接数会多算一个）
    // W13：X1 增加了「系统 · 设置」，8 → 9；自治记录页再 +1 → 11。
    const nav = asideHtml(html).match(/<nav[\s\S]*<\/nav>/)?.[0] ?? "";
    const links = nav.match(/<a[^>]*>[\s\S]*?<\/a>/g) || [];
    expect(links.length).toBe(11);
    for (const [index, link] of links.entries()) {
      expect(link, `第 ${index + 1} 个导航项应含图标`).toContain("<svg");
    }
  });

  it("选中态为「背景 + 文字色」同时变化，不再是圆点空心/实心", async () => {
    const html = await renderShell("/workflows");
    const aside = asideHtml(html);
    const active = aside.match(/<a[^>]*aria-current="page"[^>]*>/);
    expect(active, "应有 active 导航项").not.toBeNull();
    expect(active![0]).toContain("bg-primary-light");
    expect(active![0]).toContain("text-primary");
    // 圆点方案已整体删除
    expect(aside).not.toContain("nav-dot");
  });

  it("折叠开关存在且初始为展开态", async () => {
    const html = await renderShell();
    const aside = asideHtml(html);
    expect(aside).toContain('aria-label="收起侧栏"');
    expect(aside).toContain('aria-expanded="true"');
    expect(aside).not.toContain('w-[var(--app-sidebar-width-collapsed)]');
  });

  it("有失败工作流时显示数量徽标（真实 store 数据，不是编造的数字）", async () => {
    const withFailures = await renderShell("/projects", (pinia) => {
      useWorkflowsStore(pinia).workflows = [
        makeWorkflow("w1", "FAILED"),
        makeWorkflow("w2", "FAILED"),
        makeWorkflow("w3", "SUCCESS")
      ];
    });
    expect(withFailures).toContain(">2</span>");
    expect(withFailures).toContain('title="2 个工作流失败"');
  });

  it("没有失败工作流时不渲染徽标（不显示无意义的 0）", async () => {
    const noFailures = await renderShell("/projects", (pinia) => {
      useWorkflowsStore(pinia).workflows = [makeWorkflow("w1", "SUCCESS")];
    });
    expect(noFailures).not.toContain("个工作流失败");

    const notLoaded = await renderShell("/projects");
    expect(notLoaded).not.toContain("个工作流失败");
  });
});

describe("AppShell — W4 顶栏：面包屑与搜索入口", () => {
  it("列表页面包屑为「分组 / 页面名」", async () => {
    const html = await renderShell("/workflows");
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(header).toContain('aria-label="面包屑"');
    expect(header).toContain(">构建</span>");
    expect(header).toContain("工作流");
    expect(header).toContain('aria-current="page"');
  });

  it("仪表盘面包屑只有自身，没有分组", async () => {
    const html = await renderShell("/");
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(header).toContain("仪表盘");
    expect(header).not.toContain(">构建</span>");
  });

  it("搜索入口为真实按钮并带快捷键提示", async () => {
    const html = await renderShell("/workflows");
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(header).toContain("搜索…");
    expect(header).toMatch(/aria-keyshortcuts="(Meta\+K|Control\+K)"/);
    // W11：名称取自可见文字，故意不写 aria-label（写了就违反 SC 2.5.3 Label in Name —— 见组件内注释）。
    // 窄屏下这段文字走 sr-only，仍留在无障碍树里，按钮不会变成「无名称的图标按钮」。
    expect(header).not.toContain('aria-label="全局搜索"');
    expect(header).toContain("sr-only sm:not-sr-only");
  });
});
