import { type Project, type WorkflowSummary } from "@ai-se/shared";
import { createPinia, type Pinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import { useProjectsStore } from "@/stores/projects";
import { useWorkflowsStore } from "@/stores/workflows";
import DashboardView from "@/views/DashboardView.vue";

/**
 * DashboardView 页面契约测试（W6 去海报化后）。
 *
 * 覆盖：按「用户会问的问题」排序的四块 —— ① 需要处理（状态色 + 数量，全 0 时换成平静文案）
 * ② 正在运行 ③ 最近工作流（上限 5）④ 项目总量；工作流三块共享一个 store 的加载/错误 gate；
 * 项目卡独立的四态；以及两条护栏（无虚构数据、无 W6 已删的轨道与动画类）。
 *
 * Store 状态由测试直接注入，不做 API mock（SSR 下 onMounted 不发请求）。
 */

const Blank = { render: () => null };

function norm(html: string): string {
  return html.replace(/<!--[^>]*-->/g, "").replace(/\s+/g, " ").trim();
}

function makeProject(
  id: string,
  name: string,
  status: Project["status"],
  extra: Partial<Project> = {}
): Project {
  return {
    id,
    name,
    description: "",
    repository: "https://github.com/example/repo",
    workspacePath: null,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra
  };
}

function makeWorkflow(
  id: string,
  status: WorkflowSummary["status"],
  extra: Partial<WorkflowSummary> = {}
): WorkflowSummary {
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
    taskProgress: { total: 4, completed: 2 },
    ...extra
  };
}

async function renderDashboard(seed?: (pinia: Pinia) => void): Promise<string> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: DashboardView },
      { path: "/projects", component: Blank },
      { path: "/projects/:id", component: Blank },
      { path: "/requirements", component: Blank },
      { path: "/workflows", component: Blank },
      { path: "/workflows/:id", component: Blank }
    ]
  });
  await router.push("/");
  await router.isReady();

  const app = createSSRApp({ render: () => h(DashboardView) });
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  seed?.(pinia);

  return norm(await renderToString(app));
}

const seedProjects = (pinia: Pinia) => {
  useProjectsStore(pinia).projects = [
    makeProject("p1", "Mini Todo", "active"),
    makeProject("p2", "遗留系统", "active"),
    makeProject("p3", "支付网关", "archived")
  ];
};

describe("DashboardView — W6：删掉海报式装饰", () => {
  it("不再渲染交付流水线轨道、圆点与入场动画类", async () => {
    const html = await renderDashboard(seedProjects);
    for (const gone of ["dashboard-rail", "dashboard-dot", "dashboard-station", "dashboard-rise"]) {
      expect(html, `不应再出现 ${gone}`).not.toContain(gone);
    }
    // 圆点轨道是唯一用 primary 实心圆的地方，删掉后不该再有「圆点 + 站名」的重复导航
    expect(html).not.toContain('aria-label="交付流水线"');
  });

  it("页面有唯一 h1（W5 骨架），且不再用 56px 的 gap-14", async () => {
    const html = await renderDashboard(seedProjects);
    expect((html.match(/<h1/g) || []).length).toBe(1);
    expect(html).toMatch(/<h1[^>]*>仪表盘/);
    expect(html).not.toContain("gap-14");
  });
});

describe("DashboardView — ① 需要处理（最优先）", () => {
  it("没有失败/等待审批/已暂停时，换成一句平静的话，不渲染三个 0", async () => {
    const html = await renderDashboard((pinia) => {
      useWorkflowsStore(pinia).workflows = [makeWorkflow("w1", "SUCCESS")];
    });
    expect(html).toContain("当前没有失败、等待审批或已暂停的工作流。");
    expect(html).not.toMatch(/失败<\/dt>/);
    expect(html).not.toMatch(/等待审批<\/dt>/);
    expect(html).not.toMatch(/已暂停<\/dt>/);
  });

  it("按真实 workflow 状态计数，口径是 FAILED + WAITING_APPROVAL + PAUSED", async () => {
    const html = await renderDashboard((pinia) => {
      useWorkflowsStore(pinia).workflows = [
        makeWorkflow("w1", "FAILED"),
        makeWorkflow("w2", "FAILED"),
        makeWorkflow("w3", "WAITING_APPROVAL"),
        makeWorkflow("w4", "PAUSED"),
        makeWorkflow("w5", "RUNNING"),
        makeWorkflow("w6", "SUCCESS"),
        makeWorkflow("w7", "CANCELLED")
      ];
    });
    expect(html).toMatch(/失败<\/dt>\s*<dd[^>]*>2<\/dd>/);
    expect(html).toMatch(/等待审批<\/dt>\s*<dd[^>]*>1<\/dd>/);
    expect(html).toMatch(/已暂停<\/dt>\s*<dd[^>]*>1<\/dd>/);
  });

  it("状态色只在数字非 0 时使用 —— 「失败 0」不该看起来像告警", async () => {
    // 有一项需要处理（等待审批），所以走「三个数字」分支；其中失败数为 0
    const quiet = await renderDashboard((pinia) => {
      useWorkflowsStore(pinia).workflows = [makeWorkflow("w1", "WAITING_APPROVAL")];
    });
    expect(quiet).toMatch(/失败<\/dt>\s*<dd class="[^"]*text-muted-foreground[^"]*">0<\/dd>/);
    expect(quiet).toMatch(/等待审批<\/dt>\s*<dd class="[^"]*text-warning[^"]*">1<\/dd>/);
    expect(quiet).not.toContain("text-danger");

    const loud = await renderDashboard((pinia) => {
      useWorkflowsStore(pinia).workflows = [makeWorkflow("w1", "FAILED")];
    });
    expect(loud).toMatch(/失败<\/dt>\s*<dd class="[^"]*text-danger[^"]*">1<\/dd>/);
  });
});

describe("DashboardView — ② 正在运行", () => {
  it("统计 RUNNING 与 PENDING", async () => {
    const html = await renderDashboard((pinia) => {
      useWorkflowsStore(pinia).workflows = [
        makeWorkflow("w1", "RUNNING"),
        makeWorkflow("w2", "RUNNING"),
        makeWorkflow("w3", "PENDING"),
        makeWorkflow("w4", "SUCCESS")
      ];
    });
    expect(html).toContain("正在运行");
    expect(html).toMatch(/运行中<\/dt>\s*<dd[^>]*>2<\/dd>/);
    expect(html).toMatch(/等待中<\/dt>\s*<dd[^>]*>1<\/dd>/);
  });
});

describe("DashboardView — ③ 最近工作流", () => {
  it("空时给出下一步动作，不渲染表格", async () => {
    const html = await renderDashboard(seedProjects);
    expect(html).toContain("还没有工作流。");
    expect(html).toContain('href="/requirements"');
    expect(html).toContain("去看需求");
    expect(html).not.toContain("<table");
  });

  it("渲染表格：列为 需求 / 项目 / 状态 / 创建时间，并链接到工作流详情", async () => {
    const html = await renderDashboard((pinia) => {
      useWorkflowsStore(pinia).workflows = [
        makeWorkflow("w1", "FAILED"),
        makeWorkflow("w2", "SUCCESS", { requirementName: "支付网关重构", projectName: null })
      ];
    });
    expect(html).toContain("<table");
    for (const column of ["需求", "项目", "状态", "创建时间"]) {
      expect(html).toContain(column);
    }
    expect(html).toContain('href="/workflows/w1"');
    expect(html).toContain('href="/workflows/w2"');
    expect(html).toContain("登录流程");
    expect(html).toContain("支付网关重构");
    expect(html).toContain("—"); // projectName 缺失时的占位
    expect(html).toContain("bg-danger-bg"); // FAILED → error tone
    expect(html).toContain('href="/workflows"'); // 「全部工作流」
  });

  it("最多展示 5 条", async () => {
    const html = await renderDashboard((pinia) => {
      useWorkflowsStore(pinia).workflows = Array.from({ length: 7 }, (_, index) =>
        makeWorkflow(`w${index}`, "SUCCESS", {
          createdAt: `2026-09-0${index + 1}T00:00:00.000Z`
        })
      );
    });
    expect((html.match(/href="\/workflows\/w\d"/g) || []).length).toBe(5);
  });
});

describe("DashboardView — ④ 项目（总量统计，最后）", () => {
  it("空时给出「新建项目」入口，不渲染三个 0", async () => {
    const html = await renderDashboard();
    expect(html).toContain("还没有项目。");
    expect(html).toContain('href="/projects"');
    expect(html).toContain("新建项目");
  });

  it("按真实项目状态计数（数字用 text-metric）", async () => {
    const html = await renderDashboard(seedProjects);
    expect(html).toMatch(/项目总数<\/dt>\s*<dd class="[^"]*text-metric[^"]*">3<\/dd>/);
    expect(html).toMatch(/启用中<\/dt>\s*<dd[^>]*>2<\/dd>/);
    expect(html).toMatch(/已归档<\/dt>\s*<dd[^>]*>1<\/dd>/);
  });
});

describe("DashboardView — 状态 gate", () => {
  it("工作流加载中：只渲染一处骨架屏，三块工作流卡片都不出现", async () => {
    const html = await renderDashboard((pinia) => {
      useWorkflowsStore(pinia).loading = true;
    });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="加载中"');
    expect(html).not.toContain("需要处理");
    expect(html).not.toContain("正在运行");
    expect(html).not.toContain("最近工作流");
  });

  it("工作流错误：只渲染一处可重试错误态，不让三块各显示一遍", async () => {
    const html = await renderDashboard((pinia) => {
      useWorkflowsStore(pinia).error = "工作流列表读取失败";
    });
    expect(html).toContain("工作流列表读取失败");
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<button[^>]*>(?:<!--\[-->)?重试/);
    expect((html.match(/role="alert"/g) || []).length).toBe(1);
    expect(html).not.toContain("需要处理");
  });

  it("项目错误只影响项目卡，工作流三块照常渲染", async () => {
    const html = await renderDashboard((pinia) => {
      useProjectsStore(pinia).error = "项目列表读取失败";
      useWorkflowsStore(pinia).workflows = [makeWorkflow("w1", "FAILED")];
    });
    expect(html).toContain("项目列表读取失败");
    expect(html).toContain("需要处理");
    expect(html).toContain("最近工作流");
    expect(html).not.toContain("还没有项目。");
  });
});

describe("DashboardView — 无虚构数据护栏", () => {
  it("不渲染任何无真实数据源的内容", async () => {
    const html = await renderDashboard((pinia) => {
      seedProjects(pinia);
      useWorkflowsStore(pinia).workflows = [makeWorkflow("w1", "SUCCESS")];
    });
    // 注意：W6 之后 ③ 是真实的「最近工作流」，因此原护栏里的「最近动态」已从列表中移除
    // （当时那条守的是「没有数据源却摆一个动态流」；现在数据源存在且可测）。
    for (const forbidden of [
      "快速开始",
      "基础能力",
      "就绪",
      "系统状态",
      "最近部署",
      "当前工作流",
      "Agent Run",
      "已完成",
      "失败任务",
      "本月",
      "进度"
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });
});
