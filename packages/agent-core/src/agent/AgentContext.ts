import { Sandbox } from "@ai-se/sandbox";
import { Logger } from "pino";

export interface AgentContext {
  requestId: string;
  projectId?: string;
  /** 7-A：所属工作流运行；经 ToolRuntimeBackend 透传到工具审计与日志。 */
  workflowRunId?: string;
  taskId: string;
  agentRunId: string;
  actor: string;
  workspacePath: string;
  sandbox: Sandbox;
  /**
   * `docs/236` §4.2 / 第 4 步：本次运行**允许**装依赖出网。
   *
   * 由平台按 capability profile 的 `boundaryCheck`/能力面决定（`apps/server` 在装配运行时
   * 注入），agent 侧没有任何入口能设置它。缺省 `false` ⇒ 既有调用方零行为变化。
   *
   * 它是**能力上限**而非开关：置真时工具层也只对 `install` 类命令传 `registry`，
   * build / test / 任意 shell 仍无网（`docs/239`）。
   */
  dependencyInstallAllowed?: boolean;
  logger?: Logger;
  metadata?: Record<string, unknown>;
}
