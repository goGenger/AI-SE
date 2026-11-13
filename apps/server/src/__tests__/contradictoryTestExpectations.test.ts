import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTRADICTORY_TEST_EXPECTATIONS,
  analyzeTestSource,
  contradictoryCiReplanHint,
  scanContradictoryTestExpectations
} from "../services/contradictoryTestExpectations";
import { LocalCiOperations } from "../services/deliveryAdapters";

/**
 * round18 反例骨架：加载期已设 filter=done + 关键字，成功态却先断言全量再断言子集。
 * （已人工修好的评估工作区文件在注释里说明了不得先断言全量 5 条。）
 */
const ROUND18_BAD = `
import { test, expect } from "vitest";
const SOURCE_TITLES = ["整理需求", "写设计稿", "实现前端", "整理数据", "写周报"];
function titles(_w: unknown): string[] { return []; }
test('[AC-11] 加载态到成功态', async () => {
  await Promise.resolve();
  // 互斥：同一段内对 titles 既要全量又要单条
  expect(titles(wrapper)).toEqual(SOURCE_TITLES);
  expect(titles(wrapper)).toEqual(["写设计稿"]);
});
`;

const ROUND18_FIXED = `
import { test, expect } from "vitest";
const SOURCE_TITLES = ["整理需求", "写设计稿", "实现前端", "整理数据", "写周报"];
function titles(_w: unknown): string[] { return []; }
async function clickFilter(_w: unknown, _n: string) {}
async function typeSearch(_w: unknown, _n: string) {}
test('[AC-11] 加载态到成功态', async () => {
  await clickFilter(wrapper, "done");
  await typeSearch(wrapper, "写");
  await Promise.resolve();
  expect(titles(wrapper)).toEqual(["写设计稿"]);
  await clickFilter(wrapper, "all");
  expect(titles(wrapper)).toEqual(["写设计稿", "写周报"]);
});
`;

const EMPTY_THEN_FILL_OK = `
import { test, expect } from "vitest";
test("empty then fill", async () => {
  expect(items(wrapper)).toHaveLength(0);
  pending.resolve(SOURCE);
  await flushPromises();
  expect(items(wrapper)).toHaveLength(5);
});
`;

const FILTER_THEN_FULL_OK = `
import { test, expect } from "vitest";
const SOURCE_TITLES = ["a", "b", "c", "d", "e"];
test("filter then restore", async () => {
  await clickFilter(wrapper, "done");
  expect(titles(wrapper)).toEqual(["写设计稿", "整理数据"]);
  await clickFilter(wrapper, "all");
  expect(titles(wrapper)).toEqual(SOURCE_TITLES);
});
`;

const LENGTH_VS_EQUAL_BAD = `
import { it, expect } from "vitest";
it("length fights equal", () => {
  expect(items(wrapper)).toHaveLength(5);
  expect(items(wrapper)).toEqual(["only-one"]);
});
`;


const ROUND19_REF_AND_SETFILTER_OK = `
import { test, expect } from "vitest";
test("[AC-11] keyword matching trims and lowercases both sides and blank input never filters", () => {
  const { keyword, visibleTasks } = setup();
  keyword.value = "  ReLeAsE  ";
  expect(ids(visibleTasks.value)).toEqual(["b1", "a2", "d4"]);
  keyword.value = "   ";
  expect(ids(visibleTasks.value)).toEqual(["b1", "a2", "c3", "d4"]);
  keyword.value = "fix";
  expect(ids(visibleTasks.value)).toEqual(["c3"]);
  keyword.value = "";
  expect(ids(visibleTasks.value)).toEqual(["b1", "a2", "c3", "d4"]);
});
`;

const ROUND19_SETFILTER_RESTORE_OK = `
import { test, expect } from "vitest";
test("[AC-14] filter all restores every row from done and active", () => {
  const { setFilter, visibleTasks } = setup();
  setFilter("done");
  expect(ids(visibleTasks.value)).toEqual(["a2", "d4"]);
  setFilter("active");
  expect(ids(visibleTasks.value)).toEqual(["b1", "c3"]);
  setFilter("all");
  expect(ids(visibleTasks.value)).toEqual(["b1", "a2", "c3", "d4"]);
});
`;

describe("analyzeTestSource（生成测试互斥期望）", () => {
  it("检出 round18 类：同一段 titles 全量 toEqual 与筛后子集 toEqual", () => {
    const findings = analyzeTestSource(ROUND18_BAD, "src/__tests__/bad.spec.ts");
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]?.code).toBe(CONTRADICTORY_TEST_EXPECTATIONS);
    expect(findings[0]?.subject).toContain("titles");
    expect(findings[0]?.detail).toMatch(/length 5 then 1|toEqual/);
  });

  it("修好的 AC-11：中间有 clickFilter，不误报", () => {
    expect(analyzeTestSource(ROUND18_FIXED)).toEqual([]);
  });

  it("合法先空态再填充（await 边界）不误报", () => {
    expect(analyzeTestSource(EMPTY_THEN_FILL_OK)).toEqual([]);
  });

  it("合法筛选后再恢复全量不误报", () => {
    expect(analyzeTestSource(FILTER_THEN_FULL_OK)).toEqual([]);
  });

  it("同一 subject 的 toHaveLength 与 toEqual 长度冲突也检出", () => {
    const findings = analyzeTestSource(LENGTH_VS_EQUAL_BAD);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toMatch(/length 5 then 1/);
  });


  it("真实 round18 修好文件（若本机评估工作区仍在）不误报；注入全量断言则检出", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const real =
      "/Users/shixianbao/Desktop/study/ai-se-eval/F1/run-1/src/__tests__/search-filter-four-states.spec.ts";
    if (!existsSync(real)) return;
    const fixed = readFileSync(real, "utf8");
    expect(analyzeTestSource(fixed, "search-filter-four-states.spec.ts")).toEqual([]);

    const bad = fixed.replace(
      `expect(has(wrapper, "loading-indicator")).toBe(false);
    expect(titles(wrapper)).toEqual(["写设计稿"]);`,
      `expect(has(wrapper, "loading-indicator")).toBe(false);
    expect(titles(wrapper)).toEqual(SOURCE_TITLES);
    expect(titles(wrapper)).toEqual(["写设计稿"]);`
    );
    const findings = analyzeTestSource(bad, "search-filter-four-states.spec.ts");
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]?.subject).toContain("titles");
    expect(findings[0]?.detail).toMatch(/length 5 then 1|toEqual/);
  });


  it("round19：多次 keyword.value= 切换不误报（ref 赋值是状态边界）", () => {
    expect(analyzeTestSource(ROUND19_REF_AND_SETFILTER_OK)).toEqual([]);
  });

  it("round19：多次 setFilter() 切换不误报", () => {
    expect(analyzeTestSource(ROUND19_SETFILTER_RESTORE_OK)).toEqual([]);
  });

  it("真实 round19 use-task-filtering.spec.ts（若仍在）不误报", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const real =
      "/Users/shixianbao/Desktop/study/ai-se-eval/F1/run-1/test/use-task-filtering.spec.ts";
    if (!existsSync(real)) return;
    expect(analyzeTestSource(readFileSync(real, "utf8"), "use-task-filtering.spec.ts")).toEqual([]);
  });

  it("not.toEqual 不参与互斥判定", () => {
    const source = `
      test("negated", () => {
        expect(titles(wrapper)).toEqual(["写设计稿"]);
        expect(titles(wrapper)).not.toEqual(SOURCE_TITLES);
      });
    `;
    expect(analyzeTestSource(source)).toEqual([]);
  });
});

describe("scanContradictoryTestExpectations（工作区）", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("扫到 __tests__ 下的 .spec.ts，跳过 node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-se-hygiene-"));
    dirs.push(root);
    mkdirSync(join(root, "src/__tests__"), { recursive: true });
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(root, "src/__tests__/bad.spec.ts"), ROUND18_BAD);
    writeFileSync(join(root, "node_modules/pkg/x.spec.ts"), ROUND18_BAD);
    const result = scanContradictoryTestExpectations(root);
    expect(result.scannedFiles).toBe(1);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings[0]?.file).toBe("src/__tests__/bad.spec.ts");
  });
});

describe("LocalCiOperations 接入（pnpm test 前早停）", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("static 适配器在发现互斥期望时 FAILED，且不依赖 pnpm test", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-se-ci-hygiene-"));
    dirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
    mkdirSync(join(root, "src/__tests__"), { recursive: true });
    writeFileSync(join(root, "src/__tests__/search-filter.spec.ts"), ROUND18_BAD);

    const adapter = new LocalCiOperations();
    const result = await adapter.runCi(
      {
        adapter: "static",
        workflowFile: "ci.yml",
        ref: "main",
        imageRepository: "unused/app"
      },
      {
        requestId: "r",
        taskId: "t",
        agentRunId: "a",
        toolCallId: "c",
        actor: "test",
        workspacePath: root,
        sandbox: {
          async runCommand() {
            throw new Error("sandbox unused");
          }
        }
      }
    );

    expect(result.status).toBe("FAILED");
    expect(result.error).toContain(CONTRADICTORY_TEST_EXPECTATIONS);
    expect(result.error).toContain("fail-fast before pnpm test");
    expect(result.logs.some((line) => line.includes("test-expectation-hygiene"))).toBe(true);
  });

  it("修好后的样例不触发早停（会继续走到 pnpm install；此处用缺脚本验证已越过门禁）", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-se-ci-hygiene-ok-"));
    dirs.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture-ok", private: true, scripts: {} })
    );
    mkdirSync(join(root, "src/__tests__"), { recursive: true });
    writeFileSync(join(root, "src/__tests__/ok.spec.ts"), ROUND18_FIXED);

    const adapter = new LocalCiOperations();
    const result = await adapter.runCi(
      {
        adapter: "static",
        workflowFile: "ci.yml",
        ref: "main",
        imageRepository: "unused/app"
      },
      {
        requestId: "r",
        taskId: "t",
        agentRunId: "a",
        toolCallId: "c",
        actor: "test",
        workspacePath: root,
        sandbox: {
          async runCommand() {
            throw new Error("sandbox unused");
          }
        }
      }
    );

    // 门禁放过；失败应来自后续 pnpm 步骤，而非 CONTRADICTORY_TEST_EXPECTATIONS
    expect(result.error ?? "").not.toContain(CONTRADICTORY_TEST_EXPECTATIONS);
    expect(result.logs.some((line) => line.includes("test-expectation-hygiene"))).toBe(false);
  });
});

describe("contradictoryCiReplanHint（门禁 P1：矛盾 → REPLAN 改测）", () => {
  it("错误信息含 CONTRADICTORY_TEST_EXPECTATIONS → fixTaskType=TEST", () => {
    const hint = contradictoryCiReplanHint(
      `${CONTRADICTORY_TEST_EXPECTATIONS}: 1 contradictory expectation(s) in generated tests (fail-fast before pnpm test)\nfile.ts:1`
    );
    expect(hint).toEqual({
      fixTaskType: "TEST",
      errorType: CONTRADICTORY_TEST_EXPECTATIONS
    });
  });

  it("普通 CI 失败不给改测提示（避免误伤）", () => {
    expect(contradictoryCiReplanHint("CI_FAILED: pnpm test exit 1")).toBeUndefined();
    expect(contradictoryCiReplanHint("")).toBeUndefined();
  });
});
