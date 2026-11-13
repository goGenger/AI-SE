import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

export { default as Badge } from "./Badge.vue";

/**
 * AI-SE Badge 变体（Phase 3-B）。
 *
 * 状态色**全部复用既有语义 Token**（success / warning / danger），未新增任何状态色：
 *   · success     → bg-success-bg / text-success
 *   · warning     → bg-warning-bg / text-warning
 *   · destructive → bg-danger-bg / text-danger
 * 视觉风格与参考图中的状态徽标一致：低饱和底色 + 同色系文字，圆角胶囊。
 */
export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-caption font-medium",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-muted text-muted-foreground",
        success: "bg-success-bg text-success",
        warning: "bg-warning-bg text-warning",
        destructive: "bg-danger-bg text-danger"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);

export type BadgeVariants = VariantProps<typeof badgeVariants>;
