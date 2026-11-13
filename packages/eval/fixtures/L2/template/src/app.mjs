import { createServer } from "node:http";

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(payload === undefined ? "" : JSON.stringify(payload));
}

export function createApp(store, options = {}) {
  const persist = options.persist ?? null;
  const save = async () => {
    if (persist) await persist(store);
  };

  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/items") {
      send(response, 200, { items: store.list() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/items") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", async () => {
        try {
          const parsed = JSON.parse(body === "" ? "{}" : body);
          const item = store.add(String(parsed.title ?? ""));
          await save();
          send(response, 201, item);
        } catch {
          send(response, 400, { error: "invalid json" });
        }
      });
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/items/")) {
      const id = Number(url.pathname.slice("/items/".length));
      const removed = store.remove(id);
      if (!removed) {
        send(response, 404, { error: "not found" });
        return;
      }
      save()
        .then(() => send(response, 204, undefined))
        .catch(() => send(response, 500, { error: "persist failed" }));
      return;
    }

    send(response, 404, { error: "not found" });
  });
}
