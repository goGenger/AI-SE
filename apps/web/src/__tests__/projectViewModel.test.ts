import { describe, expect, it } from "vitest";
import {
  latestProjects,
  normalizeRepository,
  projectStatusLabel,
  projectStatusTone,
  repositoryLabel
} from "../viewmodels/projectViewModel";

describe("projectViewModel", () => {
  it("formats project status labels", () => {
    expect(projectStatusLabel("active")).toBe("启用");
    expect(projectStatusLabel("archived")).toBe("已归档");
  });

  it("maps project status to a StatusBadge tone (Phase 4 纯展示映射)", () => {
    expect(projectStatusTone("active")).toBe("success");
    expect(projectStatusTone("archived")).toBe("neutral");
  });

  it("returns latest projects first", () => {
    const projects = latestProjects([
      {
        id: "1",
        name: "Old",
        description: "",
        repository: "https://github.com/example/old",
        workspacePath: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "2",
        name: "New",
        description: "",
        repository: "https://github.com/example/new",
        workspacePath: null,
        status: "active",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z"
      }
    ]);

    expect(projects.map((project) => project.name)).toEqual(["New", "Old"]);
  });

  it("未配置仓库时返回中文兜底文案（UX-01）", () => {
    expect(repositoryLabel("https://github.com/example/repo")).toBe(
      "https://github.com/example/repo"
    );
    expect(repositoryLabel(null)).toBe("未配置");
  });

  it("normalizeRepository 将空输入省略为 undefined（UX-01）", () => {
    expect(normalizeRepository("")).toBeUndefined();
    expect(normalizeRepository("   ")).toBeUndefined();
    expect(normalizeRepository(undefined)).toBeUndefined();
    expect(normalizeRepository(" https://github.com/example/repo ")).toBe(
      "https://github.com/example/repo"
    );
  });
});
