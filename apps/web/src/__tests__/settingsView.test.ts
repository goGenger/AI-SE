import type { ModelConfigStatus } from "@ai-se/shared";
import { createPinia } from "pinia";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import { useModelConfigStore } from "@/stores/modelConfig";
import SettingsView from "@/views/SettingsView.vue";

/**
 * SettingsView 页面契约测试（W13 / X1：模型与凭据配置）。
 *
 * SSR 下 onMounted / watch 不执行 ⇒ 不发任何请求，状态直接注入 store（不做 API mock）。
 * 「只发送改过的字段」「密钥框回空」这类判断在 viewmodels/modelConfigViewModel 里单测；
 * 这里钉的是结构与可见文案 —— 特别是「密钥只写不读」这条硬约束在页面上的形态。
 */
const ENV_STATUS: ModelConfigStatus = {
  provider: "openai",
  model: "gpt-5.4-mini",
  baseUrl: "https://env.example/v1",
  apiKeyConfigured: true,
  source: "env",
  overridden: []
};

async function render(status: ModelConfigStatus | null, error = ""): Promise<string> {
  const pinia = createPinia();
  const app = createSSRApp({ render: () => h(SettingsView) });
  app.use(pinia);

  const store = useModelConfigStore(pinia);
  store.status = status;
  store.error = error;

  return renderToString(app);
}

/** 取页面里某个按钮的**开标签**，用来断言它是禁用还是可用。 */
function buttonTagFor(html: string, label: string): string {
  const index = html.indexOf(label);
  if (index < 0) return "";
  const start = html.lastIndexOf("<button", index);
  return start < 0 ? "" : html.slice(start, html.indexOf(">", start) + 1);
}

/** 取某个输入框的开标签。 */
function inputTagFor(html: string, id: string): string {
  const index = html.indexOf(`id="${id}"`);
  if (index < 0) return "";
  const start = html.lastIndexOf("<input", index);
  return start < 0 ? "" : html.slice(start, html.indexOf(">", start) + 1);
}

/**
 * 按钮上真的带了 `disabled` **属性**。不能直接查 "disabled" 子串 ——
 * Tailwind 的 `disabled:pointer-events-none disabled:opacity-60` 类名里就有它，
 * 那样断言会恒真，禁用与否永远看不出来。
 */
function isDisabled(tag: string): boolean {
  return /\sdisabled(?=[\s>])/.test(tag);
}

describe("SettingsView", () => {
  it("页头是「设置」，并说明改动只活在内存里", async () => {
    const html = await render(ENV_STATUS);

    expect(html).toContain("设置");
    expect(html).toContain("模型与凭据。改动立即生效，但只活在进程内存里");
  });

  it("读回当前生效的配置；密钥只呈现「已配置 / 未配置」", async () => {
    const html = await render(ENV_STATUS);

    expect(html).toContain("OpenAI 兼容接口");
    expect(html).toContain("gpt-5.4-mini");
    expect(html).toContain("https://env.example/v1");
    expect(html).toContain("已配置");
    expect(html).toContain("环境变量");
  });

  it("运行时覆盖时列出被覆盖了哪几个字段", async () => {
    const html = await render({
      ...ENV_STATUS,
      source: "runtime",
      overridden: ["model", "apiKey"]
    });

    expect(html).toContain("运行时覆盖：模型、API 密钥");
  });

  it("表单回填当前值；密钥框永远是空的（密钥只写不读）", async () => {
    const html = await render({ ...ENV_STATUS, source: "runtime", overridden: ["apiKey"] });

    // 非密钥字段回填服务端的当前值
    expect(inputTagFor(html, "model-config-model")).toContain('value="gpt-5.4-mini"');
    expect(inputTagFor(html, "model-config-base-url")).toContain('value="https://env.example/v1"');

    // 密钥框：密码类型，且即便「已配置」也不预填任何值
    const keyInput = inputTagFor(html, "model-config-api-key");
    expect(keyInput).toContain('type="password"');
    expect(keyInput).not.toMatch(/value="[^"]+"/);
    expect(html).toContain("已配置；留空表示不改动");
  });

  it("配置还没读回来时只给骨架，不渲染表单（空表单会被当成「全改过」）", async () => {
    const html = await render(null);

    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("保存");
    expect(html).not.toContain('id="model-config-api-key"');
  });

  it("三个表单字段都与各自的标签通过 for/id 关联", async () => {
    const html = await render(ENV_STATUS);

    for (const id of ["model-config-model", "model-config-base-url", "model-config-api-key"]) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("没有改动时「保存」禁用；来源是环境变量时「清除运行时覆盖」也禁用", async () => {
    const html = await render(ENV_STATUS);

    expect(isDisabled(buttonTagFor(html, "保存"))).toBe(true);
    expect(isDisabled(buttonTagFor(html, "清除运行时覆盖"))).toBe(true);
  });

  it("来源是运行时覆盖时「清除运行时覆盖」可用（且「保存」仍因没改动而禁用）", async () => {
    const html = await render({ ...ENV_STATUS, source: "runtime", overridden: ["model"] });

    expect(isDisabled(buttonTagFor(html, "清除运行时覆盖"))).toBe(false);
    expect(isDisabled(buttonTagFor(html, "保存"))).toBe(true);
  });

  it("提供方是 mock 时明说改动要等切到 openai 才生效", async () => {
    const html = await render({ ...ENV_STATUS, provider: "mock" });

    expect(html).toContain("当前提供方是 mock");
    expect(html).not.toContain("OpenAI 兼容接口");
  });

  it("读不到配置时渲染可重试的错误态，而不是一个空表单", async () => {
    const html = await render(null, "网络请求失败：无法连接后端服务");

    expect(html).toContain("网络请求失败：无法连接后端服务");
    expect(html).toContain("重试");
    expect(html).not.toContain('id="model-config-api-key"');
  });
});
