/**
 * 可访问性扫描共用的「目标解析」模块（被 a11y.mjs 与 a11yTree.mjs 同时导入）。
 *
 * 为什么单独成一个模块：两个脚本都需要同一份「路由清单 + 真实数据 id 发现」逻辑。
 * 各写一份的话，下次接口形状一变就会只改一处，另一处悄悄停在旧形状上还「看起来能跑」。
 * 本模块**只导出函数与常量**，导入时不产生任何副作用（不建连接、不读文件、不打印）。
 *
 * 「真实数据 id 发现」的三条纪律：
 *   · 只发只读 GET（`/api/projects`、`/api/workflows`、`/api/deployments`）—— 这是用户的真实数据，
 *     任何写操作都会污染它，扫描脚本永远不该有副作用；
 *   · 响应信封不统一（`{items}` / `{data}` / 裸数组都出现过），三种形状都要认（见 `unwrapList`）；
 *   · 发现失败**不抛错**：回退占位符并把该路由标成 `real: false`，让上层如实标注
 *     「placeholder (未见真实数据)」，而不是假装扫过了一个数据态。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** 至少这么多条路由，低于它说明路由正则失效（防「空扫描 = 永远通过」）。 */
export const MIN_ROUTES = 10;

/** 后端默认地址（与 apps/web 的 `VITE_API_BASE_URL` 缺省一致）。 */
export const DEFAULT_API_URL = "http://localhost:3000";

/** 真实 id 拿不到时用的占位样本（与历史 a11y.mjs 保持逐字一致）。 */
export const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";
export const PLACEHOLDER_SERVER = "demo-server";

/**
 * 承载真实数据 id 的参数化路由。`/mcp/:serverId` 目前**必然**落在占位符上
 * （`/api/mcp/servers` 返回 0 条），但保留在清单里是为了让「无数据」这件事被报告出来，
 * 而不是从扫描范围里消失。
 */
export const PARAM_ROUTES = [
  "/projects/:id",
  "/workflows/:id",
  "/deployments/:id",
  "/mcp/:serverId",
  "/mcp/:serverId/app"
];

/** 把路由里的参数替换成占位样本（历史行为，保持不变）。 */
export const substitutePlaceholders = (path) =>
  path
    .replace("/mcp/:serverId/app", `/mcp/${PLACEHOLDER_SERVER}/app`)
    .replace("/mcp/:serverId", `/mcp/${PLACEHOLDER_SERVER}`)
    .replace(/:id/g, PLACEHOLDER_ID);

/**
 * 从 `src/router/index.ts` 反向提取路由清单（不手抄）。
 * 同时断言「至少扫到 N 条」，防止正则失效导致「空扫描 = 永远通过」。
 */
export const readRoutes = () => {
  const source = readFileSync(resolve(here, "../src/router/index.ts"), "utf8");
  const paths = [...source.matchAll(/^\s*path:\s*"([^"]+)"/gm)].map((match) => match[1]);
  const unique = [...new Set(paths)];
  if (unique.length < MIN_ROUTES) {
    throw new Error(
      `只从 router/index.ts 提取到 ${unique.length} 条路由（期望 >= ${MIN_ROUTES}）。` +
        "路由文件结构可能变了，先修本脚本的正则，不要放行空扫描。"
    );
  }
  return unique.map((path) => ({ path, concrete: substitutePlaceholders(path) }));
};

/**
 * 三种响应信封都认：裸数组 / `{items}` / `{data}`（以及 `{data:{items}}`）。
 * 认不出就返回空数组 —— 上层据此回退占位符，绝不 crash。
 */
export const unwrapList = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.data?.items)) return payload.data.items;
  return [];
};

/** 只读 GET + JSON 解析 + 超时（`AbortController`，防后端半死不活时把脚本挂住）。 */
export const apiGet = async (apiUrl, path, { fetchImpl = fetch, timeoutMs = 8000 } = {}) => {
  const base = (apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}${path}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 发现参数化路由要用的真实 id。**永不抛错**：任一端点失败或形状不对，就把该路由留在占位符上，
 * 并把原因写进 `notes` 供上层报告。
 *
 * 返回：
 *   · `ok`      —— 三个真实 id（项目 / 工作流 / 部署）是否都拿到了；
 *   · `targets` —— 路由模式 → `{ concrete, real, source }`；
 *   · `ids`     —— 具名 id（可能为 null）；
 *   · `notes`   —— 人类可读的失败/回退说明。
 */
export const discoverTargets = async ({ apiUrl, fetchImpl = fetch, timeoutMs = 8000 } = {}) => {
  const base = apiUrl ?? DEFAULT_API_URL;
  const notes = [];
  const targets = {};
  for (const route of PARAM_ROUTES) {
    targets[route] = { concrete: substitutePlaceholders(route), real: false, source: "占位符" };
  }
  // MCP 的占位是「已知无数据」，与「发现失败」区分开，别让它看起来像一次真实扫描。
  const mcpSource = "无真实数据（/api/mcp/servers 返回 0 条）→ 占位符 demo-server";
  targets["/mcp/:serverId"].source = mcpSource;
  targets["/mcp/:serverId/app"].source = mcpSource;

  const ids = { project: null, workflow: null, deployment: null };
  let workflowIsApproval = false;

  try {
    const projects = unwrapList(
      await apiGet(base, "/api/projects?pageSize=1", { fetchImpl, timeoutMs })
    );
    const project = projects.find((item) => item && typeof item.id === "string");
    if (project) {
      ids.project = project.id;
      targets["/projects/:id"] = {
        concrete: `/projects/${project.id}`,
        real: true,
        source: `/api/projects?pageSize=1 → ${project.id}`
      };
    } else {
      notes.push("/api/projects 未返回可用 id");
    }
  } catch (error) {
    notes.push(`/api/projects 发现失败：${error.message}`);
  }

  try {
    const workflows = unwrapList(
      await apiGet(base, "/api/workflows?pageSize=200", { fetchImpl, timeoutMs })
    );
    // 优先 WAITING_APPROVAL：它同时渲染任务、审批卡与「拒绝」确认框的触发器，markup 最丰富。
    const approval = workflows.find((item) => item && item.status === "WAITING_APPROVAL");
    const chosen = approval ?? workflows.find((item) => item && typeof item.id === "string");
    if (chosen) {
      ids.workflow = chosen.id;
      workflowIsApproval = Boolean(approval);
      targets["/workflows/:id"] = {
        concrete: `/workflows/${chosen.id}`,
        real: true,
        source: `/api/workflows?pageSize=200 → ${chosen.id}${
          approval
            ? "（WAITING_APPROVAL，含审批与拒绝确认框）"
            : "（无 WAITING_APPROVAL，回退取首个）"
        }`
      };
    } else {
      notes.push("/api/workflows 未返回可用 id");
    }
  } catch (error) {
    notes.push(`/api/workflows 发现失败：${error.message}`);
  }

  try {
    const deployments = unwrapList(
      await apiGet(base, "/api/deployments?pageSize=1", { fetchImpl, timeoutMs })
    );
    const deployment = deployments.find((item) => item && typeof item.id === "string");
    if (deployment) {
      ids.deployment = deployment.id;
      targets["/deployments/:id"] = {
        concrete: `/deployments/${deployment.id}`,
        real: true,
        source: `/api/deployments?pageSize=1 → ${deployment.id}`
      };
    } else {
      notes.push("/api/deployments 未返回可用 id");
    }
  } catch (error) {
    notes.push(`/api/deployments 发现失败：${error.message}`);
  }

  const ok = Boolean(ids.project && ids.workflow && ids.deployment);
  return { ok, base, targets, ids, workflowIsApproval, notes };
};

/** 把发现结果渲染成表头行（两个脚本共用，保证同一份事实、同一份措辞）。 */
export const targetHeaderLines = (discovery) => {
  const lines = ["# 真实数据 id 发现："];
  for (const route of PARAM_ROUTES) {
    const target = discovery.targets[route];
    const tag = target.real ? "真实数据" : "placeholder (未见真实数据)";
    lines.push(`#   ${route.padEnd(22)} ← ${target.source} ［${tag}］`);
  }
  for (const note of discovery.notes) lines.push(`#   ⚠ ${note}`);
  return lines;
};
