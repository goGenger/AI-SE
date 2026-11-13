import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GitHubActionsOperations,
  LocalDockerOperations,
  LocalStaticOperations
} from "../services/deliveryAdapters";

function context() {
  return {
    requestId: "request",
    taskId: "task",
    agentRunId: "run",
    toolCallId: "call",
    actor: "DeliveryOrchestrator",
    workspacePath: process.cwd(),
    sandbox: {
      async runCommand() {
        throw new Error("unused");
      }
    }
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("GitHub Actions delivery adapter", () => {
  it("dispatches and maps a successful immutable image", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ sha: "abcdef1234567890" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({
          workflow_runs: [
            {
              id: 42,
              status: "completed",
              conclusion: "success",
              head_branch: "main",
              head_sha: "abcdef1234567890",
              pull_requests: [{ number: 12 }],
              created_at: new Date().toISOString(),
              html_url: "https://github.com/example/app/actions/runs/42"
            }
          ]
        })
      );
    vi.stubGlobal("fetch", fetch);
    const adapter = new GitHubActionsOperations({ token: "test-token", pollIntervalMs: 1 });
    const result = await adapter.runCi(
      {
        repository: "https://github.com/example/app",
        workflowFile: "ci.yml",
        ref: "main",
        imageRepository: "ghcr.io/example/app"
      },
      context()
    );
    expect(result.status).toBe("SUCCESS");
    expect(result.image).toBe("ghcr.io/example/app:abcdef1234567890");
    expect(result.pullRequest).toBe(12);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("returns FAILED when GitHub Actions fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ sha: "deadbee" }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(
          Response.json({
            workflow_runs: [
              {
                id: 43,
                status: "completed",
                conclusion: "failure",
                head_branch: "main",
                head_sha: "deadbee",
                created_at: new Date().toISOString()
              }
            ]
          })
        )
    );
    const adapter = new GitHubActionsOperations({ token: "test-token", pollIntervalMs: 1 });
    const result = await adapter.runCi(
      {
        repository: "https://github.com/example/app",
        workflowFile: "ci.yml",
        ref: "main",
        imageRepository: "ghcr.io/example/app"
      },
      context()
    );
    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("failure");
  });
});

describe("LocalDocker 卷与环境变量（F1-7 / FX-21）", () => {
  let root: string;
  let record: string;
  let server: Server;
  let endpointPort: number;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ai-se-fake-docker-"));
    record = path.join(root, "record.txt");
    const script = path.join(root, "fake-docker.sh");
    await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${record}'\nexit 0\n`);
    await chmod(script, 0o755);
    server = createServer((req, res) => {
      if (req.url === "/health" || req.url === "/ready") {
        res.writeHead(200);
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    endpointPort = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  function operations(): LocalDockerOperations {
    return new LocalDockerOperations(path.join(root, "fake-docker.sh"));
  }

  function deployInput(overrides: Record<string, unknown> = {}) {
    return {
      deploymentId: "8f14e45f-ea9e-4b2f-a0da-3b1de19b8f0e",
      environment: "staging" as const,
      endpoint: `http://127.0.0.1:${endpointPort}`,
      image: "example/app:abc123",
      version: "v1",
      configuration: {
        containerName: "ai-se-volume-test",
        hostPort: endpointPort,
        containerPort: 3_000,
        ...overrides
      }
    };
  }

  it("按声明挂载卷与环境变量（-v / --env 进入 docker run）", async () => {
    const result = await operations().deploy(
      deployInput({
        volumes: ["/tmp/ai-se-data:/data:rw"],
        env: { DATA_DIR: "/data", APP_ENV: "staging" }
      }),
      context()
    );

    expect(result.status).toBe("SUCCESS");
    const lines = (await readFile(record, "utf8")).trim().split("\n");
    const runLine = lines.find((line) => line.startsWith("run -d"));
    expect(runLine).toContain("--volume /tmp/ai-se-data:/data:rw");
    expect(runLine).toContain("--env DATA_DIR=/data");
    expect(runLine).toContain("--env APP_ENV=staging");
    expect(runLine).toContain("-p " + endpointPort + ":3000");
  });

  it("非法卷/环境变量声明明确报错（不静默忽略）", async () => {
    await expect(
      operations().deploy(deployInput({ volumes: ["not-a-spec"] }), context())
    ).rejects.toThrow(/Invalid deployment volume/);
    await expect(
      operations().deploy(deployInput({ env: { "BAD KEY": "x" } }), context())
    ).rejects.toThrow(/Invalid deployment env key/);
    await expect(
      operations().deploy(deployInput({ env: { OK: "a\nb" } }), context())
    ).rejects.toThrow(/Invalid deployment env value/);
  });
});

/**
 * N-73（`docs/232` §10）：**static 适配器**——工作区优先的前端（无 git、无 Dockerfile）。
 *
 * DEPLOY 起 `npm start` 的静态预览，VERIFY 用真浏览器探这个已存在的 URL，按 testid 判定页面
 * 真的渲染了。这条用例把两步都跑一遍（真实子进程 + 真实 HTTP，无 Docker）。
 */
describe("LocalStaticOperations（N-73）", () => {
  const PLAYWRIGHT = path.resolve(process.cwd(), "../../packages/browser/node_modules");
  const BROWSER_AVAILABLE = existsSync(PLAYWRIGHT);

  function workspace(html: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ai-se-static-delivery-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "static-app", private: true, scripts: { start: "node server.js" } })
    );
    writeFileSync(
      join(dir, "server.js"),
      [
        "const http = require('node:http');",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "http.createServer((req, res) => {",
        "  res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});",
        "  res.end(fs.readFileSync(path.join(__dirname, 'index.html')));",
        "}).listen(Number(process.env.PORT), '127.0.0.1');"
      ].join("\n")
    );
    writeFileSync(join(dir, "index.html"), html);
    symlinkSync(PLAYWRIGHT, join(dir, "node_modules"), "dir");
    return dir;
  }

  async function port(): Promise<number> {
    return new Promise((done) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const value = (server.address() as { port: number }).port;
        server.close(() => done(value));
      });
    });
  }

  /** 测试收尾：杀掉监听该端口的预览进程（只认 LISTEN，避免误伤自己的客户端套接字）。 */
  function stopPreview(endpoint: string): void {
    const target = new URL(endpoint).port;
    const found = spawnSync("lsof", ["-ti", `tcp:${target}`, "-sTCP:LISTEN"], {
      encoding: "utf8"
    });
    for (const pid of String(found.stdout ?? "").split("\n")) {
      const value = pid.trim();
      if (!/^\d+$/.test(value)) continue;
      try {
        process.kill(Number(value), "SIGKILL");
      } catch {
        // 已经退出
      }
    }
  }

  it("deploy 起预览、verify 命中 testid ⇒ SUCCESS", async () => {
    const dir = workspace('<!doctype html><body><h1 data-testid="app-title">TaskBoard</h1></body>');
    const endpoint = `http://127.0.0.1:${await port()}`;
    const operations = new LocalStaticOperations();
    const base = { ...context(), workspacePath: dir };

    const deployed = await operations.deploy(
      {
        adapter: "static",
        deploymentId: randomUUID(),
        environment: "staging",
        endpoint,
        image: "static:v1",
        version: "v1",
        configuration: {}
      },
      base
    );
    expect(deployed.status).toBe("SUCCESS");

    const verified = await operations.verify(
      {
        adapter: "static",
        deploymentId: randomUUID(),
        environment: "staging",
        endpoint,
        image: "static:v1",
        version: "v1",
        configuration: { testIds: ["app-title"] }
      },
      base
    );
    try {
      expect(verified.status).toBe("SUCCESS");
      expect(verified.healthCheck.present).toContain("app-title");
    } finally {
      stopPreview(endpoint);
    }
  }, 90_000);

  it.skipIf(!BROWSER_AVAILABLE)(
    "required 一个都不在 ⇒ verify 失败（页面起得来但没有该元素）",
    async () => {
      const dir = workspace("<!doctype html><body><h1>no testids here</h1></body>");
      const endpoint = `http://127.0.0.1:${await port()}`;
      const operations = new LocalStaticOperations();
      const base = { ...context(), workspacePath: dir };
      await operations.deploy(
        {
          adapter: "static",
          deploymentId: randomUUID(),
          environment: "staging",
          endpoint,
          image: "static:v1",
          version: "v1",
          configuration: {}
        },
        base
      );
      const verified = await operations.verify(
        {
          adapter: "static",
          deploymentId: randomUUID(),
          environment: "staging",
          endpoint,
          image: "static:v1",
          version: "v1",
          configuration: { testIds: ["app-title"] }
        },
        base
      );
      stopPreview(endpoint);
      expect(verified.status).toBe("FAILED");
      expect(verified.error).toContain("none of the required elements");
    },
    90_000
  );
});
