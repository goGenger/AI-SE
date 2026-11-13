import { AcceptanceCriterion, Requirement, TaskPlan } from "@ai-se/shared";
import { PlanningSliceScope } from "./PlanningState";

/**
 * F1-1 / FX-03 回归夹具 R2：E-2b 批次 S1（slugify）slice-1 重规划 v4 的真实计划快照。
 * 来源：2026-10-07 平台库 tasks（requirement 744d3321-b9b8-45eb-bc3e-eeef66284fe4，version=4，
 * slice_key=slice-1）与 requirement_acceptance_criteria（source=llm，11 条）。修复前该计划
 * acKeys 全空、N4/覆盖校验整体空转（先实现后测试被放行）；修复后回放必须得到 PLAN_ACKEYS_MISSING。
 * summary 与时间戳未经原样入库，按计划形状重建（仅元数据）。
 */

export const s1Requirement: Requirement = {
  id: "744d3321-b9b8-45eb-bc3e-eeef66284fe4",
  projectId: "e8800662-cc7d-467e-b0ea-94ab63073ff5",
  title: "S1",
  description: "实现 slugify 文本转 slug",
  rawContent:
    '实现 src/slugify.mjs 中的 slugify(text) 函数，把任意文本转成 URL 友好的 slug，规则：\n1) 转小写；\n2) 去掉首尾空白；\n3) 任何空白连续段（空格/制表/换行）转成一个连字符 -；\n4) 除 Unicode 字母与数字以及连字符外的其它字符也转成连字符（例如 _ . / 等）；\n5) 连续多个连字符合并成一个；\n6) 去掉首尾多余的连字符；\n7) 空串或只有空白/符号的输入返回空字符串 ""。\n保留 Unicode 字母与数字（例如中文"标题"要原样保留）。\n完成后 `pnpm test` 必须全部通过，且 `pnpm build`、`pnpm lint` 无错误。',
  status: "ANALYZED",
  version: 1,
  createdAt: "2026-10-07T08:08:42.695Z",
  updatedAt: "2026-10-07T12:59:19.108Z"
};

export const s1v4SliceScope: PlanningSliceScope = {
  key: "slice-1",
  title: "Core slugify normalization and Unicode preservation",
  goal: "Implement the primary slugify transformation pipeline in src/slugify.mjs: lowercase input, trim outer whitespace, convert whitespace runs and disallowed symbols to hyphens, and preserve Unicode letters and digits such as Chinese characters.",
  frKeys: ["FR-1", "FR-2", "FR-3", "FR-4", "FR-8"]
};

/** N3 库记录（source=llm；无编号 PRD 的提取结果，frKeys 为空、优先级为空）。 */
export const s1v4StoredCriteria: AcceptanceCriterion[] = [
  {
    acKey: "AC-01",
    text: "slugify('  Hello World  ') returns 'hello-world'.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-02",
    text: "slugify('Hello   World') returns 'hello-world'.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-03",
    text: "slugify('a_b.c/d') returns 'a-b-c-d'.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-04",
    text: "slugify('--a---b--') returns 'a-b'.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-05",
    text: "slugify('标题 测试') returns '标题-测试'.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-06",
    text: "slugify('') returns ''.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-07",
    text: "slugify('   ') returns ''.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-08",
    text: "slugify('___...///') returns ''.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-09",
    text: "pnpm test exits successfully with all tests passing.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-10",
    text: "pnpm build exits without errors.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-11",
    text: "pnpm lint exits without errors.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  }
];

export const s1v4Plan: TaskPlan = {
  summary: "Replay fixture: S1 slice-1 replan v4 (slugify normalization; acKeys all empty).",
  tasks: [
    {
      id: "T1",
      title: "Design slugify normalization pipeline and module contract",
      description:
        "Specify the module contract for src/slugify.mjs and the exact ordered normalization pipeline: lowercase, trim outer whitespace, replace whitespace runs with hyphens, replace disallowed characters with hyphens while preserving Unicode letters/digits, collapse consecutive hyphens, trim leading/trailing hyphens, and return empty string for empty/whitespace/symbol-only input. Define the Unicode-aware regex strategy using \\p{L} and \\p{N} property escapes.",
      type: "DESIGN",
      priority: "HIGH",
      dependencies: [],
      estimatedComplexity: 2,
      acceptanceCriteria: [
        "Module contract documented: named export slugify(text) -> string in src/slugify.mjs.",
        "Ordered pipeline documented and aligned with FR-1, FR-2, FR-3, FR-4, FR-8 and TS-1 through TS-6.",
        "Regex strategy documented: /\\s+/g, /[^\\p{L}\\p{N}-]/gu, /-+/g, and /^-+|-+$/g.",
        "Unicode preservation approach explicitly covers Chinese characters such as 标题."
      ],
      sourceSpecTypes: ["TECHNICAL", "FUNCTIONAL"]
    },
    {
      id: "T2",
      title: "Implement slugify core transformation in src/slugify.mjs",
      description:
        "Create or update src/slugify.mjs to export a synchronous pure function slugify(text) implementing the designed pipeline: lowercase, trim, convert whitespace runs to hyphens, convert disallowed symbols to hyphens while preserving Unicode letters and digits, collapse consecutive hyphens, remove leading/trailing hyphens, and return '' for empty or symbol-only results.",
      type: "BACKEND",
      priority: "HIGH",
      dependencies: ["T1"],
      estimatedComplexity: 4,
      acceptanceCriteria: [
        "src/slugify.mjs exists and exports named function slugify(text).",
        "slugify('  Hello World  ') returns 'hello-world'.",
        "slugify('Hello   World') returns 'hello-world'.",
        "slugify('a_b.c/d') returns 'a-b-c-d'.",
        "slugify('--a---b--') returns 'a-b'.",
        "slugify('标题 测试') returns '标题-测试'.",
        "slugify('') returns ''.",
        "slugify('   ') returns ''.",
        "slugify('___...///') returns ''.",
        "Implementation is synchronous, pure, and has no side effects."
      ],
      sourceSpecTypes: ["FUNCTIONAL", "TECHNICAL"]
    },
    {
      id: "T3",
      title: "Write unit tests for core normalization and Unicode preservation",
      description:
        "Add automated tests covering the primary slugify behavior for FR-1, FR-2, FR-3, FR-4, and FR-8: lowercase conversion, outer whitespace trimming, contiguous whitespace to single hyphen, disallowed symbols to hyphen, and preservation of Unicode letters/digits including Chinese characters.",
      type: "TEST",
      priority: "HIGH",
      dependencies: ["T2"],
      estimatedComplexity: 3,
      acceptanceCriteria: [
        "Tests cover lowercase: slugify('ABC') -> 'abc' and slugify('Hello World') -> 'hello-world'.",
        "Tests cover trim: slugify('  Hello World  ') -> 'hello-world'.",
        "Tests cover whitespace runs including spaces, tabs, and newlines: slugify('a\\tb') -> 'a-b', slugify('a\\nb') -> 'a-b'.",
        "Tests cover disallowed symbols: slugify('a_b.c/d') -> 'a-b-c-d' and slugify('foo+bar=baz') -> 'foo-bar-baz'.",
        "Tests cover Unicode preservation: slugify('标题 测试') -> '标题-测试' and slugify('中文123') -> '中文123'.",
        "All new tests pass via the project test command."
      ],
      sourceSpecTypes: ["FUNCTIONAL"]
    },
    {
      id: "T4",
      title: "Write edge-case and regression tests for slugify",
      description:
        "Add tests for edge cases and post-processing behavior: empty string, whitespace-only input, symbol-only input, consecutive hyphens, leading/trailing hyphens, and mixed whitespace/symbol inputs. Confirm the function returns empty string when the normalized result would be empty or hyphen-only.",
      type: "TEST",
      priority: "HIGH",
      dependencies: ["T2"],
      estimatedComplexity: 3,
      acceptanceCriteria: [
        "slugify('') returns ''.",
        "slugify('   ') returns ''.",
        "slugify('___...///') returns ''.",
        "slugify('--a---b--') returns 'a-b'.",
        "Consecutive hyphens are merged: slugify('a---b') returns 'a-b'.",
        "Leading and trailing hyphens are removed.",
        "Mixed whitespace and symbol inputs normalize to hyphen-separated tokens.",
        "All edge-case tests pass via the project test command."
      ],
      sourceSpecTypes: ["FUNCTIONAL", "TECHNICAL"]
    },
    {
      id: "T5",
      title: "Verify local build and lint after slugify implementation",
      description:
        "Run pnpm build and pnpm lint locally to ensure the new src/slugify.mjs implementation and tests do not introduce build or lint errors. This is a local verification task only; no CI or deployment pipeline is in scope.",
      type: "BUILD",
      priority: "MEDIUM",
      dependencies: ["T2", "T3", "T4"],
      estimatedComplexity: 2,
      acceptanceCriteria: [
        "pnpm build exits without errors.",
        "pnpm lint exits without errors.",
        "Any build or lint findings are either fixed or documented for follow-up."
      ],
      sourceSpecTypes: ["TECHNICAL"]
    },
    {
      id: "T6",
      title: "Review slugify implementation and tests",
      description:
        "Perform a code review of src/slugify.mjs and the associated tests against the requirement, functional spec, and technical spec. Verify normalization order, Unicode property escape usage, empty-result handling, and test coverage for FR-1, FR-2, FR-3, FR-4, and FR-8. Confirm the slice is ready.",
      type: "REVIEW",
      priority: "HIGH",
      dependencies: ["T3", "T4", "T5"],
      estimatedComplexity: 2,
      acceptanceCriteria: [
        "Implementation matches the designed ordered normalization pipeline.",
        "Unicode letters and digits are preserved as required, including Chinese characters.",
        "All acceptance criteria for FR-1, FR-2, FR-3, FR-4, and FR-8 are covered by tests.",
        "No blocking issues remain in src/slugify.mjs or the test files.",
        "Review is complete and the slice is ready for integration."
      ],
      sourceSpecTypes: ["FUNCTIONAL", "TECHNICAL"]
    }
  ]
};
