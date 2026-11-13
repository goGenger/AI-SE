# AI SRE

> ## 基线状态（2026-10-15 核实；**2026-11-04 复核**）
>
> 本文写于**平台实现之前**（第一版路线图的 Phase 8 设计），是**实现前设计**，不是 as-built 描述。
> **可执行开工依据是任务书 `docs/242`**（本文保留设计意图，不替代任务书）。原文主体未删，下面是对照现状的核实表：
>
> | 本文条款 | 与当前实现的关系 |
> | --- | --- |
> | Alert（告警）入口 | **8-A 已实现**：`POST /api/alerts` + `AlertIngestSchema`（`docs/243`） |
> | Incident 对象 | **8-A 已实现**：`incidents` / `alert_events` + API + 只读控制台（`docs/243`）。任务类型枚举 `INCIDENT` 仍保留且规划校验禁止——与本表对象不是同一条路径 |
> | Incident Agent | **8-B 已实现**：只读 `IncidentAgent` 证据合成器（`docs/244`）；未注册为可写 ProfessionalAgent |
> | 诊断数据源：Metrics / Logs / Traces / Git 历史 / 部署历史 | **底座已齐**（Phase 7，`docs/153`）+ **8-B 证据采集已接**（metrics/trace/deploy/workflow/alert；`docs/244`） |
> | 修复流程（Branch → Code → Test → Review → Staging → Approval → Production → Verify） | **8-C 已接入口** + **8-D 可选自动 start**：白名单 → 既有 delivery 链；代码默认 `INCIDENT_AUTO_REMEDIATE=false`；打开后可自动跑到 staging VERIFY；生产仍审批（`docs/245` / `docs/246`） |
> | 第一版边界：白名单故障类型 | **8-C/8-D 已实现**：`INCIDENT_REMEDIATION_WHITELIST`（不因 8-D 扩大；`docs/245` / `docs/246`） |
> | 第一版边界：禁止项 | **部分由既有设计守住**：生产审批与 Policy；动工时逐项写成可验证规则 |
> | Incident Agent 输出（summary / root cause / evidence / fix plan / risk / recommended action） | **8-B 已实现**：`IncidentDiagnosisSchema`（`docs/244`） |
>
> **结论（2026-11-04）**：Phase 7 已收口、F1 正式验收已通过；**Phase 8 AI SRE（8-A→8-D）已收口并生效**（`docs/243`…`docs/246`；迁移 `020`–`022`）。
> 8-D：**代码默认关**；本机当前 server **进程环境**曾置 `INCIDENT_AUTO_REMEDIATE=true`（**.env 未写**）。
> 后续维护以 **`docs/242`** 为准；**勿与** Agents UI Phase 8-A/B（`docs/78`/`docs/79`）混淆。依据：`AGENTS.md` §9。

属于 Phase 8。可执行规划与第一刀见 **`docs/242`**。

## 流程

```text
Alert
→ Incident
→ Incident Agent
→ Metrics / Logs / Traces / Git History / Deployment History
→ Diagnosis
→ Fix Plan
→ Branch
→ Code Change
→ Test
→ Review
→ Staging
→ Approval
→ Production
→ Verify
```

## 第一版边界

只允许白名单故障类型自动进入修复流程。

禁止：

- arbitrary production shell
- 删除数据库
- 修改 Secrets
- 绕过审批
- 直接修改生产主分支
- 未验证的自动生产修复

Incident Agent 输出：summary、root cause hypothesis、evidence、fix plan、risk、recommended action。
