import { createPinia, type Pinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import { useAgentRunsStore } from "@/stores/agentRuns";
import AgentRunView from "@/views/AgentRunView.vue";

/**
 * AgentRunView 页面契约测试（布局重构：表格 + 分页 + 抽屉详情 + 弹窗新建；
 * 承接 Phase 8-B 结构迁移 + UX-03 Context / Trace / Failure）。
 *
 * 覆盖：页头「新建运行」触发器（DialogTrigger 语义）、创建表单（弹窗内容，经 Teleport 输出）、
 * 运行列表表格（7 列 / 业务上下文 / ID 降级与复制 / 操作列「详情 + 取消 + 复制 ID」）、
 * Table 内置分页（page-size=10 纯前端切片）、详情抽屉（`?run=` 深链接打开：执行摘要 / 执行轨迹 /
 * 最终结果与产出物 / 失败上下文 / 恢复 / Evidence）以及弹窗、抽屉的默认关闭态。
 *
 * SSR 下 onMounted / onUnmounted 不执行 ⇒ 不发起请求、不建立 SSE/轮询；
 * Store 状态由测试注入（不做 API mock）。真实 SSE / 取消交互由浏览器验证承担（见 docs/80）。
 * 弹窗与抽屉内容经 Reka DialogPortal 输出到 Teleport —— 本文件用 renderToString 的
 * ctx.teleports 收集（组件侧以 unmount-on-hide=false + portal force-mount 保证内容可见），
 * `all` = 页面主输出 + Teleport 内容。
 */

const DETAIL_PATH = "/agent-run?run=run-1";

function norm(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+/g, ">")
    .replace(/\s+</g, "<");
}

interface RenderResult {
  /** 页面主 SSR 输出（不含 Teleport 内容） */
  html: string;
  /** 主输出 + Teleport 内容（弹窗表单 / 详情抽屉所在） */
  all: string;
}

async function renderAgentRun(
  seed?: (pinia: Pinia) => void,
  initialPath = "/agent-run"
): Promise<RenderResult> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/agent-run", component: AgentRunView },
      { path: "/workflows/:id", component: { render: () => null } }
    ]
  });
  await router.push(initialPath);
  await router.isReady();

  const app = createSSRApp({ render: () => h(AgentRunView) });
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  seed?.(pinia);

  const ctx: { teleports?: Record<string, string> } = {};
  const raw = await renderToString(app, ctx);
  const teleports = Object.values(ctx.teleports ?? {}).join("\n");
  return { html: norm(raw), all: norm(`${raw}\n${teleports}`) };
}

/** 匹配文本按钮（在 norm 归一化输出上使用）。 */
function buttonPattern(text: string): RegExp {
  return new RegExp(`<button[^>]*>${text}</button>`, "g");
}

/** 判断按钮标签上是否存在 disabled 属性（避免命中 `disabled:` 工具类前缀）。 */
function hasDisabledAttr(button: string): boolean {
  return / disabled[\s>]/.test(button);
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    status: "succeeded",
    currentIteration: 5,
    maxIterations: 50,
    retryCount: 0,
    input: { taskKey: "T-001" },
    startedAt: "2026-09-14T03:04:05.000Z",
    finishedAt: "2026-09-14T03:06:05.000Z",
    createdAt: "2026-09-14T03:04:00.000Z",
    ...overrides
  };
}

/** UX-03：列表 DTO = AgentRun + 服务端解析的上下文。 */
function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    ...makeRun(),
    projectName: "Mini Todo",
    workflowRunId: "wf-1",
    requirementName: "Todo 管理系统",
    planningVersion: 1,
    taskKey: "T-004",
    taskTitle: "Error handling middleware",
    agentName: "backend-agent",
    agentType: "BACKEND",
    ...overrides
  };
}

const context = {
  projectName: "Mini Todo",
  workflow: { id: "wf-1", requirementName: "Todo 管理系统", planningVersion: 1 },
  task: {
    id: "task-1",
    taskKey: "T-004",
    title: "Error handling middleware",
    type: "BACKEND",
    status: "FAILED",
    origin: "RUNTIME",
    retryCount: 1
  },
  agentName: "backend-agent",
  agentType: "BACKEND",
  maxRetries: 2
};

function makeTool(overrides: Record<string, unknown> = {}) {
  return {
    id: "tool-row-1",
    agentRunId: "run-1",
    iteration: 3,
    toolCallId: "call-1",
    toolName: "read_file",
    input: { path: "src/app.ts" },
    output: { summary: "读取完成" },
    status: "succeeded",
    duration: 1250,
    startedAt: "2026-09-14T03:04:10.000Z",
    createdAt: "2026-09-14T03:04:10.000Z",
    ...overrides
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    agentRunId: "run-1",
    eventType: "agent_run_started",
    payload: {},
    createdAt: "2026-09-14T03:04:05.000Z",
    ...overrides
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    run: makeRun(),
    toolCalls: [makeTool()],
    events: [makeEvent()],
    context,
    recovery: null,
    artifacts: [],
    evidence: [],
    ...overrides
  };
}

function seedDetail(pinia: Pinia, overrides: Record<string, unknown> = {}) {
  const store = useAgentRunsStore(pinia);
  store.runs = [makeSummary() as never, makeSummary({ id: "run-2", status: "timed_out" }) as never];
  store.currentRun = detail(overrides) as never;
}

describe("AgentRunView — 布局重构（表格 + 分页 + 抽屉 + 弹窗）", () => {
  it("页头：「Agent 运行」标题 +「新建运行」触发器（aria 状态），表单位于弹窗（Teleport）内", async () => {
    const { html, all } = await renderAgentRun();
    expect(html).toMatch(/<h1[^>]*>Agent 运行/);
    expect(html).toMatch(/<button[^>]*>新建运行/);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-state="closed"');
    // 表单内容经 Teleport 渲染：不在页面本体
    expect(html).not.toContain('id="agent-run-task"');
    // 弹窗内：表单约束（label / rows / maxlength / DEFAULT_TASK）原样
    expect(all).toContain('for="agent-run-task"');
    expect(all).toContain(">任务</label>");
    expect(all).toContain('id="agent-run-task"');
    expect(all).toContain('rows="5"');
    expect(all).toContain('maxlength="2000"');
    expect(all).toContain("修复项目中的测试失败问题，并确保所有测试通过。");
    expect(all).toMatch(/>开始<\/button>/);
  });

  it("提交按钮 disabled 条件：任务非空且未创建时可点；创建中则禁用（原「创建运行」快捷入口已由触发器替代）", async () => {
    const idle = await renderAgentRun();
    const submit = idle.all.match(/<button[^>]*>开始<\/button>/);
    expect(submit, "应渲染开始按钮").not.toBeNull();
    expect(hasDisabledAttr(submit![0])).toBe(false);

    const creating = await renderAgentRun((pinia) => {
      useAgentRunsStore(pinia).creating = true;
    });
    expect(creating.all).toContain("创建中…");
    expect(creating.all).not.toMatch(/>开始<\/button>/);
    const creatingButtons = creating.all.match(/<button[^>]*>创建中…<\/button>/g) || [];
    expect(creatingButtons.length).toBe(1); // 弹窗提交按钮
    expect(hasDisabledAttr(creatingButtons[0] ?? "")).toBe(true);
    // 触发器不受 creating 影响（打开弹窗始终可用）
    const trigger = creating.html.match(/<button[^>]*>新建运行<\/button>/);
    expect(trigger, "应渲染新建运行触发器").not.toBeNull();
    expect(hasDisabledAttr(trigger![0])).toBe(false);
  });

  it("运行列表三态 + 表格 7 列 + 业务上下文（Agent/项目/工作流/任务）+ ID 降级与复制", async () => {
    const loading = await renderAgentRun((pinia) => {
      useAgentRunsStore(pinia).loading = true;
    });
    expect(loading.html).toContain('role="status"');
    expect(loading.html).toContain('aria-label="加载中"');
    expect(loading.html).not.toContain("正在加载 Agent 运行…");
    expect(loading.html).not.toContain("暂无 Agent 运行记录。");
    expect(loading.html).not.toContain("<table");

    const failed = await renderAgentRun((pinia) => {
      useAgentRunsStore(pinia).error = "Agent 运行失败";
    });
    expect(failed.html).toContain("Agent 运行失败");
    expect(failed.html).toContain('role="alert"');
    expect(failed.html).toContain("bg-danger-bg");
    expect(failed.html).toMatch(/<button[^>]*>(?:<!--\[-->)?重试/);
    // 错误优先于空态
    expect(failed.html).not.toContain("暂无 Agent 运行记录。");

    const empty = await renderAgentRun();
    expect(empty.html).toContain("暂无 Agent 运行记录。");
    expect(empty.html).not.toContain("<table");

    const list = await renderAgentRun((pinia) => seedDetail(pinia));
    expect(list.html).not.toContain("暂无 Agent 运行记录。");
    expect((list.html.match(/<th scope="col"/g) || []).length).toBe(5);
    for (const label of ["状态", "任务", "来源", "尝试 · 用时", "操作"]) {
      expect(list.html, `表头应包含 ${label}`).toContain(label);
    }
    expect((list.html.match(/<tr/g) || []).length).toBe(3); // 表头 1 + 数据 2
    // 状态
    expect(list.html).toContain("已成功");
    expect(list.html).toContain("已超时");
    // 业务上下文（W7：Agent / 项目 并进「任务」列的次行）
    expect(list.html).toContain("Agent：backend-agent");
    expect(list.html).toContain("后端"); // agentTypeLabel(BACKEND)
    expect(list.html).toContain("项目：Mini Todo");
    expect(list.html).toContain("工作流：Todo 管理系统");
    expect(list.html).toContain("任务：T-004 · Error handling middleware");
    expect(list.html).toContain("尝试 第 1 次尝试 · 用时");
    // ID 降级为 metadata + 可点复制（W7：不再是操作列里的按钮）
    expect(list.html).toContain("ID run-1");
    expect(list.html).toContain('aria-label="复制 ID run-1"');
    expect(list.html).toContain("点击复制完整 ID：run-1");
    // 不得复用 legacy class
    expect(list.html).not.toContain("run-list-item");
    expect(list.html).not.toContain('class="metric');
    expect(list.html).not.toContain("detail-list");
    expect(list.html).not.toContain('class="state');
  });

  it("Table 内置分页：page-size=10 只渲染第 1 页并显示「共 N 条」与页码控件", async () => {
    const { html } = await renderAgentRun((pinia) => {
      useAgentRunsStore(pinia).runs = Array.from(
        { length: 12 },
        (_, index) =>
          makeSummary({
            id: `run-${index + 1}`,
            taskTitle: `测试运行${String(index + 1).padStart(2, "0")}`
          }) as never
      );
    });
    expect(html).toContain("共 12 条");
    expect(html).toContain('aria-label="下一页"');
    expect((html.match(/<tr/g) || []).length).toBe(11); // 表头 + 第 1 页 10 行
    expect(html).toContain("测试运行01");
    expect(html).toContain("测试运行10");
    expect(html).not.toContain("测试运行11");
  });

  it("操作列：详情（每行）+ 行内可点 ID；「取消」仅活动运行渲染，cancelling 时禁用", async () => {
    const { html } = await renderAgentRun((pinia) => {
      const store = useAgentRunsStore(pinia);
      store.runs = [
        makeSummary({ id: "run-1", status: "succeeded" }) as never,
        makeSummary({ id: "run-2", status: "running", finishedAt: undefined }) as never
      ];
    });
    expect((html.match(buttonPattern("详情")) || []).length).toBe(2);
    expect((html.match(/aria-label="复制 ID /g) || []).length).toBe(2);
    // 操作列只剩「详情 / 取消」——ID 复制不再占按钮位（W7）
    expect((html.match(buttonPattern("复制")) || []).length).toBe(0);
    const cancelButtons = html.match(buttonPattern("取消")) || [];
    expect(cancelButtons.length).toBe(1); // 仅 running 行
    const cancelButton = cancelButtons[0] ?? "";
    expect(cancelButton).not.toBe("");
    expect(cancelButton).toContain("bg-danger"); // destructive variant
    expect(hasDisabledAttr(cancelButton)).toBe(false);

    const cancelling = await renderAgentRun((pinia) => {
      const store = useAgentRunsStore(pinia);
      store.runs = [
        makeSummary({ id: "run-2", status: "running", finishedAt: undefined }) as never
      ];
      store.cancelling = true;
    });
    expect(cancelling.html).toContain("取消中…");
    const busyButtons = cancelling.html.match(/<button[^>]*>取消中…<\/button>/g) || [];
    expect(busyButtons.length).toBe(1);
    expect(hasDisabledAttr(busyButtons[0] ?? "")).toBe(true);
    expect((cancelling.html.match(buttonPattern("取消")) || []).length).toBe(0);
  });

  it("详情抽屉（?run= 深链接）：执行摘要（目标 + 上下文链）+ 尝试·迭代 + ID 复制", async () => {
    const { all } = await renderAgentRun(
      (pinia) => seedDetail(pinia, { run: makeRun({ status: "running", finishedAt: undefined }) }),
      DETAIL_PATH
    );
    expect(all).toContain("执行摘要");
    // 目标（这次运行是为了完成什么）
    expect(all).toContain("Error handling middleware");
    for (const label of ["项目", "工作流", "任务", "开始时间", "耗时", "尝试 · 迭代"]) {
      expect(all, `应包含 ${label}`).toContain(label);
    }
    expect(all).toContain("Todo 管理系统 · v1");
    expect(all).toContain("T-004 · Error handling middleware");
    expect(all).toContain("第 1 次尝试 ·");
    expect(all).toContain("5 / 50");
    expect(all).toContain("复制 ID");
    expect(all).toContain(`ID run-1`);
  });

  it("详情抽屉：执行轨迹（工具调用 + 事件按时间升序、tool_call_* 事件去重、失败工具详情与锚点）", async () => {
    const { all } = await renderAgentRun(
      (pinia) =>
        seedDetail(pinia, {
          toolCalls: [
            makeTool(),
            makeTool({
              id: "tool-row-2",
              toolCallId: "call-2",
              toolName: "run_unit_test",
              status: "failed",
              duration: 90,
              error: { code: "TEST_ERROR", message: "断言失败" },
              output: undefined
            })
          ],
          events: [
            makeEvent(),
            makeEvent({
              id: "evt-2",
              eventType: "tool_call_finished",
              payload: { toolName: "read_file", status: "succeeded" },
              createdAt: "2026-09-14T03:04:11.000Z"
            }),
            makeEvent({
              id: "evt-3",
              eventType: "TASK_FAILED",
              taskId: "task-1",
              payload: { errorCode: "TEST_ERROR" },
              createdAt: "2026-09-14T03:05:00.000Z"
            }),
            makeEvent({
              id: "evt-4",
              eventType: "llm_retry",
              payload: { message: "This operation was aborted", errorCode: "LLM_ERROR" },
              createdAt: "2026-09-14T03:05:30.000Z"
            }),
            makeEvent({
              id: "evt-5",
              eventType: "agent_run_finished",
              payload: { status: "failed", errorCode: "TEST_ERROR" },
              createdAt: "2026-09-14T03:06:00.000Z"
            })
          ]
        }),
      DETAIL_PATH
    );
    expect(all).toContain("执行轨迹");
    // 工具节点（label 含工具名；summary 来自 output / error）
    expect(all).toContain("工具调用 · read_file");
    expect(all).toContain("读取完成");
    expect(all).toContain("工具调用 · run_unit_test");
    expect(all).toContain("断言失败");
    // 事件节点（摘要为业务描述；tool_call_* 事件不再重复渲染）
    expect(all).toContain("Agent 运行已开始");
    expect(all).toContain("模型调用重试");
    expect(all).toContain("失败");
    const toolRows = all.match(/工具调用 · /g) || [];
    expect(toolRows.length).toBe(2);
    // 工具详情 + 锚点（供「查看工具调用」跳转）
    expect(all).toContain("TEST_ERROR");
    expect(all).toContain('id="tool-call-1"');
    expect(all).toContain('id="tool-call-2"');
  });

  it("详情抽屉：长轨迹默认双头预览（最早 30 + 最近 30），中间可展开", async () => {
    const tools = Array.from({ length: 70 }, (_, index) =>
      makeTool({
        id: `tool-row-${index}`,
        toolCallId: `call-${index}`,
        iteration: index,
        toolName: `tool_${index}`
      })
    );
    const { all } = await renderAgentRun(
      (pinia) => seedDetail(pinia, { toolCalls: tools, events: [] }),
      DETAIL_PATH
    );
    expect(all).toContain("展开中间 10 条");
    // 最早的与最近的都在默认视图中
    expect(all).toContain("工具调用 · tool_0");
    expect(all).toContain("工具调用 · tool_69");
    // 中间的未被渲染
    expect(all).not.toContain("工具调用 · tool_35");
  });

  it("详情抽屉：最终结果三分支 + 产出物（既有 agent_artifacts）摘要与展开", async () => {
    const final = await renderAgentRun(
      (pinia) => seedDetail(pinia, { run: makeRun({ output: { finalResult: "全部测试通过" } }) }),
      DETAIL_PATH
    );
    expect(final.all).toContain("全部测试通过");
    expect(final.all).toContain("max-h-55");
    expect(final.all).toContain("whitespace-pre-wrap");
    expect(final.all).toContain("overflow-auto");
    expect(final.all).toContain("bg-muted");

    const errored = await renderAgentRun(
      (pinia) =>
        seedDetail(pinia, { run: makeRun({ status: "failed", error: { message: "沙箱超时" } }) }),
      DETAIL_PATH
    );
    expect(errored.all).toContain("沙箱超时");

    const pending = await renderAgentRun(
      (pinia) => seedDetail(pinia, { run: makeRun({ status: "created" }) }),
      DETAIL_PATH
    );
    expect(pending.all).toContain("等待中");
    // 终态无文本输出：显示说明而不是"等待中"
    const settled = await renderAgentRun((pinia) => seedDetail(pinia), DETAIL_PATH);
    expect(settled.all).toContain("本次运行没有文本输出（结构化结果见上）。");
    expect(settled.all).not.toContain("等待中");

    const withArtifacts = await renderAgentRun(
      (pinia) =>
        seedDetail(pinia, {
          artifacts: [
            {
              id: "artifact-1",
              type: "TEST_RESULT",
              name: "run_unit_test",
              createdAt: "2026-09-14T03:05:00.000Z",
              content: { stdout: "ok 1 - all tests pass" }
            }
          ]
        }),
      DETAIL_PATH
    );
    expect(withArtifacts.all).toContain("产出物（1）");
    expect(withArtifacts.all).toContain("run_unit_test");
    expect(withArtifacts.all).toContain("查看内容");
    expect(withArtifacts.all).toContain("ok 1 - all tests pass");
  });

  it("详情抽屉：失败上下文（类型 / 摘要 / 错误 / 任务跳转 / 工具锚点 / 尝试）；成功运行不渲染", async () => {
    const failed = await renderAgentRun(
      (pinia) =>
        seedDetail(pinia, {
          run: makeRun({
            status: "failed",
            retryCount: 1,
            error: { code: "TEST_ERROR", message: "Todo API integration test failed." }
          }),
          toolCalls: [
            makeTool({
              id: "tool-row-2",
              toolCallId: "call-2",
              toolName: "run_unit_test",
              status: "failed",
              error: { code: "TEST_ERROR", message: "Expected 201, received 500." }
            })
          ]
        }),
      DETAIL_PATH
    );
    expect(failed.all).toContain("失败上下文");
    expect(failed.all).toContain("测试失败（TEST_ERROR）");
    expect(failed.all).toContain("工具 run_unit_test 执行失败：Expected 201, received 500.");
    expect(failed.all).toContain("Todo API integration test failed.");
    expect(failed.all).toContain("T-004 · Error handling middleware");
    expect(failed.all).toContain("/workflows/wf-1");
    expect(failed.all).toContain("查看任务");
    expect(failed.all).toContain("查看工具调用");
    expect(failed.all).toContain('href="#tool-call-2"');
    expect(failed.all).toContain("第 2 次尝试");
    expect(failed.all).toContain("任务重试 1 / 2");

    const succeeded = await renderAgentRun(
      (pinia) => seedDetail(pinia, { run: makeRun({ error: undefined }) }),
      DETAIL_PATH
    );
    expect(succeeded.all).not.toContain("失败上下文");

    const timedOut = await renderAgentRun(
      (pinia) =>
        seedDetail(pinia, {
          run: makeRun({
            status: "timed_out",
            error: { code: "TIMEOUT_ERROR", message: "Agent run timed out" }
          })
        }),
      DETAIL_PATH
    );
    expect(timedOut.all).toContain("失败上下文");
    expect(timedOut.all).toContain("执行超时（TIMEOUT_ERROR）");
  });

  it("详情抽屉：恢复链路（策略 / 原因 / 任务级重试 / 诊断任务跳转）；未触发恢复时不渲染", async () => {
    const recovered = await renderAgentRun(
      (pinia) =>
        seedDetail(pinia, {
          recovery: {
            taskRetryCount: 1,
            maxRetries: 2,
            strategy: "REPLAN",
            reason: "TEST_ERROR",
            humanRequired: false,
            stalled: false,
            recoveryTask: {
              id: "task-9",
              taskKey: "T-006",
              title: "Diagnose failure",
              type: "DEBUG"
            }
          }
        }),
      DETAIL_PATH
    );
    expect(recovered.all).toContain("恢复");
    expect(recovered.all).toContain("重规划（REPLAN）");
    expect(recovered.all).toContain("任务级重试");
    expect(recovered.all).toContain("1 / 2");
    expect(recovered.all).toContain("T-006 · Diagnose failure");
    expect(recovered.all).toContain("查看恢复任务");

    const withoutRecovery = await renderAgentRun((pinia) => seedDetail(pinia), DETAIL_PATH);
    expect(withoutRecovery.all).not.toContain("查看恢复任务");
  });

  it("详情抽屉：任务失败但运行成功（解释行 + 任务结果 + Agent 结果 + 问题列表）", async () => {
    const { all } = await renderAgentRun(
      (pinia) =>
        seedDetail(pinia, {
          run: makeRun({
            output: {
              outcome: "FAILED",
              summary: "Failed to read git status",
              issues: [
                {
                  severity: "MEDIUM",
                  description: "工具 git_status 调用失败：Failed to read git status",
                  recommendation: "确认该工具调用失败是否影响交付结果；完整调用记录见运行轨迹。"
                }
              ]
            }
          }),
          context: {
            ...context,
            task: {
              ...context.task,
              status: "FAILED",
              outcome: "FAILED",
              summary: "Failed to read git status"
            }
          }
        } as never),
      DETAIL_PATH
    );

    // 工作流页任务失败 + 运行页显示成功 ⇒ 必须给出解释与任务结果
    expect(all).toContain("本次运行成功，但任务 T-004 最终未通过：Failed to read git status");
    expect(all).toContain("任务结果");
    expect(all).toContain("失败 · Agent 结果：失败");
    // 最终结果：Agent 自报结果徽标 + 问题列表（结构化结果的一部分）；终态无文本输出不再显示"等待中"
    expect(all).toContain("Agent 结果：失败");
    expect(all).toContain("问题（1）");
    expect(all).toContain("工具 git_status 调用失败：Failed to read git status");
    expect(all).toContain("确认该工具调用失败是否影响交付结果");
    expect(all).toContain("本次运行没有文本输出（结构化结果见上）。");
    expect(all).not.toContain("等待中");
    expect(all).toContain("查看任务");
  });

  it("详情抽屉：Evidence 仅有记录时渲染（验证状态 + 结果 + 时间）", async () => {
    const withEvidence = await renderAgentRun(
      (pinia) =>
        seedDetail(pinia, {
          evidence: [
            {
              id: "evidence-1",
              verification: { status: "VERIFIED", findings: [] },
              result: { status: "success" },
              createdAt: "2026-09-14T03:06:00.000Z"
            }
          ]
        }),
      DETAIL_PATH
    );
    expect(withEvidence.all).toContain("Evidence");
    expect(withEvidence.all).toContain("已验证");
    expect(withEvidence.all).toContain("结果：success");

    const without = await renderAgentRun((pinia) => seedDetail(pinia), DETAIL_PATH);
    expect(without.all).not.toContain(">Evidence<");
  });

  it("详情抽屉：取消按钮可见性由 isActiveRun 决定（active → 可见；终态 → 不渲染）", async () => {
    const active = await renderAgentRun(
      (pinia) => seedDetail(pinia, { run: makeRun({ status: "running", finishedAt: undefined }) }),
      DETAIL_PATH
    );
    const cancelButton = active.all.match(/<button[^>]*>取消<\/button>/);
    expect(cancelButton, "应渲染取消按钮").not.toBeNull();
    expect(cancelButton![0]).toContain("bg-danger"); // destructive variant
    expect(hasDisabledAttr(cancelButton![0])).toBe(false);

    const cancelling = await renderAgentRun((pinia) => {
      seedDetail(pinia, { run: makeRun({ status: "cancelling", finishedAt: undefined }) });
      useAgentRunsStore(pinia).cancelling = true;
    }, DETAIL_PATH);
    expect(cancelling.all).toContain("取消中…");
    expect((cancelling.all.match(/<button[^>]*>取消中…<\/button>/g) || [])[0]).toMatch(
      / disabled[\s>]/
    );

    for (const status of ["succeeded", "failed", "cancelled", "timed_out"] as const) {
      const done = await renderAgentRun(
        (pinia) => seedDetail(pinia, { run: makeRun({ status }) }),
        DETAIL_PATH
      );
      expect(done.all, `${status} 不应渲染取消按钮`).not.toMatch(/>取消<\/button>/);
    }
  });

  it("详情抽屉：loading 分支优先于 empty 分支；无 currentRun 时显示 EmptyState", async () => {
    const loading = await renderAgentRun((pinia) => {
      useAgentRunsStore(pinia).detailLoading = true;
    });
    expect(loading.all).toContain('role="status"');
    expect(loading.all).not.toContain("正在加载运行详情…");
    expect(loading.all).not.toContain("请选择或创建 Agent 运行。");

    const none = await renderAgentRun();
    expect(none.all).toContain("请选择或创建 Agent 运行。");
    expect(none.all).not.toContain("执行摘要");
  });

  it("弹层默认状态与 ?run= 深链接：无 query 时弹窗与抽屉均挂载但隐藏；深链接下抽屉打开", async () => {
    const closed = await renderAgentRun();
    expect((closed.all.match(/role="dialog"/g) || []).length).toBe(2);
    expect((closed.all.match(/aria-label="关闭"/g) || []).length).toBe(2);
    expect((closed.all.match(/aria-labelledby/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((closed.all.match(/display:\s*none/g) || []).length).toBeGreaterThanOrEqual(2);
    // 抽屉关闭但内容仍挂载（关闭态安全由组件契约测试保证）
    expect(closed.all).toContain("请选择或创建 Agent 运行。");

    const open = await renderAgentRun((pinia) => seedDetail(pinia), DETAIL_PATH);
    expect((open.all.match(/data-state="open"/g) || []).length).toBeGreaterThanOrEqual(1);
    expect(open.all).toContain("执行摘要");
    expect(open.all).not.toContain("请选择或创建 Agent 运行。");
  });

  it("不得再出现任何 legacy 类名（run-item / run-list-item / form-panel 等）", async () => {
    const { all } = await renderAgentRun((pinia) => seedDetail(pinia), DETAIL_PATH);
    for (const legacy of [
      "run-item",
      "run-list-item",
      "form-panel",
      "stacked-form",
      "panel-header",
      "result-block",
      "tool-call-row",
      "event-row",
      "compact-empty"
    ]) {
      expect(all, `不应出现 legacy 类 ${legacy}`).not.toContain(legacy);
    }
    // W5：色调点已从本页 scoped 提到 `@layer components` 的共享 `.tone-dot`；
    // 原先无样式的 `run-link` 标记类已删除，改为显式的 text-primary + hover:underline。
    expect(all).toContain("tone-dot");
    expect(all).toContain("text-primary");
    expect(all).not.toContain("trace-dot");
    expect(all).not.toContain("run-link");
  });
});
