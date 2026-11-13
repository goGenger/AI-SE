import { afterEach, describe, expect, it, vi } from "vitest";
import { authHeaders } from "../auth";
import { listProjects } from "../projects";

describe("api auth headers (D-3/T8-c)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns no header when VITE_API_TOKEN is unset", () => {
    expect(authHeaders()).toEqual({});
  });

  it("returns the bearer header when VITE_API_TOKEN is set", () => {
    vi.stubEnv("VITE_API_TOKEN", "secret-token");
    expect(authHeaders()).toEqual({ Authorization: "Bearer secret-token" });
  });

  it("sends the bearer header through requestJson when configured", async () => {
    vi.stubEnv("VITE_API_TOKEN", "secret-token");
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: [] })
    });
    vi.stubGlobal("fetch", fetchMock);

    await listProjects();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret-token" })
      })
    );
  });
});
