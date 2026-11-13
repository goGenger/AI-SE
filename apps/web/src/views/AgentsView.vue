<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { AgentDefinitionView, AgentRun } from "@ai-se/shared";
import {
  DetailRow,
  EmptyState,
  ErrorState,
  PageContainer,
  PageHeader,
  SectionHeader,
  StatusBadge,
  TableSkeleton
} from "../components/common";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Drawer } from "../components/ui/drawer";
import { Table, type TableColumn } from "../components/ui/table";
import {
  agentAvailabilityLabel,
  agentTypeLabel,
  artifactTypeLabel,
  capabilityLabel,
  metricCards
} from "../viewmodels/agentRegistryViewModel";
import { agentStatusLabel, agentStatusTone } from "../viewmodels/agentRunViewModel";
import { useAgentsStore } from "../stores/agents";

/**
 * AgentsView（布局重构：表格 + 分页 + 抽屉详情，承接 Phase 8-B）。
 *
 * 业务层完全冻结（未改动一行）：onMounted → store.load()（并行取注册表 + 评测指标，
 * 并在无 current 时自动选中第一个 Agent）、store.select(name) 切换详情、
 * 6 张指标卡的数据来源与顺序、运行列表（执行 `runs`）、产出物列表、
 * `/agent-run?run=<id>` 深链接、loading / error / empty 条件。
 *
 * 布局与交互变化（与需求页 / 工作流页 / Agent 运行页同构）：
 *   · 注册表列表 → 组件库 Table（名称 / 类型 / 状态 / 操作）+ 内置分页
 *     （W7 起默认每页 10 条，纯前端切片，0 接口改动；列对齐与排序见 styles/README.md §15）
 *   · 操作列 = 「详情」（沿用既有 select(name) 语义加载详情，打开右侧抽屉）
 *   · Agent 详情（定义 + 可用性 + 能力 / 工具 / 路径 / 模式）、Agent 运行（打开深链接）、
 *     产出物整体移入组件库 Drawer；内容与文案一字未改
 *   · W11：详情抽屉与 URL 同步（`?agent=<name>`），补齐 `components/README.md` 里登记
 *     的「这两个抽屉不同步 URL」遗留项 —— 现在可分享、可后退，`?agent=` 深链接直接落在详情上
 *
 * 本页无创建能力（注册表由服务端注册表提供，无 create API）且除查看外无逐行动作，
 * 故不新增「新建」按钮 / 弹窗与第二个操作按钮（不新增功能）。
 */
const store = useAgentsStore();
const route = useRoute();
const router = useRouter();
const metrics = computed(() => metricCards(store.metrics));

/**
 * `?agent=<name>` 深链接主键。
 * Agent 定义没有独立的 id 字段：注册表一直用 `name` 作主键（列表 `row-key` 与
 * `store.select(name)` 都用它），因此 URL 里带的也是 name，不新造一个 id 概念。
 */
const selectedAgentName = computed(() =>
  typeof route.query.agent === "string" ? route.query.agent : ""
);

/** 「Agent 详情」抽屉开合（与 `?agent=` 同步：有值 = 打开）。 */
const detailOpen = ref(Boolean(selectedAgentName.value));

/**
 * 错误态的重试 / 空态的下一步动作。
 * 本页没有「新建」能力（注册表由服务端提供，无 create API），所以下一步动作是**刷新**，
 * 而不是一个假的创建按钮。
 */
function reload() {
  void store.load();
}

/** 注册表表格列（字段与旧列表项一致：类型 + 名称；另展示可用性与操作）。 */
const agentColumns: TableColumn<AgentDefinitionView>[] = [
  { key: "name", label: "名称", sortable: true },
  { key: "type", label: "类型", sortable: true },
  { key: "status", label: "状态", sortable: true },
  { key: "actions", label: "操作", align: "right" }
];

/**
 * 打开某 Agent 的详情抽屉：只改 URL。开抽屉与取数由 `watch(selectedAgentName)` 一处承担
 * —— 与工作流页 / 运行页同一形态（URL 是唯一真源，深链接、前进/后退、行内按钮走同一条路径）。
 */
function openDetail(agent: AgentDefinitionView) {
  void router.push({ path: "/agents", query: { agent: agent.name } });
}

/**
 * 运行卡片上的任务标识：优先取 input 里的 taskKey（JsonObject，需收窄），回退到 run.taskId。
 * 收窄而不直接 `String(...)`：后者会把意外出现在该字段里的对象渲染成 `[object Object]`。
 */
function runTaskLabel(run: AgentRun): string {
  const key = run.input.taskKey;
  return typeof key === "string" && key !== "" ? key : run.taskId;
}

/**
 * `?agent=` 变化 → 开合并取数（深链接 / 行内「详情」/ 前进后退共用这一条路径）。
 * 已经在看同一个 Agent 时不重复请求。
 */
watch(selectedAgentName, (name) => {
  detailOpen.value = Boolean(name);
  if (name && store.current?.definition.name !== name) void store.select(name);
});

/** 关闭抽屉 → 回到列表路由（URL 与可见状态保持一致）。 */
watch(detailOpen, (open) => {
  if (!open && selectedAgentName.value) void router.push({ path: "/agents" });
});

onMounted(async () => {
  await store.load();
  // 深链接：`store.load()` 内部会默认选中注册表第一个，这里覆盖成 URL 指定的那个。
  if (selectedAgentName.value && store.current?.definition.name !== selectedAgentName.value) {
    void store.select(selectedAgentName.value);
  }
});
</script>

<template>
  <PageContainer width="wide">
    <PageHeader title="专业 Agent" />

    <!-- 6 张指标卡：3 列 → lg（1024px）单列 -->
    <div class="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card
        v-for="metric in metrics"
        :key="metric.label"
        class="grid gap-2 p-[var(--card-padding)]"
      >
        <span class="text-secondary text-muted-foreground">{{ metric.label }}</span>
        <strong class="text-metric font-semibold text-foreground">{{ metric.value }}</strong>
      </Card>
    </div>

    <Card class="grid gap-4 p-[var(--card-padding)]">
      <SectionHeader title="注册表" />
      <TableSkeleton
        v-if="store.loading && !store.agents.length"
        :columns="agentColumns.length"
        :rows="3"
      />
      <ErrorState v-else-if="store.error" :message="store.error" @retry="reload" />
      <EmptyState v-else-if="!store.agents.length" title="暂无已注册的 Agent。" size="compact">
        <template #actions>
          <Button variant="secondary" type="button" @click="reload">刷新</Button>
        </template>
      </EmptyState>
      <div v-else class="min-w-0">
        <Table
          :columns="agentColumns"
          :rows="store.agents"
          :row-key="(row) => row.name"
          min-width="min-w-180"
        >
          <template #cell-name="{ row }">
            <strong class="break-words text-body font-semibold text-foreground">
              {{ row.name }}
            </strong>
          </template>
          <template #cell-type="{ row }">
            <Badge variant="secondary">{{ agentTypeLabel(row.type) }}</Badge>
          </template>
          <template #cell-status="{ row }">
            <StatusBadge :tone="row.status === 'available' ? 'success' : 'neutral'">
              {{ agentAvailabilityLabel(row.status) }}
            </StatusBadge>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" @click="openDetail(row)">
                详情
              </Button>
            </div>
          </template>
        </Table>
      </div>
    </Card>

    <Drawer v-model:open="detailOpen" title="Agent 详情">
      <ErrorState v-if="store.error" :message="store.error" @retry="reload" />
      <EmptyState v-else-if="!store.current" title="请选择 Agent。" />

      <div v-else class="grid gap-5">
        <Card class="p-[var(--card-padding)]">
          <SectionHeader :title="store.current.definition.name">
            <template #actions>
              <StatusBadge
                :tone="store.current.definition.status === 'available' ? 'success' : 'neutral'"
              >
                {{ agentAvailabilityLabel(store.current.definition.status) }}
              </StatusBadge>
            </template>
          </SectionHeader>
          <p class="m-0 text-body text-foreground">{{ store.current.definition.description }}</p>
          <dl class="m-0 mt-4">
            <DetailRow label="能力">{{
              store.current.definition.capabilities.map(capabilityLabel).join("、")
            }}</DetailRow>
            <DetailRow label="工具">{{
              store.current.definition.tools.join(", ")
            }}</DetailRow>
            <DetailRow label="路径">{{
              store.current.definition.permissions.pathPrefixes.join(", ")
            }}</DetailRow>
            <DetailRow label="模式">{{
              store.current.definition.permissions.readOnly ? "只读" : "读写"
            }}</DetailRow>
          </dl>
        </Card>

        <Card class="p-[var(--card-padding)]">
          <SectionHeader title="Agent 运行">
            <template #actions>
              <Badge variant="secondary">{{ store.current.runs.length }}</Badge>
            </template>
          </SectionHeader>
          <EmptyState v-if="!store.current.runs.length" title="暂无运行记录。" size="compact" />
          <ul v-else class="m-0 grid list-none gap-0 p-0">
            <li
              v-for="run in store.current.runs"
              :key="run.id"
              class="grid grid-cols-1 gap-2 border-t border-border py-3 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,1fr)_180px] lg:gap-4"
            >
              <div class="min-w-0">
                <StatusBadge :tone="agentStatusTone(run.status)">
                  {{ agentStatusLabel(run.status) }}
                </StatusBadge>
                <p
                  class="m-0 mt-1 truncate text-secondary text-muted-foreground"
                  :title="runTaskLabel(run)"
                >
                  {{ runTaskLabel(run) }}
                </p>
              </div>
              <RouterLink
                class="text-secondary text-primary hover:underline"
                :to="`/agent-run?run=${run.id}`"
                >打开</RouterLink
              >
            </li>
          </ul>
        </Card>

        <Card class="p-[var(--card-padding)]">
          <SectionHeader title="产出物">
            <template #actions>
              <Badge variant="secondary">{{ store.current.artifacts.length }}</Badge>
            </template>
          </SectionHeader>
          <EmptyState v-if="!store.current.artifacts.length" title="暂无产出物。" size="compact" />
          <ul v-else class="m-0 grid list-none gap-0 p-0">
            <li
              v-for="artifact in store.current.artifacts"
              :key="artifact.id"
              class="grid grid-cols-1 gap-2 border-t border-border py-3.5 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,1fr)_180px] lg:gap-4"
            >
              <div class="min-w-0">
                <strong class="text-body font-semibold text-foreground">
                  {{ artifactTypeLabel(artifact.type) }}
                </strong>
                <p class="m-0 mt-1.5 break-words text-body text-muted-foreground">
                  {{ artifact.name }}
                </p>
              </div>
              <small class="text-secondary text-muted-foreground">
                {{ new Date(artifact.createdAt).toLocaleString("zh-CN") }}
              </small>
            </li>
          </ul>
        </Card>
      </div>
    </Drawer>
  </PageContainer>
</template>
