# 243 · Phase 8-A 实施记录：AI SRE 骨架

> 日期：2026-11-04（上海时区）
> 任务书：`docs/242` · 设计：`docs/13`
> 范围：**仅 8-A**（告警契约、incidents 迁移/API、入站幂等、只读控制台）。不含 8-B/C/D。

## 1. 交付对照（SRE-01…04）

| 验收码 | 结果 | 证据 |
| --- | --- | --- |
| SRE-01 | 达成 | `POST /api/alerts`；同 `source+fingerprint` 活跃 Incident 不双建（`deduplicated: true`）；单测 `incidentsApi.test.ts` |
| SRE-02 | 达成 | 表 `incidents` 含 `status` / `source` / `fingerprint` / `opened_at` / `linked_workflow_run_id`；迁移 `020_phase8a_incidents.sql` |
| SRE-03 | 达成 | `GET /api/incidents`、`GET /api/incidents/:id` |
| SRE-04 | 达成 | 控制台 `/incidents` 列表 + `/incidents/:id` 只读详情 |

## 2. 入站鉴权（待用户确认的最小安全默认）

任务书 §8 要求开工前裁定；用户开写时未另选，落地如下并请确认：

1. 优先独立 shared secret：`ALERT_INGEST_TOKEN` → `Authorization: Bearer …`（仅约束 `POST /api/alerts`）
2. 未配 `ALERT_INGEST_TOKEN` 时回退既有 `API_TOKEN`（与其它 `/api/*` 一致）
3. 二者皆未配置：非 production 本地放行；**`NODE_ENV=production` 拒绝裸奔入站（401）**

实现：`apps/server/src/http/alertIngestAuth.ts`；`POST /api/alerts` **挂在全局 `apiTokenGuard` 之前**，避免 webhook 同时需要两套 token。

## 3. 主要改动

- `@ai-se/shared`：`AlertIngestSchema` / `IncidentSchema` / `AlertIngestResultSchema`
- `@ai-se/database`：迁移 `020`、`PgIncidentRepository`、`alert_events` 审计行
- `apps/server`：`IncidentService`、`createIncidentsRouter`、`ALERT_INGEST_TOKEN` 配置、接线
- `apps/web`：`IncidentsView`、store/api、侧栏「Incidents」

## 4. 本地验证

```bash
# 契约
pnpm --filter @ai-se/shared test -- src/incidentContract.test.ts

# 迁移清单 + 仓储（需 Docker）
pnpm --filter @ai-se/database test -- src/migrate.test.ts src/incidentRepository.test.ts

# API / 鉴权（内存双）
pnpm --filter @ai-se/shared build && pnpm --filter @ai-se/database build
pnpm --filter @ai-se/server test -- src/__tests__/incidentsApi.test.ts src/config.test.ts
```

平台需**重启 server** 并跑迁移后，控制台 `/incidents` 与 `POST /api/alerts` 才可用：

```bash
pnpm --filter @ai-se/database migrate
# 再按既有方式重启 apps/server
```

## 4.1 生效记录（2026-11-04）

- 迁移 **`020_phase8a_incidents.sql` 已应用**
- server 已重启加载 8-A；随后冒烟：`POST /api/alerts` 幂等、`GET /api/incidents` 可读
- 后续里程碑：`docs/244`（8-B）/`docs/245`（8-C）/`docs/246`（8-D）

## 5. 明确未做（相对 8-A 本刀；后续里程碑另记）

- ~~Incident Agent / 证据聚合（8-B）~~ → 见 `docs/244`（已做）
- ~~白名单受控修复（8-C）~~ → 见 `docs/245`（已做）
- ~~可选自动修复（8-D）~~ → 见 `docs/246`（已做；代码默认关）
- 外部 pager、改 `.env`、开 F1（全程未做）
