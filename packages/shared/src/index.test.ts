import { describe, expect, it } from "vitest";
import {
  AgentRunStatusSchema,
  CreateAgentRunSchema,
  CreateProjectSchema,
  ConflictResolutionInputSchema,
  RequirementDocumentKindSchema,
  UpsertConflictResolutionsSchema,
  UpdateWorkflowPolicySchema,
  WorkflowPolicySchema
} from "./index";

describe("CreateProjectSchema", () => {
  it("normalizes valid project input", () => {
    const project = CreateProjectSchema.parse({
      name: " AI-SE ",
      repository: "https://github.com/example/ai-se"
    });

    expect(project).toEqual({
      name: "AI-SE",
      description: "",
      repository: "https://github.com/example/ai-se",
      status: "active"
    });
    // workspacePath remains optional (omitted when not provided)
    expect(project.workspacePath).toBeUndefined();
  });

  it("rejects invalid repository URLs", () => {
    expect(() =>
      CreateProjectSchema.parse({
        name: "AI-SE",
        repository: "not-a-url"
      })
    ).toThrow();
  });

  it("accepts optional workspacePath", () => {
    const project = CreateProjectSchema.parse({
      name: "AI-SE",
      workspacePath: "/Users/me/Desktop/study/app"
    });
    expect(project.workspacePath).toBe("/Users/me/Desktop/study/app");
  });

  it("normalizes agent run input", () => {
    const input = CreateAgentRunSchema.parse({
      task: " fix tests ",
      maxIterations: 12
    });

    expect(input).toEqual({
      task: "fix tests",
      maxIterations: 12
    });
  });

  it("supports phase 2 agent run statuses", () => {
    expect(AgentRunStatusSchema.parse("created")).toBe("created");
    expect(AgentRunStatusSchema.parse("timed_out")).toBe("timed_out");
  });
});

describe("WorkflowPolicySchema / UpdateWorkflowPolicySchema（T6 预算上限）", () => {
  const base = {
    maxConcurrency: 2,
    maxRetries: 1,
    failureStrategy: "FAIL_FAST" as const,
    allowRetry: true,
    allowReplan: false,
    approvalRequired: false
  };

  it("accepts optional budget limits and rejects non-positive or non-integer values", () => {
    const policy = WorkflowPolicySchema.parse({
      ...base,
      maxCostUsd: 3.5,
      maxTokens: 1000,
      maxWallClockMs: 60_000
    });
    expect(policy.maxCostUsd).toBe(3.5);
    expect(policy.maxTokens).toBe(1000);
    expect(policy.maxWallClockMs).toBe(60_000);

    // 缺省 = 不限制（旧策略对象继续可解析）
    expect(WorkflowPolicySchema.parse(base).maxTokens).toBeUndefined();
    expect(() => WorkflowPolicySchema.parse({ ...base, maxTokens: 0 })).toThrow();
    expect(() => WorkflowPolicySchema.parse({ ...base, maxCostUsd: -1 })).toThrow();
    expect(() => WorkflowPolicySchema.parse({ ...base, maxWallClockMs: 1.5 })).toThrow();
  });

  it("parses policy patches: absent = unchanged, null = clear, unknown keys rejected", () => {
    expect(UpdateWorkflowPolicySchema.parse({ maxTokens: 5 })).toEqual({ maxTokens: 5 });
    expect(UpdateWorkflowPolicySchema.parse({ maxCostUsd: null })).toEqual({ maxCostUsd: null });
    expect(UpdateWorkflowPolicySchema.parse({})).toEqual({});
    expect(() => UpdateWorkflowPolicySchema.parse({ maxConcurrency: 2 })).toThrow();
  });
});


describe("RequirementDocumentKindSchema", () => {
  it("accepts PRD, TECHNICAL, and UI_REFERENCE", () => {
    expect(RequirementDocumentKindSchema.parse("PRD")).toBe("PRD");
    expect(RequirementDocumentKindSchema.parse("TECHNICAL")).toBe("TECHNICAL");
    expect(RequirementDocumentKindSchema.parse("UI_REFERENCE")).toBe("UI_REFERENCE");
  });

  it("rejects unknown kinds", () => {
    expect(() => RequirementDocumentKindSchema.parse("FIGMA")).toThrow();
  });
});

describe("ConflictResolution schemas", () => {
  it("accepts FOLLOW_PRD / FOLLOW_TRD / CUSTOM(with note)", () => {
    expect(
      ConflictResolutionInputSchema.parse({
        topic: "auth",
        source: "trd.md",
        prdSays: "JWT",
        documentSays: "session",
        choice: "FOLLOW_PRD"
      }).choice
    ).toBe("FOLLOW_PRD");
    expect(
      UpsertConflictResolutionsSchema.parse({
        resolutions: [
          {
            topic: "auth",
            source: "trd.md",
            prdSays: "JWT",
            documentSays: "session",
            choice: "CUSTOM",
            note: "先 JWT，二期 session"
          }
        ]
      }).resolutions
    ).toHaveLength(1);
  });

  it("rejects CUSTOM without note", () => {
    expect(() =>
      ConflictResolutionInputSchema.parse({
        topic: "auth",
        source: "trd.md",
        prdSays: "JWT",
        documentSays: "session",
        choice: "CUSTOM"
      })
    ).toThrow();
  });
});
