import type { ModelConfigStatus } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  buildModelConfigPatch,
  initialModelConfigForm,
  isModelConfigPatchDirty,
  overriddenFieldLabel,
  providerLabel
} from "../viewmodels/modelConfigViewModel";

const CURRENT: ModelConfigStatus = {
  provider: "openai",
  model: "gpt-5.4-mini",
  baseUrl: "https://env.example/v1",
  apiKeyConfigured: true,
  source: "env",
  overridden: []
};

function form(overrides: Partial<{ model: string; baseUrl: string; apiKey: string }> = {}) {
  return { model: CURRENT.model, baseUrl: CURRENT.baseUrl ?? "", apiKey: "", ...overrides };
}

describe("buildModelConfigPatch", () => {
  it("表单回填后一个字段都没动 ⇒ 空 patch（不制造看不见的假覆盖）", () => {
    const patch = buildModelConfigPatch(form(), CURRENT);

    expect(patch).toEqual({});
    expect(isModelConfigPatchDirty(patch)).toBe(false);
  });

  it("只带上真的改了的字段", () => {
    expect(buildModelConfigPatch(form({ model: "gpt-5.5" }), CURRENT)).toEqual({
      model: "gpt-5.5"
    });
  });

  it("清空字段 ⇒ null，即清除覆盖、回落到环境变量", () => {
    expect(buildModelConfigPatch(form({ model: "", baseUrl: "  " }), CURRENT)).toEqual({
      model: null,
      baseUrl: null
    });
  });

  it("密钥留空 = 不改动；只敲空格也不算输入", () => {
    // 只敲空格若被当成「有输入」，服务端 trim 后会变成空串，进而被解读成「清除密钥」——
    // 敲几个空格就把密钥删掉。
    expect(buildModelConfigPatch(form({ apiKey: "" }), CURRENT)).not.toHaveProperty("apiKey");
    expect(buildModelConfigPatch(form({ apiKey: "   " }), CURRENT)).not.toHaveProperty("apiKey");
    expect(buildModelConfigPatch(form({ apiKey: " sk-live " }), CURRENT)).toEqual({
      apiKey: "sk-live"
    });
  });

  it("密钥只敲空格也不算输入（否则会被服务端 trim 成空串、变成清除）", () => {
    expect(buildModelConfigPatch(form({ apiKey: "   " }), CURRENT)).not.toHaveProperty("apiKey");
  });
});

describe("initialModelConfigForm", () => {
  it("回填非密钥字段，且密钥框永远是空的", () => {
    expect(initialModelConfigForm(CURRENT)).toEqual({
      model: "gpt-5.4-mini",
      baseUrl: "https://env.example/v1",
      apiKey: ""
    });
  });

  it("status 为 null（还没读回来）时是空表单，不是 undefined", () => {
    expect(initialModelConfigForm(null)).toEqual({ model: "", baseUrl: "", apiKey: "" });
  });

  it('baseUrl 缺省时回空串（输入框不能出现 "undefined"）', () => {
    expect(initialModelConfigForm({ ...CURRENT, baseUrl: undefined }).baseUrl).toBe("");
  });
});

describe("modelConfigViewModel 标签", () => {
  it("overriddenFieldLabel 用中文名拼接，未覆盖时为空串", () => {
    expect(
      overriddenFieldLabel({ ...CURRENT, source: "runtime", overridden: ["model", "apiKey"] })
    ).toBe("模型、API 密钥");
    expect(overriddenFieldLabel(CURRENT)).toBe("");
    expect(overriddenFieldLabel(null)).toBe("");
  });

  it("providerLabel 区分 mock 与 openai，缺省按 mock 呈现", () => {
    expect(providerLabel("openai")).toBe("OpenAI 兼容接口");
    expect(providerLabel("mock")).toContain("Mock");
    expect(providerLabel(undefined)).toContain("Mock");
  });
});
