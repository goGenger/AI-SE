import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const healthy = readFileSync("health-status.txt", "utf8").trim() === "healthy";

createServer((request, response) => {
  if (request.url === "/health" || request.url === "/ready") {
    response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: healthy ? "ok" : "error" }));
    return;
  }
  response.writeHead(404).end();
}).listen(3000, "0.0.0.0");
