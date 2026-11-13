<script setup lang="ts">
import { computed, ref } from "vue";
import { cn } from "@/components/ui/utils";

/**
 * 文件选择区（D1，`docs/229`）。
 *
 * 为什么不是一个 `<input type="file">`：本项目**未启用 Tailwind preflight**（`styles/README.md` §0），
 * 原生 file 控件会带着 UA 的按钮外观，和组件库里的 Input / Button 完全不是一个东西。
 * 这里把原生控件保留为**语义载体**（`sr-only`，键盘可达），可见部分用令牌画：
 *   · 静止：`bg-card` + `border-dashed border-input`（表单域允许线，`docs/...` 的房规例外）
 *   · 悬停 / 拖拽悬停：只走**色调台阶**（`bg-muted` / `bg-primary-light`），不加阴影与渐变
 *   · 键盘焦点：`focus-within:ring-2 ring-ring`，与 Input 同一套焦点语言
 *   · 禁用：`opacity-60` + 不响应拖拽
 */
const props = defineProps<{
  /** 可见标签；不传则只渲染选择区（由调用方自己放 Label）。 */
  label?: string;
  /** 原生 input 的 id（标签关联与测试断言用）。 */
  id?: string;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  /** 约束说明，例如「.md / .txt / .docx · 单份 ≤ 5 MB」。 */
  hint?: string;
  class?: string;
}>();

/** 已选文件；`v-model` 绑定数组，单文件场景取第 0 项。 */
const model = defineModel<File[]>({ default: () => [] });

const dragging = ref(false);

const acceptLabel = computed(() => props.accept ?? "");

function addFiles(files: FileList | null) {
  if (!files || files.length === 0) return;
  const incoming = Array.from(files);
  model.value = props.multiple ? [...model.value, ...incoming] : incoming.slice(0, 1);
}

function onInput(event: Event) {
  const input = event.target as HTMLInputElement;
  addFiles(input.files);
  // 允许重复选同一个文件（否则第二次选它不会触发 change）。
  input.value = "";
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  if (props.disabled) return;
  addFiles(event.dataTransfer?.files ?? null);
}

function removeAt(index: number) {
  model.value = model.value.filter((_, position) => position !== index);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <div :class="cn('grid gap-2', props.class)">
    <span v-if="label" class="text-sm font-medium text-foreground">{{ label }}</span>

    <label
      :class="
        cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-input bg-card px-4 py-5 text-center transition-colors',
          'hover:bg-muted focus-within:ring-2 focus-within:ring-ring',
          dragging && 'border-primary bg-primary-light',
          disabled && 'pointer-events-none opacity-60'
        )
      "
      @dragover.prevent="dragging = !disabled"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <input
        :id="id"
        type="file"
        class="sr-only"
        :accept="acceptLabel"
        :multiple="multiple"
        :disabled="disabled"
        @change="onInput"
      />
      <svg
        class="size-5 text-muted-foreground"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M12 16V4" />
        <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
        <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
      </svg>
      <span class="text-sm text-foreground">点击选择文件，或把文件拖到这里</span>
      <span v-if="hint" class="text-xs text-muted-foreground">{{ hint }}</span>
    </label>

    <ul v-if="model.length > 0" class="m-0 grid list-none gap-1.5 p-0">
      <li
        v-for="(file, index) in model"
        :key="`${file.name}-${index}`"
        class="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2"
      >
        <span class="min-w-0 truncate text-sm text-foreground">{{ file.name }}</span>
        <span class="flex shrink-0 items-center gap-2">
          <span class="text-xs text-muted-foreground">{{ formatSize(file.size) }}</span>
          <button
            type="button"
            class="cursor-pointer appearance-none rounded-sm border-0 bg-transparent p-0 text-xs text-danger hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            :aria-label="`移除 ${file.name}`"
            @click.prevent="removeAt(index)"
          >
            移除
          </button>
        </span>
      </li>
    </ul>
  </div>
</template>
