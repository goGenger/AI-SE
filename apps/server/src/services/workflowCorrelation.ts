import { PgWorkflowEventStore } from "@ai-se/database";
import { sanitizeLogData } from "@ai-se/observability";
import { randomUUID } from "node:crypto";
import { Logger } from "pino";

/** 7-A：把工作流运行关联回触发它的 HTTP 请求。 */
export type WorkflowRequestIdResolver = (workflowRunId: string) => Promise<string>;

/**
 * 7-A：requestId 以 `WORKFLOW_STARTED` 事件的 payload 为准（不改表结构）。
 *
 * 两种情况回落到新生成的 ID，行为与旧版一致：① 本改动之前启动的运行没有该字段；
 * ② 查询失败——关联信息属观测面，不得让任务因它失败（`docs/147` §7 红线）。
 */
export function createWorkflowRequestIdResolver(
  events: Pick<PgWorkflowEventStore, "findWorkflowStartedRequestId">,
  logger?: Logger
): WorkflowRequestIdResolver {
  return async (workflowRunId) => {
    try {
      return (await events.findWorkflowStartedRequestId(workflowRunId)) ?? randomUUID();
    } catch (error) {
      logger?.warn(
        sanitizeLogData({ error, workflowRunId }),
        "workflow request id lookup failed; falling back to a new id"
      );
      return randomUUID();
    }
  };
}
