<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { computed } from "vue";
import { Check, Copy } from "@lucide/vue";
import { cn } from "@/components/ui/utils";
import { useCopyToClipboard } from "@/composables/useCopyToClipboard";

/**
 * CopyableId（W7）—— 「ID 文本本身可点复制」，替代列表里占一个按钮位的「复制 ID」。
 *
 * 设计文档与计划 §W7 工作项 4：复制一个 ID 是辅助动作，不该和「详情 / 取消」并排成第三个平级按钮。
 * 于是把 ID 文本本身做成可点目标：
 *   · 常态显示前 8 位（`font-mono`），`title` 给出完整 ID 作为悬停提示；
 *   · 悬停 / 键盘聚焦时浮现一枚复制图标（纯 CSS，不用 JS 状态）；
 *   · 复制成功后有**三重反馈**（W9）：文字换成「已复制」+ 图标换成对勾 + 对勾用 success 语义色。
 *
 * 复制的始终是**完整 ID**，不是显示出来的 8 位。
 * 复制逻辑（含失败静默与反馈时长）在 `useCopyToClipboard`，本组件只负责渲染与可访问属性。
 */
const props = withDefaults(
  defineProps<{
    /** 完整 ID（复制的内容；列表里显示为前 8 位） */
    id: string;
    /** `short`（列表，默认）显示前 8 位；`full`（详情，ID 本身是内容）显示完整 ID */
    display?: "short" | "full";
    /** 追加类 */
    class?: HTMLAttributes["class"];
  }>(),
  { display: "short", class: "" }
);

const { copied, copy } = useCopyToClipboard();
const isCopied = computed(() => copied.value === props.id);
const shownId = computed(() => (props.display === "full" ? props.id : props.id.slice(0, 8)));
</script>

<template>
  <button
    type="button"
    :title="`点击复制完整 ID：${props.id}`"
    :aria-label="isCopied ? `已复制 ID ${props.id}` : `复制 ID ${props.id}`"
    :class="
      cn(
        // 本项目不含 Tailwind preflight（见 styles/app.css 文件头）：
        // 原生 button 的 UA 外观（2px outset 边框 + 灰底 + 内距）必须自己关掉。
        'cursor-pointer appearance-none border-0 bg-transparent text-inherit',
        'group inline-flex items-center gap-1 rounded-sm font-mono text-caption text-muted-foreground',
        // -ml-1 让首字符的左边缘与同一列里其它文本对齐（抵消 px-1 的内距）
        '-ml-1 px-1 py-0.5',
        'hover:bg-muted hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        props.class
      )
    "
    @click="copy(props.id)"
  >
    <template v-if="isCopied">
      <Check class="size-3 shrink-0 text-success" aria-hidden="true" />
      <span>已复制</span>
    </template>
    <template v-else>
      <span :class="props.display === 'full' ? 'min-w-0 break-all' : ''">ID {{ shownId }}</span>
      <Copy
        class="size-3 shrink-0 opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60"
        aria-hidden="true"
      />
    </template>
  </button>
</template>
