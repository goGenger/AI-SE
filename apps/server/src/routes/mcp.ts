import { MCPContractError, MCPRegistryStoreError } from "@ai-se/mcp";
import {
  CreateMCPBindingSchema,
  CreateMCPServerSchema,
  MCPAppActionRequestSchema,
  UpdateMCPBindingSchema,
  UpdateMCPToolSchema
} from "@ai-se/shared";
import { Router } from "express";
import { z } from "zod";
import { AppError, asyncHandler } from "../http/errors";
import { sendSuccess } from "../http/response";
import { MCPAppService } from "../services/mcpAppService";
import { MCPConsoleService } from "../services/mcpService";

function paramParser<T extends string>(key: T) {
  const schema = z.object({ [key]: z.string().trim().min(1) }) as z.ZodType<Record<T, string>>;
  return (params: unknown): string => {
    const result = schema.safeParse(params);
    if (!result.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Missing path parameter: ${key}`,
        result.error.flatten()
      );
    }
    return result.data[key];
  };
}

const serverIdFrom = paramParser("serverId");
const bindingIdFrom = paramParser("bindingId");
const toolIdFrom = paramParser("toolId");

/** Phase 5.5-7 query schemas for the MCP Apps endpoints. */
const UiAppsQuerySchema = z.object({
  projectId: z.string().uuid(),
  agentName: z.string().trim().min(1).max(160)
});

const UiResourceQuerySchema = UiAppsQuerySchema.extend({
  uri: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((value) => value.startsWith("ui://"), "uri must use the ui:// scheme")
});

/**
 * Phase 5.5-5: MCP Console API (+ Phase 5.5-7 MCP Apps endpoints).
 *
 * The browser talks to THIS API only — it never reaches an MCP server, an MCP
 * client or the MCP SDK. Responses carry registry/persistence data plus
 * credential REFERENCES (authRef / credentialRef); never credential values.
 * App controlled actions are executed by MCPAppService through the existing
 * Tool Runtime chain (permission/policy/approval/audit/timeout).
 */
export function createMCPRouter(mcp: MCPConsoleService, apps?: MCPAppService): Router {
  const router = Router();

  router.get(
    "/servers",
    asyncHandler(async (_req, res) => {
      sendSuccess(res, await mcp.listServers());
    })
  );

  // T2：控制台第一次拥有创建服务器的能力（此前注册表只能带外写入）。
  router.post(
    "/servers",
    asyncHandler(async (req, res) => {
      const parsed = CreateMCPServerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "MCP server input is invalid",
          parsed.error.flatten()
        );
      }
      const created = await mcp.createServer(parsed.data).catch(translateServerError);
      sendSuccess(res, created, 201);
    })
  );

  router.get(
    "/servers/:serverId",
    asyncHandler(async (req, res) => {
      const detail = await mcp.getServer(serverIdFrom(req.params));
      if (!detail) {
        throw new AppError(404, "MCP_SERVER_NOT_FOUND", "MCP server not found");
      }
      sendSuccess(res, detail);
    })
  );

  router.get(
    "/servers/:serverId/tools",
    asyncHandler(async (req, res) => {
      const tools = await mcp.listTools(serverIdFrom(req.params));
      if (!tools) {
        throw new AppError(404, "MCP_SERVER_NOT_FOUND", "MCP server not found");
      }
      sendSuccess(res, tools);
    })
  );

  // T2：发现的工具默认关闭（迁移 008 的既定语义），这里提供唯一的开启入口。
  router.patch(
    "/servers/:serverId/tools/:toolId",
    asyncHandler(async (req, res) => {
      const parsed = UpdateMCPToolSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Tool update is invalid", parsed.error.flatten());
      }
      const serverId = serverIdFrom(req.params);
      const tools = await mcp.listTools(serverId);
      if (!tools) {
        throw new AppError(404, "MCP_SERVER_NOT_FOUND", "MCP server not found");
      }
      const toolId = toolIdFrom(req.params);
      if (!tools.some((tool) => tool.id === toolId)) {
        throw new AppError(404, "MCP_TOOL_NOT_FOUND", "MCP tool not found for this server");
      }
      const updated = await mcp.setToolEnabled(toolId, parsed.data.enabled);
      if (!updated) {
        throw new AppError(404, "MCP_TOOL_NOT_FOUND", "MCP tool not found");
      }
      sendSuccess(res, updated);
    })
  );

  router.get(
    "/servers/:serverId/bindings",
    asyncHandler(async (req, res) => {
      const bindings = await mcp.listBindings(serverIdFrom(req.params));
      if (!bindings) {
        throw new AppError(404, "MCP_SERVER_NOT_FOUND", "MCP server not found");
      }
      sendSuccess(res, bindings);
    })
  );

  router.post(
    "/servers/:serverId/bindings",
    asyncHandler(async (req, res) => {
      const parsed = CreateMCPBindingSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Binding input is invalid",
          parsed.error.flatten()
        );
      }

      const binding = await mcp
        .createBinding(serverIdFrom(req.params), parsed.data)
        .catch((error: unknown): never => {
          throw translateBindingError(error);
        });
      sendSuccess(res, binding, 201);
    })
  );

  router.patch(
    "/bindings/:bindingId",
    asyncHandler(async (req, res) => {
      const parsed = UpdateMCPBindingSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Binding update is invalid",
          parsed.error.flatten()
        );
      }
      const binding = await mcp.setBindingEnabled(bindingIdFrom(req.params), parsed.data.enabled);
      if (!binding) {
        throw new AppError(404, "MCP_BINDING_NOT_FOUND", "MCP binding not found");
      }
      sendSuccess(res, binding);
    })
  );

  router.delete(
    "/bindings/:bindingId",
    asyncHandler(async (req, res) => {
      const id = bindingIdFrom(req.params);
      const deleted = await mcp.deleteBinding(id);
      if (!deleted) {
        throw new AppError(404, "MCP_BINDING_NOT_FOUND", "MCP binding not found");
      }
      sendSuccess(res, { id });
    })
  );

  // ── Phase 5.5-7: MCP Apps (sandboxed UI resources + controlled actions) ──

  if (apps) {
    router.get(
      "/servers/:serverId/ui-apps",
      asyncHandler(async (req, res) => {
        const parsed = UiAppsQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          throw new AppError(400, "VALIDATION_ERROR", "Query is invalid", parsed.error.flatten());
        }
        const links = await apps.listUiApps(
          serverIdFrom(req.params),
          parsed.data.projectId,
          parsed.data.agentName
        );
        sendSuccess(res, links);
      })
    );

    router.get(
      "/servers/:serverId/ui-resource",
      asyncHandler(async (req, res) => {
        const parsed = UiResourceQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          throw new AppError(400, "VALIDATION_ERROR", "Query is invalid", parsed.error.flatten());
        }
        const resource = await apps.readUiResource(
          serverIdFrom(req.params),
          parsed.data.uri,
          parsed.data.projectId,
          parsed.data.agentName
        );
        sendSuccess(res, resource);
      })
    );

    router.post(
      "/apps/actions",
      asyncHandler(async (req, res) => {
        const parsed = MCPAppActionRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "App action input is invalid",
            parsed.error.flatten()
          );
        }
        // A client disconnect cancels the in-flight action through the Tool
        // Runtime signal (the runtime aborts the MCP request).
        const controller = new AbortController();
        res.on("close", () => controller.abort());
        const result = await apps.runAction(parsed.data, controller.signal);
        sendSuccess(res, result);
      })
    );
  }

  return router;
}

function translateServerError(error: unknown): never {
  // 冻结契约（`docs/25`）的判定结果原样交给人看：它比任何二道校验都准。
  if (error instanceof MCPContractError) {
    throw new AppError(400, "MCP_SERVER_INVALID", error.message);
  }
  throw error;
}

function translateBindingError(error: unknown): unknown {
  if (error instanceof MCPRegistryStoreError) {
    switch (error.code) {
      case "DUPLICATE_BINDING":
        return new AppError(409, "MCP_BINDING_EXISTS", "MCP binding already exists");
      case "UNKNOWN_TOOL":
        return new AppError(400, "MCP_TOOL_NOT_FOUND", "MCP tool not found for this server");
      case "UNKNOWN_PROJECT":
        return new AppError(400, "MCP_PROJECT_NOT_FOUND", "Project not found");
      case "UNKNOWN_SERVER":
        return new AppError(404, "MCP_SERVER_NOT_FOUND", "MCP server not found");
    }
  }
  return error;
}
