import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

export { default as Button } from "./Button.vue";

/**
 * AI-SE Button 变体（Phase 3-B）。
 *
 * 视觉来源：`docs/design/00-design-system.md` §10 + Phase 1-B Design Token。
 * · default   → Primary（--primary）；同页应尽量只保留一个权重最高的 Primary Action
 * · secondary → 次要底色（复用 --secondary / --muted）
 * · destructive → 危险操作（复用 --danger，未新增品牌色）
 * · outline / ghost / link → 低权重操作
 *
 * 用 `buttonVariants()` 给 `<a>` / `<RouterLink>` 套样式时，文字色由变体直接提供
 * （如 secondary → `text-foreground`、link → `text-primary`）。基础层的
 * `a { color: inherit }` 不再与工具类冲突，无需页面侧额外覆盖。
 */
export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer appearance-none items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-body font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        secondary: "bg-muted text-foreground hover:bg-border",
        destructive: "bg-danger text-primary-foreground hover:bg-danger/90",
        outline: "border-border bg-card text-foreground hover:bg-muted",
        ghost: "bg-transparent text-foreground hover:bg-muted",
        link: "bg-transparent text-primary underline-offset-4 hover:underline"
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3",
        lg: "h-10 px-6",
        icon: "size-9"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export type ButtonVariants = VariantProps<typeof buttonVariants>;
