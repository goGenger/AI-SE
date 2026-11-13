import { createSSRApp, h, type Component } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import { FileDropzone } from "@/components/common";

/**
 * FileDropzone（D1）组件契约测试。
 *
 * 沿用本目录既有的 SSR 断言方式（无需 jsdom）：只验渲染出的标签、原生属性与可见文案。
 * 拖拽与文件选择的**行为**由 `RequirementsView` 的用例与后端上传用例覆盖——
 * SSR 里没有拖拽事件，mock 一个 DataTransfer 只会测到 mock 自己。
 */
async function render(
  props: Record<string, unknown> = {},
  modelValue: File[] = []
): Promise<string> {
  const app = createSSRApp({
    render: () =>
      h(FileDropzone as Component, {
        ...props,
        modelValue,
        "onUpdate:modelValue": () => undefined
      })
  });
  return renderToString(app);
}

describe("FileDropzone", () => {
  it("渲染标签、约束说明与原生 file 控件（可访问的语义载体）", async () => {
    const html = await render({
      id: "requirement-prd-file",
      label: "或上传 PRD 文件",
      accept: ".md,.markdown,.txt,.docx",
      hint: ".md / .txt / .docx · 单份 ≤ 5 MB"
    });
    expect(html).toContain("或上传 PRD 文件");
    expect(html).toContain(".md / .txt / .docx · 单份 ≤ 5 MB");
    expect(html).toContain('id="requirement-prd-file"');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".md,.markdown,.txt,.docx"');
    // 原生控件对 assistive tech 仍可见（sr-only 而非 hidden）
    expect(html).toContain("sr-only");
    expect(html).not.toContain("display:none");
  });

  it("多选时带 multiple 属性；未选文件时不渲染列表", async () => {
    const html = await render({ multiple: true });
    expect(html).toContain("multiple");
    expect(html).not.toContain("移除");
  });

  it("已选文件逐项列出名称与体积，并提供移除入口", async () => {
    const files = [
      new File(["# 架构"], "architecture.md", { type: "text/markdown" }),
      new File(["# 接口"], "api.md", { type: "text/markdown" })
    ];
    const html = await render({ multiple: true }, files);
    expect(html).toContain("architecture.md");
    expect(html).toContain("api.md");
    expect(html).toContain("移除");
    expect(html).toContain('aria-label="移除 architecture.md"');
  });

  it("禁用时不可点击且降低不透明度（与 Input 同一套禁用语言）", async () => {
    const html = await render({ disabled: true });
    expect(html).toContain("opacity-60");
    expect(html).toContain("disabled");
  });
});
