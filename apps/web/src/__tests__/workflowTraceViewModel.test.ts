import type { TraceNode, WorkflowTraceCounts } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  collectTraceCounts,
  defaultExpandedTraceNodeIds,
  toggleTraceNodeId,
  traceCountsLabel,
  traceDetailRows,
  traceNodeDurationLabel,
  traceNodeKey,
  traceNodeKindLabel,
  traceNodeStatusLabel,
  traceNodeStatusTone,
  visibleTraceNodeCount
} from "@/viewmodels/workflowTraceViewModel";

/**
 * TF-M1 / TF-02 / TF-03 —— 追踪树的纯逻辑。
 *
 * 断言的是 `Workflow → Task → AgentRun → ToolCall`（deployment 挂在产生它的任务下）的
 * **层级与遍历顺序**、默认折叠下的可见节点上界、以及各事实表状态词到标签 / 配色的复用。
 * 树本身由后端组装（`docs/150`），这里不重算第二份口径。
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

/** 一棵与真实运行同形的树：1 workflow → 2 task → (agentRun → toolCall×2) + deployment。 */
const root = node("workflow", "wf-1", "RUNNING", [
  node("task", "t-1", "SUCCESS", [
    node("agentRun", "ar-1", "succeeded", [
      node("toolCall", "tc-1", "succeeded", [], { durationMs: 1500 }),
      node("toolCall", "tc-2", "failed", [], { durationMs: 500 })
    ]),
    node("deployment", "dp-1", "SUCCESS")
  ]),
  node("task", "t-2", "RUNNING", [
    node("agentRun", "ar-2", "running", [node("toolCall", "tc-3", "running")])
  ])
]);

describe("traceNodeKey（跨表 ID 可能撞号，主键必须带 kind）", () => {
  it("是 `kind:id`", () => {
    expect(traceNodeKey({ kind: "task", id: "x" })).toBe("task:x");
    expect(traceNodeKey({ kind: "agentRun", id: "x" })).toBe("agentRun:x");
  });
});

describe("默认折叠策略（TF-03 规模可控）", () => {
  it("只展开 workflow 与 task 两层，agentRun / toolCall / deployment 收起", () => {
    expect(defaultExpandedTraceNodeIds(root)).toEqual(["workflow:wf-1", "task:t-1", "task:t-2"]);
  });

  it("按前序遍历给出顺序（父先于子，同层按 children 顺序）", () => {
    const nested = node("workflow", "w", "RUNNING", [
      node("task", "a", "SUCCESS", [node("task", "a-1", "SUCCESS")]),
      node("task", "b", "SUCCESS")
    ]);
    expect(defaultExpandedTraceNodeIds(nested)).toEqual([
      "workflow:w",
      "task:a",
      "task:a-1",
      "task:b"
    ]);
  });

  it("toggle 是纯函数：不改入参，展开 / 收起各一次回到原状", () => {
    const before = ["task:t-1"];
    const opened = toggleTraceNodeId(before, "agentRun:ar-1");
    expect(opened).toEqual(["task:t-1", "agentRun:ar-1"]);
    expect(before).toEqual(["task:t-1"]);
    expect(toggleTraceNodeId(opened, "agentRun:ar-1")).toEqual(["task:t-1"]);
  });
});

describe("visibleTraceNodeCount（TF-03 首屏节点数有上界）", () => {
  it("默认折叠下：根 + 两个任务 + 两个 Agent 运行 + 挂在展开任务下的部署 = 6", () => {
    // 折叠只藏住**自己的子树**：deployment 的父节点是任务（默认展开），所以它可见；
    // 三个 toolCall 的父节点是 Agent 运行（默认收起），所以它们不可见。
    expect(visibleTraceNodeCount(root, defaultExpandedTraceNodeIds(root))).toBe(6);
  });

  it("全部展开时等于整棵树的节点数", () => {
    const all = [
      "workflow:wf-1",
      "task:t-1",
      "agentRun:ar-1",
      "toolCall:tc-1",
      "toolCall:tc-2",
      "deployment:dp-1",
      "task:t-2",
      "agentRun:ar-2",
      "toolCall:tc-3"
    ];
    expect(visibleTraceNodeCount(root, all)).toBe(9);
  });

  it("根节点收起时只剩它自己", () => {
    expect(visibleTraceNodeCount(root, [])).toBe(1);
  });
});

describe("collectTraceCounts（TF-02 计数校验；展示口径仍是后端 view.counts）", () => {
  it("逐类统计与树一致，workflow 根节点不计入任何一类", () => {
    expect(collectTraceCounts(root)).toEqual({
      tasks: 2,
      agentRuns: 2,
      toolCalls: 3,
      deployments: 1
    });
  });

  it("在 docs/153 记录的真实规模上：19 / 16 / 503 / 0", () => {
    const counts: WorkflowTraceCounts = {
      tasks: 19,
      agentRuns: 16,
      toolCalls: 503,
      deployments: 0
    };
    const perRun = Math.floor(counts.toolCalls / counts.agentRuns);
    const remainder = counts.toolCalls % counts.agentRuns;
    const big = node(
      "workflow",
      "wf-big",
      "SUCCESS",
      Array.from({ length: counts.tasks }, (_, t) =>
        node("task", `t-${t}`, "SUCCESS", [
          ...(t < counts.agentRuns
            ? [
                node(
                  "agentRun",
                  `ar-${t}`,
                  "succeeded",
                  Array.from({ length: perRun + (t < remainder ? 1 : 0) }, (_, c) =>
                    node("toolCall", `tc-${t}-${c}`, "succeeded")
                  )
                )
              ]
            : [])
        ])
      )
    );
    expect(collectTraceCounts(big)).toEqual(counts);

    // 默认折叠下首屏只渲染根 + 19 个任务 + 16 个 Agent 运行；503 个工具调用要展开才出现。
    const visible = visibleTraceNodeCount(big, defaultExpandedTraceNodeIds(big));
    expect(visible).toBe(1 + counts.tasks + counts.agentRuns);
    expect(visible).toBeLessThan(50);
  });

  it("counts 摘要文案取自后端计数对象，四类各带中文标签", () => {
    expect(
      traceCountsLabel({ tasks: 19, agentRuns: 16, toolCalls: 503, deployments: 0 })
    ).toBe("任务 19 · Agent 运行 16 · 工具调用 503 · 部署 0");
  });
});

describe("节点类型与状态展示（复用各事实表既有映射，不另立枚举）", () => {
  it("类型标签", () => {
    expect(traceNodeKindLabel("workflow")).toBe("工作流");
    expect(traceNodeKindLabel("agentRun")).toBe("Agent 运行");
    expect(traceNodeKindLabel("toolCall")).toBe("工具调用");
    expect(traceNodeKindLabel("deployment")).toBe("部署");
  });

  it("同一状态词在不同类型下走各自的既有映射", () => {
    // SUCCESS 在四类里都存在，标签一致但都要经过各表自己的映射
    expect(traceNodeStatusLabel({ kind: "task", status: "SUCCESS" })).toBe(
      traceNodeStatusLabel({ kind: "deployment", status: "SUCCESS" })
    );
    // AgentRun / ToolCall 用各自的小写枚举
    expect(traceNodeStatusLabel({ kind: "agentRun", status: "succeeded" })).toBe("已成功");
    expect(traceNodeStatusTone({ kind: "agentRun", status: "timed_out" })).toBe("warning");
    expect(traceNodeStatusTone({ kind: "task", status: "FAILED" })).toBe("error");
    expect(traceNodeStatusTone({ kind: "deployment", status: "ROLLED_BACK" })).toBe("neutral");
    expect(traceNodeStatusTone({ kind: "workflow", status: "WAITING_APPROVAL" })).toBe("warning");
  });

  it("未知状态词原样显示，不渲染 undefined、不误判成 success", () => {
    expect(traceNodeStatusLabel({ kind: "task", status: "SOMETHING_NEW" })).toBe("SOMETHING_NEW");
    expect(traceNodeStatusTone({ kind: "task", status: "SOMETHING_NEW" })).toBe("neutral");
  });
});

describe("traceNodeDurationLabel", () => {
  it("优先用后端给的 durationMs", () => {
    expect(traceNodeDurationLabel({ durationMs: 1500 })).toBe("1s");
    expect(traceNodeDurationLabel({ durationMs: 500 })).toBe("<1s");
    expect(traceNodeDurationLabel({ durationMs: 185_000 })).toBe("3m 05s");
  });

  it("没有 durationMs 时退回两端时间戳；未结束 → 进行中", () => {
    expect(
      traceNodeDurationLabel({ startedAt: "2026-10-15T00:00:00.000Z", finishedAt: "2026-10-15T00:01:00.000Z" })
    ).toBe("1m 00s");
    expect(traceNodeDurationLabel({ startedAt: "2026-10-15T00:00:00.000Z" })).toBe("进行中");
    expect(traceNodeDurationLabel({})).toBe("—");
  });
});

describe("traceDetailRows（只呈现后端白名单标量，不补工具输入 / 输出）", () => {
  it("标量原样成行，保持后端给出的字段顺序", () => {
    expect(
      traceDetailRows({ agentName: "backend-agent", attempt: 2, retried: false })
    ).toEqual([
      { label: "agentName", value: "backend-agent" },
      { label: "attempt", value: "2" },
      { label: "retried", value: "false" }
    ]);
  });

  it("null 显示为「—」，嵌套对象 / 数组不展开（契约只给标量）", () => {
    expect(
      traceDetailRows({ finishedAt: null, nested: { a: 1 }, list: [1, 2], toolName: "read_file" })
    ).toEqual([
      { label: "finishedAt", value: "—" },
      { label: "toolName", value: "read_file" }
    ]);
  });

  it("空 detail → 空数组（不渲染空的行容器）", () => {
    expect(traceDetailRows({})).toEqual([]);
  });
});
