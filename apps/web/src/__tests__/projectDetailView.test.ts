import { type Project } from "@ai-se/shared";
import { createPinia, type Pinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import { useProjectsStore } from "@/stores/projects";
import ProjectDetailView from "@/views/ProjectDetailView.vue";

/**
 * ProjectDetailView 页面契约测试（Phase 11-B：Resource Workspace 布局重构后）。
 *
 * 覆盖：PageHeader（标题兜底 + 「返回」与「删除项目」两个 action）、loading / error /
 * 未找到 三分支、**资源身份 Card**（名称 + 状态徽标 + 仓库）、**信息 Card**
 * （仓库 / 描述 / 创建时间 / 更新时间，`dl` 三列 scoped 结构）、「暂无描述。」兜底，
 * 以及"无 Tabs / Breadcrumb"和"无 legacy 类名"两道护栏。
 *
 * 交互（window.confirm → 删除 → 跳转 /projects）由浏览器验证承担。
 */

const Blank = { render: () => null };

function norm(html: string): string {
  return html
    .replace(/<!--[^>]*-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Mini Todo",
    description: "全栈待办事项应用",
    repository: "https://github.com/example/repo",
    workspacePath: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    ...overrides
  };
}

async function renderDetail(seed?: (pinia: Pinia) => void): Promise<string> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/projects", component: Blank },
      { path: "/projects/:id", component: ProjectDetailView }
    ]
  });
  await router.push("/projects/p1");
  await router.isReady();

  const app = createSSRApp({ render: () => h(ProjectDetailView) });
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  seed?.(pinia);

  return norm(await renderToString(app));
}

const LEGACY_TOKENS = [
  "page-header",
  "two-column",
  "main-column",
  "detail-grid",
  'class="detail-list"',
  'class="panel',
  "action-panel",
  "row-actions",
  'class="button',
  'class="state',
  'class="empty'
];

describe("ProjectDetailView — 页头与分支", () => {
  it("loading 分支渲染骨架屏，且不显示详情或空状态", async () => {
    const html = await renderDetail((pinia) => {
      useProjectsStore(pinia).loading = true;
    });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="加载中"');
    expect(html).not.toContain("正在加载项目…");
    expect(html).not.toContain("未找到该项目。");
    expect(html).not.toContain("创建时间");
  });

  it("error 分支显示 store 错误且优先于「未找到」", async () => {
    const html = await renderDetail((pinia) => {
      useProjectsStore(pinia).error = "网络请求失败：无法连接后端服务";
    });
    expect(html).toContain("网络请求失败：无法连接后端服务");
    expect(html).toContain("text-danger");
    expect(html).not.toContain("未找到该项目。");
  });

  it("未找到项目时渲染 EmptyState，标题回退为「项目」", async () => {
    const html = await renderDetail();
    expect(html).toContain("未找到该项目。");
    expect(html).toMatch(/<h1[^>]*>项目/);
    expect(html).not.toContain("创建时间");
  });

  it("页头同时提供「返回」与「删除项目」，且都在 header 的 actions 区内", async () => {
    const html = await renderDetail((pinia) => {
      useProjectsStore(pinia).selectedProject = makeProject();
    });
    expect(html).toMatch(/<h1[^>]*>Mini Todo/);
    expect(html).toContain('href="/projects"');
    const header = html.match(/<header[^>]*>.*?<\/header>/);
    expect(header).not.toBeNull();
    expect(header?.[0]).toContain("返回");
    expect(header?.[0]).toContain("删除项目");
  });
});

describe("ProjectDetailView — 资源身份与信息", () => {
  it("身份 Card 渲染项目名称、状态徽标与仓库", async () => {
    const html = await renderDetail((pinia) => {
      useProjectsStore(pinia).selectedProject = makeProject();
    });
    expect(html).toContain("Mini Todo");
    expect(html).toContain("https://github.com/example/repo");
    // W5：仓库行由 scoped 类改为工具类单行截断
    expect(html).toContain("truncate");
    expect(html).not.toContain("project-detail-repo");
    expect(html).toContain("启用");
    expect(html).toContain("bg-success-bg");
  });

  it("信息 Card 渲染四个字段（仓库 / 描述 / 创建时间 / 更新时间）与三列结构", async () => {
    const html = await renderDetail((pinia) => {
      useProjectsStore(pinia).selectedProject = makeProject();
    });
    for (const label of ["仓库", "描述", "创建时间", "更新时间"]) {
      expect(html, `应包含字段 ${label}`).toContain(label);
    }
    // W5：信息栅格由 scoped 类改为工具类（1 列 → lg 三列）
    expect(html).toContain("lg:grid-cols-3");
    expect(html).not.toContain("project-detail-list");
    expect(html).toContain("全栈待办事项应用");
    expect(html).toMatch(/2026年1月01日/);
    expect(html).toMatch(/2026年2月01日/);
    // 表格数量：信息 Card 用 dl，不引入表格/分页
    expect(html).not.toContain("<table");
    expect((html.match(/<dl/g) || []).length).toBe(1);
  });

  it("描述为空时保留「暂无描述。」兜底文案", async () => {
    const html = await renderDetail((pinia) => {
      useProjectsStore(pinia).selectedProject = makeProject({ description: "" });
    });
    expect(html).toContain("暂无描述。");
  });

  it("信息 Card 提供本地工作区路径表单，且 store 暴露 updateWorkspacePath", async () => {
    const pinia = createPinia();
    const store = useProjectsStore(pinia);
    expect(typeof store.updateWorkspacePath).toBe("function");

    const html = await renderDetail((active) => {
      useProjectsStore(active).selectedProject = makeProject({ workspacePath: null });
    });
    expect(html).toContain("本地工作区路径");
    expect(html).toContain('id="project-workspace-path"');
    expect(html).toContain("保存路径");
  });

  it("未配置仓库时展示「未配置」与后续绑定入口（UX-01）", async () => {
    const html = await renderDetail((pinia) => {
      useProjectsStore(pinia).selectedProject = makeProject({ repository: null });
    });
    expect(html).toContain("未配置");
    expect(html).toContain("绑定 Git 仓库");
    expect(html).toContain('id="project-repository-bind"');
    expect(html).toContain('type="url"');
    expect(html).not.toContain("https://github.com/example/repo");
  });

  it("archived 状态映射为 neutral tone", async () => {
    const html = await renderDetail((pinia) => {
      useProjectsStore(pinia).selectedProject = makeProject({ status: "archived" });
    });
    expect(html).toContain("已归档");
    expect(html).toContain("bg-muted");
  });

  it("不引入 Tabs / Breadcrumb / 搜索等本阶段禁止的元素", async () => {
    const html = await renderDetail((pinia) => {
      useProjectsStore(pinia).selectedProject = makeProject();
    });
    for (const forbidden of [
      "breadcrumb",
      "mcp-tab",
      'class="tab',
      "概览",
      "需求（",
      "工作流（",
      "搜索",
      "筛选"
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("已配置仓库时不显示绑定表单，展示当前仓库信息（UX-01）", async () => {
    const html = await renderDetail((pinia) => {
      useProjectsStore(pinia).selectedProject = makeProject();
    });
    expect(html).toContain("https://github.com/example/repo");
    expect(html).not.toContain("project-repository-bind");
  });

  it("不得再出现任何 legacy 类名", async () => {
    const html = await renderDetail((pinia) => {
      useProjectsStore(pinia).selectedProject = makeProject();
    });
    for (const token of LEGACY_TOKENS) {
      expect(html).not.toContain(token);
    }
  });
});
