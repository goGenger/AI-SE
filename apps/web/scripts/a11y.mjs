#!/usr/bin/env node
/**
 * 可访问性扫描（axe-core + 真实 Chromium）。
 *
 * 为什么是一个独立脚本、而不是 vitest 用例：`apps/web` 的测试环境是**纯 Node（无 jsdom）**，
 * 而 axe 的一半规则（对比度、目标尺寸、层级）需要真实排版引擎才能算。把它塞进 vitest 要么
 * 需要引入 jsdom（规则会失真），要么需要每个 `pnpm test` 都拉起浏览器与 dev server。
 * 因此它**不在 `test` 门禁里**，按 `pnpm --filter @ai-se/web a11y` 单独跑。
 *
 * 前提：dev server 已起在 `A11Y_BASE_URL`（默认 http://localhost:5173）。
 * 这里**不自己拉服务器**：后端 CORS 只放行 5173（`apps/server/src/config.ts`），
 * 脚本换端口起服务会全站报「无法连接后端服务」，扫出来的是一堆错误页，没有意义。
 *
 * 阶段（对应不同的 WCAG 约束 / 不同的渲染状态，分开报告，不混成一个数字）：
 *   1. axe（默认视口，浅色 / 暗色）      —— 结构与对比度
 *   2. 200% 缩放等价视口（1440/2 × 900/2）—— SC 1.4.4 文本缩放
 *   3. 强制高对比度（forced-colors: active）—— 系统强制配色下内容仍可辨
 *   4. 文本间距覆盖（SC 1.4.12）           —— 行高/字距放宽后不丢内容
 *   5+ 新增（真实数据 / 弹层，见下）：
 *   · axe/data          —— 参数化路由用**运行时发现的真实 id**再扫一遍（浅色）
 *   · axe/dialog-open   —— 各列表页点开页头「新建」对话框后再扫
 *   · axe/drawer-open   —— `/workflows/:id` 深链接自动打开的详情抽屉
 *   · axe/reject-confirm—— 抽屉内「拒绝」审批确认框（只扫、绝不提交决定）
 *   · axe/trace-open    —— 抽屉内「追踪」区加载出树并展开一层后的实际排版（TF-06）
 *
 * 前 5 个阶段的相位名、输出格式、退出码、以及「至少扫到 N 条路由」的反空扫断言**保持不变**；
 * 新增阶段只在它们之后追加。
 *
 * 路由清单**从 `src/router/index.ts` 反向提取**，不手抄 —— 新增路由自动纳入扫描。
 * 真实 id 发现逻辑放在同目录的 `a11yTargets.mjs`（与 `a11yTree.mjs` 共用，避免两份真相）。
 */
import { createRequire } from "node:module";
import { chromium } from "playwright";
import {
  PARAM_ROUTES,
  apiGet,
  discoverTargets,
  readRoutes,
  targetHeaderLines,
  unwrapList
} from "./a11yTargets.mjs";

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const BASE_URL = (process.env.A11Y_BASE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const API_URL = process.env.A11Y_API_URL ?? "http://localhost:3000";
const COLOR_SCHEMES = ["light", "dark"];
/** 参考视口：1440×900（W10 终验用的那档）。 */
const REFERENCE_VIEWPORT = { width: 1440, height: 900 };
/** 单个交互/内容断言的上限等待（优先断言内容，而不是固定 sleep）。 */
const WAIT_TIMEOUT = 10000;

/** axe 的 WCAG 规则集（不含 best-practice —— 那类会淹没真问题）。 */
const AXE_RUN_OPTIONS = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
  resultTypes: ["violations"]
};

const TEXT_SPACING_CSS = `
  * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`;

/**
 * 弹窗阶段要覆盖的页面：页头触发按钮文案 → 打开的对话框标题。
 * 注意 `/workflows` 的按钮是「新建工作流」而弹窗标题是「创建工作流」—— 两者文案不同，
 * 触发按钮认按钮文本、断言认标题（不写死成同一个串会漏掉这种不一致）。
 */
const DIALOG_PAGES = [
  { route: "/projects", trigger: "新建项目", title: "新建项目" },
  { route: "/requirements", trigger: "新建需求", title: "新建需求" },
  { route: "/workflows", trigger: "新建工作流", title: "创建工作流" },
  { route: "/agent-run", trigger: "新建运行", title: "新建运行" },
  { route: "/deployments", trigger: "环境设置", title: "环境设置" }
];

const runAxe = async (page) => {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate((options) => window.axe.run(document, options), AXE_RUN_OPTIONS);
};

/**
 * 打开页面并等它稳定。
 * 用 `domcontentloaded` 而**不是** `networkidle`：工作流页与运行页会开 EventSource
 * （`api/workflows.ts:102`、`api/agentRuns.ts:66`），长连接永不空闲，networkidle 必然超时。
 *
 * 导航竞态：离开 `/workflows/:id` 时，WorkflowsView 会补一次 `router.push("/workflows")`
 * （关抽屉回列表），Playwright 把这次同文档导航当成「打断了 goto」而抛错，但目标 URL 其实
 * 会正常落地。这类误报只重试一次；其它任何导航错误照旧抛出，绝不静默吞掉真实失败。
 */
const visit = async (page, url) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      break;
    } catch (error) {
      const benign = /interrupted by another navigation/.test(error.message);
      if (!benign || attempt === 1) throw error;
      await page.waitForTimeout(200);
    }
  }
  await page.waitForTimeout(600);
};

/** 水平溢出：内容被推到视口右侧之外（缩放后最常见的「丢内容」形态）。 */
const horizontalOverflow = (page) =>
  page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
  });

const summarize = (violations) =>
  violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.length,
    target: violation.nodes[0]?.target?.join(" ") ?? ""
  }));

/** 只读拉取某工作流的待审批 id（用于证明扫描期间没有提交任何审批决定）。 */
const pendingApprovalIds = async (workflowId) => {
  const payload = await apiGet(API_URL, `/api/workflows/${workflowId}/approvals`);
  return unwrapList(payload)
    .filter((approval) => approval.status === "PENDING")
    .map((approval) => approval.id)
    .sort();
};

async function main() {
  const routes = readRoutes();
  const findings = [];
  const overflow = [];
  /** 真实「失败」而非 axe 违规：触发器缺失、弹层打不开、抽屉没渲染出内容等。 */
  const errors = [];
  /** 每个阶段实际跑过 axe 的路由数（弹层失败的页面不计入 —— 它没被真正扫到）。 */
  const phaseScans = new Map();

  // 先做 id 发现：它是表头的一部分，也决定后续阶段能否落到真实数据上。
  const discovery = await discoverTargets({ apiUrl: API_URL });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: REFERENCE_VIEWPORT });
  const page = await context.newPage();

  const record = (phase, route, result) => {
    phaseScans.set(phase, (phaseScans.get(phase) ?? 0) + 1);
    for (const violation of summarize(result.violations)) {
      findings.push({ phase, route, ...violation });
    }
  };

  // ── 阶段 1：默认视口，浅色 + 暗色 ────────────────────────────────
  for (const scheme of COLOR_SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const route of routes) {
      await visit(page, `${BASE_URL}${route.concrete}`);
      record(`axe/${scheme}`, route.path, await runAxe(page));
    }
  }

  // ── 阶段 2：200% 缩放等价视口（SC 1.4.4）──────────────────────────
  const zoomViewport = {
    width: Math.round(REFERENCE_VIEWPORT.width / 2),
    height: Math.round(REFERENCE_VIEWPORT.height / 2)
  };
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(zoomViewport);
  for (const route of routes) {
    await visit(page, `${BASE_URL}${route.concrete}`);
    record("zoom200", route.path, await runAxe(page));
    const size = await horizontalOverflow(page);
    if (size.scrollWidth > size.clientWidth + 1) {
      overflow.push({ phase: "zoom200", route: route.path, ...size });
    }
  }

  // ── 阶段 3：强制高对比度 ────────────────────────────────────────
  await page.setViewportSize(REFERENCE_VIEWPORT);
  await page.emulateMedia({ colorScheme: "light", forcedColors: "active" });
  for (const route of routes) {
    await visit(page, `${BASE_URL}${route.concrete}`);
    record("forcedColors", route.path, await runAxe(page));
  }

  // ── 阶段 4：文本间距（SC 1.4.12）─────────────────────────────────
  await page.emulateMedia({ colorScheme: "light", forcedColors: "none" });
  for (const route of routes) {
    await visit(page, `${BASE_URL}${route.concrete}`);
    await page.addStyleTag({ content: TEXT_SPACING_CSS });
    await page.waitForTimeout(250);
    record("textSpacing", route.path, await runAxe(page));
    const size = await horizontalOverflow(page);
    if (size.scrollWidth > size.clientWidth + 1) {
      overflow.push({ phase: "textSpacing", route: route.path, ...size });
    }
  }

  // ── 阶段 5：参数化路由 × 真实数据 id（浅色）───────────────────────
  // 发现失败时相位名带占位符标注，别让「没数据」看起来像「扫过了数据态」。
  const dataPhase = discovery.ok ? "axe/data" : "axe/data (placeholder (未见真实数据))";
  const realRoutes = [];
  const placeholderRoutes = [];
  await page.setViewportSize(REFERENCE_VIEWPORT);
  await page.emulateMedia({ colorScheme: "light", forcedColors: "none" });
  for (const route of PARAM_ROUTES) {
    const target = discovery.targets[route];
    await visit(page, `${BASE_URL}${target.concrete}`);
    record(dataPhase, route, await runAxe(page));
    (target.real ? realRoutes : placeholderRoutes).push(route);
  }

  // ── 阶段 6：页头「新建」对话框 ───────────────────────────────────
  // 逐页点开触发器 → 断言确实打开的是可见 Dialog（URL 未跳走）→ 扫 → Esc 关闭 → 断言已关闭。
  // 触发器缺失或弹窗打不开一律记为失败：那是真缺陷，不是「跳过」。
  for (const spec of DIALOG_PAGES) {
    const url = `${BASE_URL}${spec.route}`;
    const dialog = page.locator('[role="dialog"]:visible', { hasText: spec.title });
    try {
      await visit(page, url);
      const before = page.url();
      const trigger = page.locator(`button:has-text("${spec.trigger}")`).first();
      if ((await trigger.count()) === 0) {
        throw new Error(`页头未找到触发按钮「${spec.trigger}」`);
      }
      await trigger.click();
      await dialog.waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
      if (page.url() !== before) {
        throw new Error(`点击「${spec.trigger}」后跳到 ${page.url()}，未停在对话框`);
      }
      record("axe/dialog-open", spec.route, await runAxe(page));
    } catch (error) {
      errors.push({ phase: "axe/dialog-open", route: spec.route, message: error.message });
    } finally {
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden", timeout: WAIT_TIMEOUT }).catch(() => {});
      if ((await dialog.count()) > 0) {
        errors.push({
          phase: "axe/dialog-open",
          route: spec.route,
          message: `按 Esc 后「${spec.title}」对话框仍可见（未关闭）`
        });
      }
    }
  }

  // ── 阶段 7：工作流详情抽屉（真实数据）───────────────────────────
  // 深链接 `/workflows/:id` 自动开抽屉；断言抽屉可见且**渲染出该工作流的真实内容**（标题即 id）。
  let drawerReady = false;
  if (discovery.ids.workflow) {
    const workflowId = discovery.ids.workflow;
    await visit(page, `${BASE_URL}/workflows/${workflowId}`);
    const drawer = page.locator('[role="dialog"]:visible', { hasText: "工作流详情" });
    try {
      await drawer.waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
      // 抽屉**先于数据出现**（先骨架、后内容），所以断言要等「内容」而不是等「可见」：
      // 详情标题就是当前工作流 id，它出现才算真的渲染了这份数据，而不是停在加载 / 错误态。
      await drawer
        .getByText(workflowId, { exact: false })
        .first()
        .waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
      record("axe/drawer-open", "/workflows/:id", await runAxe(page));
      drawerReady = true;
    } catch (error) {
      errors.push({
        phase: "axe/drawer-open",
        route: "/workflows/:id",
        message: `抽屉未渲染出该工作流的详情内容：${error.message}`
      });
    }
  } else {
    errors.push({
      phase: "axe/drawer-open",
      route: "/workflows/:id",
      message: "未发现真实工作流 id，抽屉阶段无法扫描真实内容（placeholder (未见真实数据)）"
    });
  }

  // ── 阶段 8：拒绝审批确认框（只看不点确认）─────────────────────────
  // 「拒绝」走 ConfirmDialog（`WorkflowsView.vue`），确认按钮才是提交。这里只点开、扫、Esc 关，
  // 并用只读 GET 前后比对证明**没有提交任何审批决定** —— 这是用户的真实数据，脚本绝不能改它。
  if (drawerReady) {
    const workflowId = discovery.ids.workflow;
    const drawer = page.locator('[role="dialog"]:visible', { hasText: "工作流详情" });
    const confirm = page.locator('[role="dialog"]:visible', { hasText: "拒绝任务" });
    try {
      const before = await pendingApprovalIds(workflowId).catch(() => null);
      const rejectButton = drawer.locator("button", { hasText: "拒绝" }).first();
      if ((await rejectButton.count()) === 0) {
        throw new Error("抽屉内没有「拒绝」按钮（该工作流可能不含待审批项）");
      }
      await rejectButton.waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
      await rejectButton.click();
      await confirm.waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
      record("axe/reject-confirm", "/workflows/:id", await runAxe(page));
      await page.keyboard.press("Escape");
      await confirm.waitFor({ state: "hidden", timeout: WAIT_TIMEOUT }).catch(() => {});
      if ((await confirm.count()) > 0) throw new Error("按 Esc 后拒绝确认框仍可见（未关闭）");
      // 双重断言：DOM（抽屉里的待审批项应仍在）+ 只读 GET（审批仍为 PENDING）。
      const stillPending = await drawer.locator("button", { hasText: "拒绝" }).count();
      if (stillPending === 0) {
        throw new Error("拒绝确认框已关闭，但抽屉里的审批按钮消失，疑似提交了审批决定");
      }
      const after = await pendingApprovalIds(workflowId).catch(() => null);
      if (before && after && JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error(
          `扫描期间待审批项发生变化（before=${before} after=${after}），疑似提交了决定`
        );
      }
    } catch (error) {
      errors.push({ phase: "axe/reject-confirm", route: "/workflows/:id", message: error.message });
    }
  } else {
    errors.push({
      phase: "axe/reject-confirm",
      route: "/workflows/:id",
      message: "抽屉未就绪，拒绝确认框无法扫描"
    });
  }

  // ── 阶段 9：追踪树展开态（TF-06）─────────────────────────────────
  // 追踪树是**按需加载**的：先点「加载追踪」，等数据态出现（「刷新」按钮只在数据态渲染），
  // 再展开一个默认收起的层级（Agent 运行 → 工具调用），扫描递归嵌套 + 缩进 + 折叠控件的实际排版。
  // 全程只读：追踪是 `GET /api/workflows/:id/trace` 派生视图，展开 / 收起是纯本地状态。
  if (drawerReady) {
    const drawer = page.locator('[role="dialog"]:visible', { hasText: "工作流详情" });
    try {
      const loadButton = drawer.locator("button", { hasText: "加载追踪" }).first();
      if ((await loadButton.count()) > 0) await loadButton.click();
      const refreshButton = drawer.locator("button", { hasText: "刷新" }).first();
      await refreshButton.waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
      const tree = drawer.getByRole("list", { name: "端到端追踪树" });
      await tree.waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
      const collapsed = tree.locator('button[aria-expanded="false"]').first();
      if ((await collapsed.count()) > 0) await collapsed.click();
      record("axe/trace-open", "/workflows/:id", await runAxe(page));
    } catch (error) {
      errors.push({ phase: "axe/trace-open", route: "/workflows/:id", message: error.message });
    }
  } else {
    errors.push({
      phase: "axe/trace-open",
      route: "/workflows/:id",
      message: "抽屉未就绪，追踪树无法扫描"
    });
  }

  await browser.close();
  // ── 报告 ───────────────────────────────────────────────────────
  const byPhase = new Map();
  for (const finding of findings) {
    const key = `${finding.phase} · ${finding.id}`;
    const entry = byPhase.get(key) ?? { key, impact: finding.impact, help: finding.help, count: 0 };
    entry.count += 1;
    byPhase.set(key, entry);
  }

  console.log(`# 可访问性扫描 · ${BASE_URL}`);
  console.log(
    `# 路由 ${routes.length} 条 × 4 阶段（axe 浅色 / axe 暗色 / 200% 缩放 / 强制高对比度 / 文本间距）\n`
  );
  for (const line of targetHeaderLines(discovery)) console.log(line);
  console.log(
    `# 新增阶段：axe/data · axe/dialog-open · axe/drawer-open · axe/reject-confirm · axe/trace-open\n`
  );
  console.log(`# axe/data 实扫路由（real）：${realRoutes.join(" ") || "（无）"}`);
  console.log(
    `# axe/data 占位路由（placeholder (未见真实数据)）：${placeholderRoutes.join(" ") || "（无）"}\n`
  );
  const phaseCounts = [...phaseScans.entries()].map(([phase, count]) => `${phase} ${count}`);
  console.log(`# 各阶段实际扫描路由数：${phaseCounts.join(" · ")}\n`);

  if (byPhase.size === 0) {
    console.log("✓ axe 无 WCAG A/AA 违规。");
  } else {
    console.log(`✗ axe 报告 ${byPhase.size} 类违规（合计 ${findings.length} 处）：\n`);
    for (const entry of [...byPhase.values()].sort((a, b) => b.count - a.count)) {
      console.log(`  [${entry.impact ?? "n/a"}] ${entry.key} ×${entry.count}`);
      console.log(`      ${entry.help}`);
      const sample = findings.find((f) => `${f.phase} · ${f.id}` === entry.key);
      if (sample?.target) console.log(`      例：${sample.route} → ${sample.target}`);
    }
  }

  if (overflow.length === 0) {
    console.log("\n✓ 无水平溢出（200% 缩放 / 文本间距两阶段）。");
  } else {
    console.log(`\n✗ 水平溢出 ${overflow.length} 处：`);
    for (const item of overflow) {
      console.log(
        `  ${item.phase} ${item.route} — scrollWidth ${item.scrollWidth} > clientWidth ${item.clientWidth}`
      );
    }
  }

  if (errors.length > 0) {
    console.log(`\n✗ 阶段失败 ${errors.length} 处（触发器缺失 / 弹层打不开 / 未渲染真实内容）：`);
    for (const item of errors) {
      console.log(`  ${item.phase} ${item.route} — ${item.message}`);
    }
  }

  const failed = findings.length > 0 || overflow.length > 0 || errors.length > 0;
  console.log(`\n${failed ? "结果：存在需处理的项。" : "结果：全部通过。"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("扫描失败：", error.message);
  console.error(`\n确认 dev server 已起在 ${BASE_URL}：`);
  console.error("  corepack pnpm --filter @ai-se/web dev --port 5173 --strictPort");
  process.exit(2);
});
