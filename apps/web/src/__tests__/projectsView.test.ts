import { type Project } from "@ai-se/shared";
import { createPinia, type Pinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import { useProjectsStore } from "@/stores/projects";
import ProjectsView from "@/views/ProjectsView.vue";

/**
 * ProjectsView 页面契约测试（W5：统一页面骨架 + 收敛到 Dialog 后）。
 *
 * 覆盖：PageHeader 的唯一主操作（打开新建 Dialog）、四种状态的渲染顺序与内容、
 * **Card 包 6 列语义表格**（项目名称 / 描述 / 仓库 / 状态 / 创建时间 / 操作）、
 * 描述占位、仓库单行截断、状态 tone、目标链接、多行渲染，
 * 以及「不再有常驻两栏表单」「不引入搜索/筛选/分页」「不得出现 legacy 类名」三道护栏。
 *
 * 弹窗内容经 Reka DialogPortal 输出到 Teleport —— 本文件用 renderToString 的
 * ctx.teleports 收集（组件侧以 unmount-on-hide=false + portal force-mount 保证内容可见），
 * `all` = 页面主输出 + Teleport 内容。表单已移入 Dialog，因此表单断言针对 `all`。
 *
 * SSR 下 onMounted 不会触发请求；Store 状态由测试注入 —— 不做 API mock、不创建业务数据。
 */

const Blank = { render: () => null };

/**
 * SSR 输出含换行与缩进（whitespace 折叠 + slot 被 fragment 注释包裹），
 * 统一归一化后再断言；折叠标签间空白使 `<button[^>]*>重试</button>` 这类模式可用。
 */
function norm(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+/g, ">")
    .replace(/\s+</g, "<");
}

function makeProject(
  id: string,
  name: string,
  status: Project["status"],
  description = "",
  repository: string | null = "https://github.com/example/repo"
): Project {
  return {
    id,
    name,
    description,
    repository,
    workspacePath: null,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

interface RenderResult {
  /** 页面主 SSR 输出（不含 Teleport 内容） */
  html: string;
  /** 主输出 + Teleport 内容（新建 Dialog 所在） */
  all: string;
}

async function renderProjects(seed?: (pinia: Pinia) => void): Promise<RenderResult> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: ProjectsView },
      { path: "/projects", component: ProjectsView },
      { path: "/projects/:id", component: Blank }
    ]
  });
  await router.push("/projects");
  await router.isReady();

  const app = createSSRApp({ render: () => h(ProjectsView) });
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  seed?.(pinia);

  const ctx: { teleports?: Record<string, string> } = {};
  const raw = await renderToString(app, ctx);
  const teleports = Object.values(ctx.teleports ?? {}).join("\n");
  return { html: norm(raw), all: norm(`${raw}\n${teleports}`) };
}

const seedTwoProjects = (pinia: Pinia) => {
  useProjectsStore(pinia).projects = [
    makeProject("p1", "Mini Todo", "active"),
    makeProject("p2", "遗留系统", "archived", "旧系统")
  ];
};

const LEGACY_TOKENS = [
  "page-header",
  "two-column",
  "main-column",
  "project-list",
  'class="project-row"',
  "project-row-repo",
  "project-row-title",
  "project-row-open",
  "row-actions",
  "form-panel",
  'class="button',
  'class="state',
  'class="empty',
  'class="status'
];

describe("ProjectsView — 页头与唯一主操作", () => {
  it("渲染 PageHeader（标题「项目」）", async () => {
    const { html } = await renderProjects();
    expect(html).toMatch(/<h1[^>]*>项目/);
  });

  it("主操作是「新建项目」按钮，位于页头 actions 插槽内", async () => {
    const { html } = await renderProjects();
    expect(html).toContain("新建项目");
    expect(html).toMatch(/<button[^>]*>新建项目<\/button>/);
  });
});

describe("ProjectsView — 新建 Dialog 内的表单", () => {
  it("表单字段与文案保留（名称 / 仓库地址（可选） / 描述 / 创建）", async () => {
    const { all } = await renderProjects();
    expect(all).toContain("名称");
    expect(all).toContain("仓库地址（可选）");
    expect(all).toContain("描述");
    expect(all).toContain(">创建<");
  });

  it("保持原有校验属性与控件类型", async () => {
    const { all } = await renderProjects();
    expect(all).toContain('for="project-name"');
    expect(all).toContain('id="project-name"');
    expect(all).toContain('maxlength="120"');
    expect(all).toContain('placeholder="AI-SE"');
    expect(all).toContain('for="project-repository"');
    expect(all).toContain('id="project-repository"');
    expect(all).toContain('type="url"');
    expect(all).toContain('maxlength="500"');
    expect(all).toContain('id="project-description"');
    expect(all).toContain('maxlength="1000"');
    expect(all).toMatch(/<textarea[^>]*rows="5"/);
    // UX-01：仓库改为可选——只有名称仍是必填（required），仓库输入不再带 required。
    expect((all.match(/required/g) || []).length).toBe(1);
  });

  it("保留「仓库可留空」的既有说明文案", async () => {
    const { all } = await renderProjects();
    expect(all).toContain("本地工作区路径（可选）");
    expect(all).toContain("留空则先基于本地工作区开发，之后可在项目详情页绑定 Git 仓库。");
  });
});

describe("ProjectsView — 四种状态（顺序：加载 → 错误 → 空 → 有数据）", () => {
  it("loading 分支渲染骨架屏，不再是「正在加载项目…」文字", async () => {
    const { html } = await renderProjects((pinia) => {
      useProjectsStore(pinia).loading = true;
    });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="加载中"');
    expect(html).toContain("animate-pulse");
    // 骨架屏是纯装饰，不承载任何文案
    expect(html).not.toContain("正在加载项目…");
    expect(html).not.toContain("暂无项目。");
    expect(html).not.toContain("<table");
  });

  it("error 分支渲染可重试错误态，且优先于空状态", async () => {
    const { html } = await renderProjects((pinia) => {
      useProjectsStore(pinia).error = "网络请求失败：无法连接后端服务";
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("网络请求失败：无法连接后端服务");
    expect(html).toMatch(/<button[^>]*>重试<\/button>/);
    expect(html).toContain("bg-danger-bg");
    expect(html).not.toContain("暂无项目。");
    expect(html).not.toContain("<table");
  });

  it("空数据时渲染 EmptyState，并给出下一步动作（新建项目）", async () => {
    const { html } = await renderProjects();
    expect(html).toContain("暂无项目。");
    const emptyBlock = html.slice(html.indexOf("暂无项目。"));
    expect(emptyBlock).toContain("新建项目");
    expect(html).not.toContain("<table");
  });
});

describe("ProjectsView — 资源表格", () => {
  it("使用 Card 包语义 table，表头为 6 列（项目名称 / 描述 / 仓库 / 状态 / 创建时间 / 操作）", async () => {
    const { html } = await renderProjects(seedTwoProjects);
    expect(html).toContain("<table");
    expect((html.match(/<th scope="col"/g) || []).length).toBe(7);
    for (const column of ["项目名称", "描述", "本地工作区", "仓库", "状态", "创建时间", "操作"]) {
      expect(html).toContain(column);
    }
    // 表格外层可横向滚动（窄屏），页面本身不溢出由浏览器验证承担
    expect(html).toContain("overflow-x-auto");
  });

  it("按真实字段渲染行：名称链接、描述占位、仓库截断、状态 tone、创建时间、行操作", async () => {
    const { html } = await renderProjects(seedTwoProjects);
    expect(html).toContain("Mini Todo");
    expect(html).toContain("遗留系统");
    expect(html).toContain('href="/projects/p1"');
    expect(html).toContain('href="/projects/p2"');
    expect(html).toContain("https://github.com/example/repo");
    // 描述为空 → 占位符，不编造内容；有值 → 原样
    expect(html).toContain("—");
    expect(html).toContain("旧系统");
    // 状态徽标：active → success tone，archived → neutral tone
    expect(html).toContain("启用");
    expect(html).toContain("bg-success-bg");
    expect(html).toContain("已归档");
    expect(html).toContain("bg-muted");
    // 创建时间使用既有 formatProjectDate
    expect(html).toMatch(/2026年1月01日/);
    // 行操作
    expect((html.match(/>打开</g) || []).length).toBe(2);
    expect((html.match(/>删除</g) || []).length).toBe(2);
    // 行 hover 使用 --muted
    expect(html).toContain("hover:bg-muted");
  });

  it("仓库列改为工具类单行截断（W5 删除 scoped 块）", async () => {
    const { html } = await renderProjects(seedTwoProjects);
    expect(html).toContain("max-w-35");
    expect(html).toContain("truncate");
  });

  it("分页：页长 10，7 条时一页显示完，底部显示总数", async () => {
    const { html } = await renderProjects((pinia) => {
      useProjectsStore(pinia).projects = Array.from({ length: 7 }, (_, index) =>
        makeProject(`p${index}`, `项目 ${index}`, "active")
      );
    });
    expect((html.match(/>打开</g) || []).length).toBe(7);
    expect(html).toContain("共 7 条");
  });

  it("分页：超过 10 条时只渲染当前页的行，总数仍取全量", async () => {
    const { html } = await renderProjects((pinia) => {
      useProjectsStore(pinia).projects = Array.from({ length: 23 }, (_, index) =>
        makeProject(`p${index}`, `项目 ${index}`, "active")
      );
    });
    expect((html.match(/>打开</g) || []).length).toBe(10);
    expect(html).toContain("共 23 条");
  });

  it("未配置仓库的项目在仓库列显示「未配置」兜底（UX-01）", async () => {
    const { html } = await renderProjects((pinia) => {
      useProjectsStore(pinia).projects = [makeProject("p1", "Workspace First", "active", "", null)];
    });
    expect(html).toContain("未配置");
    expect(html).not.toContain("https://github.com/example/repo");
    expect(html).toContain("truncate");
  });

  it("不引入搜索 / 筛选 / 排序 / 批量操作控件", async () => {
    const { html } = await renderProjects(seedTwoProjects);
    for (const forbidden of ["搜索", "筛选", "排序", "批量", 'placeholder="搜索']) {
      expect(html).not.toContain(forbidden);
    }
    // 页面主体内不应有列表级 <input>（新建表单在 Dialog 里，不进 html）
    expect((html.match(/<input/g) || []).length).toBe(0);
  });

  it("不得再出现任何 legacy 类名", async () => {
    const { all } = await renderProjects(seedTwoProjects);
    for (const token of LEGACY_TOKENS) {
      expect(all).not.toContain(token);
    }
  });
});

describe("ProjectsView — W5 版式：列表占满内容宽，不再有常驻两栏表单", () => {
  it("不再出现「360px 操作列 + 1fr 展示列」的任意栅格", async () => {
    const { html } = await renderProjects(seedTwoProjects);
    expect(html).not.toContain("lg:grid-cols-[360px_minmax(0,1fr)]");
    expect(html).not.toContain("grid-cols-[");
  });

  it("列表直接位于 PageContainer 内（页头之后），表单不再占据左栏", async () => {
    const { html } = await renderProjects(seedTwoProjects);
    const headerIndex = html.indexOf("<h1");
    const tableIndex = html.indexOf("<table");
    expect(headerIndex).toBeGreaterThan(-1);
    expect(tableIndex).toBeGreaterThan(headerIndex);
  });

  it("列表由组件库 Table 渲染（页面无原生 <table> 标记）", async () => {
    const { html } = await renderProjects(seedTwoProjects);
    expect(html).toContain("<table");
    expect((html.match(/<th scope="col"/g) || []).length).toBe(7);
    expect(html).toContain("overflow-x-auto");
  });
});

describe("ProjectsView — 已有数据时不渲染空状态或加载态", () => {
  it("不显示空状态、加载文案或错误态", async () => {
    const { html } = await renderProjects((pinia) => {
      useProjectsStore(pinia).projects = [makeProject("p1", "Mini Todo", "active")];
    });
    expect(html).not.toContain("暂无项目。");
    expect(html).not.toContain("正在加载项目…");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
  });
});
