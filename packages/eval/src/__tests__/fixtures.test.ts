import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EvalFixture } from "../types";

const FIXTURES_DIR = join(resolve(__dirname, "../.."), "fixtures");

async function loadFixtures(): Promise<Array<{ name: string; fixture: EvalFixture }>> {
  const entries = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const loaded: Array<{ name: string; fixture: EvalFixture }> = [];
  for (const entry of entries) {
    const raw = await readFile(join(FIXTURES_DIR, entry.name, "fixture.json"), "utf8");
    loaded.push({ name: entry.name, fixture: JSON.parse(raw) as EvalFixture });
  }
  return loaded;
}

describe("fixtures 清单", () => {
  it("10 个夹具齐备：E1 + F1 + S3 / M3 / L2", async () => {
    const loaded = await loadFixtures();
    expect(loaded.map((item) => item.name)).toEqual([
      "E1",
      "F1",
      "L1",
      "L2",
      "M1",
      "M2",
      "M3",
      "S1",
      "S2",
      "S3"
    ]);
    const tiers: Record<string, number> = { E1: 0, F1: 0, S: 0, M: 0, L: 0 };
    for (const { fixture } of loaded) tiers[fixture.tier] += 1;
    expect(tiers).toEqual({ E1: 1, F1: 1, S: 3, M: 3, L: 2 });
  });

  it("每个夹具：id 与目录一致、需求文案充分、oracle 存在；S/M/L 校对模板脚本，E1/F1 校对隔离资产", async () => {
    const loaded = await loadFixtures();
    for (const { name, fixture } of loaded) {
      const dir = join(FIXTURES_DIR, name);
      expect(fixture.id).toBe(name);
      expect(fixture.requirementText.trim().length).toBeGreaterThan(40);

      const oraclePath = join(dir, fixture.oracle.args[0]);
      await expect(stat(oraclePath)).resolves.toBeTruthy();

      if (fixture.tier === "E1") {
        // E1：PRD 源文件与 fixture.json 一致（selfcheck 同样校验）、参考实现/变异版本齐备、
        // template 仅占位（prepareWorkspace 的 git 基线依赖）。
        await expect(readFile(join(dir, "prd.md"), "utf8")).resolves.toBe(fixture.requirementText);
        await expect(stat(join(dir, "reference", "package.json"))).resolves.toBeTruthy();
        const mutants = (await readdir(join(dir, "mutants"))).filter(
          (item) => !item.startsWith(".")
        );
        expect(mutants.filter((item) => item.endsWith(".md")).length).toBeGreaterThan(0);
        expect(mutants.filter((item) => !item.endsWith(".md")).length).toBeGreaterThanOrEqual(5);
        await expect(stat(join(dir, "template"))).resolves.toBeTruthy();
      } else if (fixture.tier === "F1") {
        // F1（docs/233）：PRD 源文件与 fixture.json 一致；reference / template / 两个 mutant 齐备。
        // 断言按名字点名，不按数量——mutant 是**反向门**的唯一证据，少一个就等于少一道门。
        await expect(readFile(join(dir, "prd.md"), "utf8")).resolves.toBe(fixture.requirementText);
        await expect(stat(join(dir, "template", "package.json"))).resolves.toBeTruthy();
        await expect(stat(join(dir, "reference", "package.json"))).resolves.toBeTruthy();
        for (const mutant of ["empty-shell", "no-console-clean"]) {
          await expect(stat(join(dir, "mutants", mutant, "package.json"))).resolves.toBeTruthy();
        }
      } else {
        const pkg = JSON.parse(await readFile(join(dir, "template", "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        };
        expect(Object.keys(pkg.scripts ?? {})).toEqual(
          expect.arrayContaining(["test", "build", "lint"])
        );
      }
    }
  });
});
