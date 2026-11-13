import {
  MCPPromptDescriptor,
  MCPPromptMessage,
  MCPPromptMessageContent,
  MCPPromptResult,
  MCPResourceContent,
  MCPResourceDescriptor
} from "../contracts";
import { MCPClientError } from "./MCPClientError";

/**
 * Phase 5.5-6: normalization of the official-SDK resource/prompt shapes onto
 * the stable AI-SE structures. SDK objects never leave the client layer.
 *
 * Malformed payloads are rejected explicitly (classified MCPClientError), so a
 * misbehaving server can never leak an unexpected shape upward.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(what: string, detail?: string): MCPClientError {
  return new MCPClientError("INTERNAL", `Malformed MCP ${what}${detail ? `: ${detail}` : ""}`);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? (record[key] as string) : undefined;
}

/**
 * Phase 5.5-7: reads the UI-app link from tool metadata. The current
 * SDK/protocol carries it as `_meta.ui.resourceUri`; anything else is
 * ignored (no heuristics, no guessing).
 */
export function toolUiResourceUri(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined;
  const meta = tool._meta;
  if (!isRecord(meta)) return undefined;
  const ui = meta.ui;
  if (!isRecord(ui)) return undefined;
  const resourceUri = ui.resourceUri;
  return typeof resourceUri === "string" && resourceUri.trim() ? resourceUri : undefined;
}

export function normalizeResourceDescriptor(
  serverId: string,
  resource: unknown
): MCPResourceDescriptor {
  if (
    !isRecord(resource) ||
    typeof resource.uri !== "string" ||
    typeof resource.name !== "string"
  ) {
    throw malformed("resource descriptor", "uri/name are required");
  }
  return {
    serverId,
    uri: resource.uri,
    name: resource.name,
    description: optionalString(resource, "description"),
    mimeType: optionalString(resource, "mimeType")
  };
}

export function normalizeResourceContents(
  serverId: string,
  contents: unknown
): MCPResourceContent[] {
  if (!Array.isArray(contents) || contents.length === 0) {
    throw malformed("resources/read result", "contents must be a non-empty array");
  }
  return contents.map((entry) => {
    if (!isRecord(entry) || typeof entry.uri !== "string") {
      throw malformed("resource contents", "uri is required");
    }
    const text = entry.text;
    const blob = entry.blob;
    if (typeof text !== "string" && typeof blob !== "string") {
      throw malformed("resource contents", "text or blob is required");
    }
    return {
      uri: entry.uri,
      mimeType: optionalString(entry, "mimeType"),
      ...(typeof text === "string" ? { text } : {}),
      ...(typeof blob === "string" ? { blob } : {})
    };
  });
}

export function normalizePromptDescriptor(serverId: string, prompt: unknown): MCPPromptDescriptor {
  if (!isRecord(prompt) || typeof prompt.name !== "string") {
    throw malformed("prompt descriptor", "name is required");
  }
  const args = prompt.arguments;
  const argumentsList = Array.isArray(args)
    ? args.map((argument) => {
        if (!isRecord(argument) || typeof argument.name !== "string") {
          throw malformed("prompt argument", "name is required");
        }
        return {
          name: argument.name,
          description: optionalString(argument, "description"),
          required: argument.required === true
        };
      })
    : [];
  return {
    serverId,
    name: prompt.name,
    description: optionalString(prompt, "description"),
    arguments: argumentsList
  };
}

function normalizeMessageContent(content: unknown): MCPPromptMessageContent {
  if (!isRecord(content) || typeof content.type !== "string") {
    throw malformed("prompt message content", "type is required");
  }
  switch (content.type) {
    case "text":
      if (typeof content.text !== "string") {
        throw malformed("prompt message content", "text is required for text content");
      }
      return { type: "text", text: content.text };
    case "image":
      if (typeof content.data !== "string" || typeof content.mimeType !== "string") {
        throw malformed("prompt message content", "data/mimeType are required for image content");
      }
      return { type: "image", data: content.data, mimeType: content.mimeType };
    case "resource": {
      const resource = content.resource;
      if (!isRecord(resource) || typeof resource.uri !== "string") {
        throw malformed("prompt message content", "resource.uri is required");
      }
      const text = resource.text;
      const blob = resource.blob;
      if (typeof text !== "string" && typeof blob !== "string") {
        throw malformed("prompt message content", "embedded resource needs text or blob");
      }
      return {
        type: "resource",
        resource: {
          uri: resource.uri,
          mimeType: optionalString(resource, "mimeType"),
          ...(typeof text === "string" ? { text } : {}),
          ...(typeof blob === "string" ? { blob } : {})
        }
      };
    }
    case "resource_link":
      if (typeof content.uri !== "string") {
        throw malformed("prompt message content", "uri is required for resource_link");
      }
      return {
        type: "resource_link",
        uri: content.uri,
        name: optionalString(content, "name"),
        mimeType: optionalString(content, "mimeType")
      };
    default:
      throw malformed("prompt message content", `unsupported content type "${content.type}"`);
  }
}

export function normalizePromptResult(
  serverId: string,
  name: string,
  result: unknown
): MCPPromptResult {
  if (!isRecord(result) || !Array.isArray(result.messages) || result.messages.length === 0) {
    throw malformed("prompts/get result", "messages must be a non-empty array");
  }
  const messages: MCPPromptMessage[] = result.messages.map((message) => {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
      throw malformed("prompt message", 'role must be "user" or "assistant"');
    }
    return {
      role: message.role,
      content: normalizeMessageContent(message.content)
    };
  });
  return {
    serverId,
    name,
    description: optionalString(result, "description"),
    messages
  };
}
