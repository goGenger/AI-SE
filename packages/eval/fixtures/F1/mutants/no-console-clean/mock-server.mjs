#!/usr/bin/env node
/**
 * F1 夹具的**契约 mock**（`docs/233` §3.1）。被测前端只通过 `VITE_API_BASE` 访问它；
 * 本文件是**输入契约的一部分**，被测代码不得修改它的行为，也不得新增后端。
 *
 * 为什么是独立进程而不是 MSW：service worker 在 `vite preview` 下多一层注册失败面，
 * 而独立进程更接近「真实契约」，且便于按 journey 注入延迟与错误（`docs/233` §4.3）。
 *
 * 端口读 `PORT`；初始延迟读 `MOCK_DELAY_MS`（默认 0）。
 *
 * 控制面（`/__mock/*`，**只给 oracle 用**，前端不得调用）：
 *   GET  /__mock/requests   → { requests: [{method, path, body}] }
 *   POST /__mock/reset      → 重置数据/日志/配置，body 可带 { tasks, delayMs, failNextList, failNextPost, failNextPatch }
 *   POST /__mock/config     → 局部合并同一组字段
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 47100);
const HOST = "127.0.0.1";

const DEFAULT_SEED = [
  { id: "task-alpha", title: "Alpha task", done: false },
  { id: "task-beta", title: "Beta task", done: true },
  { id: "task-gamma", title: "Gamma task", done: false }
];

let tasks = seed(DEFAULT_SEED);
let requests = [];
let config = {
  delayMs: Number(process.env.MOCK_DELAY_MS ?? 0),
  failNextList: false,
  failNextPost: false,
  failNextPatch: false
};

function seed(entries) {
  const now = Date.now();
  return entries.map((entry, index) => ({
    id: entry.id ?? randomUUID(),
    title: entry.title,
    done: entry.done === true,
    createdAt: entry.createdAt ?? new Date(now - index * 1000).toISOString()
  }));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function send(response, status, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store"
  });
  response.end(body);
}

function errorPayload(code) {
  return { error: { code, message: code } };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function nextFailure(flag) {
  if (!config[flag]) return false;
  config[flag] = false;
  return true;
}

async function handleApi(request, response, pathname, searchParams, entry) {
  if (config.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, config.delayMs));
  }

  if (pathname === "/api/tasks" && request.method === "GET") {
    if (searchParams.get("error") === "1" || nextFailure("failNextList")) {
      send(response, 500, errorPayload("INTERNAL"));
      return;
    }
    send(response, 200, { items: clone(tasks) });
    return;
  }

  if (pathname === "/api/tasks" && request.method === "POST") {
    const body = await readBody(request);
    entry.body = body;
    if (body === null) {
      send(response, 400, errorPayload("VALIDATION_ERROR"));
      return;
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title === "") {
      send(response, 400, errorPayload("TITLE_INVALID"));
      return;
    }
    if (nextFailure("failNextPost")) {
      send(response, 500, errorPayload("INTERNAL"));
      return;
    }
    const task = { id: randomUUID(), title, done: false, createdAt: new Date().toISOString() };
    tasks = [task, ...tasks];
    send(response, 201, { task: clone(task) });
    return;
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (taskMatch) {
    const id = decodeURIComponent(taskMatch[1] ?? "");
    const index = tasks.findIndex((entry) => entry.id === id);
    if (request.method === "DELETE") {
      if (index < 0) {
        send(response, 404, errorPayload("NOT_FOUND"));
        return;
      }
      tasks = tasks.filter((entry) => entry.id !== id);
      send(response, 204);
      return;
    }
    if (request.method === "PATCH") {
      const body = await readBody(request);
      entry.body = body;
      if (body === null) {
        send(response, 400, errorPayload("VALIDATION_ERROR"));
        return;
      }
      if (index < 0) {
        send(response, 404, errorPayload("NOT_FOUND"));
        return;
      }
      if (nextFailure("failNextPatch")) {
        send(response, 500, errorPayload("INTERNAL"));
        return;
      }
      const current = tasks[index];
      const updated = {
        ...current,
        title: typeof body.title === "string" ? body.title.trim() : current.title,
        done: typeof body.done === "boolean" ? body.done : current.done
      };
      tasks = tasks.map((entry, position) => (position === index ? updated : entry));
      send(response, 200, { task: clone(updated) });
      return;
    }
    send(response, 404, errorPayload("NOT_FOUND"));
    return;
  }

  send(response, 404, errorPayload("NOT_FOUND"));
}

async function handleControl(request, response, pathname) {
  if (pathname === "/__mock/requests" && request.method === "GET") {
    send(response, 200, { requests: clone(requests) });
    return;
  }
  if (pathname === "/__mock/reset" && request.method === "POST") {
    const body = (await readBody(request)) ?? {};
    tasks = seed(Array.isArray(body.tasks) ? body.tasks : DEFAULT_SEED);
    requests = [];
    config = {
      delayMs: typeof body.delayMs === "number" ? body.delayMs : 0,
      failNextList: body.failNextList === true,
      failNextPost: body.failNextPost === true,
      failNextPatch: body.failNextPatch === true
    };
    send(response, 200, { ok: true, tasks: clone(tasks) });
    return;
  }
  if (pathname === "/__mock/config" && request.method === "POST") {
    const body = (await readBody(request)) ?? {};
    if (typeof body.delayMs === "number") config.delayMs = body.delayMs;
    for (const flag of ["failNextList", "failNextPost", "failNextPatch"]) {
      if (typeof body[flag] === "boolean") config[flag] = body[flag];
    }
    send(response, 200, { ok: true, config: clone(config) });
    return;
  }
  send(response, 404, errorPayload("NOT_FOUND"));
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  if (request.method === "OPTIONS") {
    send(response, 204);
    return;
  }
  if (url.pathname.startsWith("/__mock/")) {
    handleControl(request, response, url.pathname).catch(() => send(response, 500, errorPayload("INTERNAL")));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    const entry = { method: request.method ?? "GET", path: url.pathname, body: null };
    requests.push(entry);
    handleApi(request, response, url.pathname, url.searchParams, entry).catch(() =>
      send(response, 500, errorPayload("INTERNAL"))
    );
    return;
  }
  send(response, 404, errorPayload("NOT_FOUND"));
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`mock listening on http://${HOST}:${PORT}\n`);
});
