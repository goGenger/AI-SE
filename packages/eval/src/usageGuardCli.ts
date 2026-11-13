/**
 * `usageGuard.ts` 的命令行出口。
 *
 * 从 stdin 读 `agent_runs.token_usage->>'input_tokens'` 的**原始值**（每行一个，psql `-t -A`
 * 的输出形态），打印剔除异常值后的和。守卫脚本只负责取数与管道，**判定口径只有
 * `usageGuard.ts` 一份**（调用方见 `packages/eval/scripts/lib/usage-guard.sh`）。
 *
 * Usage: printf '%s\n' "$raw_values" | tsx src/usageGuardCli.ts
 * NOTE: keep this file ASCII-only.
 */
import { sumSaneInputTokens } from "./usageGuard";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const values = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  process.stdout.write(String(sumSaneInputTokens(values)));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
