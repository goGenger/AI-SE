import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * AI-SE 统一的 className 合并工具（Phase 3-A 基础设施，Phase 3-B 扩展）。
 *
 * 位置说明：shadcn-vue 默认放在 `@/lib/utils`，但本仓库 AGENTS.md §5 明确禁止
 * 在已规划的 `components/` `composables/` `types/` `constants/` 之外另立
 * `lib/` / `shared/` / `helpers/` 等同名变体目录，因此沿用 `components/ui/`。
 *
 * ── Phase 3-B 扩展：登记 AI-SE 自定义排版工具类 ────────────────────────────
 * `--text-*` 这组 Design Token 由 `@theme inline` 生成为 `text-body` 等工具类。
 * tailwind-merge 默认不认识这些名字，会把任何 `text-*` 未知值一律归为**文字颜色**，
 * 于是当它与真正的颜色类同时出现时会被静默丢弃，例如：
 *
 *   cn("text-caption", "text-success")  → "text-success"      // 12px 字号丢失！
 *   cn("text-secondary", "text-foreground") → "text-foreground" // 13px 字号丢失！
 *
 * 这正是 Badge / Label / Button / CardTitle 等组件会踩到的问题，因此这里把 9 个
 * 排版 Token 显式登记进 tailwind-merge 的**字号**分组，使字号与颜色互不冲突。
 */
const FONT_SIZE_TOKENS = [
  "page-title",
  "section-title",
  "card-title",
  "body",
  "secondary",
  "caption",
  "metric",
  "nav",
  "nav-sub"
];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: FONT_SIZE_TOKENS }]
    }
  }
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
