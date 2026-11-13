import { AcceptanceCriterion, Requirement, TaskPlan } from "@ai-se/shared";
import { PlanningSliceScope } from "./PlanningState";

/**
 * F1-2 / FX-04 回归夹具 R3：E-2b 批次 L1（静态站点生成器）slice-1-render-page 重规划 v5
 * 的真实计划快照（库导出：6 任务、acKeys 全空；AC 记录 8 条 source=llm）。
 * 修复前：acKeys 空 → 证据面失效 → 红灯 fail-closed（E-2b 实况）；修复后：确定性回填 → 覆盖完整。
 * summary 与时间戳按计划形状重建（仅元数据）。
 */

export const l1Requirement: Requirement = {
  id: "f78ac92d-6cfe-4a44-8159-b10dd9ab000e",
  projectId: "7e9e882c-01b1-463d-b1e2-1227c32ef241",
  title: "L1",
  description: "实现静态站点生成器（frontmatter + markdown-lite + 构建）",
  rawContent:
    '这是一个小型静态站点生成器，跨三个模块：src/frontmatter.mjs（已实现，解析 frontmatter，不要改动）、src/render.mjs（待实现 renderPage）、src/build.mjs（待实现 buildSite）。\n需要实现：\n1) renderPage(page)：page = { title, body }（body 是 markdown-lite 文本），返回完整 HTML 文档字符串：标题放进 <title> 与 <h1>；\n2) markdown-lite 规则（按行处理）：以 # 开头的行渲染成 <h2>（去掉 # 与首尾空白）；空行分段；其它连续行合并成一个 <p>（合并时用单个空格连接各行）；行内 [text](url) 渲染成 <a href="url">text</a>；\n3) 所有插入 HTML 的文本（标题、段落文本、链接文字）都要做 HTML 转义（& < > " \'），链接的 url 只做属性转义；\n4) buildSite(contentDir, outDir)：读取 contentDir 下所有 .md 文件（按文件名排序），每个 <name>.md 生成 <outDir>/<name>.html（页面标题取 frontmatter.title，缺省用文件名），并确保 outDir 存在；返回生成的文件名数组。\n完成后 `pnpm test` 必须全部通过，且 `pnpm build`、`pnpm lint` 无错误。',
  status: "ANALYZED",
  version: 1,
  createdAt: "2026-09-30T00:33:52.090Z",
  updatedAt: "2026-10-07T16:06:04.930Z"
};

export const l1v5SliceScope: PlanningSliceScope = {
  key: "slice-1-render-page",
  title: "Implement renderPage with markdown-lite and escaping",
  goal: "Implement renderPage to generate a complete HTML document from a page object, applying markdown-lite rules (headings, paragraphs, inline links) and proper HTML escaping for text and URLs.",
  frKeys: ["FR1", "FR2", "FR3"]
};

/** N3 库记录（source=llm；无编号 PRD 的提取结果，frKeys 为空、优先级为空）。 */
export const l1v5StoredCriteria: AcceptanceCriterion[] = [
  {
    acKey: "AC-01",
    text: "renderPage({ frontmatter: { title: 'Hello' }, body: '# Heading\\n\\nSome [link](http://example.com)' }) returns a valid HTML document string containing <title>Hello</title>, <h2>Heading</h2>, <p>Some <a href=\"http://example.com\">link</a></p>, and properly escaped text.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-02",
    text: "Text content escapes &, <, >, ' as &amp;, &lt;, &gt;, &#39; (or equivalent).",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-03",
    text: 'Link URLs escape only characters needed for attribute values (e.g., & as &amp;, " as &quot;), not all HTML entities.',
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-04",
    text: "buildSite(contentDir, outDir) generates one .html file per .md file, sorted by filename, and returns the list of generated filenames.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-05",
    text: "If a file has no frontmatter.title, the filename (without extension) is used as the title.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-06",
    text: "buildSite creates outDir if it does not exist.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-07",
    text: "pnpm test completes with all tests passing.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  },
  {
    acKey: "AC-08",
    text: "pnpm build and pnpm lint complete with no errors.",
    priority: null,
    verification: null,
    smoke: false,
    frKeys: []
  }
];

export const l1v5Plan: TaskPlan = {
  summary: "Replay fixture: L1 slice-1-render-page replan v5 (acKeys all empty).",
  tasks: [
    {
      id: "T1",
      title: "Design renderPage module and markdown-lite pipeline",
      description:
        "Define the internal structure of src/render.mjs: the exported renderPage function, the renderMarkdownLite processor, and the escapeHtmlText and escapeAttributeUrl helpers. Specify the exact escaping character sets, the fixed processing order (headings, then paragraph grouping, then inline links), and the complete HTML document shape with the escaped title placed in both <title> and <h1>. Confirm that src/frontmatter.mjs remains untouched.",
      type: "DESIGN",
      priority: "HIGH",
      dependencies: [],
      estimatedComplexity: 3,
      acceptanceCriteria: [
        'Design defines escapeHtmlText covering &, <, >, " and \' and escapeAttributeUrl covering only & and ".',
        "Design fixes the markdown-lite processing order as headings, then paragraph grouping, then inline link conversion.",
        "Design defines renderPage output as a complete HTML document with the escaped title in both <title> and <h1> and the rendered body fragment following the <h1>.",
        "Design explicitly states src/frontmatter.mjs and buildSite (src/build.mjs) are out of scope for this slice."
      ],
      sourceSpecTypes: ["ARCHITECTURE", "TECHNICAL", "FUNCTIONAL"]
    },
    {
      id: "T2",
      title: "Implement escapeHtmlText and escapeAttributeUrl helpers",
      description:
        'Add and use the two escaping helpers in src/render.mjs. escapeHtmlText replaces &, <, >, " and \' with &amp;, &lt;, &gt;, &quot; and &#39; (or equivalent entities) for all text inserted into element content. escapeAttributeUrl escapes only attribute-breaking characters, replacing & with &amp; and " with &quot;, while leaving all other URL characters unchanged.',
      type: "BACKEND",
      priority: "HIGH",
      dependencies: ["T1"],
      estimatedComplexity: 2,
      acceptanceCriteria: [
        "escapeHtmlText escapes &, <, >, \" and ' in a single pass without double-escaping.",
        'escapeAttributeUrl escapes & as &amp; and " as &quot; and preserves other characters such as /, ?, =, : and # verbatim.',
        "URLs are handled only by escapeAttributeUrl and are never passed through full text escaping.",
        "Helpers do not mutate their input and are usable from both renderPage and renderMarkdownLite."
      ],
      sourceSpecTypes: ["TECHNICAL", "FUNCTIONAL"]
    },
    {
      id: "T3",
      title: "Implement renderMarkdownLite body rendering",
      description:
        "Implement the markdown-lite processor used by renderPage. Split the body into lines; lines whose first non-whitespace character is '#' become escaped <h2> elements after removing the leading '#' and surrounding whitespace. Blank lines delimit paragraph groups; consecutive non-blank, non-heading lines are joined with a single space, escaped and emitted as one <p>. Within the resulting block text, inline [text](url) patterns become <a href=\"url\">text</a> with link text escaped as text and the URL escape only for attributes. Handle empty or blank-only bodies without emitting empty block elements.",
      type: "BACKEND",
      priority: "HIGH",
      dependencies: ["T1", "T2"],
      estimatedComplexity: 5,
      acceptanceCriteria: [
        "A line whose first non-whitespace character is '#' renders as <h2> with the leading '#' and surrounding whitespace removed and the heading text escaped.",
        "Consecutive non-blank, non-heading lines collapse into a single <p> with lines joined by one space, and runs of blank lines produce no empty <p> elements.",
        'Inline [text](url) renders as <a href="url">text</a> with link text escaped by escapeHtmlText and URL escaped by escapeAttributeUrl.',
        "Processing order is headings first, paragraph grouping second, inline links third, so heading lines are never absorbed into paragraphs.",
        "Empty body or body containing only blank lines returns no block elements."
      ],
      sourceSpecTypes: ["FUNCTIONAL", "TECHNICAL", "UI"]
    },
    {
      id: "T4",
      title: "Implement renderPage document assembly",
      description:
        "Implement and export renderPage from src/render.mjs. Accept a page object exposing title and body strings, escape the title with escapeHtmlText, assemble a complete HTML document containing <!DOCTYPE html> and <html>/<head>/<body> structure, place the escaped title in both <title> and <h1>, and insert the fragment returned by renderMarkdownLite after the <h1>.",
      type: "BACKEND",
      priority: "HIGH",
      dependencies: ["T1", "T2", "T3"],
      estimatedComplexity: 3,
      acceptanceCriteria: [
        "renderPage is exported from src/render.mjs and accepts a page object with a title and a body.",
        "The return value is a complete HTML document string including <!DOCTYPE html>, <html>, <head> and <body>.",
        "Both <title> and <h1> contain the HTML-escaped page title.",
        "The body region contains the renderMarkdownLite fragment in source order, after the <h1>.",
        "src/frontmatter.mjs is not modified and no buildSite behavior is implemented in this slice."
      ],
      sourceSpecTypes: ["FUNCTIONAL", "TECHNICAL", "UI"]
    },
    {
      id: "T5",
      title: "Add and run unit tests for escaping, markdown-lite and renderPage",
      description:
        'Add focused tests for this slice and run the project test command. Cover text escaping of &, <, >, " and \' in title, heading, paragraph and link text; URL attribute escaping that preserves non-attribute characters while escaping & and "; heading extraction; paragraph grouping and single-space joining; inline link conversion; empty body handling; and the fixed processing order. Verify the renderPage document contains the escaped title in both <title> and <h1> and the expected body fragment.',
      type: "TEST",
      priority: "HIGH",
      dependencies: ["T2", "T3", "T4"],
      estimatedComplexity: 4,
      acceptanceCriteria: [
        "Tests cover escaping of &, <, >, \" and ' in title, heading text, paragraph text and link text.",
        'Tests cover URL attribute escaping, asserting that & and " are escaped and that other URL characters remain unchanged.',
        "Tests cover heading rendering, paragraph grouping and joining, inline link rendering, empty body handling and block ordering.",
        "Tests verify renderPage returns a complete HTML document with the escaped title in both <title> and <h1>.",
        "pnpm test completes with all tests passing for this slice."
      ],
      sourceSpecTypes: ["FUNCTIONAL", "TECHNICAL"]
    },
    {
      id: "T6",
      title: "Review slice-1 renderPage implementation against FR1-FR3",
      description:
        "Review the implemented renderPage, renderMarkdownLite and escaping helpers against FR1, FR2 and FR3. Check the document shape, title placement, markdown-lite processing order, paragraph grouping and joining, inline link rendering, and the distinction between text escaping and URL attribute escaping. Confirm that no out-of-scope changes were made to src/frontmatter.mjs or src/build.mjs.",
      type: "REVIEW",
      priority: "HIGH",
      dependencies: ["T4", "T5"],
      estimatedComplexity: 3,
      acceptanceCriteria: [
        "Review confirms renderPage output shape and the escaped title appearing in both <title> and <h1>.",
        "Review confirms markdown-lite processing order and the heading, paragraph and inline link behaviors match FR2.",
        "Review confirms text escaping covers &, <, >, \" and ' while URL escaping covers only attribute-breaking characters, satisfying FR3.",
        "Review confirms src/frontmatter.mjs was not modified and no buildSite work is included in this slice.",
        "Review findings are recorded with any required follow-up changes identified."
      ],
      sourceSpecTypes: ["REQUIREMENT_ANALYSIS", "FUNCTIONAL", "TECHNICAL"]
    }
  ]
};
