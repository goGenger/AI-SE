// TaskBoard API 行为测试（node --test；测试名含对应 AC 编号；用例相互独立、不依赖执行顺序）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 47000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "taskboard-test-"));
const JSON_HEADERS = { "content-type": "application/json" };

let child = null;

async function ensureServer() {
  if (child) {
    return;
  }
  child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: "ignore"
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // 服务器尚未就绪，继续等待
    }
    await delay(100);
  }
  throw new Error("服务器未在 5 秒内就绪");
}

function apiTest(name, fn) {
  test(name, async () => {
    await ensureServer();
    await fn();
  });
}

after(() => {
  if (child) {
    child.kill("SIGKILL");
  }
});

let sequence = 0;
function nextUsername(prefix) {
  sequence += 1;
  return `${prefix}_${Date.now() % 1000000}_${sequence}`;
}

async function register(username, password = "password-123") {
  return fetch(`${base}/api/register`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ username, password })
  });
}

async function registerNew(prefix) {
  const username = nextUsername(prefix);
  const response = await register(username);
  assert.equal(response.status, 201);
  const { user } = await response.json();
  return { username, password: "password-123", user };
}

async function login(username, password = "password-123") {
  return fetch(`${base}/api/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ username, password })
  });
}

async function tokenFor(prefix) {
  const { username, password } = await registerNew(prefix);
  const response = await login(username, password);
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

function authed(token, path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` }
  });
}

async function createTask(token, payload) {
  const response = await authed(token, "/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  assert.equal(response.status, 201);
  return (await response.json()).task;
}

apiTest("AC-01 GET /healthz 返回 200 且 status=ok（冒烟）", async () => {
  for (const path of ["/healthz", "/health", "/ready"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  }
});

apiTest("AC-21 GET / 返回 HTML 且含 4 个约定 data-testid（冒烟）", async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const testId of ["home-title", "task-list", "search-input", "new-task-button"]) {
    assert.ok(html.includes(`data-testid="${testId}"`), `缺少 data-testid=${testId}`);
  }
});

apiTest("AC-02 POST /api/register 新用户名返回 201 与 user 字段（冒烟）", async () => {
  const { username, user } = await registerNew("reg");
  assert.equal(user.username, username);
  assert.match(user.id, /^[0-9a-f-]{36}$/);
});

apiTest("AC-03 重复用户名返回 409 USERNAME_TAKEN", async () => {
  const { username } = await registerNew("dup");
  const response = await register(username);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "USERNAME_TAKEN");
});

apiTest("AC-04 数据文件中不含明文密码（哈希存储）", async () => {
  const { username } = await registerNew("hash");
  const raw = readFileSync(join(dataDir, "db.json"), "utf8");
  assert.ok(!raw.includes("password-123"), "数据文件含明文密码");
  assert.ok(raw.includes(username), "用户未持久化到数据文件");
});

apiTest("AC-05 用户名大小写冲突返回 409", async () => {
  const { username } = await registerNew("case");
  const response = await register(username.toUpperCase());
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "USERNAME_TAKEN");
});

apiTest("AC-06 并发注册同一用户名恰好一次成功", async () => {
  const username = nextUsername("race");
  const attempts = Array.from({ length: 5 }, () => register(username));
  const statuses = (await Promise.all(attempts)).map((response) => response.status);
  assert.equal(statuses.filter((status) => status === 201).length, 1);
  assert.equal(statuses.filter((status) => status === 409).length, 4);
});

apiTest("AC-07 非法用户名返回 400 VALIDATION_ERROR", async () => {
  for (const bad of ["ab", "a b", "名".repeat(4), "x".repeat(33)]) {
    const response = await register(bad);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
  }
});

apiTest("AC-08 密码过短返回 400 VALIDATION_ERROR", async () => {
  const response = await register(nextUsername("short"), "short");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
});

apiTest("AC-09 POST /api/login 正确凭证返回 200 与 token（冒烟）", async () => {
  const { username, password, user } = await registerNew("login");
  const response = await login(username, password);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(typeof body.token === "string" && body.token.length > 20);
  assert.equal(body.user.id, user.id);
});

apiTest("AC-10 密码错误返回 401 INVALID_CREDENTIALS", async () => {
  const { username } = await registerNew("badpass");
  const response = await login(username, "wrong-password");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "INVALID_CREDENTIALS");
});

apiTest("AC-11 无令牌访问任务接口返回 401 UNAUTHORIZED", async () => {
  const response = await fetch(`${base}/api/tasks`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "UNAUTHORIZED");
});

apiTest("AC-12 令牌被篡改返回 401", async () => {
  const token = await tokenFor("tamper");
  const [payloadPart, signaturePart] = token.split(".");
  const flipped = signaturePart[5] === "A" ? "B" : "A";
  const tampered = `${payloadPart}.${signaturePart.slice(0, 5)}${flipped}${signaturePart.slice(6)}`;
  const response = await fetch(`${base}/api/tasks`, {
    headers: { authorization: `Bearer ${tampered}` }
  });
  assert.equal(response.status, 401);
});

apiTest("AC-13 令牌被截断返回 401", async () => {
  const token = await tokenFor("truncate");
  const response = await fetch(`${base}/api/tasks`, {
    headers: { authorization: `Bearer ${token.slice(0, Math.floor(token.length / 2))}` }
  });
  assert.equal(response.status, 401);
});

apiTest("AC-14 POST /api/tasks 创建任务返回 201（冒烟）", async () => {
  const token = await tokenFor("create");
  const task = await createTask(token, { title: "准备周会材料", dueDate: "2026-10-01" });
  assert.equal(task.title, "准备周会材料");
  assert.equal(task.dueDate, "2026-10-01");
  assert.equal(task.done, false);
  assert.match(task.id, /^[0-9a-f-]{36}$/);
  assert.ok(task.createdAt);
});

apiTest("AC-15 title 恰好 100 码点通过、101 失败（边界）", async () => {
  const token = await tokenFor("boundary");
  const ok = await authed(token, "/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "标".repeat(100) })
  });
  assert.equal(ok.status, 201);
  const tooLong = await authed(token, "/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "标".repeat(101) })
  });
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json()).error.code, "TITLE_INVALID");
});

apiTest("AC-16 title 首尾空格被去除；全空白返回 400", async () => {
  const token = await tokenFor("trim");
  const trimmed = await createTask(token, { title: "  边界 空格  " });
  assert.equal(trimmed.title, "边界 空格");
  const blank = await authed(token, "/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "   " })
  });
  assert.equal(blank.status, 400);
  assert.equal((await blank.json()).error.code, "TITLE_INVALID");
});

apiTest("AC-17 中文与 emoji 标题原样保存", async () => {
  const token = await tokenFor("unicode");
  const title = "发布 🚀 版本";
  const task = await createTask(token, { title });
  assert.equal(task.title, title);
});

apiTest("AC-18 非法 dueDate 返回 400 DATE_INVALID", async () => {
  const token = await tokenFor("date");
  for (const bad of ["2026-02-30", "2026-13-01", "12-31-2026", "2026/01/01"]) {
    const response = await authed(token, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "日期校验", dueDate: bad })
    });
    assert.equal(response.status, 400, `dueDate=${bad} 应被拒绝`);
    assert.equal((await response.json()).error.code, "DATE_INVALID");
  }
});

apiTest("AC-19 PATCH 未知字段返回 400 UNKNOWN_FIELD", async () => {
  const token = await tokenFor("strict");
  const task = await createTask(token, { title: "不可注入" });
  const response = await authed(token, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "改", owner: "hacker" })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "UNKNOWN_FIELD");
});

apiTest("AC-20 PATCH 更新 title 与 done 生效", async () => {
  const token = await tokenFor("patch");
  const task = await createTask(token, { title: "旧标题" });
  const response = await authed(token, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "新标题", done: true })
  });
  assert.equal(response.status, 200);
  const updated = (await response.json()).task;
  assert.equal(updated.title, "新标题");
  assert.equal(updated.done, true);
  const fetched = await authed(token, `/api/tasks/${task.id}`);
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).task.title, "新标题");
});

apiTest("AC-23 任务列表仅返回本人任务且搜索字符安全（冒烟）", async () => {
  const tokenA = await tokenFor("listA");
  const tokenB = await tokenFor("listB");
  await createTask(tokenA, { title: "季度报告 A稿" });
  await createTask(tokenB, { title: "季度报告 B稿" });

  const listA = await (await authed(tokenA, "/api/tasks")).json();
  assert.equal(listA.items.length, 1);
  assert.equal(listA.items[0].title, "季度报告 A稿");

  const searched = await (await authed(tokenA, "/api/tasks?q=季度报告")).json();
  assert.equal(searched.items.length, 1);

  for (const hostile of ["'\" ; -- ; DROP TABLE tasks;--", "%", "_", "' OR 1=1 --"]) {
    const response = await authed(tokenA, `/api/tasks?q=${encodeURIComponent(hostile)}`);
    assert.equal(response.status, 200, `q=${hostile} 不应报 500`);
    assert.ok(Array.isArray((await response.json()).items));
  }
});

apiTest("AC-27 用户 B 访问用户 A 的任务返回 404（不泄露存在性）", async () => {
  const tokenA = await tokenFor("ownerA");
  const tokenB = await tokenFor("ownerB");
  const task = await createTask(tokenA, { title: "A 的私密任务" });

  const get = await authed(tokenB, `/api/tasks/${task.id}`);
  assert.equal(get.status, 404);
  assert.equal((await get.json()).error.code, "NOT_FOUND");
  const patch = await authed(tokenB, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "被篡改" })
  });
  assert.equal(patch.status, 404);
  const del = await authed(tokenB, `/api/tasks/${task.id}`, { method: "DELETE" });
  assert.equal(del.status, 404);

  const still = await authed(tokenA, `/api/tasks/${task.id}`);
  assert.equal(still.status, 200);
  assert.equal((await still.json()).task.title, "A 的私密任务");
});

apiTest("AC-28 DELETE 本人任务返回 204 且列表中消失", async () => {
  const token = await tokenFor("delete");
  const task = await createTask(token, { title: "待删除" });
  const removed = await authed(token, `/api/tasks/${task.id}`, { method: "DELETE" });
  assert.equal(removed.status, 204);
  const list = await (await authed(token, "/api/tasks")).json();
  assert.equal(list.items.length, 0);
  const again = await authed(token, `/api/tasks/${task.id}`, { method: "DELETE" });
  assert.equal(again.status, 404);
});
