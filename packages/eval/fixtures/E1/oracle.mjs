#!/usr/bin/env node
// E1 隐藏 oracle（黑盒）：启动被测应用 → 逐条执行 30 条 AC 与边界检查 → 输出逐条 AC 的 JSON 结果。
// 用法：node oracle.mjs <workspacePath>（cwd = 本夹具目录；不修改工作区；exit 0 = 全部 Must 通过）。
// 隔离约定（docs/109 §架构判定 5）：本文件与 reference/、mutants/ 均不得进入被测工作区或提示词。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const workspace = process.argv[2];
if (!workspace || !existsSync(workspace)) {
  console.error("用法：node oracle.mjs <workspacePath>（目录必须存在）");
  process.exit(2);
}

const APP_PORT = 47400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${APP_PORT}`;
const CONTAINER_PORT = 47800 + Math.floor(Math.random() * 150);
const CONTAINER_BASE = `http://127.0.0.1:${CONTAINER_PORT}`;
const TEST_PASSWORD = "password-123";
const IMAGE = `e1-oracle-${process.pid}`;
const CONTAINER = `e1-oracle-c-${process.pid}`;
const results = [];

function record(ac, passed, detail, must = true) {
  results.push({ ac, must, passed, detail });
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function check(ac, fn, must = true) {
  try {
    const detail = await fn();
    record(ac, true, detail ?? "ok", must);
  } catch (error) {
    record(ac, false, String((error && error.message) || error), must);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${String(error)}`, timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
    });
  });
}

async function waitHealth(base, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) {
        return true;
      }
    } catch {
      // 尚未就绪，继续等待
    }
    await delay(500);
  }
  return false;
}

async function call(base, method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

async function fetchText(base, path) {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, text: await response.text() };
}

function errorCode(payload) {
  return payload && payload.error && payload.error.code ? payload.error.code : null;
}

function collectFiles(dir, limit = 300) {
  const files = [];
  const walk = (current) => {
    if (files.length >= limit) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) {
        return;
      }
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") {
          continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files;
}

function filesContaining(dir, needle) {
  const hits = [];
  for (const file of collectFiles(dir)) {
    try {
      if (readFileSync(file, "utf8").includes(needle)) {
        hits.push(file);
      }
    } catch {
      // 二进制/不可读文件跳过
    }
  }
  return hits;
}

let userSeq = 0;
async function createUser(prefix) {
  userSeq += 1;
  const username = `${prefix}_${Date.now().toString(36)}_${userSeq}`;
  const registered = await call(BASE, "POST", "/api/register", {
    body: { username, password: TEST_PASSWORD }
  });
  ensure(registered.status === 201, `注册失败（${registered.status}）`);
  const logged = await call(BASE, "POST", "/api/login", {
    body: { username, password: TEST_PASSWORD }
  });
  ensure(
    logged.status === 200 && logged.payload && typeof logged.payload.token === "string",
    `登录失败（${logged.status}）`
  );
  return { username, password: TEST_PASSWORD, token: logged.payload.token };
}

async function createTask(base, user, payload) {
  const response = await call(base, "POST", "/api/tasks", { body: payload, token: user.token });
  ensure(response.status === 201, `创建任务失败（${response.status}）`);
  return response.payload.task;
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "e1-oracle-data-"));
  const volumeDir = mkdtempSync(join(tmpdir(), "e1-oracle-vol-"));
  let app = null;
  let appLog = "";
  let started = false;

  const gated =
    (fn, gateMessage = "应用未启动（pnpm start 失败）") =>
    async () => {
      ensure(started, `${gateMessage}；日志尾部：${appLog.slice(-300)}`);
      return fn();
    };

  try {
    // ---- 启动被测应用（文档化命令：pnpm start；PORT / DATA_DIR 由环境注入）----
    app = spawn("pnpm", ["start"], {
      cwd: workspace,
      env: { ...process.env, PORT: String(APP_PORT), DATA_DIR: dataDir },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    app.stdout.on("data", (chunk) => (appLog += chunk));
    app.stderr.on("data", (chunk) => (appLog += chunk));
    started = await waitHealth(BASE, 60);

    const stamp = Date.now().toString(36);
    const userAlice = started ? { username: `alice_${stamp}`, password: TEST_PASSWORD } : null;
    let aliceToken = null;

    // ---- 健康（AC-01）----
    await check(
      "AC-01",
      gated(async () => {
        for (const path of ["/healthz", "/health", "/ready"]) {
          const response = await call(BASE, "GET", path);
          ensure(response.status === 200, `${path} 状态码 ${response.status}`);
          ensure(
            response.payload && response.payload.status === "ok",
            `${path} 返回体缺少 status=ok`
          );
        }
        return "三个健康端点均 200 且 status=ok";
      })
    );

    // ---- 注册/登录基础（AC-02、AC-03、AC-09、AC-10）----
    await check(
      "AC-02",
      gated(async () => {
        const response = await call(BASE, "POST", "/api/register", {
          body: { username: userAlice.username, password: userAlice.password }
        });
        ensure(response.status === 201, `状态码 ${response.status}`);
        const user = response.payload && response.payload.user;
        ensure(user && typeof user.id === "string", "缺少 user.id");
        ensure(user.username === userAlice.username, "user.username 不一致");
        const logged = await call(BASE, "POST", "/api/login", {
          body: { username: userAlice.username, password: userAlice.password }
        });
        ensure(logged.status === 200, "注册后登录失败");
        aliceToken = logged.payload.token;
        return "注册 201、字段完整，可登录";
      })
    );

    await check(
      "AC-03",
      gated(async () => {
        const response = await call(BASE, "POST", "/api/register", {
          body: { username: userAlice.username, password: TEST_PASSWORD }
        });
        ensure(response.status === 409, `状态码 ${response.status}`);
        ensure(errorCode(response.payload) === "USERNAME_TAKEN", "错误码不为 USERNAME_TAKEN");
        return "重复用户名 409 USERNAME_TAKEN";
      })
    );

    await check(
      "AC-05",
      gated(async () => {
        const name = `Case_${stamp}`;
        const first = await call(BASE, "POST", "/api/register", {
          body: { username: name, password: TEST_PASSWORD }
        });
        ensure(first.status === 201, `首注册状态码 ${first.status}`);
        const second = await call(BASE, "POST", "/api/register", {
          body: { username: name.toLowerCase(), password: TEST_PASSWORD }
        });
        ensure(second.status === 409, `大小写变体状态码 ${second.status}`);
        ensure(errorCode(second.payload) === "USERNAME_TAKEN", "错误码不一致");
        return "大小写冲突 409";
      })
    );

    await check(
      "AC-06",
      gated(async () => {
        const username = `race_${stamp}`;
        const responses = await Promise.all(
          Array.from({ length: 5 }, () =>
            call(BASE, "POST", "/api/register", { body: { username, password: TEST_PASSWORD } })
          )
        );
        const statuses = responses.map((entry) => entry.status);
        const created = statuses.filter((status) => status === 201).length;
        const conflicted = statuses.filter((status) => status === 409).length;
        ensure(created === 1, `成功次数 ${created}（应为 1）`);
        ensure(conflicted === 4, `409 次数 ${conflicted}（应为 4）`);
        ensure(!statuses.some((status) => status >= 500), `出现 5xx：${statuses.join(",")}`);
        return "5 并发恰好 1 成功、4 冲突、无 5xx";
      })
    );

    await check(
      "AC-07",
      gated(async () => {
        for (const bad of ["ab", "a b", "bad_name_".repeat(5), "名字".repeat(2)]) {
          const response = await call(BASE, "POST", "/api/register", {
            body: { username: bad, password: TEST_PASSWORD }
          });
          ensure(response.status === 400, `username=${bad} → ${response.status}`);
          ensure(errorCode(response.payload) === "VALIDATION_ERROR", "错误码不一致");
        }
        return "4 类非法用户名均 400 VALIDATION_ERROR";
      })
    );

    await check(
      "AC-08",
      gated(async () => {
        const response = await call(BASE, "POST", "/api/register", {
          body: { username: `short_${stamp}`, password: "short" }
        });
        ensure(response.status === 400, `状态码 ${response.status}`);
        ensure(errorCode(response.payload) === "VALIDATION_ERROR", "错误码不一致");
        return "短密码 400 VALIDATION_ERROR";
      })
    );

    await check(
      "AC-09",
      gated(async () => {
        const user = await createUser("login");
        ensure(typeof user.token === "string" && user.token.length > 20, "token 为空或过短");
        return "登录 200 且 token 非空";
      })
    );

    await check(
      "AC-10",
      gated(async () => {
        const response = await call(BASE, "POST", "/api/login", {
          body: { username: userAlice.username, password: "wrong-password" }
        });
        ensure(response.status === 401, `状态码 ${response.status}`);
        ensure(errorCode(response.payload) === "INVALID_CREDENTIALS", "错误码不一致");
        return "错误密码 401 INVALID_CREDENTIALS";
      })
    );

    // ---- 令牌（AC-11、AC-12、AC-13）----
    await check(
      "AC-11",
      gated(async () => {
        const response = await call(BASE, "GET", "/api/tasks");
        ensure(response.status === 401, `状态码 ${response.status}`);
        ensure(errorCode(response.payload) === "UNAUTHORIZED", "错误码不一致");
        return "无令牌 401 UNAUTHORIZED";
      })
    );

    await check(
      "AC-12",
      gated(async () => {
        const user = await createUser("tamper");
        const [payloadPart, signaturePart] = user.token.split(".");
        const flipped = signaturePart[5] === "A" ? "B" : "A";
        const tampered = `${payloadPart}.${signaturePart.slice(0, 5)}${flipped}${signaturePart.slice(6)}`;
        const response = await call(BASE, "GET", "/api/tasks", { token: tampered });
        ensure(response.status === 401, `篡改令牌状态码 ${response.status}`);
        return "篡改令牌 401";
      })
    );

    await check(
      "AC-13",
      gated(async () => {
        const user = await createUser("truncate");
        const truncated = user.token.slice(0, Math.floor(user.token.length / 2));
        const response = await call(BASE, "GET", "/api/tasks", { token: truncated });
        ensure(response.status === 401, `截断令牌状态码 ${response.status}`);
        return "截断令牌 401";
      })
    );

    // ---- 创建与边界（AC-14 ~ AC-18）----
    await check(
      "AC-14",
      gated(async () => {
        const user = await createUser("create");
        const task = await createTask(BASE, user, { title: "准备周会材料", dueDate: "2026-10-01" });
        ensure(task.title === "准备周会材料", "title 不一致");
        ensure(task.dueDate === "2026-10-01", "dueDate 不一致");
        ensure(task.done === false, "done 应为 false");
        ensure(typeof task.id === "string" && task.id.length === 36, "id 应为 UUID");
        return "创建 201，字段齐全";
      })
    );

    await check(
      "AC-15",
      gated(async () => {
        const user = await createUser("boundary");
        const okAscii = await call(BASE, "POST", "/api/tasks", {
          body: { title: "a".repeat(100) },
          token: user.token
        });
        ensure(okAscii.status === 201, `100 个 ASCII 字符 → ${okAscii.status}`);
        const okCjk = await call(BASE, "POST", "/api/tasks", {
          body: { title: "标".repeat(100) },
          token: user.token
        });
        ensure(okCjk.status === 201, `100 个汉字 → ${okCjk.status}`);
        const tooLong = await call(BASE, "POST", "/api/tasks", {
          body: { title: "标".repeat(101) },
          token: user.token
        });
        ensure(tooLong.status === 400, `101 个码点 → ${tooLong.status}`);
        ensure(errorCode(tooLong.payload) === "TITLE_INVALID", "错误码不一致");
        return "100 通过 / 101 拒绝";
      })
    );

    await check(
      "AC-16",
      gated(async () => {
        const user = await createUser("trim");
        const padded = await createTask(BASE, user, { title: "  边界 空格  " });
        ensure(padded.title === "边界 空格", `trim 后标题为 ${JSON.stringify(padded.title)}`);
        const blank = await call(BASE, "POST", "/api/tasks", {
          body: { title: "   " },
          token: user.token
        });
        ensure(blank.status === 400, `全空白标题 → ${blank.status}`);
        ensure(errorCode(blank.payload) === "TITLE_INVALID", "错误码不一致");
        return "首尾空格去除；全空白拒绝";
      })
    );

    await check(
      "AC-17",
      gated(async () => {
        const user = await createUser("unicode");
        const title = "发布 🚀 版本";
        const task = await createTask(BASE, user, { title });
        ensure(task.title === title, "含 emoji 标题未原样保留");
        const chinese = await createTask(BASE, user, { title: "中文标题" });
        ensure(chinese.title === "中文标题", "中文标题未原样保留");
        return "中文 / emoji 标题原样保存";
      })
    );

    await check(
      "AC-18",
      gated(async () => {
        const user = await createUser("date");
        for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "12-31-2026", "2026/01/01"]) {
          const response = await call(BASE, "POST", "/api/tasks", {
            body: { title: "日期校验", dueDate: bad },
            token: user.token
          });
          ensure(response.status === 400, `dueDate=${bad} → ${response.status}`);
          ensure(errorCode(response.payload) === "DATE_INVALID", `dueDate=${bad} 错误码不一致`);
        }
        return "5 类非法日期均 400 DATE_INVALID";
      })
    );

    // ---- 更新 / 删除（AC-19、AC-20、AC-28）----
    await check(
      "AC-19",
      gated(async () => {
        const user = await createUser("strict");
        const task = await createTask(BASE, user, { title: "未知字段检查" });
        const response = await call(BASE, "PATCH", `/api/tasks/${task.id}`, {
          body: { title: "改一改", owner: "hacker" },
          token: user.token
        });
        ensure(response.status === 400, `状态码 ${response.status}`);
        ensure(errorCode(response.payload) === "UNKNOWN_FIELD", "错误码不一致");
        return "未知字段 400 UNKNOWN_FIELD";
      })
    );

    await check(
      "AC-20",
      gated(async () => {
        const user = await createUser("patch");
        const task = await createTask(BASE, user, { title: "旧标题" });
        const patched = await call(BASE, "PATCH", `/api/tasks/${task.id}`, {
          body: { title: "新标题", done: true },
          token: user.token
        });
        ensure(patched.status === 200, `状态码 ${patched.status}`);
        ensure(patched.payload.task.title === "新标题", "title 未更新");
        ensure(patched.payload.task.done === true, "done 未更新");
        const fetched = await call(BASE, "GET", `/api/tasks/${task.id}`, { token: user.token });
        ensure(fetched.status === 200 && fetched.payload.task.title === "新标题", "GET 未反映更新");
        return "PATCH 生效并可由 GET 复核";
      })
    );

    await check(
      "AC-28",
      gated(async () => {
        const user = await createUser("delete");
        const task = await createTask(BASE, user, { title: "待删除" });
        const removed = await call(BASE, "DELETE", `/api/tasks/${task.id}`, { token: user.token });
        ensure(removed.status === 204, `删除状态码 ${removed.status}`);
        const list = await call(BASE, "GET", "/api/tasks", { token: user.token });
        ensure(
          Array.isArray(list.payload.items) && list.payload.items.length === 0,
          "删除后列表未清空"
        );
        const again = await call(BASE, "DELETE", `/api/tasks/${task.id}`, { token: user.token });
        ensure(again.status === 404, `重复删除状态码 ${again.status}`);
        return "删除 204、列表消失、重复删除 404";
      })
    );

    // ---- 列表 / 搜索（AC-23）----
    await check(
      "AC-23",
      gated(async () => {
        const userA = await createUser("listA");
        const userB = await createUser("listB");
        await createTask(BASE, userA, { title: "季度报告 A稿" });
        await createTask(BASE, userB, { title: "季度报告 B稿" });
        const list = await call(BASE, "GET", "/api/tasks", { token: userA.token });
        ensure(Array.isArray(list.payload.items), "items 非数组");
        ensure(list.payload.items.length === 1, `本人列表数量 ${list.payload.items.length}`);
        ensure(list.payload.items[0].title === "季度报告 A稿", "混入他人任务");
        const searched = await call(
          BASE,
          "GET",
          "/api/tasks?q=%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A",
          {
            token: userA.token
          }
        );
        ensure(searched.payload.items.length === 1, "搜索结果数量异常");
        for (const hostile of ["'\" ; -- ; DROP TABLE tasks;--", "%", "_", "' OR 1=1 --"]) {
          const response = await call(BASE, "GET", `/api/tasks?q=${encodeURIComponent(hostile)}`, {
            token: userA.token
          });
          ensure(response.status < 500, `q=${hostile} → ${response.status}`);
        }
        return "列表隔离、搜索过滤、恶意字符均无 5xx";
      })
    );

    // ---- 数据隔离（AC-27）----
    await check(
      "AC-27",
      gated(async () => {
        const userA = await createUser("ownerA");
        const userB = await createUser("ownerB");
        const task = await createTask(BASE, userA, { title: "A 的私密任务" });
        const get = await call(BASE, "GET", `/api/tasks/${task.id}`, { token: userB.token });
        ensure(get.status === 404, `越权 GET → ${get.status}`);
        ensure(errorCode(get.payload) === "NOT_FOUND", "越权 GET 错误码不一致");
        const patch = await call(BASE, "PATCH", `/api/tasks/${task.id}`, {
          body: { title: "被篡改" },
          token: userB.token
        });
        ensure(patch.status === 404, `越权 PATCH → ${patch.status}`);
        const del = await call(BASE, "DELETE", `/api/tasks/${task.id}`, { token: userB.token });
        ensure(del.status === 404, `越权 DELETE → ${del.status}`);
        const intact = await call(BASE, "GET", `/api/tasks/${task.id}`, { token: userA.token });
        ensure(
          intact.status === 200 && intact.payload.task.title === "A 的私密任务",
          "任务被越权修改"
        );
        return "越权三操作均 404，任务未被改动";
      })
    );

    // ---- 页面（AC-21、AC-22）----
    await check(
      "AC-21",
      gated(async () => {
        const home = await fetchText(BASE, "/");
        ensure(home.status === 200, `首页状态码 ${home.status}`);
        for (const testId of ["home-title", "task-list", "search-input", "new-task-button"]) {
          ensure(home.text.includes(`data-testid="${testId}"`), `缺少 data-testid=${testId}`);
        }
        return "首页 200 且 4 个 data-testid 齐全";
      })
    );

    await check(
      "AC-22",
      gated(async () => {
        const home = await fetchText(BASE, "/");
        ensure(/<html[\s>]/i.test(home.text) && /<\/html>/i.test(home.text), "HTML 结构不完整");
        return "（Should）首页 HTML 结构完整（fetch 等价检查）";
      }),
      false
    );

    // ---- 工程与文档（AC-30）----
    await check("AC-30", async () => {
      ensure(existsSync(join(workspace, "README.md")), "缺少 README.md");
      const readme = readFileSync(join(workspace, "README.md"), "utf8");
      ensure(readme.length > 50, "README 内容过短");
      const test = await run("pnpm", ["test"], {
        cwd: workspace,
        timeoutMs: 5 * 60 * 1000
      });
      ensure(test.code === 0, `pnpm test 未通过：${(test.stdout + test.stderr).slice(-400)}`);
      const found = new Set(test.stdout.match(/AC-\d\d/g) ?? []);
      const required = Array.from(
        { length: 21 },
        (_, index) => `AC-${String(index + 1).padStart(2, "0")}`
      ).concat(["AC-23", "AC-24", "AC-25", "AC-26", "AC-27", "AC-28", "AC-29"]);
      const missing = required.filter((id) => !found.has(id));
      ensure(missing.length === 0, `测试名缺少 AC 编号：${missing.join(", ")}`);
      return `README + pnpm test 全绿 + ${found.size} 个 AC 测试名`;
    });

    // ---- 容器段（AC-24、AC-25、AC-26、AC-29）----
    const build = await run("docker", ["build", "-t", IMAGE, "."], {
      cwd: workspace,
      timeoutMs: 10 * 60 * 1000
    });
    let containerUp = false;
    let containerDetail = "";
    if (build.code === 0) {
      const startedContainer = await run(
        "docker",
        [
          "run",
          "-d",
          "--name",
          CONTAINER,
          "-p",
          `${CONTAINER_PORT}:3000`,
          "-e",
          "PORT=3000",
          "-v",
          `${volumeDir}:/data`,
          IMAGE
        ],
        { timeoutMs: 60 * 1000 }
      );
      containerUp = startedContainer.code === 0 && (await waitHealth(CONTAINER_BASE, 60));
      containerDetail =
        startedContainer.code === 0
          ? containerUp
            ? "容器已启动且健康端点就绪"
            : "容器已启动但健康端点未就绪"
          : `docker run 失败：${startedContainer.stderr.slice(-200)}`;
    } else {
      containerDetail = `docker build 失败：${(build.stderr || build.stdout).slice(-300)}`;
    }

    await check("AC-24", async () => {
      ensure(build.code === 0, containerDetail);
      ensure(containerUp, containerDetail);
      return "镜像构建成功、容器运行且健康";
    });

    if (containerUp) {
      await check("AC-25", async () => {
        const username = `volume_${stamp}`;
        const registered = await call(CONTAINER_BASE, "POST", "/api/register", {
          body: { username, password: TEST_PASSWORD }
        });
        ensure(registered.status === 201, `容器内注册失败（${registered.status}）`);
        const logged = await call(CONTAINER_BASE, "POST", "/api/login", {
          body: { username, password: TEST_PASSWORD }
        });
        ensure(logged.status === 200, "容器内登录失败");
        const token = logged.payload.token;
        const created = await call(CONTAINER_BASE, "POST", "/api/tasks", {
          body: { title: "重启保留检查" },
          token
        });
        ensure(created.status === 201, "容器内创建任务失败");
        const restarted = await run("docker", ["restart", CONTAINER], { timeoutMs: 60 * 1000 });
        ensure(restarted.code === 0, "docker restart 失败");
        ensure(await waitHealth(CONTAINER_BASE, 60), "重启后健康端点未就绪");
        const relogin = await call(CONTAINER_BASE, "POST", "/api/login", {
          body: { username, password: TEST_PASSWORD }
        });
        ensure(relogin.status === 200, "重启后无法登录（数据丢失？）");
        const list = await call(CONTAINER_BASE, "GET", "/api/tasks", {
          token: relogin.payload.token
        });
        ensure(
          Array.isArray(list.payload.items) && list.payload.items.length === 1,
          "重启后任务未保留"
        );
        return "重启后用户与任务均保留";
      });

      await check("AC-26", async () => {
        const result = await run("docker", ["exec", CONTAINER, "id", "-u"], {
          timeoutMs: 30 * 1000
        });
        ensure(result.code === 0, `docker exec 失败：${result.stderr.slice(-200)}`);
        const uid = Number(result.stdout.trim());
        ensure(Number.isInteger(uid), `无法解析 uid：${result.stdout.trim()}`);
        ensure(uid !== 0, "容器以 root（uid=0）运行");
        return `容器内 uid=${uid}（非 root）`;
      });

      await check("AC-29", async () => {
        const logs = await run("docker", ["logs", CONTAINER], { timeoutMs: 30 * 1000 });
        ensure(logs.code === 0, "docker logs 失败");
        const text = `${logs.stdout}${logs.stderr}`;
        ensure(!text.includes(TEST_PASSWORD), "容器日志含明文密码");
        return "容器日志不含明文密码";
      });
    } else {
      record("AC-25", false, containerDetail, true);
      record("AC-26", false, containerDetail, true);
      record("AC-29", false, containerDetail, true);
    }

    // ---- 数据文件扫描（AC-04：宿主 DATA_DIR + 容器数据卷）----
    await check("AC-04", async () => {
      ensure(started, "应用未启动，无法验证数据文件");
      const hostFiles = collectFiles(dataDir);
      ensure(hostFiles.length > 0, "宿主 DATA_DIR 下未发现任何数据文件");
      const hostHits = filesContaining(dataDir, TEST_PASSWORD);
      ensure(hostHits.length === 0, `DATA_DIR 含明文密码：${hostHits.join(", ")}`);
      if (containerUp) {
        const volumeFiles = collectFiles(volumeDir);
        ensure(volumeFiles.length > 0, "容器数据卷为空（未写入 /data）");
        const volumeHits = filesContaining(volumeDir, TEST_PASSWORD);
        ensure(volumeHits.length === 0, `容器数据卷含明文密码：${volumeHits.join(", ")}`);
      }
      return containerUp
        ? "DATA_DIR 与容器数据卷均有数据文件且无明文密码"
        : "DATA_DIR 有数据文件且无明文密码（容器未运行，卷检查跳过）";
    });
  } finally {
    if (app) {
      try {
        process.kill(-app.pid, "SIGKILL");
      } catch {
        try {
          app.kill("SIGKILL");
        } catch {
          // 忽略
        }
      }
    }
    await run("docker", ["rm", "-f", CONTAINER], { timeoutMs: 30 * 1000 });
    await run("docker", ["rmi", "-f", IMAGE], { timeoutMs: 60 * 1000 });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(volumeDir, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    record("__oracle__", false, `oracle 异常：${String((error && error.message) || error)}`);
  })
  .finally(() => {
    const must = results.filter((entry) => entry.must);
    const mustFailed = must.filter((entry) => !entry.passed);
    console.log(
      `oracle E1: Must ${must.length - mustFailed.length}/${must.length} 通过` +
        (mustFailed.length > 0 ? `；失败：${mustFailed.map((entry) => entry.ac).join(", ")}` : "")
    );
    console.log(`E1_RESULTS_JSON:${JSON.stringify({ fixture: "E1", workspace, results })}`);
    process.exitCode = mustFailed.length === 0 ? 0 : 1;
  });
