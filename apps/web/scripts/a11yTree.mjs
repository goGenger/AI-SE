#!/usr/bin/env node
/**
 * 可访问性「朗读」转录（screen-reader transcript）+ 原始无障碍树导出。
 *
 * 为什么需要它：`a11y.mjs` 用 axe 报的是**规则违规**，它回答不了「一个读屏用户从头到尾会听到什么」。
 * 真要走查那件事，需要一个人戴着 VoiceOver / NVDA 逐页听 —— 本脚本**不是**那个东西，
 * 它是对浏览器无障碍树（AX tree）的一次**推导**：按树的线性顺序，把每个可访问节点渲染成
 * `role "name" (state)`，让「朗读顺序」「哪些控件没名字」这类问题可以在 diff 里被审阅。
 *
 * 数据来源：Playwright 的 Chromium 无头实例。Playwright 1.61 已经移除了 `page.accessibility`，
 * 因此这里直接用 CDP 域 `Accessibility.getFullAXTree`（同一棵 Chrome 暴露给读屏的树）。
 *
 * 覆盖的状态（都尽量落在**真实数据**上；拿不到真实数据就如实标注）：
 *   1. 各列表页   2. 一个详情页   3. 一个打开的对话框   4. 工作流详情抽屉
 *
 * 每个状态额外标记：`button/link/textbox/combobox/checkbox/tab/menuitem` 里
 * **可访问名为空、或名字其实来自 placeholder** 的控件 —— 这是读屏用户第一个会撞上的缺陷。
 *
 * 用法：
 *   node scripts/a11yTree.mjs
 *   node scripts/a11yTree.mjs --out transcript.txt     # 同时写文件
 *   node scripts/a11yTree.mjs --json ax-tree.json      # 同时导出原始 AX 树
 *
 * 前提同 `a11y.mjs`：dev server 已起在 `A11Y_BASE_URL`（默认 http://localhost:5173）。
 * 真实 id 发现复用 `a11yTargets.mjs`（只读 GET）。
 */
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { DEFAULT_API_URL, discoverTargets } from "./a11yTargets.mjs";

const BASE_URL = (process.env.A11Y_BASE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const API_URL = process.env.A11Y_API_URL ?? DEFAULT_API_URL;
const WAIT_TIMEOUT = 10000;

/** 各列表页（页面级清单，非详情）。 */
const LIST_ROUTES = [
  "/projects",
  "/requirements",
  "/workflows",
  "/deployments",
  "/agent-run",
  "/agents",
  "/mcp"
];

/** 打开页面时排查到的后端错误文案（取 API 封装里那句「无法连接后端服务」）。 */
const BACKEND_DOWN_TEXT = "无法连接后端服务";

/** 会被读屏当作「可操作控件」的角色（命名是它们的第一道门槛）。 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "tab",
  "menuitem"
]);

/** 无朗读价值的容器 / 装饰节点：跳过它们，转录才读得下去（子节点仍会继续）。 */
const SKIP_ROLES = new Set(["generic", "none", "Ignored", "InlineTextBox"]);

/** 值得写进括号的状态（其余 AX 属性如 focusable 不体现「读屏会念到的状态」）。 */
const STATE_PROPS = [
  "checked",
  "disabled",
  "expanded",
  "selected",
  "required",
  "readonly",
  "invalid",
  "modal",
  "busy",
  "pressed",
  "level"
];

const parseArgs = (argv) => {
  const args = { out: null, json: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") args.out = argv[index + 1];
    else if (argv[index] === "--json") args.json = argv[index + 1];
  }
  return args;
};

/** 一个 AX 属性值 → `(state)` 里的片段；false / 空值不显示（只标「是」的状态）。 */
const formatState = (property) => {
  const value = property.value?.value;
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === false ||
    value === "false"
  ) {
    return null;
  }
  if (value === true || value === "true") return property.name;
  return `${property.name}=${value}`;
};

/**
 * 判定一个交互控件的命名是否「有问题」：
 *   · 空 —— 完全没有可访问名，读屏只会念成「按钮」；
 *   · 仅 placeholder —— 名字的唯一来源是 placeholder 属性（它会在输入后被清掉，读屏用户一旦
 *     开始输入就丢名字）。AX 节点在 `name.sources` 里给出命名来源，据此判定。
 */
const classifyControl = (node) => {
  const name = node.name?.value ?? "";
  const sources = node.name?.sources ?? [];
  const valued = sources.filter((source) => source.value?.value);
  const placeholder = valued.find((source) => source.type === "placeholder")?.value?.value;
  const onlyPlaceholder =
    valued.length > 0 && valued.every((source) => source.type === "placeholder");
  if (name === "" && !placeholder) return { kind: "empty" };
  if (name === "" || onlyPlaceholder) return { kind: "placeholder", placeholder };
  return null;
};

/** 把 CDP 展平的节点数组按 childIds 还原成树，先序遍历产出转录行与命名问题。 */
const renderTree = (nodes) => {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find((node) => !node.parentId) ?? nodes[0];
  const lines = [];
  const flags = [];

  const walk = (node, depth) => {
    const role = node.role?.value ?? "";
    const ignored = node.ignored === true;
    const emitted = !ignored && !SKIP_ROLES.has(role) && role !== "";

    if (emitted) {
      const name = node.name?.value ?? "";
      const states = (node.properties ?? []).map(formatState).filter(Boolean);
      const description = node.description?.value ?? "";
      const indent = "  ".repeat(Math.min(depth, 16));
      let line = `${indent}${role} ${JSON.stringify(name)}`;
      if (states.length) line += ` (${states.join(", ")})`;
      if (description) line += `  // desc: ${JSON.stringify(description)}`;
      lines.push(line);

      if (INTERACTIVE_ROLES.has(role)) {
        const problem = classifyControl(node);
        if (problem) flags.push({ role, name, ...problem });
      }
    }

    // 跳过的容器不占缩进层级：它的子节点渲染在它该在的层级上。
    const childDepth = emitted ? depth + 1 : depth;
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, childDepth);
    }
  };

  walk(root, 0);
  return { lines, flags };
};

/** 单页当前的「数据状态」：后端不可达时列表页其实是错误态，别把它当数据态来读。 */
const dataState = async (page) => {
  const down = await page
    .getByText(BACKEND_DOWN_TEXT)
    .count()
    .catch(() => 0);
  return down > 0 ? "错误态（后端不可达，未见真实数据）" : "已加载（真实数据）";
};

const separator = "=".repeat(72);

const renderState = (index, total, state, { lines, flags }) => {
  const out = [];
  out.push(separator);
  out.push(`状态 ${index}/${total}：${state.title}`);
  out.push(`URL：${state.url}`);
  out.push(`数据：${state.dataState}`);
  out.push(`AX 来源：CDP Accessibility.getFullAXTree（推导，非 VoiceOver / NVDA 录音）`);
  out.push("-".repeat(72));
  if (lines.length === 0) {
    out.push("  （无障碍树为空）");
  } else {
    out.push(...lines);
  }
  out.push("-".repeat(72));
  if (flags.length === 0) {
    out.push("命名问题：0");
  } else {
    out.push(`命名问题（${flags.length}）：`);
    for (const flag of flags) {
      const detail =
        flag.kind === "placeholder"
          ? `名称疑似来自 placeholder：${JSON.stringify(flag.placeholder)}`
          : "无可访问名（读屏只会念出角色）";
      out.push(`  - ${flag.role} ${JSON.stringify(flag.name)}  ${detail}`);
    }
  }
  return out;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const discovery = await discoverTargets({ apiUrl: API_URL });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  // Playwright 1.61 没有 page.accessibility；用 CDP 直接拿 Chrome 的 AX 树。
  const client = await context.newCDPSession(page);

  const captureAxTree = async () => (await client.send("Accessibility.getFullAXTree")).nodes;

  // 组装要覆盖的状态清单（真实 id 缺席时如实跳过并在转录里说明）。
  const states = [];
  for (const route of LIST_ROUTES) {
    states.push({ kind: "list", title: `列表页 ${route}`, url: `${BASE_URL}${route}` });
  }
  if (discovery.ids.project) {
    states.push({
      kind: "detail",
      title: `详情页 /projects/:id（真实数据）`,
      url: `${BASE_URL}/projects/${discovery.ids.project}`
    });
  } else {
    states.push({
      kind: "note",
      title: "详情页 /projects/:id",
      url: `${BASE_URL}/projects`,
      note: "未发现真实项目 id，跳过（placeholder (未见真实数据)）"
    });
  }
  states.push({ kind: "dialog", title: "对话框：/projects 新建项目", url: `${BASE_URL}/projects` });
  if (discovery.ids.workflow) {
    states.push({
      kind: "drawer",
      title: "抽屉：/workflows/:id 工作流详情（真实数据）",
      url: `${BASE_URL}/workflows/${discovery.ids.workflow}`
    });
  } else {
    states.push({
      kind: "note",
      title: "抽屉：/workflows/:id",
      url: `${BASE_URL}/workflows`,
      note: "未发现真实工作流 id，跳过（placeholder (未见真实数据)）"
    });
  }

  const transcript = [];
  transcript.push(`# 可访问性朗读转录（screen-reader transcript）· ${BASE_URL}`);
  transcript.push(
    `# 说明：以下是从 Chromium 无障碍树推导出的朗读顺序，不是 VoiceOver / NVDA 的录音；`
  );
  transcript.push(`#       真机走查仍需人耳确认。跳过 generic / none / ignored 容器节点。`);
  transcript.push(`# 后端：${API_URL}　真实 id 发现：${discovery.ok ? "成功" : "未全部成功"}`);
  for (const note of discovery.notes) transcript.push(`#   ⚠ ${note}`);
  transcript.push("");

  const jsonDump = [];
  let index = 0;
  for (const state of states) {
    index += 1;
    if (state.kind === "note") {
      transcript.push(separator);
      transcript.push(`状态 ${index}/${states.length}：${state.title}`);
      transcript.push(`数据：跳过 —— ${state.note}`);
      transcript.push("");
      continue;
    }

    // 与 a11y.mjs 同一处竞态：离开 /workflows/:id 时 SPA 会补一次同文档 push，
    // Playwright 报「打断 goto」，但目标页会正常落地 —— 只对这一类误报重试一次。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await page.goto(state.url, { waitUntil: "domcontentloaded" });
        break;
      } catch (error) {
        const benign = /interrupted by another navigation/.test(error.message);
        if (!benign || attempt === 1) throw error;
        await page.waitForTimeout(200);
      }
    }
    await page.waitForTimeout(600);

    if (state.kind === "dialog") {
      const trigger = page.locator('button:has-text("新建项目")').first();
      if ((await trigger.count()) === 0) {
        transcript.push(`状态 ${index}：无法打开对话框 —— 未找到「新建项目」触发按钮`);
        continue;
      }
      await trigger.click();
      await page
        .locator('[role="dialog"]:visible', { hasText: "新建项目" })
        .waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
    }

    if (state.kind === "drawer") {
      await page
        .locator('[role="dialog"]:visible', { hasText: "工作流详情" })
        .waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
    }

    // 列表 / 详情数据都是异步拉的：等「加载中」骨架消失再抓树，否则转录记录的会是加载态
    // 而不是数据态（那样「真实数据」的标注就是假的）。超时就照实抓当前状态。
    await page
      .locator('[role="status"][aria-label="加载中"]')
      .first()
      .waitFor({ state: "hidden", timeout: WAIT_TIMEOUT })
      .catch(() => {});

    state.dataState = await dataState(page);
    const nodes = await captureAxTree();
    const { lines, flags } = renderTree(nodes);
    transcript.push(...renderState(index, states.length, state, { lines, flags }));
    transcript.push("");
    jsonDump.push({ title: state.title, url: state.url, dataState: state.dataState, nodes });

    if (state.kind === "dialog") await page.keyboard.press("Escape");
  }

  await browser.close();

  const text = `${transcript.join("\n")}\n`;
  process.stdout.write(text);
  if (args.out) {
    writeFileSync(args.out, text, "utf8");
    process.stdout.write(`\n# 已写入 ${args.out}\n`);
  }
  if (args.json) {
    writeFileSync(args.json, `${JSON.stringify(jsonDump, null, 2)}\n`, "utf8");
    process.stdout.write(`# 原始 AX 树已写入 ${args.json}\n`);
  }
}

main().catch((error) => {
  console.error("转录失败：", error.message);
  console.error(`\n确认 dev server 已起在 ${BASE_URL}：`);
  console.error("  corepack pnpm --filter @ai-se/web dev --port 5173 --strictPort");
  process.exit(2);
});
