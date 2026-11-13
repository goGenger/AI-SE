import { describe, expect, it } from "vitest";
import { isTestFilePath } from "./index";

/**
 * PL-M5（`docs/158` §3）：**唯一**的「这是不是一个测试文件」判据。
 * 它同时支撑两件事，因此上移到 shared：
 *  - `apps/server` 的防篡改（受保护测试文件快照比对）；
 *  - `@ai-se/agent-core` 的写权限（以写测试为职责的 agent 可写**任意位置**的测试文件）。
 *
 * 核心用例是 `src/__tests__/…`：白名单前缀匹配覆盖不到它，而它正是本仓库自己的测试规范
 * （`AGENTS.md` §5/§6），也正是 run 2 里 QA agent 写不进去的那一类路径。
 */

describe("isTestFilePath (PL-M5)", () => {
  it.each([
    ["src/__tests__/todo.test.ts", true],
    ["apps/web/src/__tests__/y.test.ts", true],
    ["src/components/Widget.test.tsx", true],
    ["api.spec.ts", true],
    ["test/z.test.js", true],
    ["tests/helpers/util.mjs", true],
    ["./test/data.json", true],
    ["src/index.ts", false],
    ["src/server.ts", false],
    ["probe.txt", false],
    ["README.md", false],
    ["", false],
    ["node_modules/pkg/test/foo.test.js", false],
    ["dist/out.test.js", false],
    ["coverage/lcov-report/index.html", false],
    [".next/static/chunk.test.js", false],
    [".git/hooks/pre-commit.test.sh", false]
  ])("isTestFilePath(%s) => %s", (path, expected) => {
    expect(isTestFilePath(path)).toBe(expected);
  });

  it("treats windows separators the same as posix ones", () => {
    expect(isTestFilePath("src\\__tests__\\todo.test.ts")).toBe(true);
    expect(isTestFilePath("src\\index.ts")).toBe(false);
  });
});
