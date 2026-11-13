import type { ModelConfigField, ModelConfigPatch, ModelConfigStatus } from "@ai-se/shared";

export interface ModelConfigFormValues {
  model: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * 用服务端的当前值回填表单。**密钥框永远是空的** —— 服务端从不回显密钥值（AGENTS.md §10），
 * 所以「把现有密钥读进输入框」这条路径根本不存在，留空即「不改动」。
 */
export function initialModelConfigForm(status: ModelConfigStatus | null): ModelConfigFormValues {
  return { model: status?.model ?? "", baseUrl: status?.baseUrl ?? "", apiKey: "" };
}

/**
 * 只把**真的改了**的字段放进 patch。
 *
 * 不这么做的话，「打开页面 → 直接点保存」会把环境变量里的值原样写成一个运行时覆盖 ——
 * 值没变、来源却变成 runtime，一个看不见的假改动。
 *
 * 三条归一规则：
 *   · 空串 = 清除该字段的覆盖（回落到环境变量）。表单清空输入框发出来的正是空串。
 *   · 密钥留空 = **不改动**，不是清除。页面拿不到现有密钥，用户没输入不代表他想删。
 *   · 密钥先 trim 再判断：只敲了空格时若当成「有输入」，服务端 trim 后会变成空串，
 *     进而被解读成「清除密钥」—— 敲几个空格就把密钥删掉，是个不能留的坑。
 */
export function buildModelConfigPatch(
  form: ModelConfigFormValues,
  current: ModelConfigStatus
): ModelConfigPatch {
  const patch: ModelConfigPatch = {};

  const model = form.model.trim();
  if (model !== current.model) {
    patch.model = model === "" ? null : model;
  }

  const baseUrl = form.baseUrl.trim();
  if (baseUrl !== (current.baseUrl ?? "")) {
    patch.baseUrl = baseUrl === "" ? null : baseUrl;
  }

  const apiKey = form.apiKey.trim();
  if (apiKey !== "") {
    patch.apiKey = apiKey;
  }

  return patch;
}

export function isModelConfigPatchDirty(patch: ModelConfigPatch): boolean {
  return Object.keys(patch).length > 0;
}

const FIELD_LABELS: Record<ModelConfigField, string> = {
  model: "模型",
  baseUrl: "Base URL",
  apiKey: "API 密钥"
};

/** 「运行时覆盖：模型、API 密钥」里的那半句。 */
export function overriddenFieldLabel(status: ModelConfigStatus | null): string {
  return (status?.overridden ?? []).map((field) => FIELD_LABELS[field]).join("、");
}

export function providerLabel(provider?: "mock" | "openai"): string {
  return provider === "openai" ? "OpenAI 兼容接口" : "Mock（脚本化，不调用真实模型）";
}
