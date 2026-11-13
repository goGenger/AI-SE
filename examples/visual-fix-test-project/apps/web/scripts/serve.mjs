/**
 * Fixture dev server (zero dependencies, plain Node):
 *   GET /                → renders the LIVE page module (cache-busted import)
 *   GET /reference.html  → the design reference body, same document shell
 *   GET /favicon.ico     → 200
 *
 * The document shell is shared so a page module that renders exactly the
 * reference body produces a byte-identical document (deterministic
 * analysis/evaluation downstream).
 */
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageFile = path.join(root, "src/pages/fixture-page.js");
const referenceFile = path.join(root, "reference/design.body.html");

const shell = (body) =>
  `<html><head><title>Fixture Page</title><style>body{margin:0}</style></head><body>${body}</body></html>`;

async function renderLivePage() {
  const info = await stat(pageFile);
  // Cache-bust per mtime so the latest on-disk module renders.
  const module = await import(`${pathToFileURL(pageFile).href}?v=${info.mtimeMs}`);
  const name = Object.keys(module).find(
    (key) => typeof module[key] === "function" && /^render[A-Za-z0-9]*$/.test(key)
  );
  if (!name) throw new Error("no render* export in fixture-page.js");
  return module[name]();
}

function readReferenceBody() {
  return readFile(referenceFile, "utf8");
}

const server = createServer((request, response) => {
  const url = request.url ?? "/";
  void (async () => {
    let status = 200;
    let contentType = "text/html; charset=utf-8";
    let body = "";
    if (url === "/" || url === "/index.html") {
      body = shell(await renderLivePage());
    } else if (url === "/reference.html") {
      body = shell(await readReferenceBody());
    } else if (url === "/favicon.ico") {
      body = "";
      contentType = "image/x-icon";
    } else {
      status = 404;
      contentType = "text/plain";
      body = "not found";
    }
    response.writeHead(status, { "content-type": contentType });
    response.end(body);
  })().catch((error) => {
    console.error("fixture server error:", error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(String(error));
    } else {
      response.destroy();
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(`PORT=${address.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
