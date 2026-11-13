import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EvalFixture } from "../types";

/**
 * F1（`docs/233`）的结构不变量。
 *
 * 这些断言守的不是「文件在不在」，而是**同一件事只有一份定义**：
 * - mock 是输入契约，四份工作区（template / reference / 两个 mutant）必须逐字相同，否则
 *   某个变体悄悄改契约就能刷过 oracle；
 * - 锁文件必须相同，否则 `pnpm install --frozen-lockfile` 在其中一份上会失败；
 * - oracle 必须**逐条**覆盖 AC-01..AC-24，漏一条等于少一道门，重复一条等于读数失真。
 */

const FIXTURES_DIR = join(resolve(__dirname, "../.."), "fixtures");
const F1 = join(FIXTURES_DIR, "F1");
const WORKSPACES = ["template", "reference", "mutants/empty-shell", "mutants/no-console-clean"];

async function readWorkspaceFile(workspace: string, name: string): Promise<string> {
  return readFile(join(F1, workspace, name), "utf8");
}

describe("F1 结构不变量", () => {
  it("mock 契约四份逐字相同（它是输入契约，不是可改写品）", async () => {
    const files = await Promise.all(
      WORKSPACES.map((workspace) => readWorkspaceFile(workspace, "mock-server.mjs"))
    );
    for (const [index, content] of files.entries()) {
      expect(content, WORKSPACES[index]).toBe(files[0]);
    }
  });

  it("锁文件一致，依赖声明一致（脚本可以不同）", async () => {
    const locks = await Promise.all(
      WORKSPACES.map((workspace) => readWorkspaceFile(workspace, "pnpm-lock.yaml"))
    );
    for (const [index, content] of locks.entries()) {
      expect(content, WORKSPACES[index]).toBe(locks[0]);
    }

    const manifests = await Promise.all(
      WORKSPACES.map(
        async (workspace) =>
          JSON.parse(await readWorkspaceFile(workspace, "package.json")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          }
      )
    );
    for (const [index, manifest] of manifests.entries()) {
      expect(manifest.dependencies, WORKSPACES[index]).toEqual(manifests[0]?.dependencies);
      expect(manifest.devDependencies, WORKSPACES[index]).toEqual(manifests[0]?.devDependencies);
    }
  });

  it("oracle 逐条覆盖 AC-01..AC-24，各一次", async () => {
    const oracle = await readFile(join(F1, "oracle.mjs"), "utf8");
    const covered = [...oracle.matchAll(/check\(\s*"(AC-\d{2})"/g)].map((match) => match[1]);
    const expected = Array.from({ length: 24 }, (_, index) => `AC-${String(index + 1).padStart(2, "0")}`);
    expect([...covered].sort()).toEqual([...expected].sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("需求文案以 data-testid=\"名字\" 的形式点名元素（uiSmoke 只认这个形式）", async () => {
    // 写成散文（例如只写反引号里的名字）时 `extractTestIds` 取不到任何东西，边界门会
    // 恒记 `NO_TESTIDS` 跳过——那不是通过，是没跑。
    const fixture = JSON.parse(await readFile(join(F1, "fixture.json"), "utf8")) as EvalFixture;
    expect(fixture.tier).toBe("F1");
    expect(fixture.requirementText).toContain('data-testid="app-title"');
    expect(fixture.requirementText).toContain('data-testid="task-item"');
  });

  it("四个工作区都有可构建的工程骨架", async () => {
    for (const workspace of WORKSPACES) {
      for (const file of ["package.json", "index.html", "vite.config.ts", "tsconfig.json"]) {
        await expect(stat(join(F1, workspace, file)), `${workspace}/${file}`).resolves.toBeTruthy();
      }
      const src = await readdir(join(F1, workspace, "src"));
      expect(src, workspace).toEqual(expect.arrayContaining(["main.ts", "App.vue"]));
    }
  });
});

/**
 * `docs/235` §6.7：沙箱镜像用 seed 的 **lockfile** 精确预热前端依赖。
 *
 * 运行期是 `pnpm install --frozen-lockfile`——seed 与夹具差一个补丁版本就是 `ENOTCACHED`，
 * 而且失败发生在沙箱里（只能从 `smokeSkipped`/安装日志里看见）。所以两份必须逐字相同。
 */
describe("F1 与沙箱镜像 seed 的一致性", () => {
  const SEED = join(resolve(__dirname, "../../.."), "sandbox", "probes", "f1-stack");

  it("package.json 与 pnpm-lock.yaml 都与夹具的 template 逐字相同", async () => {
    for (const file of ["package.json", "pnpm-lock.yaml"]) {
      await expect(readFile(join(SEED, file), "utf8"), file).resolves.toBe(
        await readFile(join(F1, "template", file), "utf8")
      );
    }
  });
});
