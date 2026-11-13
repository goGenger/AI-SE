import type {
  AgentDefinitionView,
  Deployment,
  MCPServerSummary,
  Project,
  Requirement,
  WorkflowSummary
} from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  NAV_ENTRIES,
  buildDataEntries,
  filterEntries,
  groupEntries,
  type PaletteSources
} from "@/viewmodels/commandPaletteViewModel";

/**
 * 命令面板展示逻辑测试（W4）。
 *
 * 只测判断，不测渲染：条目映射、空查询预览、子串匹配、结果上限、分组。
 * 「没有数据」与「没有匹配」是两件事——前者是空 store，后者是查询没命中，
 * 这里分别断言，避免 UI 把两种空混淆。
 */

function makeProject(id: string, name: string, status: Project["status"] = "active"): Project {
  return {
    id,
    name,
    description: "",
    repository: null,
    workspacePath: null,
    status,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  };
}

function makeRequirement(id: string, title: string, version = 1): Requirement {
  return {
    id,
    projectId: "p1",
    title,
    description: "",
    rawContent: "",
    status: "ANALYZED",
    version,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  };
}

function makeWorkflow(
  id: string,
  requirementName: string | null,
  projectName: string | null
): WorkflowSummary {
  return {
    id,
    projectId: "p1",
    requirementId: "r1",
    planningVersion: 1,
    status: "RUNNING",
    policy: {
      maxConcurrency: 1,
      maxRetries: 3,
      failureStrategy: "RETRY",
      allowRetry: true,
      allowReplan: false,
      approvalRequired: false
    },
    input: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    projectName,
    requirementName,
    taskProgress: { total: 4, completed: 1 }
  };
}

function makeDeployment(id: string, version: string): Deployment {
  return {
    id,
    projectId: "p1",
    workflowRunId: "w1",
    taskId: "t1",
    version,
    environment: "staging",
    image: "ghcr.io/acme/app:1",
    gitCommit: "abcdef1",
    operation: "DEPLOY",
    status: "SUCCESS",
    endpoint: "https://staging.example.com",
    healthCheck: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  };
}

function makeAgent(name: string): AgentDefinitionView {
  return {
    name,
    type: "FRONTEND",
    description: "",
    capabilities: [],
    tools: [],
    permissions: { tools: [], pathPrefixes: [], readOnly: true },
    status: "available"
  };
}

function makeServer(id: string, name: string): MCPServerSummary {
  return {
    id,
    name,
    description: "",
    transport: "stdio",
    enabled: true,
    status: "CONNECTED",
    toolCount: 3
  };
}

const EMPTY_SOURCES: PaletteSources = {
  projects: [],
  requirements: [],
  workflows: [],
  deployments: [],
  agents: [],
  mcpServers: []
};

describe("buildDataEntries — 实体到条目的映射", () => {
  it("每类实体映射到正确的分组、标题与跳转目标", () => {
    const entries = buildDataEntries({
      projects: [makeProject("p1", "Mini Todo")],
      requirements: [makeRequirement("r1", "登录流程", 3)],
      workflows: [makeWorkflow("w1", "登录流程", "Mini Todo")],
      deployments: [makeDeployment("d1", "1.4.0")],
      agents: [makeAgent("coding-agent")],
      mcpServers: [makeServer("s1", "Echo 服务")]
    });

    expect(entries.find((entry) => entry.group === "项目")).toMatchObject({
      label: "Mini Todo",
      hint: "启用中",
      to: "/projects/p1"
    });
    expect(entries.find((entry) => entry.group === "需求")).toMatchObject({
      label: "登录流程",
      hint: "v3",
      to: "/requirements"
    });
    expect(entries.find((entry) => entry.group === "工作流")).toMatchObject({
      label: "登录流程",
      hint: "Mini Todo",
      to: "/workflows/w1"
    });
    expect(entries.find((entry) => entry.group === "部署")).toMatchObject({
      label: "staging · 1.4.0",
      hint: "SUCCESS",
      to: "/deployments/d1"
    });
    expect(entries.find((entry) => entry.group === "Agent")).toMatchObject({
      label: "coding-agent",
      hint: "FRONTEND",
      to: "/agents"
    });
    expect(entries.find((entry) => entry.group === "MCP 服务器")).toMatchObject({
      label: "Echo 服务",
      hint: "stdio",
      to: "/mcp/s1"
    });
  });

  it("store 为空时不产出任何条目（不编造数据）", () => {
    expect(buildDataEntries(EMPTY_SOURCES)).toEqual([]);
  });

  it("工作流没有关联名称时退回 id，而不是空白标题", () => {
    const entries = buildDataEntries({
      ...EMPTY_SOURCES,
      workflows: [makeWorkflow("w-abcdef", null, null)]
    });
    expect(entries[0].label).toBe("w-abcdef");
    expect(entries[0].hint).toBe("RUNNING");
  });
});

describe("filterEntries — 过滤", () => {
  const sources: PaletteSources = {
    projects: [makeProject("p1", "Mini Todo"), makeProject("p2", "支付网关", "archived")],
    requirements: [makeRequirement("r1", "登录流程")],
    workflows: [],
    deployments: [],
    agents: [makeAgent("coding-agent")],
    mcpServers: []
  };
  const data = buildDataEntries(sources);

  it("空查询返回全部页面入口 + 每个数据分组的前几条", () => {
    const result = filterEntries(data, "");
    expect(result.slice(0, NAV_ENTRIES.length)).toEqual(NAV_ENTRIES);
    expect(result).toContainEqual(expect.objectContaining({ label: "Mini Todo" }));
    expect(result).toContainEqual(expect.objectContaining({ label: "登录流程" }));
  });

  it("空查询时每组限量，超出部分不出现", () => {
    const many = buildDataEntries({
      ...EMPTY_SOURCES,
      projects: Array.from({ length: 10 }, (_, index) => makeProject(`p${index}`, `项目 ${index}`))
    });
    const result = filterEntries(many, "");
    const projects = result.filter((entry) => entry.group === "项目");
    expect(projects.length).toBe(5);
    expect(projects[0].label).toBe("项目 0");
    expect(result).not.toContainEqual(expect.objectContaining({ label: "项目 5" }));
  });

  it("按标题匹配，忽略大小写", () => {
    const result = filterEntries(data, "mini");
    expect(result).toContainEqual(expect.objectContaining({ label: "Mini Todo" }));
    expect(result).not.toContainEqual(expect.objectContaining({ label: "支付网关" }));
  });

  it("按 hint 与分组名匹配（可用状态或分类检索）", () => {
    expect(filterEntries(data, "已归档")).toContainEqual(
      expect.objectContaining({ label: "支付网关" })
    );
    expect(filterEntries(data, "MCP")).toContainEqual(
      expect.objectContaining({ label: "MCP 服务器" })
    );
  });

  it("没有匹配时返回空数组（与「没有数据」区分开）", () => {
    expect(filterEntries(data, "zzz-no-such-thing")).toEqual([]);
  });

  it("结果数量受上限约束", () => {
    const many = buildDataEntries({
      ...EMPTY_SOURCES,
      projects: Array.from({ length: 200 }, (_, index) => makeProject(`p${index}`, `项目 ${index}`))
    });
    expect(filterEntries(many, "项目", { maxResults: 50 }).length).toBe(50);
  });
});

describe("groupEntries — 分组", () => {
  it("把连续同类项合成一段并保持顺序", () => {
    const entries = buildDataEntries({
      ...EMPTY_SOURCES,
      projects: [makeProject("p1", "A"), makeProject("p2", "B")],
      agents: [makeAgent("agent-x")]
    });
    const groups = groupEntries([...NAV_ENTRIES, ...entries]);
    expect(groups.map((group) => group.group)).toEqual(["页面", "项目", "Agent"]);
    expect(groups[1].entries.map((entry) => entry.label)).toEqual(["A", "B"]);
  });

  it("空输入得到空分组", () => {
    expect(groupEntries([])).toEqual([]);
  });
});
