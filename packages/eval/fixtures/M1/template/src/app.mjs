import { createServer } from "node:http";

function send(response, status, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

export function createApp(store) {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/todos") {
      send(response, 200, { items: store.list() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/todos") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        try {
          const parsed = JSON.parse(body === "" ? "{}" : body);
          send(response, 201, store.add(String(parsed.title ?? "")));
        } catch {
          send(response, 400, { error: "invalid json" });
        }
      });
      return;
    }

    send(response, 404, { error: "not found" });
  });
}
