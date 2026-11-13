import type { ModelConfigField, ModelConfigPatch, ModelConfigStatus } from "@ai-se/shared";

export type { ModelConfigField, ModelConfigPatch, ModelConfigStatus };

export interface ModelConfigServiceOptions {
  provider: "mock" | "openai";
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * 模型配置的唯一可变来源。
 *
 * **就地改写同一个对象、而不是每次返回新对象**：组合根把 {@link getOptions} 的返回值交给了
 * 按任务构造 provider 的执行器（`workflowTaskExecutor`），执行器持有的是那个**引用**。
 * 换新对象等于换掉引用，控制台改完配置也不会生效 —— 所以这里改的是对象本身。
 *
 * **不做持久化**：落库加密需要主密钥，主密钥又只能来自环境变量（循环依赖），而这正是
 * AGENTS.md §10 禁止的第二套 Secret 体系。内存态覆盖是唯一同时满足「运行时可改」与
 * 「不得新增明文存储」的方案 —— 因为它根本不存储。代价是重启后失效，这是已知限制，见 docs/145。
 */
export class ModelConfigService {
  private readonly provider: "mock" | "openai";
  private readonly envValues: { model: string; apiKey?: string; baseUrl?: string };
  private readonly options: { model: string; apiKey?: string; baseUrl?: string };
  private readonly overridden = new Set<ModelConfigField>();
  private version = 0;

  constructor(deps: ModelConfigServiceOptions) {
    this.provider = deps.provider;
    this.envValues = { model: deps.model, apiKey: deps.apiKey, baseUrl: deps.baseUrl };
    this.options = { model: deps.model, apiKey: deps.apiKey, baseUrl: deps.baseUrl };
  }

  /**
   * 交给各模型路径的**活**配置对象。调用方不要复制、也不要长期持有副本当快照 ——
   * 需要快照的地方（如按 run 构造的 provider）自己 `{ ...options }`。
   */
  getOptions(): { model: string; apiKey?: string; baseUrl?: string } {
    return this.options;
  }

  /** 每次变更自增。启动时只构造一次的 provider 用它判断要不要重建（见 `liveModel.ts`）。 */
  getVersion(): number {
    return this.version;
  }

  status(): ModelConfigStatus {
    return {
      provider: this.provider,
      model: this.options.model,
      ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
      apiKeyConfigured: Boolean(this.options.apiKey),
      source: this.overridden.size > 0 ? "runtime" : "env",
      overridden: [...this.overridden]
    };
  }

  update(patch: ModelConfigPatch): ModelConfigStatus {
    if (patch.model !== undefined) this.setModel(patch.model);
    if (patch.baseUrl !== undefined) this.setBaseUrl(patch.baseUrl);
    if (patch.apiKey !== undefined) this.setApiKey(patch.apiKey);
    return this.status();
  }

  private setModel(value: string | null): void {
    this.track("model", value);
    this.options.model = value ?? this.envValues.model;
  }

  private setBaseUrl(value: string | null): void {
    this.track("baseUrl", value);
    this.options.baseUrl = value ?? this.envValues.baseUrl;
  }

  private setApiKey(value: string | null): void {
    this.track("apiKey", value);
    this.options.apiKey = value ?? this.envValues.apiKey;
  }

  private track(field: ModelConfigField, value: string | null): void {
    if (value === null) {
      this.overridden.delete(field);
    } else {
      this.overridden.add(field);
    }
    this.version += 1;
  }
}
