/**
 * G2（GX-06/07）：确定性跨规格一致性检查（零 LLM、零依赖）。
 *
 * 规则：
 * - API 路径归属：任务文本中「落在 API 规格前缀下」的路径必须匹配某条已声明端点
 *   （逐段比较；规格端点的 {param} 段可匹配任意单段）；
 * - 表使用面：数据库规格中的每张表必须被至少一个任务文本提及。
 *
 * 产出为「发现列表」（非阻断；由调用方记录事件）。
 */

export interface CrossSpecFinding {
  code: "API_PATH_NOT_IN_SPEC" | "TABLE_UNUSED_BY_TASKS";
  detail: string;
}

export interface CrossSpecConsistencyInput {
  apiSpec?: { endpoints: { method: string; path: string }[] } | null;
  databaseSpec?: { tables: { name: string }[] } | null;
  tasks: { title: string; description: string; acceptanceCriteria?: string[] }[];
}

export interface CrossSpecConsistencyResult {
  findings: CrossSpecFinding[];
  checked: { apiPaths: number; tables: number };
}

/** 任务文本中的路径候选：以 / 开头、由路径段组成（不含空白与常见分隔符）。 */
const PATH_TOKEN = /\/[A-Za-z0-9_\-{}.]+(?:\/[A-Za-z0-9_\-{}.]+)*/g;

function taskText(input: CrossSpecConsistencyInput): string {
  return input.tasks
    .map((task) => [task.title, task.description, ...(task.acceptanceCriteria ?? [])].join("\n"))
    .join("\n");
}

function segments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/** 规格端点路径是否覆盖任务路径（逐段；{param} 段可匹配任意单段）。 */
function endpointCovers(taskPath: string, endpointPath: string): boolean {
  const task = segments(taskPath);
  const spec = segments(endpointPath);
  if (task.length !== spec.length) return false;
  return spec.every((segment, index) => {
    if (segment.startsWith("{") && segment.endsWith("}")) return true;
    return segment === task[index];
  });
}

export function checkCrossSpecConsistency(
  input: CrossSpecConsistencyInput
): CrossSpecConsistencyResult {
  const findings: CrossSpecFinding[] = [];
  const text = taskText(input);

  // API 路径归属：仅检查「落在规格前缀下」的候选（文件路径等不误报为 API 路径）。
  const endpoints = input.apiSpec?.endpoints ?? [];
  const prefixes = new Set(
    endpoints
      .map((endpoint) => segments(endpoint.path)[0])
      .filter((entry): entry is string => Boolean(entry))
  );
  const candidates = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN)) {
    const first = segments(match[0])[0];
    if (first && prefixes.has(first)) candidates.add(match[0]);
  }
  for (const token of [...candidates].sort()) {
    if (!endpoints.some((endpoint) => endpointCovers(token, endpoint.path))) {
      findings.push({ code: "API_PATH_NOT_IN_SPEC", detail: token });
    }
  }

  // 表使用面：每张规格表必须被至少一个任务文本提及。
  const tables = input.databaseSpec?.tables ?? [];
  for (const table of tables) {
    const escaped = table.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`\\b${escaped}\\b`, "i").test(text)) {
      findings.push({ code: "TABLE_UNUSED_BY_TASKS", detail: table.name });
    }
  }

  return { findings, checked: { apiPaths: candidates.size, tables: tables.length } };
}
