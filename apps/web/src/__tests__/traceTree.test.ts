import type { TraceNode } from "@ai-se/shared";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import TraceTree from "@/components/TraceTree.vue";
import { traceNodeKey } from "@/viewmodels/workflowTraceViewModel";

/**
 * TF-M2 —— 追踪树组件的渲染契约（Vue SSR `renderToString`，与既有组件测试同一手法，
 * 未新增测试依赖）。只断言结构、语义与层级，不测交互：
 * `@retry` / `@toggle` 一类事件的真实点击行为在 SSR 下无法触发，
 * 折叠语义本身由 `workflowTraceViewModel.test.ts` 的纯函数测试覆盖。
 */

function node(
  kind: TraceNode["kind"],
  id: string,
  status: string,
  children: TraceNode[] = [],
  extra: Partial<TraceNode> = {}
): TraceNode {
  return { kind, id, label: `${kind}-${id}`, status, detail: {}, children, ...extra };
}

/** 组件根节点是 `<li>`，套进 `<ul>` 才是合法列表上下文。 */
async function renderTree(n: TraceNode, expanded: string[]): Promise<string> {
  const app = createSSRApp({ render: () => h("ul", [h(TraceTree, { node: n, expanded })]) });
  return renderToString(app);
}

const tree = node("workflow", "wf-1", "RUNNING", [
  node("task", "t-1", "SUCCESS", [
    node("agentRun", "ar-1", "succeeded", [node("toolCall", "tc-1", "succeeded")], {
      detail: { agentName: "backend-agent", attempt: 2, nested: { a: 1 } },
      durationMs: 185_000
    })
  ])
]);

describe("TraceTree —— 折叠与层级", () => {
  it("收起的有子节点节点：真实 button + aria-expanded=false，子树不渲染", async () => {
    const html = await renderTree(tree, []);
    expect(html).toContain("<button");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("展开工作流「workflow-wf-1」");
    // 子树整体不渲染：任务 / Agent 运行 / 工具调用都不在输出里
    expect(html).not.toContain("task-t-1");
    expect(html).not.toContain("agentRun-ar-1");
    expect(html).not.toContain("toolCall-tc-1");
  });

  it("展开的节点：aria-expanded=true，子节点按契约层级递归渲染", async () => {
    const html = await renderTree(tree, [
      traceNodeKey(tree),
      "task:t-1",
      "agentRun:ar-1"
    ]);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("收起工作流「workflow-wf-1」");
    expect(html).toContain("task-t-1");
    expect(html).toContain("agentRun-ar-1");
    expect(html).toContain("toolCall-tc-1");
    // 嵌套列表：每一层自己一个 <ul>，父子关系由结构表达
    expect((html.match(/<ul/g) || []).length).toBe(4);
  });

  it("中间层收起时只截断它自己的子树，兄弟层级不受影响", async () => {
    const html = await renderTree(tree, [traceNodeKey(tree), "task:t-1"]);
    expect(html).toContain("agentRun-ar-1");
    expect(html).not.toContain("toolCall-tc-1");
  });

  it("叶子节点不渲染折叠按钮，只留同宽空位（无 aria-expanded）", async () => {
    const html = await renderTree(node("toolCall", "tc-9", "succeeded"), []);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-expanded");
    expect(html).toContain("toolCall-tc-9");
  });
});

describe("TraceTree —— 节点内容", () => {
  it("渲染真实标签 + 类型 + 状态（中文标签，不原样渲染枚举）", async () => {
    const html = await renderTree(tree, [traceNodeKey(tree)]);
    expect(html).toContain("workflow-wf-1");
    expect(html).toContain("工作流");
    expect(html).toContain("运行中");
    expect(html).not.toContain(">RUNNING<");
  });

  it("detail 只渲染后端给的标量：嵌套对象被跳过，不展开、不臆造", async () => {
    const html = await renderTree(tree, [traceNodeKey(tree), "task:t-1", "agentRun:ar-1"]);
    expect(html).toContain("agentName");
    expect(html).toContain("backend-agent");
    expect(html).toContain("attempt");
    // `nested: { a: 1 }` 不是白名单标量，整行不出现
    expect(html).not.toContain("nested");
  });

  it("用时取 durationMs（工具调用回落到记录的 duration）", async () => {
    const html = await renderTree(tree, [traceNodeKey(tree), "task:t-1", "agentRun:ar-1"]);
    expect(html).toContain("3m 05s");
  });

  it("空 detail 不渲染行容器", async () => {
    const html = await renderTree(node("task", "t-x", "SUCCESS"), []);
    expect(html).not.toContain("<dl");
  });
});
