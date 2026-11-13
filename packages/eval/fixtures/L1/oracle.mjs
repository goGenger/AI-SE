import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
const { renderPage } = await import(pathToFileURL(join(workspace, "src/render.mjs")).href);
const { buildSite } = await import(pathToFileURL(join(workspace, "src/build.mjs")).href);

const html = renderPage({
  title: "T & <x>",
  body: "# H\n\nline one\nline two\n\nvisit [link](a?b=1&c=2)"
});
assert.match(html, /<title>T &amp; &lt;x&gt;<\/title>/, "标题转义");
assert.match(html, /<h1>T &amp; &lt;x&gt;<\/h1>/, "h1 转义");
assert.match(html, /<h2>H<\/h2>/, "h2 渲染");
assert.match(html, /<p>line one line two<\/p>/, "连续行合并成段落");
assert.match(html, /<a href="a\?b=1&amp;c=2">link<\/a>/, "链接渲染与属性转义");
assert.ok(!html.includes("<script"), "不应注入脚本");

const contentDir = await mkdtemp(join(tmpdir(), "l1-oracle-content-"));
const outDir = join(await mkdtemp(join(tmpdir(), "l1-oracle-out-")), "nested");
await writeFile(
  join(contentDir, "index.md"),
  "---\ntitle: 首页\n---\n\n# 欢迎\n\n请读 [关于](about.html)。\n"
);
await writeFile(join(contentDir, "about.md"), "---\ntitle: 关于\n---\n\n关于内容。\n");
const written = await buildSite(contentDir, outDir);
assert.deepEqual(written, ["about.html", "index.html"], "按文件名排序返回");
assert.match(
  await readFile(join(outDir, "index.html"), "utf8"),
  /<a href="about.html">关于<\/a>/,
  "index 内链接"
);
assert.match(
  await readFile(join(outDir, "about.html"), "utf8"),
  /<title>关于<\/title>/,
  "about 标题"
);

console.log("oracle L1: 全部断言通过");
