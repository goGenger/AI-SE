import { describe, expect, it } from "vitest";
import { MCPClientError } from "../client/MCPClientError";
import {
  normalizePromptDescriptor,
  normalizePromptResult,
  normalizeResourceContents,
  normalizeResourceDescriptor,
  toolUiResourceUri
} from "../client/normalize";

/**
 * Phase 5.5-6: normalization tests — malformed server payloads must produce a
 * classified MCPClientError instead of leaking an unexpected shape upward.
 */

describe("resource/prompt normalization", () => {
  it("normalizes resource descriptors and keeps optional fields optional", () => {
    expect(
      normalizeResourceDescriptor("s1", {
        uri: "file:///a.txt",
        name: "a",
        description: "desc",
        mimeType: "text/plain",
        annotations: { priority: 1 }
      })
    ).toEqual({
      serverId: "s1",
      uri: "file:///a.txt",
      name: "a",
      description: "desc",
      mimeType: "text/plain"
    });

    expect(normalizeResourceDescriptor("s1", { uri: "u", name: "n" })).toEqual({
      serverId: "s1",
      uri: "u",
      name: "n",
      description: undefined,
      mimeType: undefined
    });
  });

  it("rejects malformed resource descriptors", () => {
    expect(() => normalizeResourceDescriptor("s1", null)).toThrow(MCPClientError);
    expect(() => normalizeResourceDescriptor("s1", { name: "n" })).toThrow(
      /Malformed MCP resource/
    );
    expect(() => normalizeResourceDescriptor("s1", { uri: "u" })).toThrow(/uri\/name are required/);
  });

  it("normalizes text and blob contents and rejects mixed/malformed entries", () => {
    expect(
      normalizeResourceContents("s1", [{ uri: "u", mimeType: "text/plain", text: "hello" }])
    ).toEqual([{ uri: "u", mimeType: "text/plain", text: "hello" }]);

    expect(normalizeResourceContents("s1", [{ uri: "u", blob: "QklO" }])).toEqual([
      { uri: "u", mimeType: undefined, blob: "QklO" }
    ]);

    expect(() => normalizeResourceContents("s1", [])).toThrow(/non-empty array/);
    expect(() => normalizeResourceContents("s1", [{ uri: "u" }])).toThrow(
      /text or blob is required/
    );
    expect(() => normalizeResourceContents("s1", "nope")).toThrow(MCPClientError);
  });

  it("normalizes prompt descriptors with argument metadata", () => {
    expect(
      normalizePromptDescriptor("s1", {
        name: "code_review",
        description: "Reviews code",
        arguments: [{ name: "language", description: "Language", required: true }, { name: "code" }]
      })
    ).toEqual({
      serverId: "s1",
      name: "code_review",
      description: "Reviews code",
      arguments: [
        { name: "language", description: "Language", required: true },
        { name: "code", description: undefined, required: false }
      ]
    });

    expect(() => normalizePromptDescriptor("s1", { name: 42 })).toThrow(MCPClientError);
    expect(() => normalizePromptDescriptor("s1", { name: "p", arguments: [{}] })).toThrow(
      /prompt argument/
    );
  });

  it("converts prompt messages: text, image, embedded resource and link", () => {
    const result = normalizePromptResult("s1", "mixed", {
      description: "d",
      messages: [
        { role: "user", content: { type: "text", text: "hello" } },
        { role: "assistant", content: { type: "image", data: "aW1n", mimeType: "image/png" } },
        {
          role: "user",
          content: {
            type: "resource",
            resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "embedded" }
          }
        },
        { role: "user", content: { type: "resource_link", uri: "file:///b", name: "b" } }
      ]
    });

    expect(result.serverId).toBe("s1");
    expect(result.name).toBe("mixed");
    expect(result.description).toBe("d");
    expect(result.messages).toEqual([
      { role: "user", content: { type: "text", text: "hello" } },
      { role: "assistant", content: { type: "image", data: "aW1n", mimeType: "image/png" } },
      {
        role: "user",
        content: {
          type: "resource",
          resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "embedded" }
        }
      },
      {
        role: "user",
        content: { type: "resource_link", uri: "file:///b", name: "b", mimeType: undefined }
      }
    ]);
  });

  it("rejects malformed prompt results", () => {
    expect(() => normalizePromptResult("s1", "p", { messages: [] })).toThrow(/non-empty array/);
    expect(() =>
      normalizePromptResult("s1", "p", { messages: [{ role: "system", content: {} }] })
    ).toThrow(MCPClientError);
    expect(() =>
      normalizePromptResult("s1", "p", {
        messages: [{ role: "user", content: { type: "video", data: "x" } }]
      })
    ).toThrow(/unsupported content type/);
    expect(() =>
      normalizePromptResult("s1", "p", {
        messages: [{ role: "user", content: { type: "resource", resource: { text: "no uri" } } }]
      })
    ).toThrow(/resource\.uri is required/);
  });
});

describe("tool `_meta.ui` normalization (Phase 5.5-7)", () => {
  it("extracts a string resourceUri from _meta.ui", () => {
    expect(toolUiResourceUri({ _meta: { ui: { resourceUri: "ui://apps/counter" } } })).toBe(
      "ui://apps/counter"
    );
  });

  it("ignores tools without a well-formed _meta.ui link", () => {
    expect(toolUiResourceUri({})).toBeUndefined();
    expect(toolUiResourceUri({ _meta: {} })).toBeUndefined();
    expect(toolUiResourceUri({ _meta: { ui: "not-an-object" } })).toBeUndefined();
    expect(toolUiResourceUri({ _meta: { ui: { resourceUri: 42 } } })).toBeUndefined();
    expect(toolUiResourceUri({ _meta: { ui: { resourceUri: "" } } })).toBeUndefined();
    expect(toolUiResourceUri({ _meta: null })).toBeUndefined();
    expect(toolUiResourceUri(null)).toBeUndefined();
    expect(toolUiResourceUri("nope")).toBeUndefined();
  });
});
