# 106 · 工作流页 Agent 运行跳转与实际运行不一致（前端状态同步）

## 现象
在工作流页点击任务卡上的「查看 Agent 运行」后，打开的 Agent 运行是**失败**的，
而任务卡本身显示「运行中」——两处状态对不上（用户报障原文）。

## 根因（代码 + 真实数据）
- 任务卡的状态徽章来自 `task.status`（实时快照 ✔），但**跳转目标**来自
  `task.output.agentRunId`——该字段只在**运行结束时**才由执行器写入
  （`workflowTaskExecutor.execute` 返回 `{status, output, agentRunId}`，任务行由调用方在收尾时更新）。
- 因此重试/再次运行期间：任务状态已是「运行中/重试中」，而 `output.agentRunId` 仍指向
  上一次（可能已失败的）运行；首次尝试失败且尚未收尾时该字段为空 → 卡片干脆没有跳转入口。
- 真实数据：T6 两次运行（1 失败 + 1 运行中），`output.agentRunId` = **未写入** → 旧实现无链接；
  T5 运行中时同样无链接。用户看到的「点了是失败、卡片仍运行中」即上述字段滞后所致。

## 改动（前端，2 个文件 + 2 个测试文件）
- `apps/web/src/viewmodels/workflowViewModel.ts`：新增纯函数
  `taskAgentRunId(task, events)` —— 优先取快照事件里**该任务最新带 `agentRunId` 的事件**
  （运行中即有值），`output.agentRunId` 仅作回退；与既有 `workflowEventView` 的取值优先级一致。
- `apps/web/src/views/WorkflowsView.vue`：任务卡的跳转改用 `taskRunId(task)`（同上函数），
  运行中的任务因此**立即**出现「查看 Agent 运行」入口，且指向当前这次运行。
- 测试：`workflowViewModel.test.ts` +4（事件优先 / 回退 output / 跳过无 runId 的事件 / 都无则 undefined）、
  `workflowsView.test.ts` +1（运行中任务用事件里的 run id 跳转，不指向已失败的旧运行）。

## 验证
- 门禁：`@ai-se/web` typecheck / lint 全绿；测试 **291 通过 / 7 失败**——7 个失败与本次改动无关
  （PageHeader / eyebrow 文案的**先存**失败，与改动前基线一致），改动文件相关用例全绿。
- 真实页面（localhost:5173，工作流 `49a6cd7d` 正在运行）：T6 处于「第 1 次尝试失败 → 重试运行中」，
  任务卡现渲染 `/agent-run?run=d3a01a31…`（= DB 里该任务的**最新运行**，状态 running），
  点击进入的运行页同样显示「运行中」——两页一致。
- 边界：事件时间线上历史条目仍指向**其所属那次**运行（历史语义正确，未改动）。

## 备注
- 快照事件列表（`current.events`，ASC 全量）已含 `taskId` / `agentRunId`，无需后端改动、无新增接口。
- 浏览器验证时用 `http://localhost:5173`（服务端 CORS 的 origin 白名单不含 `127.0.0.1:5173`，
  用 127.0.0.1 打开会得到「网络请求失败：无法连接后端服务」，是验证方式问题而非产品缺陷）。
