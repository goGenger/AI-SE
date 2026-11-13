import { describe, expect, it } from "vitest";
import { isProjectManifestPath } from "./index";

/**
 * PL-M10（`docs/168`）：**唯一**的「这是不是一个工程清单/配置文件」判据。只判**仓库根级**条目。
 *
 * 它同时支撑两件事，因此与 `isTestFilePath` 同置于 shared：
 *  - `apps/server` 的写范围审计（原 `writeScopeAudit.ts` 内的 `CONFIG_PATH` 正则表）；
 *  - `@ai-se/agent-core` 的写权限（声明了 `writeProjectManifests` 的 agent 可写仓库根清单）。
 *
 * 修前两侧**互相矛盾**：审计早已把根级 `package.json` 判为 BACKEND 任务的合法写入，而强制侧的
 * 前缀白名单（`apps/server`、`server`、`backend`、`src`）把它全部拒绝——工程骨架任务因此写不出
 * `package.json`，L1-M4b run 1 在**第一个任务**上即致败。
 */

describe("isProjectManifestPath (PL-M10)", () => {
  it.each([
    ["package.json", true],
    ["package-lock.json", true],
    ["pnpm-lock.yaml", true],
    ["yarn.lock", true],
    ["tsconfig.json", true],
    ["tsconfig.base.json", true],
    ["requirements.txt", true],
    ["pyproject.toml", true],
    ["go.mod", true],
    ["Cargo.toml", true],
    ["vitest.config.ts", true],
    ["vite.config.mjs", true],
    ["eslint.config.js", true],
    ["jest.config.js", true],
    [".env", true],
    [".env.local", true],
    [".gitignore", true],
    [".eslintrc.json", true],
    [".prettierrc", true],
    [".prettierignore", true],
    [".npmrc", true],
    [".nvmrc", true],
    ["Makefile", true],
    ["./package.json", true],
    // 只判根级：同名文件出现在子目录里不是「仓库根清单」。
    ["src/package.json", false],
    ["apps/server/package.json", false],
    ["docs/tsconfig.json", false],
    // 非清单类：文档、源码、其他配置一律为假。
    ["README.md", false],
    ["index.js", false],
    ["probe.txt", false],
    [".dockerignore", false],
    ["package.json.bak", false],
    [".gitignore.bak", false],
    ["", false]
  ])("isProjectManifestPath(%s) => %s", (path, expected) => {
    expect(isProjectManifestPath(path)).toBe(expected);
  });

  it("treats windows separators the same as posix ones", () => {
    expect(isProjectManifestPath("package.json")).toBe(true);
    expect(isProjectManifestPath("src\\package.json")).toBe(false);
  });
});
