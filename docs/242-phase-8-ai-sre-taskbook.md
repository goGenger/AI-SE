# 242 · 阶段 8 任务书：AI SRE（平台运维 / 可靠性）

> 状态：**8-A→8-D 已收口并生效**（2026-11-04）。记录：8-A=`docs/243`，8-B=`docs/244`，8-C=`docs/245`，8-D=`docs/246`。
> 实机：迁移 `020`/`021`/`022` 已应用；server 已加载 8-D。**代码默认** `INCIDENT_AUTO_REMEDIATE=false`；**当前进程**为 `true`（仅进程环境，**.env 未写**）。
> 设计原文：`docs/13-ai-sre.md`（实现前设计；基线表已于同日复核）。
> 清单勾选：`docs/17` 节「Phase 8 — AI SRE」。路线图入口：`docs/15` Phase 8。总表：`docs/146` §1 / §1.1。
> 工程目标摘要：`docs/18` Phase 8。
>
> **命名澄清（必读）**：本阶段是路线图 **Phase 8 — AI SRE**。
> **不是** 前端 Agents / AgentRun 改造里的 Phase 8-A/B（`docs/78` / `docs/79`）。两者编号撞车，但对象完全不同。
>
> **与 F1 的衔接**：F1（`docs/233`）已于 **round20** 正式验收通过（oracle 24/24、staging CI/DEPLOY/VERIFY 全 SUCCESS）。
> F1 **不新增** SRE 能力；它证明了交付链与观测底座可被真实批次踩到。Phase 8 在此之上接「告警 → 事件 → 诊断 → 受控修复」。

## 0. 一句话目标

让平台能从**受控告警**生成 **Incident**，用既有 Metrics / Logs / Traces / 部署与工作流历史做**证据化诊断**，产出结构化修复计划，并在**白名单故障类型**内走既有工作流 / 交付 / 审批闭环完成修复——**高风险生产动作仍必须经 Tool Runtime、Policy、Approval、Audit**。

## 1. 为什么现在可以开

| 前置 | 状态 | 证据 |
| --- | --- | --- |
| Phase 7 可观测性 | 已收口 | `docs/153`；`/api/metrics`、`/api/workflows/:id/trace`、决策事件 |
| 交付链（含 staging VERIFY） | 已在真实批次跑通 | F1 round20；`docs/17` F1；N-73 判据关闭 |
| 自治 L1 策略内审批 / 回滚 | M1–M3 已有 | `docs/155`（L1-8 数据门槛另册，不阻塞 8-A/B） |
| 告警 / Incident / Incident Agent | **已实现（8-A…8-D）** | `docs/243`…`docs/246`；基线表见 `docs/13` |

## 2. 范围边界

### 2.1 做

- Alert 摄入（HTTP 或内部事件总线，**先一种**）与幂等去重；
- Incident 持久化对象 + API +（最小）控制台列表/详情；
- Incident Agent（或等价专业 Agent）：只读聚合 Metrics/Logs/Traces/Git/Deployment/Workflow 证据；
- 结构化输出契约：summary / rootCauseHypothesis / evidence[] / fixPlan / risk / recommendedAction；
- 白名单故障类型 → 可自动开「诊断」或「修复」工作流；非白名单 → 只建 Incident + 等人；
- 修复执行**复用**既有规划 / 工作流 / 验证门 / 交付编排 / 审批——禁止第二套 Runtime。

### 2.2 不做（非目标）

- 任意生产 shell、删库、改 Secrets、绕过审批、未验证的自动生产修复（`docs/13` 禁止项）；
- 引入外部 On-call 全家桶（PagerDuty/Opsgenie 等）作为硬依赖——**第一版可用 webhook 入站模拟**；
- 重做 Phase 7 外部栈（OTel/Grafana/Loki 服务端）——继续用已收口的平台侧 metrics/trace；
- 多集群 / 多云故障域、容量规划、成本 FinOps；
- Agents UI Phase 8-A/B 的页面翻新（除非 Incident 最小页必需的只读挂载）；
- 借机重跑整轮 F1 或改 `.env` 模型路由。

### 2.3 与既有抽象的关系

| 能力 | 复用 | 禁止 |
| --- | --- | --- |
| 执行 | Tool Runtime | 第二套执行器 |
| 权限 / 审批 / 审计 | 既有 Policy / Approval / audit | 第二套 |
| 观测 | `@ai-se/observability`、`/api/metrics`、workflow trace | 平行日志体系 |
| 修复落地 | WorkflowEngine + DeliveryOrchestrator | 告警路径直写生产 |

## 3. 里程碑（建议切片）

| 里程碑 | 内容 | 出口（建议验收码） | 依赖 |
| --- | --- | --- | --- |
| **8-A 骨架** | Alert 入站 + Incident 模型/迁移/API；控制台最小列表；幂等键 | SRE-01…SRE-04 | 无 |
| **8-B 只读诊断** | Incident Agent；证据收集器（metrics/logs/trace/deploy/workflow）；结构化诊断输出；**不改代码** | SRE-05…SRE-08 | 8-A |
| **8-C 受控修复计划** | 白名单类型 → 生成 fix plan → 开工作流到 **staging + 审批门**；生产仍人工 | SRE-09…SRE-12 | 8-B、既有交付链 |
| **8-D 白名单自动修复（可选）** | 极窄类型允许自动走完 staging VERIFY；生产仍审批；回滚路径演练 | SRE-13…SRE-15 | 8-C、用户书面批准类型表 |

**纪律**：一次只做一个里程碑；8-A 未验收不得开 8-B（`AGENTS.md` §9）。

## 4. 验收标准（草案，审阅后冻结编号）

### 8-A

- SRE-01：`POST /api/alerts`（或等价）接受合法载荷，重复幂等键不双建 Incident；
- SRE-02：Incident 落库字段含 status / source / fingerprint / openedAt / linkedWorkflowRunId?；
- SRE-03：`GET /api/incidents` + `GET /api/incidents/:id` 与库一致；
- SRE-04：控制台只读列表可打开详情（允许极简）。

### 8-B

- SRE-05：对夹具故障，Agent 输出通过 schema（六段字段全在）；
- SRE-06：证据至少引用两类真实数据源（例如 metrics 计数 + workflow trace 节点）；
- SRE-07：诊断路径**零**生产变更（无新 deployment SUCCESS）；
- SRE-08：敏感字段走既有 sanitize，不进 Prompt/Result 明文。

### 8-C

- SRE-09：白名单类型自动创建修复工作流；非白名单仅通知；
- SRE-10：修复链复用验证门与交付任务类型（不发明平行 task type 执行器）；
- SRE-11：staging VERIFY 失败不升生产；
- SRE-12：生产 DEPLOY 仍 `WAITING_APPROVAL`（或 L1 策略显式允许时走既有 AUTO_APPROVED 事件，须可审计）。

### 8-D（可选）

- SRE-13：书面白名单内类型可自动完成到 staging VERIFY；
- SRE-14：故意注入失败可触发既有回滚路径并留事件；
- SRE-15：禁止项各有一条负向测试（shell/secrets/绕过审批等至少抽样）。

## 5. 建议的第一批可开干任务（第一刀 = 8-A）

1. **冻结告警载荷契约**（JSON schema / zod）：`source`、`fingerprint`、`severity`、`labels`、`raw`；
2. **迁移**：`incidents`（+ 可选 `alert_events`）表；更新 `migrate.test.ts` 文件清单；
3. **`IncidentService` + routes**：创建 / 查询 / 状态机（`open → diagnosing → mitigating → resolved/cancelled` 先最小集）；
4. **入站端点** + 单测（幂等、校验失败、鉴权与既有路由风格一致）；
5. **控制台**：Incidents 列表/详情只读（可挂工作流详情链）；
6. **文档**：实施记录 `docs/NN-phase-8a-…`；回勾 `docs/17` 对应项；更新 `docs/146`。

**明确不在第一刀**：Incident Agent、自动开修复工作流、任何生产动作、外部 pager 集成。

## 6. 风险

| 风险 | 表现 | 对策 |
| --- | --- | --- |
| 与 UI「Phase 8」混淆 | 改错目录 / 做错验收 | 任务书抬头 + `docs/15`/`17`/`146` 反复写明 |
| 告警风暴 | 重复 Incident / 烧配额 | fingerprint 幂等 + 速率上限 + 同指纹去重窗 |
| 诊断幻觉 | 无证据的 root cause | schema 强制 evidence[]；单测夹具；禁止空证据 SUCCESS |
| 绕过审批 | 「自动修复」直打生产 | 复用 DeliveryOrchestrator + Approval；负向测试 |
| 范围膨胀 | 一上来做 8-D | 里程碑硬停；8-D 需单独书面批准 |
| 观测不足被误读 | 以为缺 OTel 就不能做 | Phase 7 平台侧 metrics/trace 已够 8-B；外部栈仍延期 |

## 7. 与 F1 / 评测的关系

- Phase 8 **不**以再跑 F1 全绿为出口；F1 已收口。
- 若回归需要踩交付链，优先**小工作流夹具 / 合成告警**，避免整轮 `f1-frontend-x3.sh` 烧配额。
- 仍遵守：F1 相关脚本若被借用，`.env` **勿改** DeepSeek 直连；停批用 `f1-frontend-stop.sh`；retry 冒烟 ≠ F1 分数。

## 8. 收口结论 / 待确认事项（STOP）

> 开放项库存正本（2026-11-04）：**`docs/249-phase-8-open-items.md`**（告警鉴权=代码已默认实现，仍待书面确认；不阻塞前端主线）。

- **8-A→8-D 实现与生效已收口**（`docs/243`…`docs/246`）：迁移 `020`/`021`/`022` 已应用；server 已重启加载。
- **开关口径**：`INCIDENT_AUTO_REMEDIATE` **代码默认关闭**；本机当前 server **进程环境**为 `true`（用户显式要求），**.env 未写入**——下次若只靠 `.env` 启动会回到默认关。
- 告警鉴权：最小安全默认 `ALERT_INGEST_TOKEN`（回退 `API_TOKEN`；production 禁止裸奔）——**仍待用户书面确认或改裁定**。
- 白名单 starter set 已冻结（`docs/245` §2）；**扩大白名单 / 静默生产修复**需另批批准。
- 本收口轮：**不改实现代码、不开 F1、不改 `.env`、不再次重启**。

## 9. 审阅清单（给用户）

- [x] 同意「第一刀 = 8-A 骨架」，不做 Agent/自动修复；
- [x] 同意继续 8-B 只读诊断（不做受控修复）；
- [ ] 确认告警入站鉴权默认（`ALERT_INGEST_TOKEN` / 回退 `API_TOKEN` / production 禁裸奔）；
- [x] 确认控制台最小只读页可接受；
- [x] 确认 8-D 保持可选、**代码默认关闭**；用户已批准实施并显式以进程环境打开（`docs/246`）。
- [x] 确认开干 8-C 受控修复（白名单 starter set 见 `docs/245`）。
- [x] 确认开干 8-D 可选自动修复（默认关；`docs/246`）。
