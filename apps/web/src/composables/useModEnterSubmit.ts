/**
 * Cmd/Ctrl + Enter 提交表单（W8）。
 *
 * 为什么需要：普通输入框里按 Enter 本来就会提交表单，但 **`<textarea>` 里不行** ——
 * Enter 是换行。于是「用多行输入写一段任务描述，写完后想直接提交」这条路径，
 * 在改造前必须把手从键盘挪到鼠标。Cmd/Ctrl + Enter 是这类输入框的通行约定。
 *
 * 放在 `composables/`：`AGENTS.md` §5 规划的四个目录里，它是「会被多个组件挂上去的
 * 组件行为」的最接近归属（`components/` 放 UI 片段、`types/` 放类型、`constants/` 放常量）。
 * 它没有响应式状态，但归属判据是「跨组件复用」，不是「含 ref」。
 */

/** 是否是一次「修饰键 + Enter」。独立导出，便于在 Node 环境下直接单测。 */
export function isModEnter(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">
): boolean {
  return (event.metaKey || event.ctrlKey) && event.key === "Enter";
}

/**
 * 给 `<form>` 挂 `@keydown`。
 *
 * 走 `requestSubmit()` 而不是直接调用页面的提交函数：这样**原生表单校验照常生效**
 * （`required` 会拦住空字段并弹出浏览器提示），表单的 `submit` 监听器也只被触发一次。
 */
export function useModEnterSubmit(): (event: KeyboardEvent) => void {
  return (event) => {
    if (!isModEnter(event)) {
      return;
    }
    // 鸭子类型而非 `instanceof HTMLFormElement`：本仓库的测试环境是纯 Node（无 jsdom），
    // 只按行为判断才能把这条逻辑直接测掉（见 __tests__/modEnterSubmit.test.ts）。
    const form = event.currentTarget as HTMLFormElement | null;
    if (!form || typeof form.requestSubmit !== "function") {
      return;
    }
    event.preventDefault();
    form.requestSubmit();
  };
}
