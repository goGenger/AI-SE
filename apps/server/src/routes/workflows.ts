import {
  ApprovalDecisionSchema,
  CreateWorkflowSchema,
  UpdateWorkflowPolicySchema
} from "@ai-se/shared";
import { Response, Router } from "express";
import { z } from "zod";
import { AppError, asyncHandler } from "../http/errors";
import { sendSuccess } from "../http/response";
import { TraceService } from "../services/traceService";
import { WorkflowService } from "../services/workflowService";

const IdSchema = z.object({ id: z.string().uuid() });

/** UX-02: timeline pagination query (server-side DESC page, max 100 per page). */
const EventsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

function idFrom(params: unknown, label = "Workflow id"): string {
  const parsed = IdSchema.safeParse(params);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", `${label} must be a UUID`, parsed.error.flatten());
  }
  return parsed.data.id;
}

function writeSse(res: Response, data: unknown): void {
  res.write("event: snapshot\n");
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createWorkflowsRouter(service: WorkflowService, traceService?: TraceService): Router {
  const router = Router();

  router.post(
    "/workflows",
    asyncHandler(async (req, res) => {
      const parsed = CreateWorkflowSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Workflow input is invalid",
          parsed.error.flatten()
        );
      }
      sendSuccess(res, await service.create(parsed.data), 201);
    })
  );

  router.get(
    "/workflows",
    asyncHandler(async (_req, res) => sendSuccess(res, await service.list()))
  );

  router.get(
    "/workflows/:id",
    asyncHandler(async (req, res) => {
      const detail = await service.getDetail(idFrom(req.params));
      if (!detail) throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
      sendSuccess(res, detail);
    })
  );

  // 7-A：启动时把本次 HTTP 请求 ID 交给引擎（写进 WORKFLOW_STARTED，后续执行沿用）。
  router.post(
    "/workflows/:id/start",
    asyncHandler(async (req, res) => {
      const requestId = typeof res.locals.requestId === "string" ? res.locals.requestId : undefined;
      sendSuccess(res, await service.start(idFrom(req.params), { requestId }));
    })
  );

  for (const action of ["pause", "resume", "cancel", "retry"] as const) {
    router.post(
      `/workflows/:id/${action}`,
      asyncHandler(async (req, res) => sendSuccess(res, await service[action](idFrom(req.params))))
    );
  }

  // T6：调整工作流级预算（仅 RUNNING/PAUSED；随后走既有 /resume 恢复）。
  router.patch(
    "/workflows/:id/policy",
    asyncHandler(async (req, res) => {
      const id = idFrom(req.params);
      const parsed = UpdateWorkflowPolicySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Workflow policy input is invalid",
          parsed.error.flatten()
        );
      }
      sendSuccess(res, await service.updatePolicy(id, parsed.data));
    })
  );

  router.get(
    "/workflows/:id/tasks",
    asyncHandler(async (req, res) => {
      const id = idFrom(req.params);
      if (!(await service.get(id)))
        throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
      sendSuccess(res, await service.getTasks(id));
    })
  );

  router.get(
    "/workflows/:id/events",
    asyncHandler(async (req, res) => {
      const id = idFrom(req.params);
      const parsed = EventsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Event query is invalid",
          parsed.error.flatten()
        );
      }
      if (!(await service.get(id)))
        throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
      sendSuccess(res, await service.getEventsPage(id, parsed.data.page, parsed.data.pageSize));
    })
  );

  router.get(
    "/workflows/:id/graph",
    asyncHandler(async (req, res) => {
      const id = idFrom(req.params);
      if (!(await service.get(id)))
        throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
      sendSuccess(res, await service.getGraph(id));
    })
  );

  router.get(
    "/workflows/:id/approvals",
    asyncHandler(async (req, res) => {
      const id = idFrom(req.params);
      if (!(await service.get(id)))
        throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
      sendSuccess(res, await service.getApprovals(id));
    })
  );

  // 7-C：端到端追踪树（只读派生：Workflow → Task → AgentRun → ToolCall，部署挂在其任务下）。
  if (traceService) {
    router.get(
      "/workflows/:id/trace",
      asyncHandler(async (req, res) => {
        const trace = await traceService.build(idFrom(req.params));
        if (!trace) throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
        sendSuccess(res, trace);
      })
    );
  }

  router.get(
    "/workflows/:id/stream",
    asyncHandler(async (req, res) => {
      const id = idFrom(req.params);
      const initial = await service.snapshot(id);
      if (!initial) throw new AppError(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      });
      res.flushHeaders();
      let closed = false;
      let sending = Promise.resolve();
      const send = async () => {
        if (closed) return;
        const snapshot = await service.snapshot(id);
        if (snapshot) writeSse(res, snapshot);
      };
      const schedule = () => {
        sending = sending.then(send).catch(() => undefined);
      };
      const unsubscribe = service.onWorkflowEvent(id, schedule);
      const interval = setInterval(schedule, 2_000);
      req.on("close", () => {
        closed = true;
        clearInterval(interval);
        unsubscribe();
      });
      writeSse(res, initial);
    })
  );

  for (const action of ["approve", "reject"] as const) {
    router.post(
      `/approvals/:id/${action}`,
      asyncHandler(async (req, res) => {
        const id = idFrom(req.params, "Approval id");
        const parsed = ApprovalDecisionSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "Approval input is invalid",
            parsed.error.flatten()
          );
        }
        await service[action](id, parsed.data);
        sendSuccess(res, { id, status: action === "approve" ? "APPROVED" : "REJECTED" });
      })
    );
  }

  return router;
}
