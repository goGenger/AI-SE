import { describe, expect, it } from "vitest";

/**
 * W9 — 可访问性的**静态契约**。
 *
 * 对比度、焦点环、键盘可操作性这些必须在真实浏览器里实测（见 docs/141 §5），
 * 这里只钉住那些「读源码就能判定、而且一旦回退没人会注意到」的项：
 * 文档语言、图标文件、以及 icon-only 按钮的可访问名称。
 *
 * 源码通过 Vite 的 `?raw` 读取（本仓库的测试环境是纯 Node，未装 @types/node，
 * 因此不用 `node:fs`）—— 与 `uiComponents.test.ts` 的页面扫描同一手法。
 */
function rawOnce(glob: Record<string, string>, label: string): string {
  const values = Object.values(glob);
  if (values.length !== 1) {
    throw new Error(`应恰好读到一份 ${label}，实得 ${values.length} 份`);
  }
  return values[0];
}

const indexHtml = rawOnce(
  import.meta.glob("/index.html", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >,
  "index.html"
);
const faviconSvg = rawOnce(
  import.meta.glob("/public/favicon.svg", {
    query: "?raw",
    import: "default",
    eager: true
  }) as Record<string, string>,
  "favicon.svg"
);
const viewSources = import.meta.glob("../views/*.vue", {
  query: "?raw",
  import: "default",
  eager: true
}) as Record<string, string>;
const componentSources = import.meta.glob("../components/**/*.vue", {
  query: "?raw",
  import: "default",
  eager: true
}) as Record<string, string>;

describe("W9 · index.html", () => {
  it("文档语言是 zh-CN（不是 en）", () => {
    expect(indexHtml).toMatch(/<html lang="zh-CN">/);
  });

  it("title 有意义且非空", () => {
    const match = indexHtml.match(/<title>([^<]*)<\/title>/);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? "").trim().length).toBeGreaterThan(0);
  });

  it("favicon 指向真实文件（不再是空的 data: URI）", () => {
    expect(indexHtml).not.toContain('href="data:,"');
    expect(indexHtml).toMatch(/<link rel="icon"[^>]*href="\/favicon\.svg"/);
  });

  it("favicon 文件存在且是 SVG", () => {
    expect(faviconSvg.startsWith("<svg")).toBe(true);
    expect(faviconSvg).toContain("viewBox");
  });

  it("声明 color-scheme（两套配色都支持）", () => {
    expect(indexHtml).toMatch(/name="color-scheme"[^>]*content="light dark"/);
  });
});

describe("W9 · icon-only 按钮的可访问名称", () => {
  /**
   * 「只有一枚图标、没有可见文字」的按钮必须有 `aria-label` 或 `title`，
   * 否则屏幕阅读器只会念出一个无意义的「按钮」。
   */
  function findIconOnly(entries: Record<string, string>): string[] {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(entries)) {
      const name = path.split("/").pop() ?? path;
      for (const match of source.matchAll(/<Button\b[^>]*\/>/g)) {
        const tag: string = match[0];
        if (!/size="icon"/.test(tag)) continue;
        if (/aria-label=|title=/.test(tag)) continue;
        offenders.push(`${name}: ${tag.replace(/\s+/g, " ").slice(0, 100)}`);
      }
    }
    return offenders;
  }

  it("views / components 里不存在没有名字的 icon-only 按钮", () => {
    expect(findIconOnly({ ...viewSources, ...componentSources })).toEqual([]);
  });

  it("扫描确实覆盖到了内容（防止 glob 失效导致空扫描）", () => {
    expect(Object.keys(viewSources).length).toBeGreaterThanOrEqual(11);
    expect(Object.keys(componentSources).length).toBeGreaterThanOrEqual(15);
  });

  it("已知的 icon-only 按钮都带 aria-label（抽样确认扫描有效）", () => {
    const sidebarEntry = Object.entries(componentSources).find(([path]) =>
      path.endsWith("AppSidebar.vue")
    );
    expect(sidebarEntry).toBeDefined();
    const blocks: string[] = (sidebarEntry?.[1] ?? "").match(/<button[\s\S]*?<\/button>/g) ?? [];
    expect(blocks.some((block) => /aria-label[^>]*(展开侧栏|收起侧栏)/.test(block))).toBe(true);
  });
});

describe("W9 · 状态徽标的三重冗余（源码级）", () => {
  it("StatusBadge 的六个 tone 各自映射到一枚图标，且图标是装饰性的", () => {
    const source = Object.entries(componentSources).find(([path]) =>
      path.endsWith("StatusBadge.vue")
    )?.[1];
    expect(source).toBeDefined();
    for (const tone of ["success", "running", "pending", "warning", "error", "neutral"]) {
      expect(source, `TONE_ICON 应含 ${tone}`).toMatch(new RegExp(`${tone}:\\s*\\w+`));
    }
    // 文字已经朗读过同样的信息，图标重复朗读是噪音
    expect(source).toContain('aria-hidden="true"');
  });
});
