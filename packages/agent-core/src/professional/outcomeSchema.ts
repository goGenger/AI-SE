import { z } from "zod";

/** 枚举值大小写归一：chatty 模型常写 "success"/"high" 这类小写枚举。 */
export function uppercaseEnum(value: unknown): unknown {
  return typeof value === "string" ? value.trim().toUpperCase() : value;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 对象级枚举归一：safeParse 之前把 status / artifacts[].type / issues[].severity 转大写。
 * 归一放在对象级 preprocess 里（而不是字段级），基础 schema 才能保持 JSON-Schema 可表示。
 */
function normalizeEnums(value: unknown): unknown {
  const root = object(value);
  if (!root) return value;
  const normalized: Record<string, unknown> = { ...root, status: uppercaseEnum(root.status) };
  if (Array.isArray(root.artifacts)) {
    normalized.artifacts = root.artifacts.map((entry) => {
      const artifact = object(entry);
      return artifact ? { ...artifact, type: uppercaseEnum(artifact.type) } : entry;
    });
  }
  if (Array.isArray(root.issues)) {
    normalized.issues = root.issues.map((entry) => {
      const issue = object(entry);
      return issue ? { ...issue, severity: uppercaseEnum(issue.severity) } : entry;
    });
  }
  return normalized;
}

/**
 * ProfessionalOutcome 的结构契约（基础版，无 transform/preprocess —— JSON-Schema 可表示）。
 * submit_result 工具的入参 schema 用它：框架需要把 schema 转成 JSON Schema 发给模型。
 * 根对象不做 strict：多余字段会被自动剥离而不是判失败（真实案例：模型附带额外字段导致整体被拒）。
 */
export const SubmitResultSchema = z.object({
  status: z.enum(["SUCCESS", "FAILED", "RETRY", "REPLAN"]),
  summary: z.string(),
  artifacts: z
    .array(
      z.object({
        type: z.enum([
          "CODE_DIFF",
          "TEST_RESULT",
          "REVIEW_RESULT",
          "BUILD_RESULT",
          "DOCUMENTATION",
          "GENERATED_FILE"
        ]),
        name: z.string(),
        content: z.record(z.string(), z.unknown()),
        metadata: z.record(z.string(), z.unknown()).optional()
      })
    )
    .default([]),
  issues: z
    .array(
      z.object({
        severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
        file: z.string().optional(),
        description: z.string(),
        recommendation: z.string()
      })
    )
    .default([]),
  recommendations: z.array(z.string()).default([]),
  /**
   * N-22（`docs/199`）：`status === "REPLAN"` 时**应当创建的任务类型**。
   *
   * 此前该字段只能藏在 `metadata`（`z.record`——无契约、无文档、无校验），且**只有 qa-agent
   * 被口头要求填**（`AgentRegistry.ts:186`）⇒ `WorkflowEngine.debugTargetType` 的第 1 步
   * （读 `source.output.fixTaskType`）对**其余 agent 结构性不可达**，必然落到第 3 步兜底。
   * 实测 L1-M4n run 2：backend-agent 在 `recommendations` 里**原文要求**「Route a TEST-type task …」
   * 而平台给了它**又一个 BACKEND**——链不收敛。
   *
   * 放**根**上是为了让它成为**契约**而不是藏起来的约定；`metadata.fixTaskType` 仍被容忍
   * （历史任务与未更新提示词的 agent 都还在用）。**不设必填**：缺省时第 3 步兜底仍然正确。
   */
  fixTaskType: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

/**
 * 宽松版（文本解析 / 复核路径）：先做枚举大小写归一，再按基础 schema 校验。
 * 与 SubmitResultSchema 共享同一份结构定义，不存在两份 schema 漂移。
 */
export const OutcomeSchema = z.preprocess(normalizeEnums, SubmitResultSchema);
