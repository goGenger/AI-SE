import { describe, expect, it, vi } from "vitest";
import { isModEnter, useModEnterSubmit } from "@/composables/useModEnterSubmit";

/**
 * W8 — Cmd/Ctrl + Enter 提交表单。
 *
 * `<form>` 与 `KeyboardEvent` 都用最小替身构造：这条逻辑只关心「按了什么键」
 * 与「当前元素能不能 requestSubmit」，不需要真实 DOM。
 */
type KeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">;

function key(partial: Partial<KeyEvent>): KeyEvent {
  return { key: "Enter", metaKey: false, ctrlKey: false, ...partial };
}

/** 造一个「事件 + 表单」替身。`requestSubmit` 用 vi.fn 记录是否被调用。 */
function harness(options: { requestSubmit?: unknown } = {}) {
  const form: { requestSubmit: unknown } = { requestSubmit: vi.fn() };
  if ("requestSubmit" in options) {
    form.requestSubmit = options.requestSubmit;
  }
  const event = {
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    currentTarget: form,
    preventDefault: vi.fn()
  };
  return { form, event };
}

describe("isModEnter", () => {
  it("Cmd+Enter / Ctrl+Enter 命中", () => {
    expect(isModEnter(key({ metaKey: true }))).toBe(true);
    expect(isModEnter(key({ ctrlKey: true }))).toBe(true);
  });

  it("裸 Enter 不命中（它在 <textarea> 里是换行）", () => {
    expect(isModEnter(key({}))).toBe(false);
  });

  it("修饰键 + 别的键不命中", () => {
    expect(isModEnter(key({ metaKey: true, key: "k" }))).toBe(false);
  });
});

describe("useModEnterSubmit", () => {
  it("修饰键 + Enter：阻止默认并 requestSubmit（让原生校验照常生效）", () => {
    const onFormKeydown = useModEnterSubmit();
    const { form, event } = harness();
    event.metaKey = true;

    onFormKeydown(event as unknown as KeyboardEvent);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(form.requestSubmit).toHaveBeenCalledTimes(1);
  });

  it("裸 Enter：什么都不做", () => {
    const onFormKeydown = useModEnterSubmit();
    const { form, event } = harness();

    onFormKeydown(event as unknown as KeyboardEvent);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(form.requestSubmit).not.toHaveBeenCalled();
  });

  it("当前元素不是表单时静默返回，不抛错", () => {
    const onFormKeydown = useModEnterSubmit();
    const { event } = harness({ requestSubmit: null });
    event.metaKey = true;

    expect(() => onFormKeydown(event as unknown as KeyboardEvent)).not.toThrow();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("currentTarget 为 null 时静默返回", () => {
    const onFormKeydown = useModEnterSubmit();
    const event = {
      key: "Enter",
      metaKey: true,
      ctrlKey: false,
      currentTarget: null,
      preventDefault: vi.fn()
    };

    expect(() => onFormKeydown(event as unknown as KeyboardEvent)).not.toThrow();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("Ctrl 变体同样生效（Windows / Linux）", () => {
    const onFormKeydown = useModEnterSubmit();
    const { form, event } = harness();
    event.ctrlKey = true;

    onFormKeydown(event as unknown as KeyboardEvent);

    expect(form.requestSubmit).toHaveBeenCalledTimes(1);
  });
});
