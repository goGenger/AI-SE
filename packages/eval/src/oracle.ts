import { join } from "node:path";
import { EvalFixture } from "./types";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number }
  ): Promise<CommandResult>;
}

export interface OracleResult {
  passed: boolean;
  exitCode: number | null;
  output: string;
}

/** 判定：oracle 退出码为 0 才算通过（null = 未能启动/超时 → 不通过）。 */
export function judgeOracle(result: Pick<CommandResult, "exitCode">): boolean {
  return result.exitCode === 0;
}

/**
 * 以 cwd = 本包目录启动 oracle，并追加目标工作区绝对路径参数（oracle 读 process.argv[2]）。
 * oracle 只读工作区、不修改它。
 */
export async function runOracle(
  fixture: EvalFixture,
  workspacePath: string,
  commands: CommandRunner,
  options: { packageDir: string; timeoutMs: number }
): Promise<OracleResult> {
  const result = await commands.run(
    fixture.oracle.command,
    [...fixture.oracle.args, workspacePath],
    {
      cwd: options.packageDir,
      timeoutMs: options.timeoutMs
    }
  );
  const output = [result.stdout, result.stderr].filter((part) => part.trim() !== "").join("\n");
  return { passed: judgeOracle(result), exitCode: result.exitCode, output };
}

export function workspaceFilePath(workspacePath: string, relative: string): string {
  return join(workspacePath, relative);
}
