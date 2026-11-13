import { ref } from "vue";

/** 复制成功反馈的默认保留时长。 */
const DEFAULT_FEEDBACK_MS = 1500;

export interface UseCopyToClipboardOptions {
  /** 成功反馈保留多久（毫秒） */
  feedbackMs?: number;
  /** 注入剪贴板实现（测试用）。默认 `navigator.clipboard.writeText`。 */
  writeText?: (text: string) => Promise<void>;
}

export interface UseCopyToClipboard {
  /** 最近一次**成功**复制的文本；反馈超时后清空 */
  copied: ReturnType<typeof ref<string>>;
  /** 复制。返回是否成功 —— 失败（如非安全上下文里没有剪贴板）时静默返回 false */
  copy: (text: string) => Promise<boolean>;
  /** `text` 是否是当前显示「已复制」的那一条 */
  isCopied: (text: string) => boolean;
}

/**
 * 复制到剪贴板 + 短暂的成功反馈状态。
 *
 * 这是「逻辑」，不是样式：反馈时长与失败静默策略放在这里，`CopyableId` 只负责渲染。
 * 剪贴板实现可注入，因此可在 Node 环境下直接单测（见 `__tests__/copyToClipboard.test.ts`）。
 */
export function useCopyToClipboard(options: UseCopyToClipboardOptions = {}): UseCopyToClipboard {
  const copied = ref("");
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function copy(text: string): Promise<boolean> {
    const write =
      options.writeText ?? ((value: string) => navigator.clipboard.writeText(value));
    try {
      await write(text);
    } catch {
      return false;
    }
    copied.value = text;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      copied.value = "";
    }, options.feedbackMs ?? DEFAULT_FEEDBACK_MS);
    return true;
  }

  function isCopied(text: string): boolean {
    return copied.value === text;
  }

  return { copied, copy, isCopied };
}
