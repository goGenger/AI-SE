import type {
  AgentDefinitionView,
  Deployment,
  MCPServerSummary,
  Project,
  Requirement,
  WorkflowSummary
} from "@ai-se/shared";

/**
 * 全局搜索（命令面板）的展示逻辑（W4）。
 *
 * 纯函数，不依赖 Vue / store / 网络：调用方把各 store **已加载**的列表传进来，
 * 这里只负责把实体映射成可搜索的条目、过滤与分组。store 为空就是空结果，
 * 本模块不编造任何条目——「没有数据」与「没有匹配」在 UI 上是两件事。
 */

export interface PaletteEntry {
  id: string;
  /** 分组标题，同时决定渲染与键盘遍历的顺序 */
  group: string;
  label: string;
  /** 右侧的次要与可搜索信息（状态、版本、类型…） */
  hint: string;
  /** 选中后跳转的目标 */
  to: string;
}

export interface PaletteSources {
  projects: Project[];
  requirements: Requirement[];
  workflows: WorkflowSummary[];
  deployments: Deployment[];
  agents: AgentDefinitionView[];
  mcpServers: MCPServerSummary[];
}

/** 一级页面。与 `路由器` 的列表路由一一对应；详情路由只能由数据结果进入。 */
export const NAV_ENTRIES: PaletteEntry[] = [
  { id: "nav:/", group: "页面", label: "仪表盘", hint: "交付总览", to: "/" },
  { id: "nav:/projects", group: "页面", label: "项目", hint: "构建", to: "/projects" },
  { id: "nav:/requirements", group: "页面", label: "需求", hint: "构建", to: "/requirements" },
  { id: "nav:/workflows", group: "页面", label: "工作流", hint: "构建", to: "/workflows" },
  { id: "nav:/deployments", group: "页面", label: "部署", hint: "构建", to: "/deployments" },
  { id: "nav:/agents", group: "页面", label: "专业 Agent", hint: "运行", to: "/agents" },
  { id: "nav:/agent-run", group: "页面", label: "Agent 运行", hint: "运行", to: "/agent-run" },
  { id: "nav:/mcp", group: "页面", label: "MCP 服务器", hint: "运行", to: "/mcp" },
  { id: "nav:/autonomy-runs", group: "页面", label: "自治记录", hint: "运行", to: "/autonomy-runs" },
  { id: "nav:/settings", group: "页面", label: "设置", hint: "系统", to: "/settings" }
];

const PROJECT_STATUS_LABEL: Record<string, string> = { active: "启用中", archived: "已归档" };

/** 把 store 里已加载的实体摊平成条目，顺序即分组的先后。 */
export function buildDataEntries(sources: PaletteSources): PaletteEntry[] {
  return [
    ...sources.projects.map((project) => ({
      id: `project:${project.id}`,
      group: "项目",
      label: project.name,
      hint: PROJECT_STATUS_LABEL[project.status] ?? project.status,
      to: `/projects/${project.id}`
    })),
    ...sources.requirements.map((requirement) => ({
      id: `requirement:${requirement.id}`,
      group: "需求",
      label: requirement.title,
      hint: `v${requirement.version}`,
      to: "/requirements"
    })),
    ...sources.workflows.map((workflow) => ({
      id: `workflow:${workflow.id}`,
      group: "工作流",
      label: workflow.requirementName ?? workflow.id,
      hint: workflow.projectName ?? workflow.status,
      to: `/workflows/${workflow.id}`
    })),
    ...sources.deployments.map((deployment) => ({
      id: `deployment:${deployment.id}`,
      group: "部署",
      label: `${deployment.environment} · ${deployment.version}`,
      hint: deployment.status,
      to: `/deployments/${deployment.id}`
    })),
    ...sources.agents.map((agent) => ({
      id: `agent:${agent.name}`,
      group: "Agent",
      label: agent.name,
      hint: agent.type,
      to: "/agents"
    })),
    ...sources.mcpServers.map((server) => ({
      id: `mcp:${server.id}`,
      group: "MCP 服务器",
      label: server.name,
      hint: server.transport,
      to: `/mcp/${server.id}`
    }))
  ];
}

export const PREVIEW_PER_GROUP = 5;
export const MAX_RESULTS = 60;

/**
 * 过滤。`dataEntries` 只传数据条目（页面入口由本模块统一在前面补上）。
 *
 * 空查询时返回「全部页面 + 每个数据分组的前 N 条」——避免一屏塞满整库，
 * 同时保证页面入口永远可见；有查询时在「页面 + 全部数据」上做子串匹配。
 */
export function filterEntries(
  dataEntries: PaletteEntry[],
  query: string,
  options: { previewPerGroup?: number; maxResults?: number } = {}
): PaletteEntry[] {
  const previewPerGroup = options.previewPerGroup ?? PREVIEW_PER_GROUP;
  const maxResults = options.maxResults ?? MAX_RESULTS;

  const needle = query.trim().toLowerCase();
  if (needle) {
    return [...NAV_ENTRIES, ...dataEntries]
      .filter((entry) =>
        `${entry.label} ${entry.hint} ${entry.group}`.toLowerCase().includes(needle)
      )
      .slice(0, maxResults);
  }

  const used = new Map<string, number>();
  const preview = dataEntries.filter((entry) => {
    const seen = used.get(entry.group) ?? 0;
    if (seen >= previewPerGroup) return false;
    used.set(entry.group, seen + 1);
    return true;
  });
  return [...NAV_ENTRIES, ...preview];
}

/** 连续同类项合成一段，供渲染分组标题；顺序保持不变，因此下标可直接用于键盘遍历。 */
export function groupEntries(entries: PaletteEntry[]): { group: string; entries: PaletteEntry[] }[] {
  const groups: { group: string; entries: PaletteEntry[] }[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.group === entry.group) last.entries.push(entry);
    else groups.push({ group: entry.group, entries: [entry] });
  }
  return groups;
}
