# 245 · Phase 8-C 实施记录：受控修复

> 日期：2026-11-04（上海时区）
> 任务书：`docs/242` · 设计：`docs/13` · 前置：`docs/244`（8-B）
> 范围：**仅 8-C**（白名单故障类型 → staging 绑定修复工作流 + 生产审批门）。不含 8-D 自动修复默认开启、改 `.env`、开 F1、外部 pager、任意生产 shell。

## 1. 交付对照（SRE-09…12）

| 验收码 | 结果 | 证据 |
| --- | --- | --- |
| SRE-09 | 达成 | `INCIDENT_REMEDIATION_WHITELIST` + `IncidentService.remediate`；白名单开工作流，非白名单 `NOTIFY_ONLY`；单测 `incidentRemediation.test.ts` / API |
| SRE-10 | 达成 | `buildStagingFixTaskPlan` 使用既有 delivery `CI` / `DEPLOY` / `VERIFY`；`createPlanningFixWorkflowOpener` 走 `PgPlanningRepository` + `WorkflowService`（无第二套 Runtime） |
| SRE-11 | 达成（结构） | `PRODUCTION` 依赖 `VERIFY`；staging VERIFY 失败无法调度生产 DEPLOY |
| SRE-12 | 达成（结构） | `approvalTaskKeys: ["PRODUCTION"]` + 仓储对 `environment===production` 强制 `approvalRequired` → `WAITING_APPROVAL` |

## 2. 书面白名单（8-C 冻结 starter set）

告警须设 `labels.faultType`（或 `labels.fault_type`）为下列之一才会开修复工作流：

1. `staging_verify_flaky`
2. `ci_release_missing`
3. `config_drift_staging`

其它类型 / 缺省 → **仅通知**（落 `remediation.decision=NOTIFY_ONLY`），不创建工作流。扩大名单属策略变更，需另行批准（8-D 不扩大白名单）。

## 3. 主要改动

- `@ai-se/shared`：白名单常量、`IncidentRemediationDecisionSchema`、Incident 可选 `remediation` / `remediatedAt`
- `@ai-se/database`：迁移 `022_phase8c_incident_remediation.sql`；`PgIncidentRepository.saveRemediation`
- `apps/server`：`incidentRemediationPolicy`、`incidentFixWorkflowOpener`、`IncidentService.remediate`、`POST /api/incidents/:id/remediate`；组合根接线 planning + WorkflowService
- `apps/web`：详情「受控修复」按钮 + remediation 展示

**默认不自动 `start` 工作流**（`startWorkflow: false`）：创建后可在工作流 UI 启动；传 `startWorkflow: true` 才会 `WorkflowService.start`。生产 DEPLOY 仍等审批。

## 4. 本地验证

```bash
pnpm --filter @ai-se/shared test -- src/incidentContract.test.ts
pnpm --filter @ai-se/database test -- src/migrate.test.ts src/incidentRepository.test.ts
pnpm --filter @ai-se/shared build && pnpm --filter @ai-se/database build
pnpm --filter @ai-se/server test -- \
  src/__tests__/incidentRemediation.test.ts \
  src/__tests__/incidentDiagnosis.test.ts \
  src/__tests__/incidentsApi.test.ts
```

## 5. 生效步骤

```bash
pnpm --filter @ai-se/database migrate
# 再按既有方式重启 apps/server
```

### 5.1 生效记录（2026-11-04）

- 迁移 **`022_phase8c_incident_remediation.sql` 已应用**
- server 已重启；白名单 `remediate` 可开 staging 修复流（生产仍审批）；非白名单 `NOTIFY_ONLY`
- 后续：8-D=`docs/246`

## 6. 安全边界

- 禁止：任意生产 shell、删库、改 Secrets、绕过审批、未验证自动生产修复
- 生产 DEPLOY 必须经既有 Approval / Policy / Audit
- 非白名单永不自动开修复工作流
- 8-D 自动 start **代码默认关闭**（见 `docs/246`）

## 7. 明确未做（相对 8-C 本刀）

- ~~8-D 白名单自动 start 到 staging VERIFY~~ → `docs/246`（已实施；默认关）
- 外部 pager 硬依赖
- 改 `.env` / 开 F1
