<script setup lang="ts">
import type { TraceNode } from "@ai-se/shared";
import { ChevronRight } from "@lucide/vue";
import { computed } from "vue";
import { StatusBadge } from "./common";
import { cn } from "./ui/utils";
import {
  traceDetailRows,
  traceNodeDurationLabel,
  traceNodeKey,
  traceNodeKindLabel,
  traceNodeStatusLabel,
  traceNodeStatusTone
} from "../viewmodels/workflowTraceViewModel";

/**
 * TraceTree（TF-M2）—— 7-C 追踪树的递归可折叠渲染。
 *
 * 输入是 `@ai-se/shared` 的 `TraceNode`，本组件对它**只读**：不重排、不丢节点、
 * 不补后端没给的字段（`docs/156` §7）。层级就是契约里的层级
 * （`Workflow → Task → AgentRun → ToolCall`，deployment 挂在产生它的任务下）。
 *
 * 展开态由调用方持有（`expanded: string[]`，元素是 `traceNodeKey`），
 * 本组件只 `emit('toggle', key)` —— **展开 / 收起是纯本地状态，不触发任何请求**（TF-03）。
 *
 * 无障碍（TF-06）—— 选**语义化嵌套列表**而非 `role="tree"`：
 * 完整的 ARIA tree 模式要求 roving tabindex + 方向键导航，只做一半比不做更糟
 * （读屏会播报成树，方向键却不动）。嵌套 `<ul>/<li>` + 真实 `<button aria-expanded>`
 * 结构正确、播报正确，键盘路径是标准的 Tab + Enter/Space，且没有键盘陷阱。
 */
const props = defineProps<{
  node: TraceNode;
  /** 已展开节点的主键集合（`traceNodeKey` 的产物）。 */
  expanded: readonly string[];
}>();

const emit = defineEmits<{ toggle: [key: string] }>();

const key = computed(() => traceNodeKey(props.node));
const isExpanded = computed(() => props.expanded.includes(key.value));
const hasChildren = computed(() => props.node.children.length > 0);
const detailRows = computed(() => traceDetailRows(props.node.detail));
const duration = computed(() => traceNodeDurationLabel(props.node));
</script>

<template>
  <li class="grid gap-1">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <button
        v-if="hasChildren"
        type="button"
        class="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :aria-expanded="isExpanded"
        :aria-label="`${isExpanded ? '收起' : '展开'}${traceNodeKindLabel(node.kind)}「${node.label}」`"
        @click="emit('toggle', key)"
      >
        <ChevronRight
          :class="cn('size-4 transition-transform', isExpanded && 'rotate-90')"
          aria-hidden="true"
        />
      </button>
      <!-- 叶子节点留同宽空位，让同一层的标签对齐（装饰性，读屏跳过）。 -->
      <span v-else class="size-5 shrink-0" aria-hidden="true" />
      <strong class="break-words text-body font-medium text-foreground">{{ node.label }}</strong>
      <span class="text-caption text-muted-foreground">{{ traceNodeKindLabel(node.kind) }}</span>
      <StatusBadge :tone="traceNodeStatusTone(node)">{{ traceNodeStatusLabel(node) }}</StatusBadge>
      <span class="text-caption text-muted-foreground">{{ duration }}</span>
    </div>

    <!-- detail 是后端给的白名单标量（字符串已脱敏），原样呈现。 -->
    <dl
      v-if="detailRows.length"
      class="m-0 grid gap-1 rounded-md border border-border bg-muted p-2"
    >
      <div v-for="row in detailRows" :key="row.label" class="flex flex-wrap gap-2 text-caption">
        <dt class="m-0 font-semibold text-muted-foreground">{{ row.label }}</dt>
        <dd class="m-0 break-all text-foreground">{{ row.value }}</dd>
      </div>
    </dl>

    <ul
      v-if="hasChildren && isExpanded"
      class="m-0 grid list-none gap-1 border-l border-border p-0 pl-3"
    >
      <TraceTree
        v-for="child in node.children"
        :key="traceNodeKey(child)"
        :node="child"
        :expanded="expanded"
        @toggle="emit('toggle', $event)"
      />
    </ul>
  </li>
</template>
