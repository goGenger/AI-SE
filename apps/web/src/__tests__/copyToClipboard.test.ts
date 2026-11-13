import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCopyToClipboard } from "@/composables/useCopyToClipboard";

/**
 * W7 — 复制到剪贴板的逻辑层（`CopyableId` 的「已复制」反馈由它驱动）。
 *
 * 剪贴板实现可注入，所以这个 composable 不需要 DOM、也不需要真的写剪贴板就能测。
 */
describe("useCopyToClipboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("复制成功：返回 true，并把成功反馈指向该文本", async () => {
    const written: string[] = [];
    const { copy, copied, isCopied } = useCopyToClipboard({
      writeText: async (text) => {
        written.push(text);
      }
    });

    await expect(copy("abc-123")).resolves.toBe(true);
    expect(written).toEqual(["abc-123"]);
    expect(copied.value).toBe("abc-123");
    expect(isCopied("abc-123")).toBe(true);
    expect(isCopied("other")).toBe(false);
  });

  it("反馈在超时后自行清空", async () => {
    const { copy, copied } = useCopyToClipboard({
      writeText: async () => undefined,
      feedbackMs: 1000
    });

    await copy("abc-123");
    expect(copied.value).toBe("abc-123");

    vi.advanceTimersByTime(999);
    expect(copied.value).toBe("abc-123");

    vi.advanceTimersByTime(1);
    expect(copied.value).toBe("");
  });

  it("连续复制：计时器重置，反馈跟着最后一条走", async () => {
    const { copy, copied } = useCopyToClipboard({
      writeText: async () => undefined,
      feedbackMs: 1000
    });

    await copy("first");
    vi.advanceTimersByTime(800);
    await copy("second");

    vi.advanceTimersByTime(800); // first 的计时器本应已到点，但它被重置了
    expect(copied.value).toBe("second");

    vi.advanceTimersByTime(200);
    expect(copied.value).toBe("");
  });

  it("剪贴板不可用时静默失败：返回 false，不显示成功反馈", async () => {
    const { copy, copied } = useCopyToClipboard({
      writeText: async () => {
        throw new Error("clipboard unavailable");
      }
    });

    await expect(copy("abc-123")).resolves.toBe(false);
    expect(copied.value).toBe("");
  });
});
