import { describe, expect, it, vi } from "vitest";
import { ToolRuntime } from "../ToolRuntime";
import { createDeliveryTools, DeliveryOperations } from "../tools/deliveryTools";

function context() {
  return {
    requestId: "request",
    projectId: "project",
    taskId: "task",
    agentRunId: "run",
    toolCallId: "call",
    actor: "DeploymentOrchestrator",
    workspacePath: process.cwd(),
    sandbox: {
      async runCommand() {
        throw new Error("Delivery tools must not execute through the coding sandbox");
      }
    }
  };
}

function operations(): DeliveryOperations {
  return {
    runCi: vi.fn(async () => ({
      providerRunId: "42",
      status: "SUCCESS" as const,
      gitCommit: "abcdef1",
      image: "ghcr.io/example/app:abcdef1",
      logs: ["passed"]
    })),
    deploy: vi.fn(async () => ({
      status: "SUCCESS" as const,
      healthCheck: { "/health": 200, "/ready": 200 },
      logs: ["deployed"]
    })),
    verify: vi.fn(async () => ({
      status: "SUCCESS" as const,
      healthCheck: { "/health": 200, "/ready": 200 },
      logs: ["verified"]
    })),
    rollback: vi.fn(async () => ({
      status: "SUCCESS" as const,
      healthCheck: { "/health": 200, "/ready": 200 },
      logs: ["rolled back"]
    }))
  };
}

describe("Phase 6 delivery tools", () => {
  it("runs CI and records HIGH risk audit metadata", async () => {
    const adapter = operations();
    const runtime = new ToolRuntime({ tools: createDeliveryTools(adapter) });
    const result = await runtime.execute(
      "run_ci",
      {
        repository: "https://github.com/example/app",
        workflowFile: "ci.yml",
        ref: "main",
        imageRepository: "ghcr.io/example/app"
      },
      context()
    );
    expect(result.success).toBe(true);
    expect(result.audit.riskLevel).toBe("HIGH");
    expect(adapter.runCi).toHaveBeenCalledOnce();
  });

  /**
   * N-73（`docs/232` §10）：工作区优先的前端项目没有 git 仓库，CI 仍然要能跑。
   * 契约上把 `repository` 从必填改成「docker 适配器必填」。
   */
  it("N-73：static 适配器的 run_ci 不需要 repository", async () => {
    const adapter = operations();
    const runtime = new ToolRuntime({ tools: createDeliveryTools(adapter) });
    const result = await runtime.execute(
      "run_ci",
      { adapter: "static", workflowFile: "ci.yml", ref: "main", imageRepository: "ai-se-app" },
      context()
    );
    expect(result.success).toBe(true);
    expect(adapter.runCi).toHaveBeenCalledOnce();
  });

  it("N-73：docker 适配器仍然要求 repository", async () => {
    const adapter = operations();
    const runtime = new ToolRuntime({ tools: createDeliveryTools(adapter) });
    const result = await runtime.execute(
      "run_ci",
      { adapter: "docker", workflowFile: "ci.yml", ref: "main", imageRepository: "ai-se-app" },
      context()
    );
    expect(result.success).toBe(false);
    expect(adapter.runCi).not.toHaveBeenCalled();
  });

  it("rejects invalid deployment input before the adapter", async () => {
    const adapter = operations();
    const runtime = new ToolRuntime({ tools: createDeliveryTools(adapter) });
    const result = await runtime.execute(
      "deploy_release",
      { environment: "production" },
      context()
    );
    expect(result.success).toBe(false);
    expect(adapter.deploy).not.toHaveBeenCalled();
  });

  it("blocks production deployment without Workflow approval metadata", async () => {
    const adapter = operations();
    const runtime = new ToolRuntime({ tools: createDeliveryTools(adapter) });
    const result = await runtime.execute(
      "deploy_release",
      {
        deploymentId: "00000000-0000-4000-8000-000000000000",
        environment: "production",
        endpoint: "https://production.example.test",
        image: "ghcr.io/example/app:abcdef1",
        version: "abcdef1",
        configuration: {}
      },
      context()
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("approval");
    expect(adapter.deploy).not.toHaveBeenCalled();
  });
});
