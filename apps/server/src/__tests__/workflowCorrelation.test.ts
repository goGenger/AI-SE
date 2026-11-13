import { PgWorkflowEventStore } from "@ai-se/database";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowRequestIdResolver } from "../services/workflowCorrelation";

function events(found: string | undefined | Error) {
  return {
    findWorkflowStartedRequestId: async (_workflowRunId: string) => {
      if (found instanceof Error) throw found;
      return found;
    }
  } as unknown as Pick<PgWorkflowEventStore, "findWorkflowStartedRequestId">;
}

describe("workflow request id resolver (7-A)", () => {
  it("returns the id recorded in WORKFLOW_STARTED", async () => {
    const resolve = createWorkflowRequestIdResolver(events("req-from-event"));
    await expect(resolve("workflow-1")).resolves.toBe("req-from-event");
  });

  it("falls back to a new id when the run predates the field", async () => {
    const resolve = createWorkflowRequestIdResolver(events(undefined));
    const id = await resolve("workflow-1");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("swallows lookup failures (correlation must not fail the task)", async () => {
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() };
    const resolve = createWorkflowRequestIdResolver(
      events(new Error("database is down")),
      logger as unknown as Parameters<typeof createWorkflowRequestIdResolver>[1]
    );
    const id = await resolve("workflow-1");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
