import { exec } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptanceTexts,
  buildServerSmokeCommand,
  businessRoutes,
  evaluateServerSmoke,
  extractHttpRoutes,
  parseServerSmokeOutput,
  type ServerSmokeResult,
  type SmokeRoute
} from "../services/serverSmoke";

/**
 * N-49（`docs/232` §9.14）：门看不见「路由没挂」。
 *
 * 实测证据（第六次回归）：slice-auth-persistence 的边界检查判 `passed`（作用域 AC-01..AC-13），
 * 同一时刻 `GET /api/register` 是 404——交付的是「模块 + 单元测试」，没人把路由挂进服务器；
 * 项目自己的 136 条测试里 135 条是绿的（它们直接调 handler，不启动服务）。
 */

/** 真实 AC 文本（取自第六次回归 slice-auth-persistence 的 `tasks.input.acceptanceCriteria`）。 */
const AUTH_SLICE_AC = [
  "GET /healthz、/health、/ready 均返回 200 与 {\"status\":\"ok\"}，无需鉴权，Content-Type 为 application/json（AC-01 测试通过）。",
  "src/router.js 暴露受保护路由注册点，/api/tasks 前缀在无 Authorization 头时返回 401 UNAUTHORIZED。",
  "无令牌访问 /api/tasks 受保护接口返回 401 UNAUTHORIZED；携带有效令牌可进入后续处理（AC-11）。",
  "`pnpm start` 能在 PORT 上启动 HTTP 服务并返回 JSON 响应（探测端口成功后再终止进程，不挂起构建流程）。"
];

function probe(method: string, path: string, status: number | null): ServerSmokeResult["probes"][number] {
  return { method, path, status };
}

function result(overrides: Partial<ServerSmokeResult> = {}): ServerSmokeResult {
  return {
    booted: true,
    exited: false,
    exitCode: null,
    signal: null,
    control: { method: "GET", path: "/__ai_se_smoke__abc", status: 404 },
    probes: [],
    stderrTail: "",
    ...overrides
  };
}

describe("N-49 extractHttpRoutes：只认 AC 文本里点名的路由", () => {
  it("从真实切片 AC 里取出方法+路径，并按大小写与重复去重", () => {
    const routes = extractHttpRoutes(AUTH_SLICE_AC);
    expect(routes).toContainEqual({ method: "GET", path: "/healthz" });
    expect(routes).toContainEqual({ method: "GET", path: "/api/tasks" });
    // `/health`、`/ready` 是裸路径（无方法前缀），按 GET 收；`/api/tasks` 只出现一次。
    expect(routes.filter((route) => route.path === "/api/tasks")).toHaveLength(1);
  });

  it("`POST /api/register` 这类带方法的路由被完整保留", () => {
    const routes = extractHttpRoutes(["POST /api/register 新用户名 → 201，返回 user.id"]);
    expect(routes).toContainEqual({ method: "POST", path: "/api/register" });
  });

  it("文本里没有路由时返回空数组——不猜 REST 形状", () => {
    expect(extractHttpRoutes(["合法注册返回 201，user.id 为 crypto.randomUUID 生成的 UUID。"])).toEqual(
      []
    );
  });

  it("根路径、静态资源不算业务面", () => {
    const routes = extractHttpRoutes(["GET / 返回 HTML", "GET /favicon.ico", "GET /styles/app.css"]);
    expect(businessRoutes(routes)).toEqual([]);
  });

  it("健康端点只证明进程活着，不参与挂载判定", () => {
    const routes = extractHttpRoutes(AUTH_SLICE_AC);
    expect(businessRoutes(routes).map((route) => route.path)).toEqual(["/api/tasks"]);
  });

  it("路径占位符换成固定 UUID", () => {    const command = buildServerSmokeCommand({
      startCommand: "node server.js",
      port: 43210,
      routes: [{ method: "GET", path: "/api/tasks/:id" }],
      bootTimeoutMs: 1000,
      probeTimeoutMs: 500
    });
    expect(command).toContain("00000000-0000-4000-8000-000000000000");
  });
});

describe("N-49 evaluateServerSmoke：只判定「业务面是否挂上」", () => {
  const routes: SmokeRoute[] = [{ method: "GET", path: "/api/tasks" }];

  it("业务路由有非 404 响应 → 通过（401 也算挂上了）", () => {
    const verdict = evaluateServerSmoke(
      result({ probes: [probe("GET", "/api/tasks", 401)] }),
      routes
    );
    expect(verdict).toEqual({
      kind: "passed",
      businessProbes: [probe("GET", "/api/tasks", 401)]
    });
  });

  it("进程活着，但切片点名的业务路由全部 404 → SURFACE_UNMOUNTED", () => {
    const verdict = evaluateServerSmoke(
      result({ probes: [probe("GET", "/api/tasks", 404)] }),
      routes
    );
    expect(verdict.kind).toBe("failed");
    if (verdict.kind !== "failed") return;
    expect(verdict.failureCode).toBe("SURFACE_UNMOUNTED");
    expect(verdict.detail).toContain("GET /api/tasks -> 404");
  });

  it("进程根本没起来（非环境原因）→ BOOT_FAILED", () => {
    const verdict = evaluateServerSmoke(
      result({ booted: false, exited: true, exitCode: 1, stderrTail: "TypeError: x is not a function" }),
      routes
    );
    expect(verdict.kind).toBe("failed");
    if (verdict.kind !== "failed") return;
    expect(verdict.failureCode).toBe("BOOT_FAILED");
  });

  it("缺依赖/无网导致的启动失败记跳过，不判交付缺陷", () => {
    const verdict = evaluateServerSmoke(
      result({ booted: false, exited: true, exitCode: 1, stderrTail: "Error: Cannot find module 'express'" }),
      routes
    );
    expect(verdict).toEqual({ kind: "skipped", reason: "BOOT_ENV_UNRESOLVED" });
  });

  it("切片 AC 里只点名健康端点 → NO_ROUTES（留痕跳过）", () => {
    const verdict = evaluateServerSmoke(result(), [{ method: "GET", path: "/healthz" }]);
    expect(verdict).toEqual({ kind: "skipped", reason: "NO_ROUTES" });
  });

  it("只点名带占位符的路由时，404 不算证据 → ONLY_PARAMETERIZED_ROUTES", () => {
    const parameterized: SmokeRoute[] = [{ method: "GET", path: "/api/tasks/:id" }];
    const verdict = evaluateServerSmoke(
      result({
        probes: [
          { method: "GET", path: "/api/tasks/00000000-0000-4000-8000-000000000000", status: 404 }
        ]
      }),
      parameterized
    );
    expect(verdict).toEqual({ kind: "skipped", reason: "ONLY_PARAMETERIZED_ROUTES" });
  });

  it("带占位符的路由返回 401 仍算挂上了（非 404 就是证据）", () => {
    const parameterized: SmokeRoute[] = [{ method: "GET", path: "/api/tasks/:id" }];
    const verdict = evaluateServerSmoke(
      result({
        probes: [
          { method: "GET", path: "/api/tasks/00000000-0000-4000-8000-000000000000", status: 401 }
        ]
      }),
      parameterized
    );
    expect(verdict.kind).toBe("passed");
  });
});

describe("N-49 parseServerSmokeOutput", () => {
  it("取最后一行可解析的 JSON（业务日志不污染结论）", () => {
    const parsed = parseServerSmokeOutput(
      'noise\n{"booted":false}\n{"booted":true,"exited":false,"exitCode":null,"signal":null,"control":{"method":"GET","path":"/x","status":404},"probes":[{"method":"GET","path":"/api/tasks","status":401}],"stderrTail":""}'
    );
    expect(parsed?.booted).toBe(true);
    expect(parsed?.probes).toEqual([{ method: "GET", path: "/api/tasks", status: 401 }]);
  });

  it("没有结论行 → null（调用方按 BOOT_FAILED 记证据）", () => {
    expect(parseServerSmokeOutput("npm ERR! code ELIFECYCLE")).toBeNull();
  });
});

describe("N-49 acceptanceTexts", () => {
  it("从任务输入里取验收标准，忽略形状不符的条目", () => {
    expect(
      acceptanceTexts([
        { acceptanceCriteria: ["a", 42, "", "b"] },
        { acceptanceCriteria: "not-an-array" },
        null
      ])
    ).toEqual(["a", "b"]);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function run(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error(`${error.message}\nstdout: ${stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * 真实进程验证（AGENTS §7：核心链路需真实验证）。沙箱里起进程与探测必须在同一条命令内完成——
 * 这两例直接跑 `buildServerSmokeCommand` 产出的那条命令，覆盖启动、端口探测、请求与进程组回收。
 */
describe("N-49 真实进程冒烟（起服务 → 打路由 → 回收进程组）", () => {
  it("路由挂上了 → 通过（401 也算挂上）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-se-smoke-mounted-"));
    writeFileSync(
      join(dir, "server.js"),
      [
        "const http = require('node:http');",
        "const server = http.createServer((req, res) => {",
        "  if (req.url.startsWith('/health')) { res.writeHead(200, {'content-type':'application/json'}); res.end('{\"status\":\"ok\"}'); return; }",
        "  if (req.url.startsWith('/api/tasks')) { res.writeHead(401, {'content-type':'application/json'}); res.end('{\"error\":{\"code\":\"UNAUTHORIZED\"}}'); return; }",
        "  res.writeHead(404, {'content-type':'application/json'}); res.end('{\"error\":{\"code\":\"NOT_FOUND\"}}');",
        "});",
        "server.listen(Number(process.env.PORT), '127.0.0.1');"
      ].join("\n")
    );
    const routes: SmokeRoute[] = [
      { method: "GET", path: "/healthz" },
      { method: "GET", path: "/api/tasks" }
    ];
    const command = buildServerSmokeCommand({
      startCommand: "node server.js",
      port: await freePort(),
      routes,
      bootTimeoutMs: 15_000,
      probeTimeoutMs: 3_000
    });
    const parsed = parseServerSmokeOutput(await run(command, dir));
    expect(parsed?.booted).toBe(true);
    const verdict = evaluateServerSmoke(parsed as ServerSmokeResult, routes);
    expect(verdict.kind).toBe("passed");
  });

  it("进程起来了但业务路由是 404（N-49 的实测形状）→ SURFACE_UNMOUNTED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-se-smoke-unmounted-"));
    writeFileSync(
      join(dir, "server.js"),
      [
        "const http = require('node:http');",
        "const server = http.createServer((req, res) => {",
        "  if (req.url.startsWith('/health')) { res.writeHead(200, {'content-type':'application/json'}); res.end('{\"status\":\"ok\"}'); return; }",
        "  res.writeHead(404, {'content-type':'application/json'}); res.end('{\"error\":{\"code\":\"NOT_FOUND\"}}');",
        "});",
        "server.listen(Number(process.env.PORT), '127.0.0.1');"
      ].join("\n")
    );
    const routes: SmokeRoute[] = [
      { method: "GET", path: "/healthz" },
      { method: "GET", path: "/api/tasks" }
    ];
    const command = buildServerSmokeCommand({
      startCommand: "node server.js",
      port: await freePort(),
      routes,
      bootTimeoutMs: 15_000,
      probeTimeoutMs: 3_000
    });
    const parsed = parseServerSmokeOutput(await run(command, dir));
    const verdict = evaluateServerSmoke(parsed as ServerSmokeResult, routes);
    expect(verdict.kind).toBe("failed");
    if (verdict.kind !== "failed") return;
    expect(verdict.failureCode).toBe("SURFACE_UNMOUNTED");
  });
});

/**
 * N-53（`docs/232` §9.24）：第十次回归里 `VOLUME /data`、`DATA_DIR=/data`、`挂载 /data 数据卷`
 * 被裸路径正则当成了 HTTP 路由，`server-smoke` 对**容器数据卷路径**判 `SURFACE_UNMOUNTED`，
 * 把 REVIEW 任务连判两次失败并派生 REPLAN。裸路径只认 `/api…`，带方法的路径照旧信任。
 */
describe("N-53 裸路径不猜：文件系统路径不是 HTTP 路由", () => {
  it("VOLUME /data、DATA_DIR=/data、挂载 /data 数据卷 都不产生路由", () => {
    const routes = extractHttpRoutes([
      "容器以非 root 用户运行，挂载 /data 数据卷，DATA_DIR=/data。",
      "测试静态断言 Dockerfile 包含 VOLUME /data 且 DATA_DIR=/data。",
      "README 的运行命令挂载 /data 数据卷并说明重启持久化。"
    ]);
    expect(routes.filter((route) => route.path === "/data")).toEqual([]);
  });

  it("裸的 `/api/...` 仍然收（业务路由的通行写法）", () => {
    const routes = extractHttpRoutes([
      "src/router.js 暴露受保护路由注册点，/api/tasks 前缀在无 Authorization 头时返回 401。"
    ]);
    expect(routes).toContainEqual({ method: "GET", path: "/api/tasks" });
  });

  it("带方法的路径直接信任——AC 写 `GET /data` 就当它是路由", () => {
    const routes = extractHttpRoutes(["GET /data 返回原始数据"]);
    expect(routes).toContainEqual({ method: "GET", path: "/data" });
  });

  it("裸的 `/healthz` 仍被收取（由 businessRoutes 过滤，不进挂载判定）", () => {
    const routes = extractHttpRoutes(["健康端点 /healthz、/health 均返回 200"]);
    expect(routes.map((route) => route.path)).toEqual(["/healthz", "/health"]);
    expect(businessRoutes(routes)).toEqual([]);
  });
});

/**
 * N-54（`docs/232` §9.26）：全库 1901 条历史 AC 文本的普查发现两个同源的误判入口——
 *
 * 1. 通配族 `/api/*` 被字符类截成 `/api/`，再被去尾斜杠变成 `/api`，于是「受保护 /api/* 路由」
 *    这种散文被当成一个具体端点；
 * 2. 裸的 `/api` 是**挂载点**，不是端点，而「未实现健康端点、首页 HTML 与 /api 路由（留待后续切片）」
 *    这样的**否定句**同样会产出一条要探测的 `/api`。
 *
 * 实测后果：`S1-foundation` 切片的业务路由只有 `GET /api` 一条——只要它走到边界检查、而 `/api` 返回
 * 404，这个切片就会被单条 404 判死。以下四例用了普查里命中过的**原文**。
 */
describe("N-54 通配族与挂载点都不是端点", () => {
  it("`/api/*` 不产生路由（既不是具体地址，也不该被截成 `/api`）", () => {
    const routes = extractHttpRoutes([
      "用例名包含 [AC-11]：不带 Authorization 头、或头非 'Bearer ' 前缀访问受保护 /api/* 路由，返回 401",
      "静态断言 src/server.js 不含 /healthz、/health、/ready 与 /api/* 路由实现。",
      "测试名称包含 [AC-11]：不带 Authorization 头访问受保护 /api/* 路径 → 401。"
    ]);
    expect(routes.filter((route) => route.path === "/api" || route.path.includes("*"))).toEqual([]);
  });

  it("裸的 `/api` 挂载点不算业务端点（否定句也不例外）", () => {
    const routes = extractHttpRoutes([
      "未实现健康端点、首页 HTML 与 /api 路由（留待后续切片）。",
      "服务内不存在 /healthz、/health、/ready 与任何 /api 路由实现。"
    ]);
    expect(businessRoutes(routes)).toEqual([]);
  });

  it("裸的 `/api/<段>` 仍然收——这是业务路由的通行写法", () => {
    expect(extractHttpRoutes(["访问 /api/tasks 返回 401 UNAUTHORIZED"])).toContainEqual({
      method: "GET",
      path: "/api/tasks"
    });
  });

  it("显式方法的 `GET /api` 仍然信任（AC 明写就是端点声明）", () => {
    expect(extractHttpRoutes(["GET /api 返回路由索引"])).toContainEqual({
      method: "GET",
      path: "/api"
    });
  });
});
