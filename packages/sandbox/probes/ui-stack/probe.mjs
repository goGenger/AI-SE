#!/usr/bin/env node
/**
 * 探针（`docs/234` §5/§6）：
 *
 *   A3 预览可达      —— 起 preview、等端口、取首页（始终执行）
 *   A4 Tailwind 生效 —— 计算样式必须是 `rgb(18, 52, 86)` / `16px`（不带浏览器时跳过）
 *   A5 控制台干净    —— 页面加载与断言期间无 console error / pageerror（同上）
 *
 * 浏览器断言由 `PROBE_BROWSER=1` 启用：P1（无浏览器镜像）不加该变量即回到 A3-only，
 * 保证第 2 步的读数可复现。
 */
import { spawn } from "node:child_process";
import net from "node:net";

const PORT = Number(process.env.PORT ?? 4173);
const WANT_BROWSER = process.env.PROBE_BROWSER === "1";
const EXPECTED_COLOR = "rgb(18, 52, 86)";
const EXPECTED_PADDING = "16px";

const started = Date.now();
const result = {
  ok: false,
  preview: { status: null, ms: null },
  html: { bytes: 0, hasRoot: false, hasModuleScript: false },
  browser: null
};

const child = spawn("pnpm", ["preview"], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
  env: { ...process.env, PORT: String(PORT) }
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.stdout.on("data", () => {});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reachable(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // 忽略
      }
      resolve(value);
    };
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function cleanup() {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // 进程组已退出
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // 已退出
  }
}

function emitAndExit(payload, code) {
  console.log(JSON.stringify(payload));
  cleanup();
  process.exit(code);
}

async function runBrowserChecks() {
  const { chromium } = await import("playwright");
  const browserStarted = Date.now();
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const consoleErrors = [];
  try {
    const page = await browser.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(String(error && error.message)));

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
    const title = page.locator('[data-testid="probe-title"]');
    await title.waitFor({ state: "visible", timeout: 15_000 });
    const text = ((await title.textContent()) ?? "").trim();
    const styles = await title.evaluate((node) => {
      const computed = getComputedStyle(node);
      return { color: computed.color, paddingTop: computed.paddingTop };
    });

    const filteredErrors = consoleErrors.filter((entry) => !/favicon/i.test(entry));
    const checks = {
      launchMs: Date.now() - browserStarted,
      text,
      color: styles.color,
      paddingTop: styles.paddingTop,
      consoleErrors: filteredErrors.length
    };
    const ok =
      text !== "" &&
      styles.color === EXPECTED_COLOR &&
      styles.paddingTop === EXPECTED_PADDING &&
      filteredErrors.length === 0;
    return { browser: { ok, ...checks, errors: filteredErrors.slice(0, 5) } };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline) {
    if (await reachable(PORT)) {
      up = true;
      break;
    }
    if (child.exitCode !== null) break;
    await wait(200);
  }
  if (!up) {
    emitAndExit(
      { ...result, error: "PREVIEW_UNREACHABLE", stderrTail: stderr.slice(-800) },
      1
    );
  }

  const response = await fetch(`http://127.0.0.1:${PORT}/`);
  const html = await response.text();
  result.preview.status = response.status;
  result.preview.ms = Date.now() - started;
  result.html.bytes = Buffer.byteLength(html);
  result.html.hasRoot = html.includes('id="root"');
  result.html.hasModuleScript = /<script[^>]+type="module"/.test(html);
  const pageOk = response.status === 200 && result.html.hasRoot && result.html.hasModuleScript;

  if (!WANT_BROWSER) {
    result.ok = pageOk;
    emitAndExit(result, pageOk ? 0 : 1);
  }

  const browserResult = await runBrowserChecks();
  result.browser = browserResult.browser;
  result.ok = pageOk && browserResult.browser.ok;
  emitAndExit(result, result.ok ? 0 : 1);
}

main().catch((error) => {
  emitAndExit({ ...result, error: String((error && error.message) || error) }, 1);
});
