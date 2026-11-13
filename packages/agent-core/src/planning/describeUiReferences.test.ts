import { describe, expect, it, vi } from "vitest";
import {
  describeUiReferencesForPlanning,
  isMultimodalUnsupportedError,
  isOpenCodePlanningEndpoint,
  stripUiReferenceImages
} from "./describeUiReferences";

describe("isOpenCodePlanningEndpoint / isMultimodalUnsupportedError", () => {
  it("detects opencode gateways", () => {
    expect(isOpenCodePlanningEndpoint("https://opencode.ai/zen/go/v1")).toBe(true);
    expect(isOpenCodePlanningEndpoint("https://api.deepseek.com/v1")).toBe(false);
    expect(isOpenCodePlanningEndpoint(undefined)).toBe(false);
  });

  it("detects atlas multimodal rejection messages", () => {
    expect(
      isMultimodalUnsupportedError(
        new Error(
          "400 Upstream request failed: [invalid_request_error] this feature is not yet supported by atlas"
        )
      )
    ).toBe(true);
    expect(isMultimodalUnsupportedError(new Error("Failed to parse. Text: {}"))).toBe(false);
  });
});

describe("describeUiReferencesForPlanning", () => {
  it("injects vision notes and strips base64 on OpenCode endpoints", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  "Layout: left sidebar + main dashboard. Regions: nav, stats cards, task list. Colors: purple accent on white."
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await describeUiReferencesForPlanning(
      [
        {
          fileName: "dash.png",
          mimeType: "image/png",
          note: "[UI reference image: dash.png]",
          base64: "qqq"
        }
      ],
      {
        apiKey: "test-key",
        baseUrl: "https://opencode.ai/zen/go/v1",
        model: "deepseek-v4.1-flash",
        fetchImpl: fetchImpl as unknown as typeof fetch
      }
    );

    expect(result.describedCount).toBe(1);
    expect(result.textOnly).toBe(true);
    expect(result.references[0]?.base64).toBeUndefined();
    expect(result.references[0]?.note).toContain("UI reference analysis for dash.png");
    expect(result.references[0]?.note).toContain("purple accent");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0] as unknown as [
      string,
      { body?: string; headers?: Record<string, string> }
    ];
    const init = call[1];
    const body = JSON.parse(String(init.body));
    expect(body.messages[1].content.some((part: { type: string }) => part.type === "image_url")).toBe(
      true
    );
    expect(init.headers?.["x-opencode-session"]).toBeTruthy();
  });

  it("on vision failure with OpenCode, keeps filename note and strips base64", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("this feature is not yet supported by atlas", { status: 400 });
    });
    const result = await describeUiReferencesForPlanning(
      [
        {
          fileName: "dash.png",
          mimeType: "image/png",
          note: "[UI reference image: dash.png]",
          base64: "qqq"
        }
      ],
      {
        apiKey: "test-key",
        baseUrl: "https://opencode.ai/zen/go/v1",
        fetchImpl: fetchImpl as unknown as typeof fetch
      }
    );
    expect(result.describedCount).toBe(0);
    expect(result.warnings[0]).toContain("dash.png");
    expect(result.references[0]?.base64).toBeUndefined();
    expect(result.references[0]?.note).toContain("dash.png");
  });

  it("on vision failure with non-OpenCode, keeps base64 for native multimodal", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("boom", { status: 500 });
    });
    const result = await describeUiReferencesForPlanning(
      [
        {
          fileName: "dash.png",
          mimeType: "image/png",
          note: "[UI reference image: dash.png]",
          base64: "qqq"
        }
      ],
      {
        apiKey: "test-key",
        baseUrl: "https://api.openai.com/v1",
        fetchImpl: fetchImpl as unknown as typeof fetch
      }
    );
    expect(result.textOnly).toBe(false);
    expect(result.references[0]?.base64).toBe("qqq");
  });
});

describe("stripUiReferenceImages", () => {
  it("removes base64 while preserving notes", () => {
    expect(
      stripUiReferenceImages([
        { fileName: "a.png", mimeType: "image/png", note: "n", base64: "x" }
      ])
    ).toEqual([{ fileName: "a.png", mimeType: "image/png", note: "n" }]);
  });
});
