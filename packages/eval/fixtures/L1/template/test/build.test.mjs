import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSite } from "../src/build.mjs";
import { renderPage } from "../src/render.mjs";

test("renderPage 产出含标题的 HTML", () => {
  const html = renderPage({ title: "标题", body: "# 小节\n\n正文" });
  assert.match(html, /<title>标题<\/title>/);
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<h2>小节<\/h2>/);
  assert.match(html, /<p>正文<\/p>/);
});

test("buildSite 把 content 下的 md 生成 html", async () => {
  const contentDir = await mkdtemp(join(tmpdir(), "l1-content-"));
  const outDir = await mkdtemp(join(tmpdir(), "l1-out-"));
  await writeFile(join(contentDir, "a.md"), "---\ntitle: A\n---\n\n# A\n");
  const written = await buildSite(contentDir, outDir);
  assert.deepEqual(written, ["a.html"]);
  assert.match(await readFile(join(outDir, "a.html"), "utf8"), /<title>A<\/title>/);
});
