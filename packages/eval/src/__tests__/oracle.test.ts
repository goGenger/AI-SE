import { describe, expect, it } from "vitest";
import { judgeOracle, runOracle, workspaceFilePath } from "../oracle";
import { EvalFixture } from "../types";

const fixture: EvalFixture = {
  id: "S1",
  tier: "S",
  title: "t",
  requirementText: "r",
  oracle: { command: "node", args: ["oracle.mjs"] }
};

describe("judgeOracle", () => {
  it("退出码 0 才算通过", () => {
    expect(judgeOracle({ exitCode: 0 })).toBe(true);
    expect(judgeOracle({ exitCode: 1 })).toBe(false);
    expect(judgeOracle({ exitCode: null })).toBe(false);
  });
});

describe("runOracle", () => {
  it("以包目录为 cwd 启动，并追加目标工作区绝对路径参数", async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const commands = {
      run: async (command: string, args: string[], options?: { cwd?: string }) => {
        calls.push({ command, args, cwd: options?.cwd });
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    };

    const result = await runOracle(fixture, "/tmp/ws", commands, {
      packageDir: "/pkg",
      timeoutMs: 1000
    });

    expect(result.passed).toBe(true);
    expect(calls[0]).toEqual({ command: "node", args: ["oracle.mjs", "/tmp/ws"], cwd: "/pkg" });
  });

  it("退出码非 0 判不通过，并保留输出", async () => {
    const commands = {
      run: async () => ({ exitCode: 2, stdout: "boom", stderr: "detail" })
    };

    const result = await runOracle(fixture, "/tmp/ws", commands, {
      packageDir: "/pkg",
      timeoutMs: 1000
    });

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("boom");
    expect(result.output).toContain("detail");
  });
});

describe("workspaceFilePath", () => {
  it("拼接工作区内的相对路径", () => {
    expect(workspaceFilePath("/tmp/ws", "src/slugify.mjs")).toBe("/tmp/ws/src/slugify.mjs");
  });
});
