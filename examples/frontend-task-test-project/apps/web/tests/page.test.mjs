/**
 * Fixture acceptance test for the "Fixture Page" visual task.
 *
 * This is the project's own quality bar: it fails until a page module exists
 * at src/pages/fixture-page.js that implements the visual task with the
 * project's components, tokens and assets. The frontend agent must make this
 * pass; it must not edit this file.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageFile = path.join(root, "src/pages/fixture-page.js");

async function loadPage() {
  const module = await import(pathToFileURL(pageFile).href);
  const name = Object.keys(module).find(
    (key) => typeof module[key] === "function" && /^render[A-Za-z0-9]*$/.test(key)
  );
  assert.ok(name, "page must export a render* function");
  return module[name];
}

test("fixture page reuses the shared Button component", async () => {
  const render = await loadPage();
  assert.match(render(), /<button class="btn" type="button">/);
});

test("fixture page carries the section layout from the visual task", async () => {
  const render = await loadPage();
  const html = render();
  assert.match(html, /data-section-id="section:header:1"/);
  assert.match(html, /data-rect="0,0,1440,180"/);
  assert.match(html, /<h2>Header<\/h2>/);
});

test("fixture page uses design tokens as CSS custom properties", async () => {
  const source = readFileSync(pageFile, "utf8");
  for (const token of ["--colors-primary", "--typography-body", "--radii-card"]) {
    assert.ok(source.includes(`var(${token})`), `missing var(${token})`);
  }
  const tokens = readFileSync(path.join(root, "src/tokens.css"), "utf8");
  assert.match(tokens, /--colors-primary: #1533ff;/);
});

test("fixture page references the project asset for image elements", async () => {
  const source = readFileSync(pageFile, "utf8");
  assert.match(source, /src="\.\.\/assets\/logo\.svg"/);
  assert.match(source, /alt="avatar: image"/);
});

test("existing index page still renders", async () => {
  const module = await import(pathToFileURL(path.join(root, "src/pages/index.js")).href);
  assert.match(module.renderIndex(), /data-page="index"/);
});
