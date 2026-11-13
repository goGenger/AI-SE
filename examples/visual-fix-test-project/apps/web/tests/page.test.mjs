/**
 * Sanity test (NOT the quality gate — Visual Evaluation is): the page module
 * must export a render* function that returns non-empty HTML in every fix
 * state, so build/test stay green while the loop iterates.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("fixture page module renders non-empty HTML", async () => {
  const module = await import(
    pathToFileURL(path.join(root, "src/pages/fixture-page.js")).href
  );
  const name = Object.keys(module).find(
    (key) => typeof module[key] === "function" && /^render[A-Za-z0-9]*$/.test(key)
  );
  assert.ok(name, "page must export a render* function");
  const html = module[name]();
  assert.equal(typeof html, "string");
  assert.ok(html.trim().length > 0, "render must return non-empty HTML");
});

test("design reference body exists for the visual target", async () => {
  const { readFile } = await import("node:fs/promises");
  const body = await readFile(path.join(root, "reference/design.body.html"), "utf8");
  // Section palette: Header band + Body band.
  assert.ok(body.includes("#112233"));
  assert.ok(body.includes("#445566"));
});
