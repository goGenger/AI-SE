import { CreateRequirementSchema, AnalyzeRequirementSchema, UpsertConflictResolutionsSchema } from "@ai-se/shared";
import { Router } from "express";
import { z } from "zod";
import { AppError, asyncHandler } from "../http/errors";
import { sendSuccess } from "../http/response";
import { PlanningService } from "../services/planningService";
import { renderTraceabilityMarkdown } from "../services/traceability";

const IdParamSchema = z.object({
  id: z.string().uuid()
});

const ProjectIdParamSchema = z.object({
  projectId: z.string().uuid()
});

function parseId(params: unknown, label: string): string {
  const result = IdParamSchema.safeParse(params);
  if (!result.success) {
    throw new AppError(400, "VALIDATION_ERROR", `${label} must be a UUID`, result.error.flatten());
  }

  return result.data.id;
}

function parseProjectId(params: unknown): string {
  const result = ProjectIdParamSchema.safeParse(params);
  if (!result.success) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Project id must be a UUID",
      result.error.flatten()
    );
  }

  return result.data.projectId;
}

export function createPlanningRouter(service: PlanningService): Router {
  const router = Router();

  router.post(
    "/projects/:projectId/requirements",
    asyncHandler(async (req, res) => {
      const projectId = parseProjectId(req.params);
      const parsed = CreateRequirementSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Requirement input is invalid",
          parsed.error.flatten()
        );
      }

      const requirement = await service.createRequirement(projectId, parsed.data);
      sendSuccess(res, requirement, 201);
    })
  );

  router.get(
    "/projects/:projectId/requirements",
    asyncHandler(async (req, res) => {
      const projectId = parseProjectId(req.params);
      sendSuccess(res, await service.listRequirements(projectId));
    })
  );

  router.get(
    "/requirements/:id",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params, "Requirement id");
      const requirement = await service.getRequirement(id);
      if (!requirement) {
        throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
      }

      sendSuccess(res, requirement);
    })
  );

  router.get(
    "/requirements/:id/conflict-resolutions",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params, "Requirement id");
      sendSuccess(res, await service.listConflictResolutions(id));
    })
  );

  router.post(
    "/requirements/:id/conflict-resolutions",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params, "Requirement id");
      const parsed = UpsertConflictResolutionsSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Conflict resolution input is invalid",
          parsed.error.flatten()
        );
      }
      const saved = await service.upsertConflictResolutions(id, parsed.data.resolutions);
      sendSuccess(res, saved);
    })
  );

  router.post(
    "/requirements/:id/analyze",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params, "Requirement id");
      const parsed = AnalyzeRequirementSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Analyze input is invalid",
          parsed.error.flatten()
        );
      }

      const result = await service.analyzeRequirement(id, parsed.data, res.locals.requestId);
      sendSuccess(res, result, result.accepted ? 202 : 200);
    })
  );

  router.get(
    "/requirements/:id/specifications",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params, "Requirement id");
      const specifications = await service.getSpecifications(id);
      if (!specifications) {
        throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
      }

      sendSuccess(res, specifications);
    })
  );

  router.get(
    "/requirements/:id/tasks",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params, "Requirement id");
      const tasks = await service.getRequirementTasks(id);
      if (!tasks) {
        throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
      }

      sendSuccess(res, tasks);
    })
  );

  // N2：需求页切片视图（切片列表 + 待确认的关口 1 审批）。
  router.get(
    "/requirements/:id/slices",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params, "Requirement id");
      const view = await service.getRequirementSlices(id);
      if (!view) {
        throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
      }

      sendSuccess(res, view);
    })
  );

  router.get(
    "/requirements/:id/acceptance-criteria",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params, "Requirement id");
      const view = await service.getRequirementAcceptanceCriteria(id);
      if (!view) {
        throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
      }

      sendSuccess(res, view);
    })
  );

  // C-5（N5）：追溯表（默认 JSON；`?format=markdown` 按需导出）。
  router.get(
    "/requirements/:id/traceability",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params, "Requirement id");
      const view = await service.getRequirementTraceability(id);
      if (!view) {
        throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
      }

      const format = typeof req.query.format === "string" ? req.query.format : "";
      if (format === "markdown" || format === "md") {
        res.type("text/markdown").send(renderTraceabilityMarkdown(view));
        return;
      }

      sendSuccess(res, view);
    })
  );

  router.get(
    "/tasks/:id",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params, "Task id");
      const task = await service.getTask(id);
      if (!task) {
        throw new AppError(404, "TASK_NOT_FOUND", "Task not found");
      }

      sendSuccess(res, task);
    })
  );

  router.get(
    "/tasks/:id/dependencies",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params, "Task id");
      const dependencies = await service.getTaskDependencies(id);
      if (!dependencies) {
        throw new AppError(404, "TASK_NOT_FOUND", "Task not found");
      }

      sendSuccess(res, dependencies);
    })
  );

  // 产品补齐：切片规划完成后的手动启动 / 重试（补救自动启动失败）。
  router.post(
    "/requirements/:id/slices/:sliceKey/start-workflow",
    asyncHandler(async (req, res) => {
      const parsed = z
        .object({
          id: z.string().uuid(),
          sliceKey: z.string().trim().min(1).max(40)
        })
        .safeParse(req.params);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Requirement id / sliceKey is invalid",
          parsed.error.flatten()
        );
      }
      const body = z
        .object({
          workspacePath: z.string().trim().min(1).max(1000).optional()
        })
        .safeParse(req.body ?? {});
      if (!body.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Start-workflow input is invalid",
          body.error.flatten()
        );
      }

      const workflow = await service.startSliceWorkflowForSlice(
        parsed.data.id,
        parsed.data.sliceKey,
        body.data.workspacePath ? { workspacePath: body.data.workspacePath } : {}
      );
      sendSuccess(res, workflow, 201);
    })
  );

  return router;
}
