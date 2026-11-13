# Phase 5.7-3 Action Policy — Completion Report

> 项目:AI-SE(Action Policy / 统一风险策略)
> 阶段:Phase 5.7-3(Action Policy)
> 状态:**PASS**
> 完成日期:2026-09-13
> 开发模式:ponytail(单一政策引擎 + 复用既有审批/审计链,零第二套系统)+ 以代码为准
> 参考:docs/17 §5.7-3、docs/24、docs/43(5.7-0)、docs/52/53(5.7-1)、docs/54(5.7-2)

---

## 1. Status

**PASS** — 任务书 §3/§5/§6 与 docs/17 §5.7-3 五项全部达成;真实 E2E:
`Agent → ToolRuntime → Action Policy → Approval(既有 WAITING_APPROVAL 链)→ Browser / MCP`

- `Approval denied → 零外部请求`;全仓四门禁 exit 0。

```
Browser Action(MEDIUM)                    External Action(HIGH)
        \                                /
         → Platform Action Policy(唯一引擎)
              ↓ {riskLevel, requiresApproval}
         ToolRuntime(既有)→ 审批门(既有)→ Execution
              ↓
         ToolCallRecorder(既有审计)
```

## 2. Policy 结构

新包 **`@ai-se/action-policy`**(packages/action-policy,依赖仅 tool-runtime):

| 文件             | 职责                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/policy.ts`  | `ActionPolicy` 引擎:冻结风险表(verb floors)+ 浏览器动作白名单表 + `resolveBrowser` / `resolveExternal` / `resolve`(统一入口)/ `approvalRequiredFor`;`ActionPolicyError`;`defaultActionPolicy` |
| `src/enforce.ts` | `applyActionPolicy`(组合期执行:未知动作 DENY、低于政策声明 DENY、riskLevel 以政策为准、自动挂审批门)+ `withApprovalGate`(执行期门,复用 `context.metadata.approved === true` 既有约定)         |
| `src/index.ts`   | barrel                                                                                                                                                                                        |

架构定性(任务书 §4):

```text
Action Metadata(catalog 声明 / 浏览器表)→ Platform Action Policy → {riskLevel, requiresApproval} → ToolRuntime
```

- **ExternalToolCatalog 保持为输入来源**,不再是最终政策:`createExternalToolRegistry` 的
  policyProvider 与 connector 的 `toolDefinitions`/`descriptors` 全部改经 `ActionPolicy.resolveExternal`;
- 消费方注入:connector 支持 `actionPolicy` 选项(默认冻结政策);
- 源码级证据(测试锁定,见 §5)。

## 3. Risk mapping(冻结表,测试锁定)

| 层           | 规则                                                                                                                                                     | 输出   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| LOW floor    | observe / screenshot / navigate / read / list / search / status / get / fetch / view / inspect / check / health / docs / info / lookup / query           | LOW    |
| MEDIUM floor | click / type / create / update / edit / modify / add / insert / save / comment / send / submit / apply                                                   | MEDIUM |
| HIGH floor   | publish / commit / push / merge / delete / remove / drop / destroy / deploy / deployment / release / rollback / write                                    | HIGH   |
| 浏览器白名单 | browser.observe / browser.action.navigate / browser.action.screenshot → LOW;browser.action.click / browser.action.type → MEDIUM(与 5.7-1 原声明逐项一致) | —      |

- 动作名按 token 匹配(最强命中胜出)`releases.publish` → HIGH、`issues.create` → MEDIUM、`issues.list` → LOW;
- **同一词表**:LOW/MEDIUM/HIGH(CRITICAL 保留为可声明级别,按 ≥ HIGH 处理;冻结表不生成);
- **Risk 来源 = 平台**:浏览器侧只有平台白名单表(浏览器 metadata 不携带任何声明,伪造声明被忽略);
  外部侧 catalog 声明只是输入,verb floor 只升不降(误声明 LOW 的 `releases.publish` 仍为 HIGH);
- **未声明/未知 → DENY**:未知浏览器动作、无效声明、未声明工具 → `undefined`,组合期/可见性链一律拒绝;
- **高风险默认**:publish / commit / delete / deployment(及 push / merge / write / rollback 等)→ HIGH + 需人审;
- **Agent 无法降低**:工具参数不能携带 risk(严格 schema 拒绝,实测 `TOOL_ERROR` 零动作);定义低于政策 =
  组合期 `ActionPolicyError`(DENY);政策决策不可被调用方覆盖。

## 4. Approval 复用(零第二套)

- `approvalRequired` 由 `ActionPolicy.approvalRequiredFor(...)` **派生**(HIGH/CRITICAL → true;声明只能升不能降);
- 引擎级:E2E 以派生结果设置任务 `approvalRequired`(approvalTaskKeys),**既有 workflow-engine
  WAITING_APPROVAL 链原样工作**(创建 Approval → task/workflow WAITING_APPROVAL → approve/reject →
  READY/FAILED + APPROVAL_REQUIRED / APPROVAL_GRANTED / APPROVAL_REJECTED 事件)——零新审批实体/引擎/状态机;
- 动作级:既有 approval gate 缝(`createMCPToolAdapter` 的 approvalGate / 5.7-2 connector 选项)消费政策
  `requiresApproval`;5.7-3 新增的 `withApprovalGate` 复用既有 `context.metadata.approved === true`
  约定(delivery 工具的同一约定),未批准 → `TOOL_ERROR` 且**零下游动作**;
- **Approval denied → 零外部请求**:拒绝发生在 adapter 门(=0 请求)或引擎(任务不执行),E2E 计数锁定。

## 5. Audit 复用(零第二套)

- 审计继续 = `ToolCallRecorder`(started/finished)+ `ToolResult.audit`(riskLevel 来自政策决策;
  ToolRuntime 既有字段)+ workflow 审批事件;无新事件体系、无新表、无 migration;
- 关联证据(E2E 断言):`started.toolCallId === ToolResult.toolCallId === finished.toolCallId`,
  finished.status = succeeded,`result.audit.riskLevel === "HIGH"`,事件流含 APPROVAL_GRANTED/REQUIRED;
  即 action/tool/risk/approval/outcome 五要素可经既有工件关联。

## 6. Browser Action 验证

- 5 个 5.7-1 工具的风险**来源改为政策**(`browserActionRisk()` 从 `defaultActionPolicy.resolveBrowser`
  取,未知即拒绝构建)——LOW/MEDIUM 逐项断言;
- 真实 Chromium E2E:政策应用后的工具经 ToolRuntime 全链路(navigate/click/observe),
  audit riskLevel 逐项 LOW/LOW/MEDIUM;参数级伪造 `riskLevel:"LOW"` → `TOOL_ERROR` 且页面仅被点击一次
  (零额外动作);
- 审批语义(源无关)在浏览器侧实证:政策将 navigate 升为 HIGH+审批 → 未批准 `TOOL_ERROR` +
  **零浏览器动作**(session 停在 about:blank),批准后真实导航成功;
- 组合期:未知动作 DENY、低于政策声明 DENY(测试)。

## 7. External Action 验证

- 5.7-2 全部既有行为零回归(232 基线保持);政策接入后:误声明 LOW 的 catalog 条目
  被升为 HIGH+审批(descriptors 与 ToolDefinitions 均以政策决策为准);
- 无门/拒绝门 → `TOOL_ERROR` + **零 MCP 请求**;批准门 → 真实执行 + `published:true` + 1 次请求;
- server E2E(真实 PG + 真实 MCP stdio):
  - HIGH `releases.publish` + 拒绝 → 引擎 WAITING_APPROVAL → APPROVAL_REJECTED → workflow FAILED,
    **零 MCP 请求、零执行记录**;
  - HIGH + 批准 → APPROVAL_GRANTED → 任务恢复 → 真实执行 1 次 + 审计关联(§5);
  - LOW `issues.list` → 无审批任务、直接执行成功、risk LOW;
  - 误声明 LOW(approvalTaskKeys 被错误派生为空)→ 执行期仍被政策升为 HIGH+审批并被门拒绝,
    零请求(纵深防御实证)。

## 8. Security / fail-closed

未知动作 DENY / 未知工具 DENY(目录+政策双层)/ 无效声明 DENY / 政策不允许 DENY / 未批准 DENY /
DENY 均零请求(计数断言);远程 MCP 与浏览器参数均**无**风险声称通道;政策决策只在平台侧产生。
不信任原则延续:外部数据仍是 DATA(5.7-2 规则未动),政策判断不消费任何外部内容。

## 9. E2E / 测试

- action-policy 单元 **13 例**(映射表、floors、伪造拒绝、审批派生、执行包装、audit);
- browser +4(LOW/MEDIUM 政策断言、未知/低报拒绝、真实 Chromium 执行+防伪、审批门零动作);
- mcp +3(升险、零请求拒绝、批准执行);
- server +4(WAITING_APPROVAL 拒绝零请求 / 批准真实执行 + 审计关联 / LOW 直行 / 误声明纵深防御);
- 全仓回归与四门禁见 §10。

## 10. Regression

- 全仓 **615/615,0 failed**;四门禁 `TYPECHECK/LINT/TEST/BUILD = 0`;零残留容器;
- 分包:action-policy 13(新) | browser 38(+4) | mcp 235(+3) | server 57(+4) | 其余不变;
- 5.7-1 / 5.7-2 全部既有测试保持通过(policy 接入值与既有声明逐项一致,零行为漂移);
- Prettier 全绿。

## 11. Known Limitations

1. `withApprovalGate` 的批准来源 = 既有 `metadata.approved` 约定(与 delivery 工具一致);拒绝语义在
   adapter 门(E2E 覆盖);如果未来浏览器侧出现 HIGH 动作,可直接复用同一门(已于浏测侧实证);
2. CRITICAL 不在冻结表输出面(任务书默认 HIGH;CRITICAL 仅作为可声明级别按 ≥HIGH 处理);
3. 原生 delivery 工具(run_ci / deploy_release 等)沿用其既有的生产审批链,未纳入本阶段改造(任务书范围
   为 Browser + External;统一化留待需要时);
4. `applyActionPolicy` 的 external 分支为组合期工具(connector 内部走 per-tool decision);行为等价已测试;
5. 环境观察:Docker Desktop 守护在本阶段中途出现瞬时 500/挂起(与本阶段代码无关;重启后恢复,
   deliveryLifecycle 早前 flake 与此同族症状)——全量门禁在守护健康状态下通过并如实记录。

## 12. Boundary(严格禁止项核对)

未实现/未触碰:EvidenceRecord / Evidence persistence / Evidence API、before/after verification、
Failure Recovery、retry orchestration、re-observe、re-plan、GitHub 生产集成、新 Browser Tool Runtime、
新 MCP transport、新 Permission/Approval/Audit 系统。5.7-4 / 5.7-5 零开始;
docs/43/52/53/54 历史报告未修改。
