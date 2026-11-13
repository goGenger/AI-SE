<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/components/ui/utils";

/**
 * DetailRow（AI-SE Common Component，W5）。
 *
 * 「字段名 / 值」的一行，**必须放在 `<dl>` 里**（渲染出 `<dt>` + `<dd>`）。
 *
 * 改造前这套 markup 在 17 处逐字重复（AgentRun 10 / Agents 4 / Requirements 3），
 * 栅格与边框/内距收进 `.detail-row`（`@layer components`，见 styles/app.css §3.5）——
 * 列宽是布局模板而非刻度值，Tailwind 无法用具名刻度表达。
 *
 * 值那一列的默认类是 `break-words`（长串换行而不是撑破栅格）。
 * 需要保留原生换行的场景（如错误堆栈）传 `valueClass="break-all whitespace-pre-wrap"`。
 *
 * 无业务依赖：不访问 API / Store / Router。
 */
const props = withDefaults(
  defineProps<{
    /** 字段名（渲染为 `<dt>`）。 */
    label: string;
    /** 值那一列（`<dd>`）的附加类，用于覆盖默认的换行策略。 */
    valueClass?: HTMLAttributes["class"];
  }>(),
  {
    valueClass: ""
  }
);
</script>

<template>
  <div class="detail-row">
    <dt class="text-body font-semibold text-muted-foreground">{{ props.label }}</dt>
    <dd :class="cn('m-0 break-words text-body text-foreground', props.valueClass)">
      <slot />
    </dd>
  </div>
</template>
