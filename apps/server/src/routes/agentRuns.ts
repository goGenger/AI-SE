import {
  AgentRunDetailView,
  AgentRunView,
  CreateAgentRunSchema,
  ToolCallAudit
} from "@ai-se/shared";
import { Router, Response } from "express";
import { z } from "zod";
import { AppError, asyncHandler } from "../http/errors";
import { sendSuccess } from "../http/response";
import { AgentRunService, runDuration } from "../services/agentRunService";

const IdParamSchema = z.object({
  id: z.string().uuid()
});

const RunCodingAgentSchema = z
  .object({
    task: z.string().trim().min(1).max(2000).optional()
  })
  .strict();

interface AgentRunsDependencies {
  service: AgentRunService;
}

function parseId(params: unknown): string {
  const result = IdParamSchema.safeParse(params);
  if (!result.success) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Agent run id must be a UUID",
      result.error.flatten()
    );
  }
  return result.data.id;
}

function summaryFromToolCall(toolCall: ToolCallAudit): string {
  const outputSummary = toolCall.output?.summary;
  if (typeof outputSummary === "string" && outputSummary.trim()) {
    return outputSummary;
  }

  return toolCall.error?.message ?? "";
}

function finalResult(detail: AgentRunDetailView): string {
  const value = detail.run.output?.finalResult;
  return typeof value === "string" ? value : "";
}

function toAgentRunView(detail: AgentRunDetailView): AgentRunView {
  const lastTest = [...detail.toolCalls]
    .reverse()
    .find((entry) => entry.toolName === "run_unit_test");

  return {
    agentRunId: detail.run.id,
    taskId: detail.run.taskId,
    projectId: detail.run.projectId,
    status: detail.run.status,
    currentIteration: detail.run.currentIteration,
    maxIterations: detail.run.maxIterations,
    retryCount: detail.run.retryCount,
    toolCalls: detail.toolCalls.map((entry) => ({
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      status: entry.status,
      iteration: entry.iteration,
      duration: entry.duration,
      resultSummary: summaryFromToolCall(entry),
      errorCode: entry.error?.code,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt
    })),
    events: detail.events,
    testResult: lastTest ? summaryFromToolCall(lastTest) : "",
    finalResult: finalResult(detail),
    error: detail.run.error,
    startedAt: detail.run.startedAt,
    finishedAt: detail.run.finishedAt,
    duration: runDuration(detail.run),
    createdAt: detail.run.createdAt,
    updatedAt: detail.run.updatedAt
  };
}

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createAgentRunsRouter({ service }: AgentRunsDependencies): Router {
  const router = Router();

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = CreateAgentRunSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Agent run input is invalid",
          parsed.error.flatten()
        );
      }

      const run = await service.create(parsed.data, res.locals.requestId);
      sendSuccess(res, run, 201);
    })
  );

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      sendSuccess(res, await service.list());
    })
  );

  router.post(
    "/coding-demo",
    asyncHandler(async (req, res) => {
      const parsed = RunCodingAgentSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Agent run input is invalid",
          parsed.error.flatten()
        );
      }

      const run = await service.create(
        {
          task: parsed.data.task ?? "修复项目中的测试失败问题，并确保所有测试通过。"
        },
        res.locals.requestId
      );
      const detail = await service.waitForTerminalRun(run.id, 240_000);
      if (!detail) {
        throw new AppError(504, "TIMEOUT_ERROR", "Agent run did not finish in time");
      }

      sendSuccess(res, toAgentRunView(detail), 201);
    })
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params);
      const detail = await service.getDetail(id);
      if (!detail) {
        throw new AppError(404, "AGENT_RUN_NOT_FOUND", "Agent run not found");
      }

      sendSuccess(res, detail);
    })
  );

  router.post(
    "/:id/cancel",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params);
      const run = await service.cancel(id);
      if (!run) {
        throw new AppError(404, "AGENT_RUN_NOT_FOUND", "Agent run not found");
      }

      sendSuccess(res, run);
    })
  );

  router.get(
    "/:id/events",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params);
      const events = await service.getEvents(id);
      if (!events) {
        throw new AppError(404, "AGENT_RUN_NOT_FOUND", "Agent run not found");
      }

      sendSuccess(res, events);
    })
  );

  router.get(
    "/:id/stream",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params);
      const initial = await service.snapshot(id);
      if (!initial) {
        throw new AppError(404, "AGENT_RUN_NOT_FOUND", "Agent run not found");
      }

      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      });
      res.flushHeaders();

      let closed = false;
      let sending = Promise.resolve();
      const sendSnapshot = async () => {
        if (closed) {
          return;
        }

        const snapshot = await service.snapshot(id);
        if (snapshot) {
          writeSse(res, "snapshot", snapshot);
        }
      };
      const scheduleSnapshot = () => {
        sending = sending.then(sendSnapshot).catch(() => undefined);
      };
      const unsubscribe = service.onRunEvent(id, scheduleSnapshot);
      const interval = setInterval(scheduleSnapshot, 2_000);

      req.on("close", () => {
        closed = true;
        clearInterval(interval);
        unsubscribe();
      });

      writeSse(res, "snapshot", initial);
    })
  );

  return router;
}
