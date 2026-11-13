# 244 · Phase 8-B 实施记录：只读诊断

> 日期：2026-11-04（上海时区）
> 任务书：`docs/242` · 设计：`docs/13` · 前置：`docs/243`（8-A）
> 范围：**仅 8-B**（证据收集 + Incident Agent 结构化诊断挂到 Incident）。不含受控修复（8-C）、自动修复（8-D）、改 `.env`、开 F1。

## 1. 交付对照（SRE-05…08）

| 验收码 | 结果 | 证据 |
| --- | --- | --- |
| SRE-05 | 达成 | `IncidentDiagnosisSchema` 六段字段；`IncidentAgent.diagnose` + `incidentDiagnosis.test.ts` / `incidentContract.test.ts` |
| SRE-06 | 达成 | 证据至少两类 `sourceKind`（默认 `alert`+`metrics`；有关联工作流时再加 `workflow_trace`；另可采 `deployment` / `workflow_summary`） |
| SRE-07 | 达成 | 诊断路径只读：collector / agent **不**调用 DeliveryOrchestrator、不写 deployments；仅 `incidents.diagnosis` / `status=diagnosing` |
| SRE-08 | 达成 | 落库 / Prompt 向文本走 `sanitizeLogData`；单测断言凭证形态串打码 |

## 2. 主要改动

- `@ai-se/shared`：`IncidentEvidence*` / `IncidentDiagnosisSchema`；`Incident` 增加可选 `diagnosis` / `diagnosedAt`
- `@ai-se/database`：迁移 `021_phase8b_incident_diagnosis.sql`；`PgIncidentRepository.saveDiagnosis`
- `apps/server`：`IncidentEvidenceCollector`、`IncidentAgent`、`IncidentService.diagnose`、`POST /api/incidents/:id/diagnose`；组合根接线复用 metrics / TraceService / deployments / workflows **只读**端口
- `apps/web`：详情展示诊断 +「运行只读诊断」按钮

**未**把 incident-agent 塞进 `AgentType` / 编码类 `ProfessionalAgent` 注册表：避免能力面与写路径扩散；8-B 诊断是证据合成器，修复执行仍留给 8-C 复用既有 Runtime。

## 3. 本地验证

```bash
pnpm --filter @ai-se/shared test -- src/incidentContract.test.ts
pnpm --filter @ai-se/database test -- src/migrate.test.ts src/incidentRepository.test.ts
pnpm --filter @ai-se/shared build && pnpm --filter @ai-se/database build
pnpm --filter @ai-se/server test -- src/__tests__/incidentDiagnosis.test.ts src/__tests__/incidentsApi.test.ts
```

## 4. 生效步骤

```bash
pnpm --filter @ai-se/database migrate
# 再按既有方式重启 apps/server（加载 8-B 路由与接线）
```

### 4.1 生效记录（2026-11-04）

- 迁移 **`021_phase8b_incident_diagnosis.sql` 已应用**
- server 已重启；`POST /api/incidents/:id/diagnose` 冒烟 **200**，诊断六段齐全
- 后续：8-C=`docs/245`、8-D=`docs/246`

## 5. 明确未做（相对 8-B 本刀）

- ~~白名单受控修复（8-C）~~ → `docs/245`
- ~~可选自动修复（8-D）~~ → `docs/246`
- 生产绕过审批、外部 pager、LLM 版可写 Incident ProfessionalAgent（未做）
