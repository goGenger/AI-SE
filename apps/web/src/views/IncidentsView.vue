<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import {
  CopyableId,
  DetailRow,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  PageContainer,
  PageHeader,
  SectionHeader,
  StatusBadge
} from "../components/common";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useIncidentsStore } from "../stores/incidents";
import {
  evidenceSourceKindLabel,
  faultTypeLabel,
  formatIncidentDateTime,
  incidentLabelChips,
  incidentListMeta,
  incidentSeverityLabel,
  incidentSeverityTone,
  incidentStatusLabel,
  incidentStatusTone,
  recommendedActionLabel,
  remediationDecisionLabel,
  yesNoLabel
} from "../viewmodels/incidentViewModel";

/**
 * IncidentsView（W5 对齐 Deployments：主从 320px | 1fr + 中文枚举标签）。
 *
 * 业务层冻结：load / select / diagnose / remediate(false) 与路由 :id 行为不变。
 * 本页只做展示打磨：中文文案、DetailRow、标签芯片、证据分条，不用原始英文 chrome。
 */

const route = useRoute();
const router = useRouter();
const incidents = useIncidentsStore();

const selectedId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));

const currentLabelChips = computed(() =>
  incidents.current ? incidentLabelChips(incidents.current.labels) : []
);

watch(selectedId, (id) => {
  if (id) void incidents.select(id);
  else incidents.clearCurrent();
});

function openDetail(id: string) {
  void router.push(`/incidents/${id}`);
}

function reload() {
  void incidents.load();
  if (selectedId.value) void incidents.select(selectedId.value);
}

function runDiagnosis() {
  if (!selectedId.value) return;
  void incidents.diagnose(selectedId.value);
}

function runRemediation() {
  if (!selectedId.value) return;
  void incidents.remediate(selectedId.value, false);
}

const canDiagnose = computed(() => {
  const current = incidents.current;
  if (!current) return false;
  return !["resolved", "cancelled", "mitigating"].includes(current.status);
});

const canRemediate = computed(() => {
  const current = incidents.current;
  if (!current?.diagnosis) return false;
  if (["resolved", "cancelled"].includes(current.status)) return false;
  return current.remediation?.decision !== "OPENED_STAGING_FIX_WORKFLOW";
});

onMounted(async () => {
  await incidents.load();
  if (selectedId.value) await incidents.select(selectedId.value);
});
</script>

<template>
  <PageContainer width="wide">
    <PageHeader
      title="事件"
      description="告警入站 → 只读诊断 → 白名单受控修复（预发验证 + 生产审批；自动启动默认关闭）。"
    />

    <ErrorState
      v-if="incidents.error"
      class="mb-[var(--section-gap)]"
      :message="incidents.error"
      @retry="reload"
    />

    <!-- 主从两栏：<1024px 单列 / ≥1024px 320px 列表 + 1fr 详情 -->
    <div v-else class="grid grid-cols-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside class="grid content-start gap-3">
        <Card class="grid gap-4 p-[var(--card-padding)]">
          <SectionHeader title="列表" />
          <div
            v-if="incidents.loading && incidents.incidents.length === 0"
            class="grid gap-2"
            role="status"
            aria-label="加载中"
          >
            <LoadingSkeleton v-for="row in 3" :key="row" class="h-16 rounded-lg" />
          </div>
          <EmptyState
            v-else-if="incidents.incidents.length === 0"
            title="暂无事件"
            description="向 POST /api/alerts 投递告警后会出现在这里。"
            size="compact"
          />
          <div v-else class="grid gap-2">
            <button
              v-for="item in incidents.incidents"
              :key="item.id"
              type="button"
              class="grid w-full cursor-pointer gap-1 rounded-lg border border-border bg-card p-3 text-left text-body text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :class="
                item.id === selectedId ? 'border-primary bg-primary-light' : 'hover:bg-muted'
              "
              :data-active="item.id === selectedId ? 'true' : undefined"
              @click="openDetail(item.id)"
            >
              <div class="flex items-start justify-between gap-2">
                <strong class="min-w-0 truncate text-body font-semibold text-foreground">
                  {{ item.title }}
                </strong>
                <StatusBadge :tone="incidentStatusTone(item.status)">
                  {{ incidentStatusLabel(item.status) }}
                </StatusBadge>
              </div>
              <span
                class="truncate text-secondary text-muted-foreground"
                :title="incidentListMeta(item.source, item.fingerprint)"
              >
                {{ incidentSeverityLabel(item.severity) }} ·
                {{ incidentListMeta(item.source, item.fingerprint) }}
              </span>
              <span class="truncate text-caption text-muted-foreground">
                {{ formatIncidentDateTime(item.openedAt) }}
              </span>
            </button>
          </div>
        </Card>
      </aside>

      <main v-if="incidents.loading && !incidents.current && selectedId" class="grid content-start gap-3">
        <LoadingSkeleton class="h-40 rounded-lg" />
      </main>

      <main v-else-if="incidents.current" class="grid content-start gap-3">
        <Card class="grid gap-4 p-[var(--card-padding)]">
          <SectionHeader eyebrow="事件详情" :title="incidents.current.title">
            <template #actions>
              <StatusBadge :tone="incidentStatusTone(incidents.current.status)">
                {{ incidentStatusLabel(incidents.current.status) }}
              </StatusBadge>
              <StatusBadge :tone="incidentSeverityTone(incidents.current.severity)">
                {{ incidentSeverityLabel(incidents.current.severity) }}
              </StatusBadge>
            </template>
          </SectionHeader>

          <dl class="m-0">
            <DetailRow label="ID">
              <CopyableId :id="incidents.current.id" display="full" class="max-w-full" />
            </DetailRow>
            <DetailRow label="来源">{{ incidents.current.source }}</DetailRow>
            <DetailRow label="指纹" value-class="font-mono text-caption">
              {{ incidents.current.fingerprint }}
            </DetailRow>
            <DetailRow label="开启时间">
              {{ formatIncidentDateTime(incidents.current.openedAt) }}
            </DetailRow>
            <DetailRow v-if="incidents.current.summary" label="摘要">
              {{ incidents.current.summary }}
            </DetailRow>
            <DetailRow v-if="incidents.current.linkedWorkflowRunId" label="关联工作流">
              <RouterLink
                class="text-primary hover:underline"
                :to="`/workflows/${incidents.current.linkedWorkflowRunId}`"
              >
                {{ incidents.current.linkedWorkflowRunId }}
              </RouterLink>
            </DetailRow>
            <DetailRow v-if="currentLabelChips.length" label="标签" value-class="min-w-0">
              <ul class="m-0 flex list-none flex-wrap gap-2 p-0">
                <li
                  v-for="chip in currentLabelChips"
                  :key="chip.key"
                  class="rounded-md border border-border bg-muted px-2 py-1 text-caption text-foreground"
                >
                  <span class="text-muted-foreground">{{ chip.keyLabel }}</span>
                  · {{ chip.valueLabel }}
                </li>
              </ul>
            </DetailRow>
          </dl>

          <div class="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              :disabled="incidents.loading || !canDiagnose"
              @click="runDiagnosis"
            >
              运行只读诊断
            </Button>
            <Button
              type="button"
              :disabled="incidents.loading || !canRemediate"
              @click="runRemediation"
            >
              受控修复（白名单 → 预发）
            </Button>
          </div>
        </Card>

        <Card
          v-if="incidents.current.remediation"
          class="grid gap-3 p-[var(--card-padding)]"
        >
          <SectionHeader title="受控修复" />
          <dl class="m-0">
            <DetailRow label="决策">
              {{ remediationDecisionLabel(incidents.current.remediation.decision) }}
            </DetailRow>
            <DetailRow v-if="incidents.current.remediation.faultType" label="故障类型">
              {{ faultTypeLabel(incidents.current.remediation.faultType) }}
            </DetailRow>
            <DetailRow label="原因">{{ incidents.current.remediation.reason }}</DetailRow>
            <DetailRow
              v-if="incidents.current.remediation.workflowRunId"
              label="修复工作流"
            >
              <RouterLink
                class="text-primary hover:underline"
                :to="`/workflows/${incidents.current.remediation.workflowRunId}`"
              >
                {{ incidents.current.remediation.workflowRunId }}
              </RouterLink>
            </DetailRow>
            <DetailRow
              v-if="incidents.current.remediation.started !== undefined"
              label="已启动工作流"
            >
              {{ yesNoLabel(incidents.current.remediation.started) }}
            </DetailRow>
            <DetailRow
              v-if="incidents.current.remediation.autoStarted !== undefined"
              label="自动启动"
            >
              {{ yesNoLabel(incidents.current.remediation.autoStarted) }}
            </DetailRow>
            <DetailRow label="决策时间">
              {{ formatIncidentDateTime(incidents.current.remediation.decidedAt) }}
            </DetailRow>
          </dl>
        </Card>

        <Card
          v-if="incidents.current.diagnosis"
          class="grid gap-3 p-[var(--card-padding)]"
        >
          <SectionHeader title="只读诊断" />
          <dl class="m-0">
            <DetailRow label="摘要">{{ incidents.current.diagnosis.summary }}</DetailRow>
            <DetailRow label="根因假设">
              {{ incidents.current.diagnosis.rootCauseHypothesis }}
            </DetailRow>
            <DetailRow label="修复计划（建议）">
              {{ incidents.current.diagnosis.fixPlan }}
            </DetailRow>
            <DetailRow label="风险">{{ incidents.current.diagnosis.risk }}</DetailRow>
            <DetailRow label="建议动作">
              {{ recommendedActionLabel(incidents.current.diagnosis.recommendedAction) }}
            </DetailRow>
            <DetailRow label="诊断时间">
              {{ formatIncidentDateTime(incidents.current.diagnosis.diagnosedAt) }}
            </DetailRow>
            <DetailRow label="诊断 Agent">
              {{ incidents.current.diagnosis.agentName }}
            </DetailRow>
          </dl>

          <SectionHeader title="证据" />
          <ol class="m-0 grid list-none gap-3 p-0">
            <li
              v-for="(item, index) in incidents.current.diagnosis.evidence"
              :key="`${item.ref}-${index}`"
              class="grid gap-2 rounded-lg border border-border bg-muted/40 p-3"
            >
              <div class="flex flex-wrap items-center gap-2">
                <StatusBadge tone="neutral">
                  {{ evidenceSourceKindLabel(item.sourceKind) }}
                </StatusBadge>
                <span class="font-mono text-caption text-muted-foreground">{{ item.ref }}</span>
                <span class="text-caption text-muted-foreground">
                  {{ formatIncidentDateTime(item.collectedAt) }}
                </span>
              </div>
              <p class="m-0 whitespace-pre-wrap break-words text-body text-foreground">
                {{ item.excerpt }}
              </p>
              <ul
                v-if="Object.keys(item.labels).length"
                class="m-0 flex list-none flex-wrap gap-2 p-0"
              >
                <li
                  v-for="(value, key) in item.labels"
                  :key="String(key)"
                  class="rounded-md border border-border bg-card px-2 py-0.5 text-caption text-foreground"
                >
                  <span class="text-muted-foreground">{{ key }}</span> · {{ value }}
                </li>
              </ul>
            </li>
          </ol>
        </Card>
      </main>

      <EmptyState
        v-else
        title="请选择事件"
        description="从左侧列表打开详情。"
      />
    </div>
  </PageContainer>
</template>

<style scoped>
/*
 * 选中态左侧强调条（与 DeploymentsView 同款例外：inset 阴影工具类表达不了）。
 */
[data-active="true"] {
  box-shadow: inset 3px 0 0 var(--primary);
}
</style>
