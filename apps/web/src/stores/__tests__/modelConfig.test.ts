import type { ModelConfigStatus } from "@ai-se/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModelConfig, updateModelConfig } from "../../api/modelConfig";
import { useModelConfigStore } from "../modelConfig";

vi.mock("../../api/modelConfig", () => ({
  getModelConfig: vi.fn(),
  updateModelConfig: vi.fn()
}));

const STATUS: ModelConfigStatus = {
  provider: "openai",
  model: "gpt-5.4-mini",
  baseUrl: "https://env.example/v1",
  apiKeyConfigured: true,
  source: "env",
  overridden: []
};

describe("modelConfig store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(getModelConfig).mockReset();
    vi.mocked(updateModelConfig).mockReset();
  });

  it("load 写入状态；失败时写 error 且不抛（沿用既有 store 的同一错误通道）", async () => {
    vi.mocked(getModelConfig).mockResolvedValue(STATUS);
    const store = useModelConfigStore();

    await store.load();
    expect(store.status).toEqual(STATUS);
    expect(store.error).toBe("");

    vi.mocked(getModelConfig).mockRejectedValue(new Error("后端不可用"));
    await store.load();
    expect(store.error).toBe("后端不可用");
    expect(store.loading).toBe(false);
  });

  it("save 返回是否成功，并把服务端回读的状态写回去", async () => {
    const store = useModelConfigStore();
    vi.mocked(updateModelConfig).mockResolvedValue({
      ...STATUS,
      source: "runtime",
      overridden: ["apiKey"]
    });

    await expect(store.save({ apiKey: "k" })).resolves.toBe(true);
    expect(store.status?.source).toBe("runtime");
    expect(store.notice).toContain("重启后端后会回落到环境变量");
    expect(store.error).toBe("");

    vi.mocked(updateModelConfig).mockRejectedValue(new Error("保存失败"));
    await expect(store.save({ apiKey: "k" })).resolves.toBe(false);
    expect(store.error).toBe("保存失败");
    // 失败时不留上一轮的「已生效」提示 —— 那会与错误同时显示。
    expect(store.notice).toBe("");
  });

  it("patch 原样送出去：null 的「清除」语义不会被吞掉", async () => {
    const store = useModelConfigStore();
    vi.mocked(updateModelConfig).mockResolvedValue(STATUS);

    await store.save({ model: null, apiKey: "k" });

    expect(updateModelConfig).toHaveBeenCalledWith({ model: null, apiKey: "k" });
  });
});
