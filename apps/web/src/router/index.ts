import { createRouter, createWebHistory } from "vue-router";

declare module "vue-router" {
  interface RouteMeta {
    /** 所属导航分组，顶栏据此显示当前区域。 */
    group?: string;
    /** 没有分组的页面（仪表盘）用它作为顶栏标签。 */
    title?: string;
  }
}

/**
 * 路由级代码分割（W11）：13 条路由原先全部静态 import，整站打进同一个 569 kB 的 chunk
 * （build 一直警告 > 500 kB）。改为动态 import 后每个页面各自成块，首屏只下载仪表盘那一个。
 *
 * 两点说明：
 *   · `WorkflowsView` 与 `DeploymentsView` 各被两条路由引用，动态 import 同一个说明符
 *     由 Vite 自动去重成一个共享块 —— 不需要手工起名或抽公共 chunk。
 *   · 懒加载会改变首屏渲染时序（多一次网络往返），因此改完后**必须重新走一遍浏览器走查**，
 *     重点看深链接（如 `/workflows/:id`）是否仍能直接落在详情上。
 */
const routes = [
  {
    path: "/",
    name: "dashboard",
    component: () => import("../views/DashboardView.vue"),
    meta: { title: "仪表盘" }
  },
  {
    path: "/projects",
    name: "projects",
    component: () => import("../views/ProjectsView.vue"),
    meta: { group: "构建" }
  },
  {
    path: "/projects/:id",
    name: "project-detail",
    component: () => import("../views/ProjectDetailView.vue"),
    meta: { group: "构建" }
  },
  {
    path: "/requirements",
    name: "requirements",
    component: () => import("../views/RequirementsView.vue"),
    meta: { group: "构建" }
  },
  {
    path: "/workflows",
    name: "workflows",
    component: () => import("../views/WorkflowsView.vue"),
    meta: { group: "构建" }
  },
  {
    path: "/workflows/:id",
    name: "workflow-detail",
    component: () => import("../views/WorkflowsView.vue"),
    meta: { group: "构建" }
  },
  {
    path: "/deployments",
    name: "deployments",
    component: () => import("../views/DeploymentsView.vue"),
    meta: { group: "构建" }
  },
  {
    path: "/deployments/:id",
    name: "deployment-detail",
    component: () => import("../views/DeploymentsView.vue"),
    meta: { group: "构建" }
  },
  {
    path: "/agents",
    name: "agents",
    component: () => import("../views/AgentsView.vue"),
    meta: { group: "运行" }
  },
  {
    path: "/agent-run",
    name: "agent-run",
    component: () => import("../views/AgentRunView.vue"),
    meta: { group: "运行" }
  },
  {
    path: "/mcp",
    name: "mcp-servers",
    component: () => import("../views/MCPServersView.vue"),
    meta: { group: "运行" }
  },
  {
    path: "/mcp/:serverId",
    name: "mcp-server-detail",
    component: () => import("../views/MCPServerDetailView.vue"),
    meta: { group: "运行" }
  },
  {
    path: "/mcp/:serverId/app",
    name: "mcp-app",
    component: () => import("../views/MCPAppView.vue"),
    meta: { group: "运行" }
  },
  {
    path: "/incidents",
    name: "incidents",
    component: () => import("../views/IncidentsView.vue"),
    meta: { group: "运行" }
  },
  {
    path: "/incidents/:id",
    name: "incident-detail",
    component: () => import("../views/IncidentsView.vue"),
    meta: { group: "运行" }
  },
  {
    path: "/autonomy-runs",
    name: "autonomy-runs",
    component: () => import("../views/AutonomyRunsView.vue"),
    meta: { group: "运行" }
  },
  {
    path: "/autonomy-runs/:id",
    name: "autonomy-run-detail",
    component: () => import("../views/AutonomyRunsView.vue"),
    meta: { group: "运行" }
  },
  {
    path: "/settings",
    name: "settings",
    component: () => import("../views/SettingsView.vue"),
    meta: { group: "系统" }
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

export default router;
