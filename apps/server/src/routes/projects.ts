import { ProjectRepository } from "@ai-se/database";
import {
  AttachProjectRepositorySchema,
  CreateProjectSchema,
  UpdateProjectWorkspacePathSchema
} from "@ai-se/shared";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { AppError, asyncHandler } from "../http/errors";
import { sendSuccess } from "../http/response";
import {
  ensureWorkspacePathUnderRoot,
  resolveProjectWorkspacePath
} from "../services/projectWorkspacePath";

const IdParamSchema = z.object({
  id: z.string().uuid()
});

function parseId(params: unknown): string {
  const result = IdParamSchema.safeParse(params);
  if (!result.success) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Project id must be a UUID",
      result.error.flatten()
    );
  }
  return result.data.id;
}

export function createProjectRouter(
  projects: ProjectRepository,
  options: { agentWorkspaceRoot: string } = { agentWorkspaceRoot: process.cwd() }
): Router {
  const router = Router();
  const agentWorkspaceRoot = options.agentWorkspaceRoot;

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = CreateProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Project input is invalid",
          parsed.error.flatten()
        );
      }

      // Auto path embeds a fresh short id for uniqueness (need not equal DB project id).
      const workspacePath = await resolveProjectWorkspacePath({
        requested: parsed.data.workspacePath,
        projectName: parsed.data.name,
        projectId: randomUUID(),
        agentWorkspaceRoot
      });

      const project = await projects.create({
        ...parsed.data,
        workspacePath
      });
      sendSuccess(res, project, 201);
    })
  );

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      sendSuccess(res, await projects.findMany());
    })
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params);
      const project = await projects.findById(id);

      if (!project) {
        throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      }

      sendSuccess(res, project);
    })
  );

  // UX-01: bind (or replace) the Git repository of an existing project.
  router.put(
    "/:id/repository",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params);
      const parsed = AttachProjectRepositorySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Repository input is invalid",
          parsed.error.flatten()
        );
      }

      const project = await projects.attachRepository(id, parsed.data.repository);
      if (!project) {
        throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      }

      sendSuccess(res, project);
    })
  );

  // Set / replace local workspace path (must stay under AGENT_WORKSPACE_ROOT).
  router.put(
    "/:id/workspace-path",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params);
      const parsed = UpdateProjectWorkspacePathSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Workspace path input is invalid",
          parsed.error.flatten()
        );
      }

      const existing = await projects.findById(id);
      if (!existing) {
        throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      }

      const workspacePath = await ensureWorkspacePathUnderRoot(
        parsed.data.workspacePath,
        agentWorkspaceRoot
      );
      const project = await projects.updateWorkspacePath(id, workspacePath);
      if (!project) {
        throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      }

      sendSuccess(res, project);
    })
  );

  router.delete(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params);
      const deleted = await projects.deleteById(id);

      if (!deleted) {
        throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      }

      sendSuccess(res, { id });
    })
  );

  return router;
}
