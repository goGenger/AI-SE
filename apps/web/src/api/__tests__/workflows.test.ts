import { WorkflowRun } from "@ai-se/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workflowAction } from "../workflows";

/**
 * 手动重试动作的网络契约(任务书 §四.4「断言 URL 与 method」):
 * store 层测试整体 mock 了 api 模块,URL/method 只能在本层断言。
 */

function run(): WorkflowRun {
  return {
    id: "workflow-1",
    projectId: "project-1",
    requirementId: "requirement-1",
    planningVersion: 1,
    status: "RUNNING",
    policy: {
      maxConcurrency: 2,
      maxRetries: 1,
      failureStrategy: "FAIL_FAST",
      allowRetry: true,
      allowReplan: false,
      approvalRequired: false
    },
    input: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("workflow api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the manual retry action to /api/workflows/:id/retry with POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: run() })
    });
    vi.stubGlobal("fetch", fetchMock);

    const workflow = await workflowAction("workflow-1", "retry");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflows/workflow-1/retry",
      expect.objectContaining({ method: "POST" })
    );
    expect(workflow.id).toBe("workflow-1");
  });
});
