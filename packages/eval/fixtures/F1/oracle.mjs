#!/usr/bin/env node
/**
 * F1 隐藏 oracle（黑盒浏览器，`docs/233` §4）：启动被测前端 → 按 journey 逐条判定 20 条 Must +
 * 4 条 Should → 输出逐条 AC 的 JSON 结果。
 *
 * 用法：`node oracle.mjs <workspacePath>`（cwd = 本夹具目录；**不改原工作区**——安装与构建都在
 * 临时副本里做）。退出码：0 = 所有 Must 通过；1 = 有 Must 失败；2 = 用法错误。
 *
 * 隔离约定（与 E1 同）：本文件、`reference/`、`mutants/` 均不得进入被测工作区或提示词。
 *
 * 依赖：`playwright` 从 `@ai-se/eval` 的 devDependency 解析（与 `packages/browser` 同版本）。
 * 这是**黑盒**脚本：不导入任何 workspace 包，判据全部来自浏览器。
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const workspace = process.argv[2];
if (!workspace || !existsSync(workspace)) {
  console.error("用法：node oracle.mjs <workspacePath>（目录必须存在）");
  process.exit(2);
}

const results = [];
const consoleErrors = [];
const SKIP_ENTRIES = new Set(["node_modules", "dist", ".git", ".vite"]);

function record(ac, passed, detail, must = true) {
  results.push({ ac, must, passed, detail });
}

async function check(ac, fn, must = true) {
  try {
    const detail = await fn();
    record(ac, true, detail ?? "ok", must);
  } catch (error) {
    record(ac, false, error instanceof Error ? error.message : String(error), must);
  }
}

async function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs ?? 0}ms`));
    }, options.timeoutMs ?? 600_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${code}\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`
          )
        );
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    output: () => `${stdout}\n${stderr}`,
    kill: () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* 进程可能已退出 */
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* 同上 */
      }
    }
  };
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const net = await import("node:net");
  while (Date.now() < deadline) {
    const ok = await new Promise((resolveProbe) => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        resolveProbe(value);
      };
      socket.on("connect", () => finish(true));
      socket.on("error", () => finish(false));
      socket.setTimeout(500, () => finish(false));
    });
    if (ok) return true;
    await delay(200);
  }
  return false;
}

function copyWorkspace(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !SKIP_ENTRIES.has(source.split("/").pop() ?? "")
  });
}

// ── 浏览器侧辅助 ───────────────────────────────────────────────────────────────

let browser;
let MOCK;
let PAGE;

async function resetMock(body = {}) {
  const response = await fetch(`${MOCK}/__mock/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tasks: DEFAULT_SEED, ...body })
  });
  if (!response.ok) throw new Error(`mock reset failed with ${response.status}`);
}

async function configMock(body) {
  const response = await fetch(`${MOCK}/__mock/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`mock config failed with ${response.status}`);
}

async function mockRequests() {
  const response = await fetch(`${MOCK}/__mock/requests`);
  if (!response.ok) throw new Error(`mock requests failed with ${response.status}`);
  return (await response.json()).requests;
}

const DEFAULT_SEED = [
  { id: "task-alpha", title: "Alpha task", done: false },
  { id: "task-beta", title: "Beta task", done: true },
  { id: "task-gamma", title: "Gamma task", done: false }
];

async function withPage(options, fn) {
  const context = await browser.newContext({
    baseURL: PAGE,
    viewport: options.viewport ?? { width: 1280, height: 800 },
    ...(options.colorScheme ? { colorScheme: options.colorScheme } : {})
  });
  const page = await context.newPage();
  const journeyLabel = options.label ?? "journey";
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // 网络失败（含被 4xx/5xx 拒绝的资源）不是应用错误——`docs/233` §3.3 AC-20 的明文例外。
    if (/Failed to load resource/i.test(text)) return;
    consoleErrors.push(`${journeyLabel}: ${text}`);
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(`${journeyLabel}: ${error?.message ?? String(error)}`);
  });
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

async function waitVisible(page, testid, timeout = 10_000) {
  const locator = page.getByTestId(testid).first();
  await locator.waitFor({ state: "visible", timeout });
  return locator;
}

async function waitHidden(page, testid, timeout = 10_000) {
  await page.getByTestId(testid).first().waitFor({ state: "hidden", timeout });
}

async function waitCount(page, testid, expected, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await page.getByTestId(testid).count()) === expected) return;
    await delay(100);
  }
  const actual = await page.getByTestId(testid).count();
  throw new Error(`expected ${expected} "${testid}" element(s), found ${actual}`);
}

async function titles(page) {
  return page.getByTestId("task-title").allTextContents();
}

async function countText(page) {
  return (await waitVisible(page, "task-count")).textContent();
}

async function openWith(page, options = {}) {
  // 每个 journey 都从**默认种子**开始：上一条 journey 改过 mock 状态（空列表 / 失败注入），
  // 不重置的话下一条会读到残留状态（实测：empty journey 之后 create journey 拿不到任何 item）。
  await resetMock(options.mock ?? {});
  await page.goto("/");
}

/**
 * 一条 journey。**启动失败不能让整轮中止**：被测工作区可能连 `task-item` 都渲染不出来
 * （template / `empty-shell` 正是这样），此时要的是「逐条 AC 的读数」，而不是一条 BOOT 记录
 * ——`docs/233` §6.2 第 2 条正是按 Must 失败条数判的。
 */
async function runJourney(journey) {
  try {
    await journey.run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const [ac, must] of journey.acs) {
      if (!results.some((entry) => entry.ac === ac)) {
        record(ac, false, `${journey.label} journey could not run: ${message.split("\n")[0]}`, must);
      }
    }
  }
}

/** 每条 journey 负责的 AC：启动失败时按这张表补齐失败记录（不静默跳过）。 */
const JOURNEYS = [
  {
    label: "first-render",
    acs: [
      ["AC-01", true],
      ["AC-02", true],
      ["AC-03", true],
      ["AC-04", true],
      ["AC-21", false]
    ],
    run: firstRenderJourney
  },
  { label: "empty", acs: [["AC-05", true]], run: emptyJourney },
  {
    label: "create",
    acs: [
      ["AC-06", true],
      ["AC-07", true],
      ["AC-08", true],
      ["AC-09", true],
      ["AC-10", true]
    ],
    run: createJourney
  },
  {
    label: "search-filter",
    acs: [
      ["AC-11", true],
      ["AC-12", true],
      ["AC-13", true],
      ["AC-14", true],
      ["AC-15", true]
    ],
    run: searchFilterJourney
  },
  {
    label: "toggle-delete",
    acs: [
      ["AC-16", true],
      ["AC-17", true],
      ["AC-18", true]
    ],
    run: toggleDeleteJourney
  },
  { label: "resilience", acs: [["AC-19", true]], run: resilienceJourney },
  {
    label: "usability",
    acs: [
      ["AC-22", false],
      ["AC-23", false],
      ["AC-24", false]
    ],
    run: usabilityJourneys
  }
];

// ── journey ───────────────────────────────────────────────────────────────────

async function firstRenderJourney() {
  await withPage({ label: "first-render" }, async (page) => {
    await resetMock({ delayMs: 800 });
    const startedAt = Date.now();
    await page.goto("/");

    await check("AC-01", async () => {
      const title = await waitVisible(page, "app-title");
      const text = (await title.textContent())?.trim() ?? "";
      if (text === "") throw new Error("app-title is empty");
      return `app-title="${text}"`;
    });

    await check("AC-02", async () => {
      await waitVisible(page, "loading-indicator", 3_000);
      await waitVisible(page, "task-item", 15_000);
      await waitHidden(page, "loading-indicator", 5_000);
      return "loading-indicator shown during the 800ms mock delay, gone after data arrived";
    });

    await check("AC-03", async () => {
      await waitCount(page, "task-item", 3);
      const seen = await titles(page);
      const expected = DEFAULT_SEED.map((task) => task.title);
      if (JSON.stringify(seen) !== JSON.stringify(expected)) {
        throw new Error(`order mismatch: ${JSON.stringify(seen)} != ${JSON.stringify(expected)}`);
      }
      return `3 items in mock order: ${seen.join(" | ")}`;
    });

    await check("AC-04", async () => {
      const seen = await titles(page);
      const expected = DEFAULT_SEED.map((task) => task.title);
      for (const title of expected) {
        if (!seen.includes(title)) throw new Error(`missing task-title "${title}"`);
      }
      return `task-title matches mock titles: ${seen.join(" | ")}`;
    });

    await check("AC-21", async () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed > 3_000) throw new Error(`first task-item took ${elapsed}ms (> 3000ms)`);
      return `first task-item visible in ${elapsed}ms (mock delay 800ms included)`;
    }, false);
  });
}

async function emptyJourney() {
  await withPage({ label: "empty" }, async (page) => {
    await openWith(page, { mock: { tasks: [] } });
    await check("AC-05", async () => {
      await waitVisible(page, "empty-state");
      const items = await page.getByTestId("task-item").count();
      if (items !== 0) throw new Error(`expected no task-item, found ${items}`);
      return "empty-state visible with 0 task-item";
    });
  });
}

async function createJourney() {
  await withPage({ label: "create" }, async (page) => {
    await openWith(page);
    await waitCount(page, "task-item", 3);

    await check("AC-06", async () => {
      await page.getByTestId("new-task-button").click();
      await waitVisible(page, "new-task-dialog");
      return "new-task-dialog opened from new-task-button";
    });

    await check("AC-07", async () => {
      await page.getByTestId("task-title-input").fill("   ");
      await page.getByTestId("save-task-button").click();
      await waitVisible(page, "form-error");
      const posts = (await mockRequests()).filter((entry) => entry.method === "POST");
      if (posts.length !== 0) {
        throw new Error(`blank title still sent ${posts.length} POST request(s)`);
      }
      return "form-error shown and no POST reached the mock";
    });

    await check("AC-08", async () => {
      await page.getByTestId("task-title-input").fill("Write docs");
      await page.getByTestId("save-task-button").click();
      await waitHidden(page, "new-task-dialog");
      await waitCount(page, "task-item", 4);
      const seen = await titles(page);
      if (seen[0] !== "Write docs") throw new Error(`new task not first: ${JSON.stringify(seen)}`);
      const count = (await countText(page))?.trim();
      if (count !== "4") throw new Error(`task-count is "${count}", expected "4"`);
      return "dialog closed, item added, task-count 3 -> 4";
    });

    await check("AC-09", async () => {
      await configMock({ failNextPost: true });
      await page.getByTestId("new-task-button").click();
      await page.getByTestId("task-title-input").fill("Will fail");
      await page.getByTestId("save-task-button").click();
      await waitVisible(page, "error-banner");
      const dialogVisible = await page.getByTestId("new-task-dialog").isVisible();
      if (!dialogVisible) throw new Error("dialog closed even though the POST failed");
      await page.getByTestId("cancel-task-button").click();
      await waitHidden(page, "new-task-dialog");
      return "error-banner shown and dialog kept open on 500";
    });

    await check("AC-10", async () => {
      await configMock({ delayMs: 900 });
      await page.getByTestId("new-task-button").click();
      await page.getByTestId("task-title-input").fill("Slow task");
      const save = page.getByTestId("save-task-button");
      await save.click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-task-button"]')?.hasAttribute("disabled") ===
          true,
        undefined,
        { timeout: 3_000 }
      );
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-task-button"]') === null ||
          document.querySelector('[data-testid="save-task-button"]')?.hasAttribute("disabled") ===
            false,
        undefined,
        { timeout: 10_000 }
      );
      await configMock({ delayMs: 0 });
      return "save-task-button disabled during the request, enabled after it";
    });
  });
}

async function searchFilterJourney() {
  await withPage({ label: "search-filter" }, async (page) => {
    await openWith(page);
    await waitCount(page, "task-item", 3);

    await check("AC-11", async () => {
      await page.getByTestId("search-input").fill("alp");
      await waitCount(page, "task-item", 1);
      const seen = await titles(page);
      if (seen[0] !== "Alpha task") throw new Error(`unexpected match: ${JSON.stringify(seen)}`);
      return "search 'alp' leaves only Alpha task";
    });

    await check("AC-12", async () => {
      await page.getByTestId("search-input").fill("zzz");
      await waitVisible(page, "no-results");
      if ((await page.getByTestId("empty-state").count()) !== 0) {
        throw new Error("empty-state rendered for a filtered-empty list");
      }
      if ((await page.getByTestId("task-item").count()) !== 0) {
        throw new Error("task-item still rendered for a no-match search");
      }
      return "no-results shown, empty-state not used";
    });

    await check("AC-13", async () => {
      await page.getByTestId("search-input").fill("");
      await page.getByTestId("filter-done").click();
      await waitCount(page, "task-item", 1);
      const seen = await titles(page);
      if (seen[0] !== "Beta task") throw new Error(`unexpected done list: ${JSON.stringify(seen)}`);
      return "filter-done leaves only Beta task";
    });

    await check("AC-14", async () => {
      await page.getByTestId("filter-all").click();
      await waitCount(page, "task-item", 3);
      return "filter-all restores 3 items";
    });

    await check("AC-15", async () => {
      await page.getByTestId("search-input").fill("a");
      await page.getByTestId("filter-done").click();
      await waitCount(page, "task-item", 1);
      const seen = await titles(page);
      if (seen[0] !== "Beta task") {
        throw new Error(`search+filter did not intersect: ${JSON.stringify(seen)}`);
      }
      return "search 'a' + filter-done intersect to Beta task";
    });
  });
}

async function toggleDeleteJourney() {
  await withPage({ label: "toggle-delete" }, async (page) => {
    await openWith(page);
    await waitCount(page, "task-item", 3);

    await check("AC-16", async () => {
      const first = page.getByTestId("task-item").first();
      await first.getByTestId("task-done-toggle").click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll('[data-testid="task-item"]')[0]?.getAttribute("data-done") ===
          "true",
        undefined,
        { timeout: 10_000 }
      );
      return "first task-item flipped to data-done=true";
    });

    await check("AC-17", async () => {
      await page.reload();
      await waitCount(page, "task-item", 3);
      await page.waitForFunction(
        () =>
          document.querySelectorAll('[data-testid="task-item"]')[0]?.getAttribute("data-done") ===
          "true",
        undefined,
        { timeout: 10_000 }
      );
      return "done state survived a reload (persisted by the mock)";
    });

    await check("AC-18", async () => {
      const before = (await countText(page))?.trim();
      await page.getByTestId("task-item").first().getByTestId("task-delete-button").click();
      await waitCount(page, "task-item", 2);
      const after = (await countText(page))?.trim();
      if (before !== "3" || after !== "2") {
        throw new Error(`task-count went ${before} -> ${after}, expected 3 -> 2`);
      }
      return "deleted item disappeared and task-count 3 -> 2";
    });
  });
}

async function resilienceJourney() {
  await withPage({ label: "resilience" }, async (page) => {
    await openWith(page, { mock: { failNextList: true } });
    await check("AC-19", async () => {
      await waitVisible(page, "error-banner");
      await page.getByTestId("retry-button").click();
      await waitCount(page, "task-item", 3);
      await waitHidden(page, "error-banner");
      return "error-banner on the first 500, retry-button recovers the list";
    });
  });
}

async function usabilityJourneys() {
  await withPage({ label: "mobile-375", viewport: { width: 375, height: 812 } }, async (page) => {
    await openWith(page);
    await waitCount(page, "task-item", 3);
    await check("AC-22", async () => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      if (overflow > 1) throw new Error(`horizontal overflow of ${overflow}px at 375px`);
      return "no horizontal scroll at 375px";
    }, false);
  });

  await withPage({ label: "keyboard" }, async (page) => {
    await openWith(page);
    await waitCount(page, "task-item", 3);
    await check("AC-23", async () => {
      const sequence = [];
      for (let step = 0; step < 14; step += 1) {
        await page.keyboard.press("Tab");
        const testId = await page.evaluate(() => {
          const active = document.activeElement;
          return active?.closest("[data-testid]")?.getAttribute("data-testid") ?? "";
        });
        if (testId !== "") sequence.push(testId);
      }
      const order = ["search-input", "new-task-button", "task-done-toggle"];
      const positions = order.map((testId) => sequence.indexOf(testId));
      if (positions.some((position) => position < 0)) {
        throw new Error(`tab order never reached ${JSON.stringify(order)} in ${JSON.stringify(sequence)}`);
      }
      if (!(positions[0] < positions[1] && positions[1] < positions[2])) {
        throw new Error(`tab order is ${JSON.stringify(positions)} for ${JSON.stringify(order)}`);
      }
      return `tab order: ${sequence.slice(0, 6).join(" -> ")}`;
    }, false);
  });

  const backgrounds = {};
  for (const scheme of ["light", "dark"]) {
    await withPage({ label: `colors-${scheme}`, colorScheme: scheme }, async (page) => {
      await openWith(page);
      await waitCount(page, "task-item", 3);
      backgrounds[scheme] = await page.evaluate(() => {
        const item = document.querySelector('[data-testid="task-item"]');
        return item ? getComputedStyle(item).backgroundColor : "";
      });
    });
  }

  await check("AC-24", async () => {
    const parse = (value) => {
      const match = /rgba?\(([^)]+)\)/.exec(value ?? "");
      if (!match) return null;
      const [r, g, b] = match[1].split(",").map((part) => Number(part.trim()));
      return { r, g, b };
    };
    const light = parse(backgrounds.light);
    const dark = parse(backgrounds.dark);
    if (!light || !dark) throw new Error(`unreadable background colors: ${JSON.stringify(backgrounds)}`);
    const mean = (color) => (color.r + color.g + color.b) / 3;
    if (backgrounds.light === backgrounds.dark) {
      throw new Error(`task-item background unchanged under prefers-color-scheme: dark (${backgrounds.dark})`);
    }
    if (mean(dark) >= 128) throw new Error(`dark task-item background is not dark: ${backgrounds.dark}`);
    return `task-item background ${backgrounds.light} (light) -> ${backgrounds.dark} (dark)`;
  }, false);
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), "f1-oracle-"));
  const workdir = join(tempRoot, "workspace");
  let mockProcess;
  let previewProcess;

  try {
    copyWorkspace(workspace, workdir);
    if (!existsSync(join(workdir, "package.json"))) {
      throw new Error("workspace has no package.json");
    }

    await run("corepack", ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"], {
      cwd: workdir,
      timeoutMs: 600_000
    });

    const mockPort = await freePort();
    const previewPort = await freePort();
    MOCK = `http://127.0.0.1:${mockPort}`;
    PAGE = `http://127.0.0.1:${previewPort}`;

    // `VITE_API_BASE` 在**构建时**内联（Vite 的 `import.meta.env`），所以端口必须先定下来。
    await run("corepack", ["pnpm", "build"], {
      cwd: workdir,
      env: { VITE_API_BASE: MOCK },
      timeoutMs: 600_000
    });

    mockProcess = startProcess("node", ["mock-server.mjs"], {
      cwd: workdir,
      env: { PORT: String(mockPort) }
    });
    if (!(await waitForPort(mockPort, 20_000))) {
      throw new Error("mock-server did not start");
    }

    previewProcess = startProcess("corepack", ["pnpm", "start"], {
      cwd: workdir,
      env: { PORT: String(previewPort) }
    });
    if (!(await waitForPort(previewPort, 60_000))) {
      throw new Error(
        `preview did not start on ${previewPort}\n${previewProcess.output().slice(-2000)}`
      );
    }

    const { chromium } = await import("playwright");
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });

    // AC-20 是**汇总判定**：它读所有 journey 累积的 console error（网络 4xx/5xx 已排除），
    // 所以排在最后单独判定，不挂在某一条 journey 上。
    for (const journey of JOURNEYS) await runJourney(journey);

    await check("AC-20", async () => {
      if (consoleErrors.length > 0) {
        throw new Error(`console reported ${consoleErrors.length} error(s): ${consoleErrors.slice(0, 3).join(" | ")}`);
      }
      return "no console error across every journey (network 4xx/5xx excluded)";
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (results.length === 0 || results.every((entry) => entry.passed)) {
      record("BOOT", false, `oracle could not run: ${message}`);
    } else {
      record("BOOT", false, `oracle aborted: ${message}`);
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    mockProcess?.kill();
    previewProcess?.kill();
    rmSync(tempRoot, { recursive: true, force: true });
  }

  const mustFailed = results.filter((entry) => entry.must && !entry.passed);
  console.log(
    `F1 oracle: ${results.filter((entry) => entry.passed).length}/${results.length} passed` +
      ` (must failed: ${mustFailed.length})`
  );
  console.log(`F1_RESULTS_JSON:${JSON.stringify({ fixture: "F1", workspace, results })}`);
  process.exitCode = mustFailed.length === 0 ? 0 : 1;
}

await main();
