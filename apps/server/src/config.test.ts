import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("delivery config", () => {
  it("treats an empty optional GitHub token as unset", () => {
    const config = loadConfig({ GITHUB_TOKEN: "", CI_PROVIDER: "local" });
    expect(config.githubToken).toBeUndefined();
  });
});

describe("model API config", () => {
  it("keeps the mock provider with no endpoint settings by default", () => {
    const config = loadConfig({});
    expect(config.llmProvider).toBe("mock");
    expect(config.llmModel).toBe("gpt-5.4-mini");
    expect(config.llmApiKey).toBeUndefined();
    expect(config.llmBaseUrl).toBeUndefined();
    expect(config.llmStructuredOutputMethod).toBeUndefined();
  });

  it("parses a DeepSeek-style OpenAI-compatible configuration", () => {
    const config = loadConfig({
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test-key",
      OPENAI_MODEL: "deepseek-chat",
      OPENAI_BASE_URL: "https://api.deepseek.com/v1",
      OPENAI_STRUCTURED_OUTPUT_METHOD: "functionCalling"
    });
    expect(config.llmProvider).toBe("openai");
    expect(config.llmApiKey).toBe("sk-test-key");
    expect(config.llmModel).toBe("deepseek-chat");
    expect(config.llmBaseUrl).toBe("https://api.deepseek.com/v1");
    expect(config.llmStructuredOutputMethod).toBe("functionCalling");
  });

  it("treats empty optional strings as unset", () => {
    const config = loadConfig({
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENAI_STRUCTURED_OUTPUT_METHOD: ""
    });
    expect(config.llmApiKey).toBeUndefined();
    expect(config.llmBaseUrl).toBeUndefined();
    expect(config.llmStructuredOutputMethod).toBeUndefined();
  });

  it("rejects an invalid structured-output method", () => {
    expect(() => loadConfig({ OPENAI_STRUCTURED_OUTPUT_METHOD: "yaml" })).toThrow();
  });
});

describe("task timeout config", () => {
  it("defaults to 30 minutes and accepts an explicit override", () => {
    expect(loadConfig({}).taskTimeoutMs).toBe(1_800_000);
    expect(loadConfig({ TASK_TIMEOUT_MS: "120000" }).taskTimeoutMs).toBe(120_000);
  });
});

describe("planning budgets (N-51 / N-52)", () => {
  it("单切片 900s、task_planning 单独一档 300s，其余阶段仍是 150s", () => {
    const config = loadConfig({});
    expect(config.planningSliceTimeoutMs).toBe(900_000);
    expect(config.planningTaskPlanningTimeoutMs).toBe(300_000);
    expect(config.planningStageTimeoutMs).toBe(150_000);
    expect(loadConfig({ PLANNING_TASK_PLANNING_TIMEOUT_MS: "420000" }).planningTaskPlanningTimeoutMs).toBe(420_000);
  });
});

describe("submit_result config (C-1/T2)", () => {
  it("defaults to tool mode, accepts the text switch, and rejects unknown values", () => {
    expect(loadConfig({}).submitResultMode).toBe("tool");
    expect(loadConfig({ SUBMIT_RESULT_MODE: "text" }).submitResultMode).toBe("text");
    expect(() => loadConfig({ SUBMIT_RESULT_MODE: "yaml" })).toThrow();
  });
});

describe("verification gate config (C-3/T1)", () => {
  it("defaults to observe and accepts off/enforce", () => {
    expect(loadConfig({}).verificationGate).toBe("observe");
    expect(loadConfig({ VERIFICATION_GATE: "off" }).verificationGate).toBe("off");
    expect(loadConfig({ VERIFICATION_GATE: "enforce" }).verificationGate).toBe("enforce");
    expect(() => loadConfig({ VERIFICATION_GATE: "strict" })).toThrow();
  });
});

describe("api token config (D-3/T8-c)", () => {
  it("defaults to unset, treats empty as unset, and accepts a value", () => {
    expect(loadConfig({}).apiToken).toBeUndefined();
    expect(loadConfig({ API_TOKEN: "" }).apiToken).toBeUndefined();
    expect(loadConfig({ API_TOKEN: "secret-token" }).apiToken).toBe("secret-token");
  });
});

describe("model pricing config (PL-C2)", () => {
  it("is absent unless both prices are configured", () => {
    expect(loadConfig({}).modelPricing).toBeUndefined();
    expect(loadConfig({ MODEL_INPUT_PRICE_PER_MTOK: "3" }).modelPricing).toBeUndefined();
    expect(loadConfig({ MODEL_OUTPUT_PRICE_PER_MTOK: "15" }).modelPricing).toBeUndefined();
    expect(loadConfig({ MODEL_INPUT_PRICE_PER_MTOK: "", MODEL_OUTPUT_PRICE_PER_MTOK: "" }).modelPricing).toBeUndefined();
  });

  it("parses both prices into a pricing object", () => {
    const config = loadConfig({
      MODEL_INPUT_PRICE_PER_MTOK: "3",
      MODEL_OUTPUT_PRICE_PER_MTOK: "15"
    });
    expect(config.modelPricing).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  it("rejects negative prices", () => {
    expect(() =>
      loadConfig({ MODEL_INPUT_PRICE_PER_MTOK: "-1", MODEL_OUTPUT_PRICE_PER_MTOK: "15" })
    ).toThrow();
  });
});


describe("alert ingest token (Phase 8-A)", () => {
  it("treats empty ALERT_INGEST_TOKEN as unset and accepts an explicit secret", () => {
    expect(loadConfig({ ALERT_INGEST_TOKEN: "" }).alertIngestToken).toBeUndefined();
    expect(loadConfig({ ALERT_INGEST_TOKEN: "alert-secret" }).alertIngestToken).toBe("alert-secret");
  });
});

describe("incident auto remediate (Phase 8-D)", () => {
  it("defaults to false and accepts common truthy/falsey env spellings", () => {
    expect(loadConfig({}).incidentAutoRemediate).toBe(false);
    expect(loadConfig({ INCIDENT_AUTO_REMEDIATE: "" }).incidentAutoRemediate).toBe(false);
    expect(loadConfig({ INCIDENT_AUTO_REMEDIATE: "false" }).incidentAutoRemediate).toBe(false);
    expect(loadConfig({ INCIDENT_AUTO_REMEDIATE: "off" }).incidentAutoRemediate).toBe(false);
    expect(loadConfig({ INCIDENT_AUTO_REMEDIATE: "true" }).incidentAutoRemediate).toBe(true);
    expect(loadConfig({ INCIDENT_AUTO_REMEDIATE: "1" }).incidentAutoRemediate).toBe(true);
    expect(loadConfig({ INCIDENT_AUTO_REMEDIATE: "on" }).incidentAutoRemediate).toBe(true);
  });

  it("rejects unknown values fail-closed", () => {
    expect(() => loadConfig({ INCIDENT_AUTO_REMEDIATE: "maybe" })).toThrow();
  });
});

