#!/usr/bin/env node
// 轻量自检：对 src/ 下全部 .mjs 执行 node --check（语法），并做基础卫生扫描。
// 说明：零依赖 Node 项目的 lint / typecheck / build 允许为轻量自检脚本（退出码 0 即通过）；
// 该取舍与 P0 夹具模板（S1）的 `node --check` 先例一致。
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const files = readdirSync(srcDir)
  .filter((name) => name.endsWith(".mjs"))
  .sort();

let failures = 0;
for (const file of files) {
  const fullPath = join(srcDir, file);
  try {
    execFileSync(process.execPath, ["--check", fullPath], { stdio: "pipe" });
  } catch (error) {
    failures += 1;
    console.error(`syntax: ${file}`);
    console.error(String(error.stderr ?? error.message));
  }
  const text = readFileSync(fullPath, "utf8");
  if (text.includes("eval(")) {
    failures += 1;
    console.error(`hygiene: ${file} 含 eval(`);
  }
}

if (failures > 0) {
  console.error(`check 失败：${failures} 项`);
  process.exit(1);
}
console.log(`check ok：${files.length} 个源文件（syntax + hygiene）`);
