import { exec } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  buildUiSmokeCommand,
  evaluateUiSmoke,
  extractContractTestIds,
  extractTestIds,
  parseUiSmokeOutput,
  staticTestIds,
  uiTestIdSkipReason,
  type UiSmokeResult
} from "../services/uiSmoke";

/**
 * `docs/233` §5.2 / `docs/235` §6 第 3 步：**UI 边界冒烟**。
 *
 * 判据只有一条——AC 点名的元素在不在**渲染后**的页面上。它补的是逐任务门看不见的那一块：
 * 一个 SPA 可以 `build` 过、`lint` 过、单测全绿而页面白屏。
 */

function uiResult(overrides: Partial<UiSmokeResult> = {}): UiSmokeResult {
  return {
    booted: true,
    exited: false,
    exitCode: null,
    signal: null,
    pageStatus: 200,
    browser: "playwright",
    browserError: null,
    present: [],
    consoleErrors: [],
    stderrTail: "",
    ...overrides
  };
}

describe("extractTestIds：只认 AC 文本点名的 data-testid", () => {
  it("三种写法都收，并按名字去重", () => {
    const ids = extractTestIds([
      '列表项携带 data-testid="todo-item"',
      "空态提示 [data-testid='todo-empty']",
      "点击 data-testid=todo-add 后新增",
      "再次提到 data-testid=\"todo-item\" 不应重复"
    ]);
    expect(ids.map((entry) => entry.name)).toEqual(["todo-item", "todo-empty", "todo-add"]);
    expect(ids.every((entry) => !entry.dynamic)).toBe(true);
  });

  it("运行期拼出来的 testid 归为动态（不能当静态元素判定）", () => {
    const ids = extractTestIds(['每行 data-testid="todo-${id}"', '另一处 data-testid="row-{id}"']);
    expect(ids).toEqual([
      { name: "todo-${id}", dynamic: true },
      { name: "row-{id}", dynamic: true }
    ]);
  });

  it("文本里没写 testid 时返回空数组——不猜", () => {
    expect(extractTestIds(["页面显示待办列表", "列表项可勾选"])).toEqual([]);
    expect(extractTestIds([])).toEqual([]);
  });

  it("散文里的示例串不算 testid（非 ASCII 名字被拒）", () => {
    // 实测来源：F1 的需求文档写过「写成 `data-testid="名字"` 的形式」，提取器当场把 `名字`
    // 当成了一个必须存在的元素；放进判定就会造出一次假的 SURFACE_MISSING。
    expect(extractTestIds(['一律写成 data-testid="名字" 的形式'])).toEqual([]);
    expect(extractTestIds(['每个 data-testid="todo-item" 都要有'])).toEqual([
      { name: "todo-item", dynamic: false }
    ]);
  });

  it("数量上限：探测成本与证据体积的折中", () => {
    const text = Array.from({ length: 20 }, (_, index) => `data-testid="item-${index}"`).join(" ");
    expect(extractTestIds([text])).toHaveLength(8);
  });
});

describe("uiTestIdSkipReason：跳过原因与判定同源", () => {
  it("没有 testid → NO_TESTIDS；只有动态 → ONLY_DYNAMIC_TESTIDS；有静态 → 不跳过", () => {
    expect(uiTestIdSkipReason([])).toBe("NO_TESTIDS");
    expect(uiTestIdSkipReason([{ name: "row-{id}", dynamic: true }])).toBe("ONLY_DYNAMIC_TESTIDS");
    expect(
      uiTestIdSkipReason([
        { name: "row-{id}", dynamic: true },
        { name: "todo-list", dynamic: false }
      ])
    ).toBeNull();
  });

  it("staticTestIds 去重保序", () => {
    expect(
      staticTestIds([
        { name: "b", dynamic: false },
        { name: "a", dynamic: false },
        { name: "b", dynamic: false },
        { name: "x-{id}", dynamic: true }
      ])
    ).toEqual(["b", "a"]);
  });
});

describe("evaluateUiSmoke：判定表（docs/233 §5.2）", () => {
  const ids = [{ name: "todo-item", dynamic: false }];

  it("元素挂上了且控制台干净 → 通过", () => {
    expect(evaluateUiSmoke(uiResult({ present: ["todo-item"] }), ids)).toEqual({
      kind: "passed",
      present: ["todo-item"]
    });
  });

  it("页面 200 但点名的元素一个都不在 → SURFACE_MISSING（N-49 的 UI 版形状）", () => {
    const verdict = evaluateUiSmoke(uiResult({ present: ["something-else"] }), ids);
    expect(verdict.kind).toBe("failed");
    if (verdict.kind !== "failed") return;
    expect(verdict.failureCode).toBe("SURFACE_MISSING");
    expect(verdict.detail).toContain("todo-item");
  });

  it("起不来且不是环境问题 → PAGE_UNREACHABLE", () => {
    const verdict = evaluateUiSmoke(uiResult({ booted: false, pageStatus: null }), ids);
    expect(verdict.kind).toBe("failed");
    if (verdict.kind !== "failed") return;
    expect(verdict.failureCode).toBe("PAGE_UNREACHABLE");
  });

  it("缺依赖/无网导致的启动失败 → 跳过留痕，不判交付缺陷", () => {
    const verdict = evaluateUiSmoke(
      uiResult({ booted: false, pageStatus: null, stderrTail: "Error: Cannot find module 'vite'" }),
      ids
    );
    expect(verdict).toEqual({ kind: "skipped", reason: "BOOT_ENV_UNRESOLVED" });
  });

  it("进程起来了但首页 404/500 → PAGE_UNREACHABLE（不是 SURFACE_MISSING）", () => {
    const verdict = evaluateUiSmoke(uiResult({ pageStatus: 500 }), ids);
    expect(verdict.kind).toBe("failed");
    if (verdict.kind !== "failed") return;
    expect(verdict.failureCode).toBe("PAGE_UNREACHABLE");
  });

  it("**没有浏览器时必须跳过，不能读成「元素不在」**", () => {
    // 这一条是假阴性的防线：镜像里没有 playwright 时，`present` 恒为空。
    const verdict = evaluateUiSmoke(uiResult({ browser: "unavailable", present: [] }), ids);
    expect(verdict).toEqual({ kind: "skipped", reason: "BROWSER_UNAVAILABLE" });
  });

  it("元素挂上了但控制台有 error → CONSOLE_ERROR（可配置是否致命）", () => {
    const failed = evaluateUiSmoke(
      uiResult({ present: ["todo-item"], consoleErrors: ["Uncaught TypeError: x is undefined"] }),
      ids
    );
    expect(failed.kind).toBe("failed");
    if (failed.kind !== "failed") return;
    expect(failed.failureCode).toBe("CONSOLE_ERROR");
    expect(
      evaluateUiSmoke(
        uiResult({ present: ["todo-item"], consoleErrors: ["boom"] }),
        ids,
        { consoleErrorsFatal: false }
      )
    ).toEqual({ kind: "passed", present: ["todo-item"] });
  });

  it("SURFACE_MISSING 先于 CONSOLE_ERROR：报错只是症状", () => {
    const verdict = evaluateUiSmoke(uiResult({ consoleErrors: ["boom"] }), ids);
    expect(verdict.kind).toBe("failed");
    if (verdict.kind !== "failed") return;
    expect(verdict.failureCode).toBe("SURFACE_MISSING");
  });

  it("AC 没点名 testid / 只点名动态 testid → 跳过并留痕", () => {
    expect(evaluateUiSmoke(uiResult(), [])).toEqual({ kind: "skipped", reason: "NO_TESTIDS" });
    expect(evaluateUiSmoke(uiResult(), [{ name: "row-{id}", dynamic: true }])).toEqual({
      kind: "skipped",
      reason: "ONLY_DYNAMIC_TESTIDS"
    });
  });
});

describe("parseUiSmokeOutput", () => {
  it("取最后一行可解析的 JSON（预览日志不污染结论）", () => {
    const stdout = [
      "VITE v8.2.2  ready in 120 ms",
      "Local: http://127.0.0.1:4173/",
      JSON.stringify({ booted: true, pageStatus: 200, browser: "playwright", present: ["a"] })
    ].join("\n");
    expect(parseUiSmokeOutput(stdout)?.present).toEqual(["a"]);
  });

  it("没有结论行 → null（调用方记 PROBE_ERROR 跳过）", () => {
    expect(parseUiSmokeOutput("Local: http://127.0.0.1:4173/")).toBeNull();
    expect(parseUiSmokeOutput("")).toBeNull();
  });
});

// ── 真实进程 + 真浏览器（AGENTS §7：核心链路需真实验证） ──────────────────────

function chromiumAvailable(): boolean {
  const cacheRoot = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(cacheRoot)) return false;
  return (
    existsSync(`${cacheRoot}/chromium_headless_shell-1228`) || existsSync(`${cacheRoot}/chromium-1228`)
  );
}

/** 探测程序从**工作区**解析 playwright（生产里 F1 夹具自带这个依赖）。 */
const PLAYWRIGHT_MODULES = resolve(process.cwd(), "../../packages/browser/node_modules");

function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

function run(command: string, cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // **清掉 `NODE_PATH`**：vitest 会把它指向仓库的 node_modules，子进程会因此"意外"解析到
    // playwright——而生产沙箱没有这个变量。探测必须只从**工作区**解析（F1 夹具自带该依赖）。
    const env = { ...process.env, NODE_PATH: "" };
    exec(command, { cwd, timeout: 90_000, maxBuffer: 4 * 1024 * 1024, env }, (error, stdout) => {
      if (error) {
        reject(new Error(`${error.message}\nstdout: ${stdout}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

const PAGE_SERVER = [
  "const http = require('node:http');",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const server = http.createServer((req, res) => {",
  "  const file = path.join(__dirname, 'index.html');",
  "  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }",
  "  res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});",
  "  res.end(fs.readFileSync(file));",
  "});",
  "server.listen(Number(process.env.PORT), '127.0.0.1');"
].join("\n");

function makeProject(html: string, options: { withPlaywright: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-se-ui-smoke-"));
  writeFileSync(join(dir, "server.js"), PAGE_SERVER);
  writeFileSync(join(dir, "index.html"), html);
  if (options.withPlaywright) {
    symlinkSync(PLAYWRIGHT_MODULES, join(dir, "node_modules"), "dir");
  }
  return dir;
}

async function probe(html: string, ids: string[], withPlaywright = true) {
  const dir = makeProject(html, { withPlaywright });
  const command = buildUiSmokeCommand({
    startCommand: "node server.js",
    port: await freePort(),
    testIds: ids,
    bootTimeoutMs: 15_000,
    probeTimeoutMs: 8_000,
    settleMs: 300
  });
  const result = parseUiSmokeOutput(await run(command, dir));
  expect(result).not.toBeNull();
  return result as UiSmokeResult;
}

const BROWSER_AVAILABLE = chromiumAvailable() && existsSync(PLAYWRIGHT_MODULES);

describe("真实预览 + 真浏览器（docs/233 §6.2 的 mutant 反向）", () => {
  const ids = [{ name: "todo-item", dynamic: false }];

  it.skipIf(!BROWSER_AVAILABLE)("元素由脚本渲染出来 → 通过（证明断言的是 DOM，不是 HTML 文本）", async () => {
    // 关键设计：testid **不在** index.html 里，由脚本注入。任何「抓 HTML 找字符串」的偷懒实现都会失败。
    const html = [
      "<!doctype html><html><body><div id='root'></div>",
      "<script>document.getElementById('root').innerHTML =",
      "'<ul><li data-testid=\"todo-item\">buy milk</li></ul>'</script>",
      "</body></html>"
    ].join("");
    const result = await probe(html, ["todo-item"]);
    expect(result.browser).toBe("playwright");
    expect(result.pageStatus).toBe(200);
    expect(evaluateUiSmoke(result, ids)).toEqual({ kind: "passed", present: ["todo-item"] });
  });

  it.skipIf(!BROWSER_AVAILABLE)("empty-shell 变体：页面起得来但什么都没渲染 → SURFACE_MISSING", async () => {
    const html = "<!doctype html><html><body><div id='root'></div><script>void 0</script></body></html>";
    const result = await probe(html, ["todo-item"]);
    const verdict = evaluateUiSmoke(result, ids);
    expect(verdict.kind).toBe("failed");
    if (verdict.kind !== "failed") return;
    expect(verdict.failureCode).toBe("SURFACE_MISSING");
  });

  it.skipIf(!BROWSER_AVAILABLE)("控制台报错但元素在 → CONSOLE_ERROR", async () => {
    const html = [
      "<!doctype html><html><body><div data-testid='todo-item'>x</div>",
      "<script>console.error('boom from the app')</script>",
      "</body></html>"
    ].join("");
    const result = await probe(html, ["todo-item"]);
    expect(result.consoleErrors.length).toBeGreaterThan(0);
    const verdict = evaluateUiSmoke(result, ids);
    expect(verdict.kind).toBe("failed");
    if (verdict.kind !== "failed") return;
    expect(verdict.failureCode).toBe("CONSOLE_ERROR");
  });

  it.skipIf(!BROWSER_AVAILABLE)("网络失败日志不算应用错误（与 oracle 的 AC-20 同口径）", async () => {
    // 不排除的话，「列表请求失败但页面正常降级」的应用会被这道门误判成缺陷。
    const html = [
      "<!doctype html><html><body><div data-testid='todo-item'>x</div>",
      "<script>console.error('Failed to load resource: the server responded with a status of 500')</script>",
      "</body></html>"
    ].join("");
    const result = await probe(html, ["todo-item"]);
    expect(result.consoleErrors).toEqual([]);
    expect(evaluateUiSmoke(result, ids)).toEqual({ kind: "passed", present: ["todo-item"] });
  });

  it("工作区里没有 playwright → BROWSER_UNAVAILABLE 跳过（不判交付缺陷）", async () => {
    const html = "<!doctype html><html><body><div data-testid='todo-item'>x</div></body></html>";
    const result = await probe(html, ["todo-item"], false);
    expect(result.booted).toBe(true);
    expect(result.browser).toBe("unavailable");
    expect(evaluateUiSmoke(result, ids)).toEqual({ kind: "skipped", reason: "BROWSER_UNAVAILABLE" });
  });
});

/**
 * N-64（`docs/232` §10）：**需求原文里的 testid 命名契约**。
 *
 * 起因：F1 第四轮，`task-title-input` 只出现在 PRD 第四节的定值表里（`| \`task-title-input\` | … |`），
 * **没有任何一条 AC 点名过它**。`extractTestIds` 只认 `data-testid="x"` 写法 ⇒ 冒烟判据看不见它
 * ⇒ agent 写成 `new-task-title`，AC-07/08/09/10 四条 Must 全失败。
 */
describe("extractContractTestIds：从需求原文取命名契约", () => {
  const PRD = [
    "## 四、UI 契约：testid 命名（硬性）",
    "",
    "| testid | 用途 |",
    "| --- | --- |",
    "| `app-title` | 页面标题 |",
    "| `filter-all` / `filter-active` / `filter-done` | 三个筛选按钮 |",
    "| `task-title-input` | 新建对话框里的标题输入框 |",
    "",
    "## 五、功能需求与验收标准",
    "",
    "| 编号 | 验收标准 | 优先级 |",
    "| --- | --- | --- |",
    "| AC-06 | 点击 `data-testid=\"new-task-button\"` 打开对话框 | Must |"
  ].join("\n");

  it("表格首列的反引号名字入契约，`/` 分隔的多个名字拆开", () => {
    expect(extractContractTestIds(PRD)).toEqual([
      "app-title",
      "filter-all",
      "filter-active",
      "filter-done",
      "task-title-input",
      "new-task-button"
    ]);
  });

  it("**只要**表格首列的反引号名——AC 表格里的裸 `AC-06` 不是 testid", () => {
    expect(extractContractTestIds(PRD)).not.toContain("AC-06");
  });

  it("正文里以 `data-testid=` 点名的名字同样入契约（与 AC 冒烟同源）", () => {
    expect(extractContractTestIds(PRD)).toContain("new-task-button");
  });

  it("既没有命名表也没点名 testid ⇒ 空数组（调用方据此跳过，不判缺陷）", () => {
    expect(extractContractTestIds("## 一、目标\n\n做一个任务看板。")).toEqual([]);
  });

  it("散文里的示例串不算（`data-testid=\"名字\"` 的非 ASCII 值被既有规则拒掉）", () => {
    expect(extractContractTestIds("一律写成 data-testid=\"名字\" 的形式")).toEqual([]);
  });

  it("去重且保序", () => {
    const text = "| `a-b` | x |\n| `a-b` | y |\n| `c-d` | z |";
    expect(extractContractTestIds(text)).toEqual(["a-b", "c-d"]);
  });
});

/**
 * N-71（`docs/232` §10）：**起 mock 再探页面**。
 *
 * 生产事故的形状：`ui-smoke` 只起 `vite preview`，不启动 mock API ⇒ 应用首屏必然进错误态 ⇒
 * 列表项 testid 永远不在 ⇒ 只点名列表项的任务被判 `SURFACE_MISSING`（参考实现同样过不了）。
 *
 * 这条集成用例把整条链走一遍：用 `VITE_API_BASE` **重建**（模拟 Vite 的构建期内联）→ 起 mock →
 * 起页面 → 页面从 mock 取到数据并渲染出 `task-item`。没有 mock 这一步时，页面拿不到数据。
 */
const MOCK_SERVER = [
  "const http = require('node:http');",
  "const server = http.createServer((req, res) => {",
  "  const body = JSON.stringify({ tasks: [{ id: 't-1' }, { id: 't-2' }] });",
  "  res.writeHead(req.url === '/api/tasks' ? 200 : 404, {",
  "    'content-type': 'application/json; charset=utf-8',",
  "    'access-control-allow-origin': '*'",
  "  });",
  "  res.end(body);",
  "});",
  "server.listen(Number(process.env.PORT), '127.0.0.1');"
].join("\n");

const BUILD_SCRIPT = [
  "const fs = require('node:fs');",
  "const base = process.env.VITE_API_BASE || '';",
  "const body =",
  "  '<div id=\"root\"></div><script>' +",
  "  'fetch(\"' + base + '/api/tasks\").then(r => r.json()).then(d => {' +",
  "  '  document.getElementById(\"root\").innerHTML = d.tasks' +",
  "  '    .map(t => \"<li data-testid=\\\\\"task-item\\\\\">\" + t.id + \"</li>\").join(\"\");' +",
  "  '});' +",
  "  '</script>';",
  "fs.writeFileSync(__dirname + '/index.html', '<!doctype html><body>' + body + '</body>');"
].join("\n");

describe("N-71：mock 与重建", () => {
  it("命令里带上 mock / 构建命令与 mock 端口", () => {
    const command = buildUiSmokeCommand({
      startCommand: "npm run start",
      port: 47001,
      testIds: ["task-item"],
      bootTimeoutMs: 15_000,
      probeTimeoutMs: 8_000,
      settleMs: 300,
      mockCommand: "npm run mock",
      mockPort: 50001,
      buildCommand: "npm run build"
    });
    expect(command).toContain("'npm run mock'");
    expect(command).toContain("'50001'");
    expect(command).toContain("'npm run build'");
    expect(command).toContain("VITE_API_BASE");
    expect(command).toContain("mockBooted");
  });

  it("没有 mock 脚本时三个参数为空（行为与改动前一致）", () => {
    const command = buildUiSmokeCommand({
      startCommand: "npm run start",
      port: 47001,
      testIds: ["task-item"],
      bootTimeoutMs: 15_000,
      probeTimeoutMs: 8_000,
      settleMs: 300
    });
    // 末尾三个参数依次是 mockCommand / mockPort / buildCommand。
    expect(command.endsWith("'' '0' ''")).toBe(true);
  });

  it.skipIf(!BROWSER_AVAILABLE)(
    "起 mock + 按 mock 端口重建 → 页面从 mock 取数并渲染出列表项",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "ai-se-ui-smoke-mock-"));
      writeFileSync(join(dir, "server.js"), PAGE_SERVER);
      writeFileSync(join(dir, "mock.js"), MOCK_SERVER);
      writeFileSync(join(dir, "build.js"), BUILD_SCRIPT);
      symlinkSync(PLAYWRIGHT_MODULES, join(dir, "node_modules"), "dir");

      const command = buildUiSmokeCommand({
        startCommand: "node server.js",
        port: await freePort(),
        testIds: ["task-item"],
        bootTimeoutMs: 15_000,
        probeTimeoutMs: 8_000,
        settleMs: 800,
        mockCommand: "node mock.js",
        mockPort: await freePort(),
        buildCommand: "node build.js"
      });

      const result = parseUiSmokeOutput(await run(command, dir));
      expect(result).not.toBeNull();
      expect(result?.mockBooted).toBe(true);
      expect(result?.buildExitCode).toBe(0);
      expect(result?.present).toContain("task-item");
    }
  );
});
