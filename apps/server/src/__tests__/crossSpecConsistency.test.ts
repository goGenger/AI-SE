import { describe, expect, it } from "vitest";
import { checkCrossSpecConsistency } from "../services/crossSpecConsistency";

/** G2（GX-07 / FG7）：跨规格一致性检查单测（确定性、零 LLM）。 */

const API_SPEC = {
  endpoints: [
    { method: "GET", path: "/api/todos" },
    { method: "POST", path: "/api/todos" },
    { method: "GET", path: "/api/todos/{id}" },
    { method: "PATCH", path: "/api/todos/{id}" }
  ]
};

describe("checkCrossSpecConsistency（G2/GX-07）", () => {
  it("路径与表均一致 → 零发现", () => {
    const result = checkCrossSpecConsistency({
      apiSpec: API_SPEC,
      databaseSpec: { tables: [{ name: "todos" }, { name: "users" }] },
      tasks: [
        {
          title: "实现 GET /api/todos 列表端点",
          description: "读取 todos 表并返回列表。",
          acceptanceCriteria: ["GET /api/todos 返回 200"]
        },
        {
          title: "实现 PATCH /api/todos/{id} 校验",
          description: "users 表仅作引用校验。"
        }
      ]
    });
    expect(result.findings).toEqual([]);
    expect(result.checked.apiPaths).toBe(2);
    expect(result.checked.tables).toBe(2);
  });

  it("{param} 容差：具体 id 路径匹配规格模板（不误报）", () => {
    const result = checkCrossSpecConsistency({
      apiSpec: API_SPEC,
      databaseSpec: { tables: [{ name: "todos" }] },
      tasks: [{ title: "GET /api/todos/42 返回单条", description: "todos 表查询。" }]
    });
    expect(result.findings).toEqual([]);
  });

  it("任务引用的 API 路径不在规格中 → API_PATH_NOT_IN_SPEC", () => {
    const result = checkCrossSpecConsistency({
      apiSpec: API_SPEC,
      databaseSpec: { tables: [] },
      tasks: [{ title: "实现 GET /api/unknown/list", description: "无对应端点。" }]
    });
    expect(result.findings).toEqual([
      { code: "API_PATH_NOT_IN_SPEC", detail: "/api/unknown/list" }
    ]);
  });

  it("规格表未被任何任务使用 → TABLE_UNUSED_BY_TASKS", () => {
    const result = checkCrossSpecConsistency({
      apiSpec: API_SPEC,
      databaseSpec: { tables: [{ name: "todos" }, { name: "audit_log" }] },
      tasks: [{ title: "GET /api/todos", description: "todos 表。" }]
    });
    expect(result.findings).toEqual([{ code: "TABLE_UNUSED_BY_TASKS", detail: "audit_log" }]);
  });

  it("非 API 前缀路径候选被忽略（文件路径不误报）；空规格零发现", () => {
    const result = checkCrossSpecConsistency({
      apiSpec: API_SPEC,
      databaseSpec: { tables: [] },
      tasks: [{ title: "整理 /tmp/workspace 目录", description: "路径 /usr/local/bin 说明。" }]
    });
    expect(result.findings).toEqual([]);
    expect(result.checked.apiPaths).toBe(0);

    const empty = checkCrossSpecConsistency({ tasks: [] });
    expect(empty.findings).toEqual([]);
    expect(empty.checked).toEqual({ apiPaths: 0, tables: 0 });
  });
});
