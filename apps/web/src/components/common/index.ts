/**
 * AI-SE Common Components（Phase 3-C；W5 扩充）。
 *
 * 层级（docs/design/04-component-system.md §1）：
 *   UI Primitives (components/ui) → AI-SE Common Components (components/common) → 业务组件 → 页面
 *
 * 骨架与状态组件（页面统一使用）：
 *   PageHeader（11 个页面全部使用）、SectionHeader（6 个页面约 20 处）、
 *   StatusBadge（5 个页面的状态展示）、EmptyState（11 个页面约 25 处）、
 *   PageContainer（W4 新增，11 个页面全部套用，承载全站唯一的页面宽度）。
 *
 * W5 新增——统一「四种状态」里的前三种（见 src/styles/README.md §14「页面骨架」）：
 *   LoadingSkeleton（骨架条基础件）、TableSkeleton（列表加载态）、
 *   ErrorState（可重试错误态）。第四种「有数据」不另设组件，由各页面的业务结构直接渲染。
 *   DetailRow（「字段名 / 值」详情行，收敛 17 处重复的 `<dl>` 栅格）。
 *
 * W7 新增：
 *   CopyableId（ID 文本本身可点复制，替代列表里占按钮位的「复制 ID」）。
 *
 * W8 新增：
 *   ConfirmDialog（全站唯一的危险操作确认方式，见 components/README.md §2）。
 *
 * D1 新增：
 *   FileDropzone（文件选择区——原生 file 控件在无 preflight 下会带 UA 外观，
 *   统一用令牌画；支持拖拽、键盘焦点、多选与逐项移除）。
 *
 * 仍未创建（依据 Phase 0「没有真实使用场景不提前创建」）：
 *   MetricCard / FormField / DataTable / FilterBar / SearchInput / Toolbar。
 *   （Dialog / Drawer / Select / Pagination / Table / Tabs 等已在 components/ui 下实现，
 *     不在本层重复。）
 */
export { default as ConfirmDialog } from "./ConfirmDialog.vue";
export { default as CopyableId } from "./CopyableId.vue";
export { default as DetailRow } from "./DetailRow.vue";
export { default as EmptyState } from "./EmptyState.vue";
export { default as ErrorState } from "./ErrorState.vue";
export { default as FileDropzone } from "./FileDropzone.vue";
export { default as LoadingSkeleton } from "./LoadingSkeleton.vue";
export { default as PageContainer } from "./PageContainer.vue";
export { default as PageHeader } from "./PageHeader.vue";
export { default as SectionHeader } from "./SectionHeader.vue";
export { default as StatusBadge } from "./StatusBadge.vue";
export { default as TableSkeleton } from "./TableSkeleton.vue";
