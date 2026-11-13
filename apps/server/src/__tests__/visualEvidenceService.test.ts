import { createRealPlaywright, type PlaywrightLike } from "@ai-se/browser";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VisualEvidenceService,
  compareVisualEvidence,
  isUiDeliverable,
  resolveEntryPage
} from "../services/visualEvidenceService";

/**
 * 功能清点 T3：UI 交付物截图证据。
 *
 * 最后一条用例用**真实 Chromium** 打开一个临时页面并截图——这是本阶段唯一
 * 「真能证明它在生产里做得出证据」的断言；其余用例只验边界与失败语义，
 * 用一个会抛错的 playwright 桩就够了（它们在碰浏览器之前就返回了）。
 */

const throwingPlaywright = {
  chromium: {
    launch: async () => {
      throw new Error("chromium must not be touched in this case");
    }
  }
} as unknown as PlaywrightLike;

const workspaces: string[] = [];

async function tempWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-se-visual-"));
  workspaces.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return dir;
}

afterEach(async () => {
  for (const dir of workspaces.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("isUiDeliverable", () => {
  it("页面、组件与样式都算 UI 交付物", () => {
    for (const path of ["a/index.html", "b/App.vue", "c/App.tsx", "d/app.jsx", "e/main.css"]) {
      expect(isUiDeliverable(path), path).toBe(true);
    }
  });

  it("服务端代码与文档不算", () => {
    for (const path of ["src/server.ts", "README.md", "package.json", "a.scss.txt"]) {
      expect(isUiDeliverable(path), path).toBe(false);
    }
  });
});

describe("resolveEntryPage", () => {
  it("工作区根的 index.html 优先于其它页面", () => {
    const entry = resolveEntryPage("/ws", ["docs/preview.html", "index.html"]);
    expect(entry).toBe("/ws/index.html");
  });

  it("没有根 index 时取本任务写出的第一个 .html", () => {
    expect(resolveEntryPage("/ws", ["src/App.vue", "site/page.html"])).toBe("/ws/site/page.html");
  });

  it("只有组件文件时没有入口页（组件渲染不出页面）", () => {
    expect(resolveEntryPage("/ws", ["src/App.vue", "src/main.css"])).toBeUndefined();
  });
});

describe("VisualEvidenceService.capture 的失败语义", () => {
  it("任务没写 UI 文件 ⇒ no-ui-deliverable，且完全不碰浏览器", async () => {
    const service = new VisualEvidenceService({ playwright: throwingPlaywright });
    const outcome = await service.capture({
      workspacePath: "/ws",
      writtenPaths: ["src/server.ts", "README.md"]
    });
    expect(outcome).toEqual({ status: "unavailable", reason: "no-ui-deliverable" });
  });

  it("写了组件但没有入口页 ⇒ no-entry-page", async () => {
    const service = new VisualEvidenceService({ playwright: throwingPlaywright });
    const outcome = await service.capture({
      workspacePath: "/ws",
      writtenPaths: ["src/App.vue"]
    });
    expect(outcome).toEqual({ status: "unavailable", reason: "no-entry-page" });
  });

  it("浏览器起不来 ⇒ browser-failed，带可读原因而不是抛异常", async () => {
    const service = new VisualEvidenceService({ playwright: throwingPlaywright });
    const outcome = await service.capture({
      workspacePath: "/ws",
      writtenPaths: ["index.html"]
    });
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.reason).toBe("browser-failed");
      // BrowserSession 把底层失败包成 BrowserError，原始 detail 不外泄。
      expect(outcome.detail).toContain("chromium launch failed");
    }
  });
});

describe("compareVisualEvidence（基线回归）", () => {
  const base = { consoleErrors: 0, networkErrors: 0, settled: "networkidle" as const, bytes: 40_000 };

  it("各项持平或变好都不算回归", () => {
    expect(compareVisualEvidence(base, { ...base }).regressed).toBe(false);
    expect(
      compareVisualEvidence(
        { ...base, consoleErrors: 3, networkErrors: 2 },
        { ...base, consoleErrors: 1, networkErrors: 0 }
      ).regressed
    ).toBe(false);
  });

  it("控制台错误变多 ⇒ console-errors-increased", () => {
    const result = compareVisualEvidence(base, { ...base, consoleErrors: 1 });
    expect(result.regressed).toBe(true);
    expect(result.signals).toEqual(["console-errors-increased"]);
  });

  it("网络错误变多 ⇒ network-errors-increased", () => {
    const result = compareVisualEvidence(base, { ...base, networkErrors: 2 });
    expect(result.signals).toEqual(["network-errors-increased"]);
  });

  it("渲染从收敛变成超时 ⇒ render-no-longer-settles", () => {
    const result = compareVisualEvidence(base, { ...base, settled: "timeout" });
    expect(result.signals).toEqual(["render-no-longer-settles"]);
  });

  it("基线本来就超时、候选仍超时 ⇒ 不算新回归（不重复报同一个问题）", () => {
    const result = compareVisualEvidence(
      { ...base, settled: "timeout" },
      { ...base, settled: "timeout" }
    );
    expect(result.regressed).toBe(false);
  });

  it("空截图 ⇒ screenshot-empty，且与其他信号并列", () => {
    const result = compareVisualEvidence(base, { ...base, bytes: 0, consoleErrors: 1 });
    expect(result.signals).toEqual(["screenshot-empty", "console-errors-increased"]);
  });
});

describe("VisualEvidenceService.capture（真实 Chromium）", () => {
  it("渲染临时页面并截出非空 PNG，记录渲染是否稳定", async () => {
    const workspacePath = await tempWorkspace({
      "index.html": "<!doctype html><html><body><h1>证据</h1><script>document.title='ok'</script></body></html>"
    });
    const service = new VisualEvidenceService({
      playwright: createRealPlaywright(),
      viewport: { width: 800, height: 600 }
    });

    const outcome = await service.capture({ workspacePath, writtenPaths: ["index.html"] });

    expect(outcome.status).toBe("captured");
    if (outcome.status !== "captured") return;
    expect(outcome.entry).toBe(join(workspacePath, "index.html"));
    expect(outcome.bytes).toBeGreaterThan(0);
    expect(outcome.storedBytes).toBe(true);
    expect(outcome.base64.startsWith("iVBORw0KGgo")).toBe(true);
    expect(outcome.viewport).toEqual({ width: 800, height: 600 });
    expect(["networkidle", "timeout"]).toContain(outcome.settled);
  }, 60_000);
});
