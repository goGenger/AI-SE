import type { LLMProvider, PlanningModel, PlanningModelRequest } from "@ai-se/agent-core";
import type { JsonObject } from "@ai-se/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LiveLLMProvider, LivePlanningModel } from "../services/liveModel";
import { ModelConfigService } from "../services/modelConfigService";

const ENV_CONFIG = {
  provider: "openai" as const,
  model: "gpt-5.4-mini",
  apiKey: "env-key",
  baseUrl: "https://env.example/v1"
};

const planningRequest = {
  stage: "slice",
  prompt: "p",
  schema: z.object({}),
  input: {},
  validationErrors: []
} as unknown as PlanningModelRequest<JsonObject>;

describe("ModelConfigService", () => {
  it("初始状态取自环境变量，且整个状态对象里不含密钥值", () => {
    const status = new ModelConfigService(ENV_CONFIG).status();

    expect(status).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      baseUrl: "https://env.example/v1",
      apiKeyConfigured: true,
      source: "env",
      overridden: []
    });
    // 读回接口只允许暴露「有没有」，不允许暴露「是什么」（AGENTS.md §10）。
    expect(JSON.stringify(status)).not.toContain("env-key");
  });

  it("getOptions 返回的是同一个会被就地改写的对象", () => {
    const service = new ModelConfigService(ENV_CONFIG);
    const options = service.getOptions();

    service.update({ model: "gpt-5.5", apiKey: "runtime-key" });

    // 这条断言的正是「运行时可改」赖以成立的不变量：组合根把这个对象的**引用**
    // 交给了按任务现构造 provider 的执行器，换新对象 = 改动不生效。
    expect(service.getOptions()).toBe(options);
    expect(options).toEqual({
      model: "gpt-5.5",
      apiKey: "runtime-key",
      baseUrl: "https://env.example/v1"
    });
  });

  it("改动记进 overridden；清除（null）后回落到环境变量", () => {
    const service = new ModelConfigService(ENV_CONFIG);

    expect(service.update({ baseUrl: "https://runtime.example/v1" })).toMatchObject({
      baseUrl: "https://runtime.example/v1",
      source: "runtime",
      overridden: ["baseUrl"]
    });

    const cleared = service.update({ baseUrl: null });
    expect(cleared.baseUrl).toBe("https://env.example/v1");
    expect(cleared.source).toBe("env");
    expect(cleared.overridden).toEqual([]);
  });

  it("每改一个字段推进一次版本号；空 patch 不动它", () => {
    const service = new ModelConfigService(ENV_CONFIG);
    const before = service.getVersion();

    service.update({ model: "a", baseUrl: "https://a.example" });
    expect(service.getVersion()).toBe(before + 2);

    service.update({});
    expect(service.getVersion()).toBe(before + 2);
  });

  it("apiKeyConfigured 只反映「有没有」", () => {
    const service = new ModelConfigService({ ...ENV_CONFIG, apiKey: undefined });

    expect(service.status().apiKeyConfigured).toBe(false);
    expect(service.update({ apiKey: "k" }).apiKeyConfigured).toBe(true);
    expect(service.update({ apiKey: null }).apiKeyConfigured).toBe(false);
  });
});

describe("LiveLLMProvider / LivePlanningModel", () => {
  function fakeProvider() {
    return {
      invoke: vi.fn(async () => "invoked"),
      stream: vi.fn(),
      bindTools: vi.fn()
    } as unknown as LLMProvider;
  }

  it("LiveLLMProvider：配置没变就复用，变了才重建", async () => {
    const service = new ModelConfigService(ENV_CONFIG);
    const built: LLMProvider[] = [];
    const live = new LiveLLMProvider(service, () => {
      const provider = fakeProvider();
      built.push(provider);
      return provider;
    });

    await live.invoke([]);
    await live.invoke([]);
    expect(built).toHaveLength(1);
    expect(built[0].invoke).toHaveBeenCalledTimes(2);

    service.update({ apiKey: "runtime-key" });
    await live.invoke([]);
    expect(built).toHaveLength(2);
    expect(built[0].invoke).toHaveBeenCalledTimes(2);
    expect(built[1].invoke).toHaveBeenCalledTimes(1);
  });

  it("LiveLLMProvider：bindTools 与 stream 一样转发到当前 provider", () => {
    const service = new ModelConfigService(ENV_CONFIG);
    const provider = fakeProvider();
    const live = new LiveLLMProvider(service, () => provider);

    live.stream([]);
    live.bindTools([]);

    expect(provider.stream).toHaveBeenCalledTimes(1);
    expect(provider.bindTools).toHaveBeenCalledTimes(1);
  });

  it("LivePlanningModel：同样的重建规则，且请求原样转发", async () => {
    const service = new ModelConfigService(ENV_CONFIG);
    const built: Array<ReturnType<typeof vi.fn>> = [];
    const live = new LivePlanningModel(service, () => {
      const generateStructured = vi.fn(async () => ({ ok: true }));
      built.push(generateStructured);
      return { generateStructured } as unknown as PlanningModel;
    });

    await live.generateStructured(planningRequest);
    await live.generateStructured(planningRequest);
    expect(built).toHaveLength(1);
    expect(built[0]).toHaveBeenCalledTimes(2);

    service.update({ model: "other" });
    await live.generateStructured(planningRequest);
    expect(built).toHaveLength(2);
    expect(built[1]).toHaveBeenCalledWith(planningRequest);
  });
});
