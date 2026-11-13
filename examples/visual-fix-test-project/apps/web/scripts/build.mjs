/**
 * Fixture build check: the page module must import cleanly and render a
 * non-empty HTML string. Deliberately minimal — the visual fix loop's real
 * quality gate is Visual Evaluation, not this sanity check.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pagesDir = path.join(root, "src/pages");

function renderExport(module) {
  const name = Object.keys(module).find(
    (key) => typeof module[key] === "function" && /^render[A-Za-z0-9]*$/.test(key)
  );
  if (!name) throw new Error("no render* export found");
  const html = module[name]();
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new Error(`${name}() returned an empty render`);
  }
  return html;
}

const pages = readdirSync(pagesDir).filter((file) => file.endsWith(".js"));
if (pages.length === 0) throw new Error("no page modules found");

for (const file of pages.sort()) {
  const module = await import(pathToFileURL(path.join(pagesDir, file)).href);
  const html = renderExport(module);
  console.log(`page ok: ${file} (${html.length} chars)`);
}

console.log(`build ok (${pages.length} pages)`);
