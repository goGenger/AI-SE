import { createPinia, type Pinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import { useDeploymentsStore } from "@/stores/deployments";
import { useProjectsStore } from "@/stores/projects";
import DeploymentsView from "@/views/DeploymentsView.vue";

/**
 * DeploymentsView 页面契约测试（W5：统一页面骨架后）。
 *
 * 覆盖：PageHeader 的唯一主操作（环境设置 Dialog）、环境表单字段/属性/默认值、
 * 历史列表三态与选中态、详情 6 项元数据与链接、健康检查 pre、CI 面板三分支、
 * 日志时间线（含 lg 折叠列）、回滚表单 gate 与 production 提示、详情空态、
 * 可重试错误态、tone 徽标、legacy 类不得出现。
 *
 * 弹窗内容经 Reka DialogPortal 输出到 Teleport —— 本文件用 renderToString 的
 * ctx.teleports 收集（组件侧以 unmount-on-hide=false + portal force-mount 保证内容可见），
 * `all` = 页面主输出 + Teleport 内容。环境表单已移入 Dialog，因此表单断言针对 `all`。
 *
 * SSR 下 onMounted / watch 不执行 ⇒ 不发起任何请求；Store 状态由测试注入（不做 API mock）。
 * 真实 API / 404 / 响应式由浏览器验证承担（见 docs/137 §3.3）。
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
  /** 主输出 + Teleport 内容（环境设置 Dialog 所在） */
  all: string;
}

async function renderDeployments(
  seed?: (pinia: Pinia) => void,
  initialPath = "/deployments"
): Promise<RenderResult> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/deployments", component: DeploymentsView },
      { path: "/deployments/:id", component: DeploymentsView },
      { path: "/workflows/:id", component: { render: () => null } }
    ]
  });
  await router.push(initialPath);
  await router.isReady();

  const app = createSSRApp({ render: () => h(DeploymentsView) });
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  seed?.(pinia);

  const ctx: { teleports?: Record<string, string> } = {};
  const raw = await renderToString(app, ctx);
  const teleports = Object.values(ctx.teleports ?? {}).join("\n");
  return { html: norm(raw), all: norm(`${raw}\n${teleports}`) };
}

function makeDeployment(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    projectId: "b55c87fc-8f67-411c-94f2-007e9ab88c97",
    workflowRunId: "99975877-48e3-4448-9092-2ea9b10d53fe",
    taskId: "task-1",
    version: "abcdef1234567890",
    environment: "staging",
    image: "ai-se/web:abcdef1",
    gitCommit: "abcdef1234567890",
    operation: "DEPLOY",
    status: "SUCCESS",
    endpoint: "http://localhost:18001",
    healthCheck: { status: "healthy", checks: [{ name: "/health", ok: true }] },
    createdAt: "2026-09-14T03:04:05.000Z",
    updatedAt: "2026-09-14T03:05:05.000Z",
    ...overrides
  };
}

function seedDetail(pinia: Pinia, overrides: Record<string, unknown> = {}) {
  const store = useDeploymentsStore(pinia);
  store.deployments = [
    makeDeployment() as never,
    makeDeployment({ id: "22222222-3333-4444-8555-666666666666", status: "FAILED" }) as never
  ];
  store.current = {
    deployment: makeDeployment(),
    logs: [
      {
        id: "log-1",
        deploymentId: "11111111-2222-4333-8444-555555555555",
        level: "info",
        message: "container started",
        metadata: {},
        createdAt: "2026-09-14T03:04:30.000Z"
      },
      {
        id: "log-2",
        deploymentId: "11111111-2222-4333-8444-555555555555",
        level: "error",
        message: "health probe failed",
        metadata: {},
        createdAt: "2026-09-14T03:04:50.000Z"
      }
    ],
    ...overrides
  } as never;
}

const DETAIL_PATH = "/deployments/11111111-2222-4333-8444-555555555555";

describe("DeploymentsView — 页头与环境设置 Dialog", () => {
  it("PageHeader 渲染标题「部署」与唯一主操作「环境设置」", async () => {
    const { html } = await renderDeployments();
    expect(html).toMatch(/<h1[^>]*>部署/);
    expect(html).toContain("环境设置");
    expect(html).toMatch(/<button[^>]*>环境设置<\/button>/);
  });

  it("环境表单在 Dialog 内：字段、属性、默认值、选项全部保留", async () => {
    const { all } = await renderDeployments((pinia) => {
      useProjectsStore(pinia).projects = [{ id: "proj-1", name: "Mini Todo" }] as never;
    });
    for (const label of ["项目", "环境", "端点", "主机端口", "容器端口", "Secret 引用"]) {
      expect(all, `应包含字段 ${label}`).toContain(label);
    }
    // 项目 select：required 由组件库 Select 反映为 aria-required（触发器为 Reka UI combobox）
    expect(all).toContain('id="deployment-project"');
    expect(all).toContain('aria-required="true"');
    expect(all).toContain("选择项目");
    // 环境 select：默认 staging → SSR 回显选中项 label（选项列表本身在浮层内，浏览器验证）
    expect(all).toContain("预发（staging）");
    // 端点：type=url + required + 默认值
    expect(all).toContain('type="url"');
    expect(all).toContain('value="http://localhost:18001"');
    // 端口：number + min/max + 默认值
    expect((all.match(/type="number"/g) || []).length).toBe(2);
    expect((all.match(/min="1"/g) || []).length).toBe(2);
    expect((all.match(/max="65535"/g) || []).length).toBe(2);
    expect(all).toContain('value="18001"');
    expect(all).toContain('value="3000"');
    // Secret 引用：placeholder（仅引用，不含明文）
    expect(all).toContain("仅引用，不含明文");
    // 保存按钮
    expect(all).toMatch(/>保存<\/button>/);
  });

  it("不得出现 legacy 类", async () => {
    const { all } = await renderDeployments((pinia) => seedDetail(pinia), DETAIL_PATH);
    for (const legacy of ["form-panel", "stacked-form", "panel-header", "status-pill"]) {
      expect(all, `不应出现 legacy 类 ${legacy}`).not.toContain(legacy);
    }
  });
});

describe("DeploymentsView — 历史列表四种状态", () => {
  it("loading：渲染骨架屏，不再是「加载中…」文字", async () => {
    const { html } = await renderDeployments((pinia) => {
      useDeploymentsStore(pinia).loading = true;
    });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="加载中"');
    expect((html.match(/animate-pulse/g) || []).length).toBe(3);
    expect(html).not.toContain("加载中…");
    expect(html).not.toContain("暂无部署记录。");
  });

  it("empty：EmptyState + 详情区提示", async () => {
    const { html } = await renderDeployments();
    expect(html).toContain("暂无部署记录。");
    expect(html).toContain("请选择部署。");
  });

  it("有数据：列表项渲染 + 选中态 data-active + 版本号截断", async () => {
    const { html } = await renderDeployments((pinia) => seedDetail(pinia), DETAIL_PATH);
    expect(html).not.toContain("暂无部署记录。");
    expect((html.match(/data-active=/g) || []).length).toBe(1);
    expect(html).toContain('data-active="true"');
    expect(html).toContain("预发 · 成功"); // environmentLabel · deploymentStatusLabel
    expect(html).toContain("预发 · 失败");
    expect(html).toContain("abcdef123456"); // shortVersion 截断到 12 位
    // 选中态的边框/底色由工具类给出，强调条在 scoped
    expect(html).toContain("border-primary");
    expect(html).toContain("bg-primary-light");
    expect(html).not.toContain("deployment-list-item");
    expect(html).not.toContain("deployment-item");
  });
});

describe("DeploymentsView — 错误态", () => {
  it("渲染可重试错误态，保留后端原文（不再是 .error-banner）", async () => {
    const { html } = await renderDeployments((pinia) => {
      useDeploymentsStore(pinia).error = "Deployment not found";
    });
    expect(html).toContain("Deployment not found");
    expect(html).toContain('role="alert"');
    expect(html).toContain("bg-danger-bg");
    expect(html).toMatch(/<button[^>]*>重试<\/button>/);
    expect(html).not.toContain("error-banner");
    // 错误是页面级的，与列表/详情并存
    expect(html).toContain("请选择部署。");
  });
});

describe("DeploymentsView — 详情", () => {
  it("元数据：环境/版本/Git 提交/Docker 镜像/工作流/端点（含链接属性）", async () => {
    const { html } = await renderDeployments((pinia) => seedDetail(pinia), DETAIL_PATH);
    expect(html).toContain("部署详情");
    for (const field of ["环境", "版本", "Git 提交", "Docker 镜像", "工作流", "端点"]) {
      expect(html, `应包含字段 ${field}`).toContain(field);
    }
    expect(html).toContain("abcdef1234567890"); // 完整版本（不截断）
    expect(html).toContain("ai-se/web:abcdef1");
    expect(html).toContain('href="/workflows/99975877-48e3-4448-9092-2ea9b10d53fe"');
    expect(html).toContain('href="http://localhost:18001"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("grid-cols-2");
    expect(html).not.toContain("deployment-metadata");
  });

  it("健康检查：JSON.stringify(…, null, 2) 原样输出，pre 仅 overflow-auto（无 max-height）", async () => {
    const { html } = await renderDeployments((pinia) => seedDetail(pinia), DETAIL_PATH);
    expect(html).toContain("健康检查");
    expect(html).toContain("&quot;status&quot;: &quot;healthy&quot;");
    const pre = html.match(/<pre[^>]*>/);
    expect(pre, "应渲染 pre").not.toBeNull();
    expect(pre![0]).toContain("overflow-auto");
    expect(pre![0]).not.toContain("max-h-55");
  });

  it("CI 面板：无 ciRun 整块不渲染；有则状态/提供方 + PR + 链接（url 缺失时不渲染链接）", async () => {
    const without = await renderDeployments((pinia) => seedDetail(pinia), DETAIL_PATH);
    expect(without.html).not.toMatch(/>CI<\/h2>/);

    const withCi = await renderDeployments(
      (pinia) =>
        seedDetail(pinia, {
          ciRun: {
            id: "ci-1",
            projectId: "b55c87fc-8f67-411c-94f2-007e9ab88c97",
            workflowRunId: "99975877-48e3-4448-9092-2ea9b10d53fe",
            taskId: "task-1",
            provider: "github",
            workflowFile: ".github/workflows/ci.yml",
            pullRequest: 42,
            status: "SUCCESS",
            url: "https://ci.example.test/runs/1",
            createdAt: "2026-09-14T03:00:00.000Z",
            updatedAt: "2026-09-14T03:00:00.000Z"
          }
        }),
      DETAIL_PATH
    );
    expect(withCi.html).toMatch(/>CI<\/h2>/);
    expect(withCi.html).toContain("成功 · GitHub");
    expect(withCi.html).toContain("拉取请求 #42");
    expect(withCi.html).toContain('href="https://ci.example.test/runs/1"');
    expect(withCi.html).toContain("打开 CI 运行");

    const noUrl = await renderDeployments(
      (pinia) =>
        seedDetail(pinia, {
          ciRun: {
            id: "ci-2",
            projectId: "p",
            workflowRunId: "w",
            taskId: "t",
            provider: "local",
            workflowFile: "ci.yml",
            status: "RUNNING",
            createdAt: "2026-09-14T03:00:00.000Z",
            updatedAt: "2026-09-14T03:00:00.000Z"
          }
        }),
      DETAIL_PATH
    );
    expect(noUrl.html).toContain("进行中 · 本地");
    expect(noUrl.html).not.toContain("打开 CI 运行");
    expect(noUrl.html).not.toContain("拉取请求");
  });

  it("日志：空态 / 行结构（time · level 原值 · message）与 lg 折叠列定义", async () => {
    const emptyLogs = await renderDeployments(
      (pinia) => seedDetail(pinia, { logs: [] }),
      DETAIL_PATH
    );
    expect(emptyLogs.html).toContain("暂无部署日志。");

    const { html } = await renderDeployments((pinia) => seedDetail(pinia), DETAIL_PATH);
    expect(html).toContain("container started");
    expect(html).toContain("health probe failed");
    expect(html).toContain(">info<"); // level 原值，无 label 映射
    expect(html).toContain(">error<");
    expect(html).toContain("grid-cols-[80px_minmax(0,1fr)]");
    expect(html).toContain("lg:grid-cols-[100px_minmax(0,1fr)_90px]");
    expect(html).toContain("col-start-2");
    expect(html).toContain("lg:col-start-auto");
    expect(html).not.toContain("event-timeline");
  });

  it("深链接无匹配部署时不渲染详情面板，显示 EmptyState", async () => {
    const { html } = await renderDeployments(undefined, "/deployments/99999999-0000-4000-8000-000000000000");
    expect(html).toContain("请选择部署。");
    expect(html).not.toContain("部署详情");
    expect(html).not.toContain("健康检查");
  });
});

describe("DeploymentsView — 回滚与禁用态", () => {
  it("回滚表单 gate：canRollback 为真才渲染；含默认原因 + rows=3 + required + danger 按钮", async () => {
    const visible = await renderDeployments((pinia) => seedDetail(pinia), DETAIL_PATH);
    expect(visible.html).toMatch(/>回滚<\/h2>/);
    expect(visible.html).toContain("恢复到上一个已知可用版本");
    expect(visible.html).toContain('rows="3"');
    expect(visible.html).toContain('id="deployment-rollback-reason"');
    const rollbackButton = visible.html.match(/<button[^>]*>回滚<\/button>/);
    expect(rollbackButton, "应渲染回滚按钮").not.toBeNull();
    expect(rollbackButton![0]).toContain("bg-danger"); // destructive
    expect(rollbackButton![0]).not.toMatch(/\sdisabled(?![-\w:])/);

    // operation=ROLLBACK → 不渲染
    const rollbackOp = await renderDeployments(
      (pinia) => seedDetail(pinia, { deployment: makeDeployment({ operation: "ROLLBACK" }) }),
      DETAIL_PATH
    );
    expect(rollbackOp.html).not.toMatch(/>回滚<\/h2>/);

    // status=RUNNING → 不渲染
    const running = await renderDeployments(
      (pinia) => seedDetail(pinia, { deployment: makeDeployment({ status: "RUNNING" }) }),
      DETAIL_PATH
    );
    expect(running.html).not.toMatch(/>回滚<\/h2>/);

    // FAILED + DEPLOY → 渲染（状态徽标 error tone）
    const failed = await renderDeployments(
      (pinia) => seedDetail(pinia, { deployment: makeDeployment({ status: "FAILED" }) }),
      DETAIL_PATH
    );
    expect(failed.html).toMatch(/>回滚<\/h2>/);
    expect(failed.html).toContain("bg-danger-bg");
  });

  it("production 提示仅在 production 环境出现；acting 时保存与回滚都禁用", async () => {
    const staging = await renderDeployments((pinia) => seedDetail(pinia), DETAIL_PATH);
    expect(staging.html).not.toContain("关联的生产部署任务必须已通过人工审批。");

    const production = await renderDeployments(
      (pinia) => seedDetail(pinia, { deployment: makeDeployment({ environment: "production" }) }),
      DETAIL_PATH
    );
    expect(production.html).toContain("关联的生产部署任务必须已通过人工审批。");

    const acting = await renderDeployments((pinia) => {
      seedDetail(pinia, { deployment: makeDeployment({ environment: "production" }) });
      useDeploymentsStore(pinia).acting = true;
    }, DETAIL_PATH);
    // 保存按钮在 Dialog 内（Teleport），回滚按钮在页面上
    for (const [label, source] of [
      ["保存", acting.all],
      ["回滚", acting.html]
    ] as const) {
      const button = source.match(new RegExp(`<button[^>]*>${label}</button>`));
      expect(button, `应渲染 ${label} 按钮`).not.toBeNull();
      expect(button![0], `${label} 在 acting 时应 disabled`).toMatch(/\sdisabled(?![-\w:])/);
    }
  });

  it("状态徽标按 deploymentStatusTone 输出 tone（7 种状态抽样）", async () => {
    const cases: Array<[string, string]> = [
      ["PENDING", "bg-neutral-bg"],
      ["RUNNING", "bg-info-bg"],
      ["SUCCESS", "bg-success-bg"],
      ["FAILED", "bg-danger-bg"],
      ["ROLLING_BACK", "bg-warning-bg"],
      ["ROLLED_BACK", "bg-muted"],
      ["ROLLBACK_FAILED", "bg-danger-bg"]
    ];
    for (const [status, toneClass] of cases) {
      const { html } = await renderDeployments(
        (pinia) => seedDetail(pinia, { deployment: makeDeployment({ status }) }),
        DETAIL_PATH
      );
      expect(html, `${status} 应渲染 ${toneClass}`).toContain(toneClass);
    }
  });
});

describe("DeploymentsView — 护栏", () => {
  it("页面不得出现任何 legacy 类", async () => {
    const { all } = await renderDeployments((pinia) => seedDetail(pinia), DETAIL_PATH);
    for (const legacy of [
      "deployment-page",
      "deployment-layout",
      "deployment-sidebar",
      "deployment-detail",
      "deployment-list",
      "deployment-list-item",
      "deployment-item",
      "deployment-metadata",
      "deployment-empty",
      "form-panel",
      "stacked-form",
      "panel-header",
      "status-pill",
      "event-timeline",
      "error-banner",
      'class="page"',
      'class="empty',
      'class="button'
    ]) {
      expect(all, `不应出现 legacy 类 ${legacy}`).not.toContain(legacy);
    }
  });

  it("W5：主从两栏保留（320px 主列表 + 1fr 详情），lg 以下单列", async () => {
    const { html } = await renderDeployments((pinia) => seedDetail(pinia), DETAIL_PATH);
    expect(html).toContain("lg:grid-cols-[320px_minmax(0,1fr)]");
    expect(html).toContain("grid-cols-1");
  });
});
