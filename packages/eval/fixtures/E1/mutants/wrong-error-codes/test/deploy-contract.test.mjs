// 部署契约静态测试（Dockerfile / README 的静态约定；运行时构建与容器验证由外部 oracle 执行）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const serverSource = readFileSync(join(root, "src", "server.mjs"), "utf8");

test("AC-24 Dockerfile 存在且可构建（静态约定：FROM + CMD）", () => {
  assert.match(dockerfile, /^FROM node:/m);
  assert.match(dockerfile, /CMD \[/);
});

test("AC-25 数据卷持久化约定（VOLUME /data + README 文档化）", () => {
  assert.match(dockerfile, /VOLUME \/data/);
  assert.match(readme, /data/);
});

test("AC-26 容器以非 root 用户运行（USER 指令非 root）", () => {
  assert.match(dockerfile, /^USER (?!root\b)\S+/m);
});

test("AC-29 日志输出到 stdout（无文件重定向约定）", () => {
  assert.match(serverSource, /console\.log/);
  assert.ok(!/>>?\s*\S*\.log/.test(dockerfile), "Dockerfile 不应重定向日志到文件");
});
