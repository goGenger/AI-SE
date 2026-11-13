import { JsonObject } from "@ai-se/shared";
import { z } from "zod";
import { ToolExecutionError } from "../errors";
import { ToolDefinition, ToolExecutionContext } from "../types";

/**
 * N-73（`docs/232` §10）：交付执行面分两种**适配器**。
 *
 * `docker` = 既有口径（需要 git 仓库、Dockerfile、镜像）；`static` = 工作区优先的前端项目
 * （无仓库、无 Dockerfile）：CI 直接在工作区跑 lint/typecheck/test/build，DEPLOY 起静态预览，
 * VERIFY 用浏览器探页面。缺省仍是 `docker`，零行为变化。
 */
const DeliveryAdapterSchema = z.enum(["docker", "static"]).default("docker");

const CiInputSchema = z
  .object({
    adapter: DeliveryAdapterSchema,
    /** `docker` 适配器必需（要解析 commit 并建镜像）；`static` 可以不填。 */
    repository: z.string().url().optional(),
    workflowFile: z.string().trim().min(1).max(200),
    ref: z.string().trim().min(1).max(200),
    imageRepository: z.string().trim().min(1).max(500)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.adapter === "docker" && !value.repository) {
      ctx.addIssue({
        code: "custom",
        path: ["repository"],
        message: "repository is required for the docker adapter"
      });
    }
  });

const ReleaseInputSchema = z
  .object({
    adapter: DeliveryAdapterSchema,
    deploymentId: z.string().uuid(),
    environment: z.enum(["dev", "staging", "production"]),
    endpoint: z.string().url(),
    image: z.string().trim().min(1).max(500),
    version: z.string().trim().min(1).max(160),
    configuration: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export interface CiExecutionResult {
  providerRunId: string;
  status: "SUCCESS" | "FAILED" | "CANCELLED";
  gitCommit: string;
  pullRequest?: number;
  image: string;
  url?: string;
  logs: string[];
  error?: string;
  /** F1-5（FX-18）：交付前全量测试（`pnpm test`）的逐条 AC 结果（本地 CI 解析；外部 CI 可不提供）。 */
  testResults?: Record<string, "passed" | "failed">;
}

export interface ReleaseExecutionResult {
  status: "SUCCESS" | "FAILED";
  healthCheck: JsonObject;
  logs: string[];
  error?: string;
}

export interface DeliveryOperations {
  // 输入类型取 `z.input`：调用方给的是**未填默认值**的形状，默认值由工具层（`createDeliveryTools`）补。
  // 这样既有调用方不必为了新增的 `adapter` 字段改签名（缺省 = docker，行为不变）。
  runCi(
    input: z.input<typeof CiInputSchema>,
    context: ToolExecutionContext
  ): Promise<CiExecutionResult>;
  deploy(
    input: z.input<typeof ReleaseInputSchema>,
    context: ToolExecutionContext
  ): Promise<ReleaseExecutionResult>;
  verify(
    input: z.input<typeof ReleaseInputSchema>,
    context: ToolExecutionContext
  ): Promise<ReleaseExecutionResult>;
  rollback(
    input: z.input<typeof ReleaseInputSchema>,
    context: ToolExecutionContext
  ): Promise<ReleaseExecutionResult>;
}

function assertPermission(
  input: unknown,
  context: ToolExecutionContext,
  requiresApproval: boolean
): void {
  const environment =
    typeof input === "object" && input !== null && "environment" in input
      ? (input as { environment?: string }).environment
      : undefined;
  if (context.actor !== "DeploymentOrchestrator") {
    throw new ToolExecutionError("TOOL_ERROR", "Delivery tools require DeploymentOrchestrator");
  }
  if (requiresApproval && environment === "production" && context.metadata?.approved !== true) {
    throw new ToolExecutionError("TOOL_ERROR", "Production delivery requires human approval");
  }
}

export function createDeliveryTools(
  operations: DeliveryOperations
): ToolDefinition<unknown, unknown>[] {
  const runCi: ToolDefinition<z.infer<typeof CiInputSchema>, CiExecutionResult> = {
    name: "run_ci",
    description: "Run the configured CI workflow and return its immutable release metadata.",
    riskLevel: "HIGH",
    inputSchema: CiInputSchema,
    execute: (input, context) => {
      assertPermission(input, context, false);
      return operations.runCi(input, context);
    }
  };
  const deploy: ToolDefinition<z.infer<typeof ReleaseInputSchema>, ReleaseExecutionResult> = {
    name: "deploy_release",
    description: "Deploy one immutable image to a configured environment.",
    riskLevel: "HIGH",
    inputSchema: ReleaseInputSchema,
    execute: (input, context) => {
      assertPermission(input, context, true);
      return operations.deploy(input, context);
    }
  };
  const verify: ToolDefinition<z.infer<typeof ReleaseInputSchema>, ReleaseExecutionResult> = {
    name: "verify_release",
    description: "Verify the health and readiness of a deployed release.",
    riskLevel: "LOW",
    inputSchema: ReleaseInputSchema,
    execute: (input, context) => {
      assertPermission(input, context, false);
      return operations.verify(input, context);
    }
  };
  const rollback: ToolDefinition<z.infer<typeof ReleaseInputSchema>, ReleaseExecutionResult> = {
    name: "rollback_release",
    description: "Restore a configured environment to a previously successful image.",
    riskLevel: "HIGH",
    inputSchema: ReleaseInputSchema,
    execute: (input, context) => {
      assertPermission(input, context, true);
      return operations.rollback(input, context);
    }
  };
  return [runCi, deploy, verify, rollback] as ToolDefinition<unknown, unknown>[];
}
