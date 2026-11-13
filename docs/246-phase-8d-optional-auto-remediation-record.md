# 246 · Phase 8-D 实施记录：可选自动修复

> 日期：2026-11-04（上海时区）
> 任务书：`docs/242` · 设计：`docs/13` · 前置：`docs/245`（8-C）
> 范围：**仅 8-D**（可选自动 start 白名单 staging 修复工作流到 VERIFY；生产仍审批）。不含改 `.env`、开 F1、扩大白名单、静默生产修复。

## 1. 交付对照（SRE-13…15）

| 验收码 | 结果 | 证据 |
| --- | --- | --- |
| SRE-13 | 达成（结构） | `INCIDENT_AUTO_REMEDIATE`（**默认 false**）+ 书面白名单 → `resolveRemediationAutoStart` → `WorkflowService.start`；生产仍 `approvalTaskKeys: ["PRODUCTION"]`；单测 `incidentRemediation.test.ts` |
| SRE-14 | 达成（结构） | fix workflow `policy.deployFailureStrategy = "ROLLBACK"`（复用既有 staging 失败回滚路径）；`incidentAutoRemediateOpener.test.ts` |
| SRE-15 | 达成（抽样） | 非白名单 + 开关开仍 `NOTIFY_ONLY`；计划禁止项检查 `findForbiddenRemediationPlanViolation`；PRODUCTION 不可缺 / 不可跳过 VERIFY 依赖 |

## 2. 开关默认值

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `INCIDENT_AUTO_REMEDIATE` | **关闭**（`false` / 空 / `off` / `0` / `no`） | 为 `true`/`1`/`on`/`yes` 时，白名单 `remediate` **默认** `start=true`（请求体显式 `startWorkflow` 仍优先） |

**白名单不扩大**：仍为 8-C starter set（`staging_verify_flaky` / `ci_release_missing` / `config_drift_staging`）。`INCIDENT_AUTO_REMEDIATE_WHITELIST` 只是同表别名。

**生产红线**：即使开关打开，PRODUCTION 仍经既有 Approval / Policy / Audit；无静默生产自动部署。

## 3. 主要改动

- `@ai-se/shared`：`INCIDENT_AUTO_REMEDIATE_WHITELIST` 别名；`IncidentRemediationDecision` 增加可选 `autoStarted` / `autoRemediateEnabled`
- `apps/server`：`INCIDENT_AUTO_REMEDIATE` 配置；`resolveRemediationAutoStart` / `findForbiddenRemediationPlanViolation`；`IncidentService.remediate` 尊重开关；opener 写入 `deployFailureStrategy: "ROLLBACK"`；组合根注入 `autoRemediateEnabled`
- `apps/web`：详情展示 started / auto-started
- **无新迁移**（复用 8-C `remediation` JSONB）

## 4. 本地验证

```bash
pnpm --filter @ai-se/shared test -- src/incidentContract.test.ts
pnpm --filter @ai-se/shared build
pnpm --filter @ai-se/server test -- \
  src/config.test.ts \
  src/__tests__/incidentRemediation.test.ts \
  src/__tests__/incidentAutoRemediateOpener.test.ts \
  src/__tests__/incidentsApi.test.ts
```

## 5. 生效步骤

无需 migrate。重启 `apps/server` 以加载新配置与接线。

默认行为与 8-C 相同（不自动 start）。若要开启 8-D 自动 start，需**显式**设置环境变量：

```bash
INCIDENT_AUTO_REMEDIATE=true
```

### 5.1 生效记录（2026-11-04）

- server **已重启加载 8-D**（约 **12:03 上海时区**；当时 PID **65510**，`PORT=47558`）
- 进程环境 **`INCIDENT_AUTO_REMEDIATE=true`**（用户显式要求）
- **根 `.env` 未写入**该变量；代码默认仍为关闭——仅靠 `.env` 冷启动会回到默认关
- 白名单 `remediate` 可 `autoStarted`；非白名单仍 `NOTIFY_ONLY`；生产仍审批
- 无新迁移（复用 `022` 的 `remediation` JSONB）

## 6. 明确未做

- 把自动修复写成**代码默认打开**（仍默认关）
- 把开关持久化进 `.env`
- 扩大书面白名单
- 绕过生产审批 / 任意 production shell / 改 Secrets
- 开 F1
