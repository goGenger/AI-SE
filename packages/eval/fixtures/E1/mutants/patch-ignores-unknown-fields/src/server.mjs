// TaskBoard 服务器：路由、JSON 封套、Bearer 令牌鉴权。
// 错误封套：{ "error": { "code", "message" } }；成功载荷为普通 JSON 对象。
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_RE,
  hashPassword,
  issueToken,
  loadTokenSecret,
  verifyPassword,
  verifyToken
} from "./auth.mjs";
import { HOME_HTML } from "./pages.mjs";
import { createStore } from "./store.mjs";
import {
  CREATE_TASK_FIELDS,
  PATCH_TASK_FIELDS,
  createTask,
  deleteTask,
  findUnknownField,
  getTask,
  listTasks,
  updateTask
} from "./tasks.mjs";

const port = Number(process.env.PORT ?? 3000);
const dataDir = process.env.DATA_DIR ?? "./data";
const store = createStore(dataDir);
const tokenSecret = loadTokenSecret(dataDir);
const AUTH_FIELDS = new Set(["username", "password"]);

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, code, message = code) {
  sendJson(res, status, { error: { code, message } });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function parseBody(raw) {
  return raw !== undefined && raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? raw
    : null;
}

async function readStrictBody(req, res, allowedFields) {
  const body = parseBody(await readJsonBody(req));
  if (!body) {
    sendError(res, 400, "VALIDATION_ERROR");
    return null;
  }
  if (findUnknownField(body, allowedFields)) {
    sendError(res, 400, "UNKNOWN_FIELD");
    return null;
  }
  return body;
}

function authenticate(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) {
    return null;
  }
  const payload = verifyToken(tokenSecret, match[1]);
  if (!payload) {
    return null;
  }
  return store.state.users.find((user) => user.id === payload.sub) ?? null;
}

async function handleRegister(req, res) {
  const body = await readStrictBody(req, res, AUTH_FIELDS);
  if (!body) {
    return;
  }
  const { username, password } = body;
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    sendError(res, 400, "VALIDATION_ERROR");
    return;
  }
  if (
    typeof password !== "string" ||
    password.length < PASSWORD_MIN ||
    password.length > PASSWORD_MAX
  ) {
    sendError(res, 400, "VALIDATION_ERROR");
    return;
  }
  const usernameLower = username.toLowerCase();
  if (store.state.users.some((user) => user.usernameLower === usernameLower)) {
    sendError(res, 409, "USERNAME_TAKEN");
    return;
  }
  const { salt, hash } = hashPassword(password);
  const user = {
    id: randomUUID(),
    username,
    usernameLower,
    salt,
    passwordHash: hash,
    createdAt: new Date().toISOString()
  };
  store.state.users.push(user);
  store.persist();
  sendJson(res, 201, { user: { id: user.id, username: user.username } });
}

async function handleLogin(req, res) {
  const body = await readStrictBody(req, res, AUTH_FIELDS);
  if (!body) {
    return;
  }
  const usernameLower = typeof body.username === "string" ? body.username.toLowerCase() : null;
  const user = usernameLower
    ? store.state.users.find((entry) => entry.usernameLower === usernameLower)
    : undefined;
  if (
    !user ||
    typeof body.password !== "string" ||
    !verifyPassword(body.password, user.salt, user.passwordHash)
  ) {
    sendError(res, 401, "INVALID_CREDENTIALS");
    return;
  }
  sendJson(res, 200, {
    token: issueToken(tokenSecret, user.id),
    user: { id: user.id, username: user.username }
  });
}

async function route(req, res) {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;

  if (req.method === "GET" && (path === "/healthz" || path === "/health" || path === "/ready")) {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HOME_HTML);
    return;
  }

  if (req.method === "POST" && path === "/api/register") {
    await handleRegister(req, res);
    return;
  }

  if (req.method === "POST" && path === "/api/login") {
    await handleLogin(req, res);
    return;
  }

  if (path === "/api/tasks" && req.method === "GET") {
    const user = authenticate(req);
    if (!user) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }
    sendJson(res, 200, { items: listTasks(store, user.id, url.searchParams.get("q")) });
    return;
  }

  if (path === "/api/tasks" && req.method === "POST") {
    const user = authenticate(req);
    if (!user) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }
    const body = await readStrictBody(req, res, CREATE_TASK_FIELDS);
    if (!body) {
      return;
    }
    const result = createTask(store, user.id, body);
    if (result.error) {
      sendError(res, result.error.status, result.error.code);
      return;
    }
    sendJson(res, 201, { task: result.task });
    return;
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
  if (taskMatch) {
    const user = authenticate(req);
    if (!user) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }
    const taskId = taskMatch[1];

    if (req.method === "GET") {
      const task = getTask(store, user.id, taskId);
      if (!task) {
        sendError(res, 404, "NOT_FOUND", "Not found");
        return;
      }
      sendJson(res, 200, { task });
      return;
    }

    if (req.method === "PATCH") {
      const body = parseBody(await readJsonBody(req));
      if (!body) {
        sendError(res, 400, "VALIDATION_ERROR");
        return;
      }
      const hasField = ["title", "dueDate", "done"].some((key) => key in body);
      if (!hasField) {
        sendError(res, 400, "VALIDATION_ERROR");
        return;
      }
      const result = updateTask(store, user.id, taskId, body);
      if (result.error) {
        sendError(res, result.error.status, result.error.code);
        return;
      }
      sendJson(res, 200, { task: result.task });
      return;
    }

    if (req.method === "DELETE") {
      if (!deleteTask(store, user.id, taskId)) {
        sendError(res, 404, "NOT_FOUND", "Not found");
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }
  }

  sendError(res, 404, "NOT_FOUND", "Not found");
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error("unhandled error:", error);
    if (!res.headersSent) {
      sendError(res, 500, "INTERNAL_ERROR");
    } else {
      res.end();
    }
  });
});

server.listen(port, () => {
  console.log(`taskboard listening on :${port} (data dir: ${dataDir})`);
});
