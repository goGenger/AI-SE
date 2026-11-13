import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeliveryOperations } from "@ai-se/tool-runtime";
import { LocalDockerOperations } from "../services/deliveryAdapters";

/**
 * F1-7（FX-21）真实 Docker 集成：部署配置声明的卷与环境变量按声明生效——容器重启后数据仍在
 * （E1 持久化 AC 的形态：数据目录挂宿主卷，重启不丢）。
 */

const runDockerTests = process.env.AI_SE_SKIP_DOCKER_TESTS !== "1";
const exec = promisify(execFile);

const IMAGE = "ai-se-volume-e2e:latest";

const APP_SERVER = `import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
const dir = process.env.DATA_DIR || "/tmp/default-data";
mkdirSync(dir, { recursive: true });
appendFileSync(dir + "/boots.log", "boot " + new Date().toISOString() + "\\n");
const port = Number(process.env.PORT || 3000);
createServer((req, res) => {
  if (req.url === "/health" || req.url === "/ready") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port);
`;

function contextLike(): Parameters<DeliveryOperations["deploy"]>[1] {
  return { signal: undefined } as unknown as Parameters<DeliveryOperations["deploy"]>[1];
}

describe.skipIf(!runDockerTests)("卷挂载跨重启保留（F1-7 / FX-21）", () => {
  let root: string;
  let dataDir: string;
  let appDir: string;
  const containers: string[] = [];

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ai-se-volume-e2e-"));
    dataDir = path.join(root, "data");
    appDir = path.join(root, "app");
    await mkdir(dataDir, { recursive: true });
    await mkdir(appDir, { recursive: true });
    await writeFile(path.join(appDir, "server.mjs"), APP_SERVER);
    await writeFile(
      path.join(appDir, "Dockerfile"),
      [
        "FROM node:22-bookworm",
        "WORKDIR /app",
        "COPY server.mjs .",
        'CMD ["node", "server.mjs"]',
        ""
      ].join("\n")
    );
    await exec("docker", ["build", "-t", IMAGE, appDir], { timeout: 120_000 });
  }, 150_000);

  afterAll(async () => {
    for (const name of containers) {
      await exec("docker", ["rm", "-f", name]).catch(() => undefined);
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("部署 → 重启 → 数据保留（卷 + 环境变量声明生效）", async () => {
    const operations = new LocalDockerOperations("docker");
    const hostPort = 37_800 + Math.floor(Math.random() * 200);
    const containerName = `ai-se-volume-${Date.now() % 100000}`;
    containers.push(containerName);

    const deployOnce = () =>
      operations.deploy(
        {
          deploymentId: "5c2f33aa-7f31-4a1b-b1e5-0f8a1d2c3b4a",
          environment: "staging",
          endpoint: `http://127.0.0.1:${hostPort}`,
          image: IMAGE,
          version: "v1",
          configuration: {
            containerName,
            hostPort,
            containerPort: 3_000,
            volumes: [`${dataDir}:/data:rw`],
            env: { DATA_DIR: "/data" }
          }
        },
        contextLike()
      );

    const first = await deployOnce();
    expect(first.status).toBe("SUCCESS");

    const before = (await readFile(path.join(dataDir, "boots.log"), "utf8")).trim();
    expect(before.split("\n")).toHaveLength(1);

    // 重启：同名再部署（内部先 rm -f 旧容器再 run）——数据目录经卷保留 → 追加第二行。
    const second = await deployOnce();
    expect(second.status).toBe("SUCCESS");

    const after = (await readFile(path.join(dataDir, "boots.log"), "utf8")).trim();
    expect(after.split("\n")).toHaveLength(2);
  }, 180_000);
});
