import { sanitizeLogData } from "@ai-se/observability";
import { JsonObject, Task, WorkflowRun } from "@ai-se/shared";
import { TaskExecutionResult, WorkflowTaskExecutor } from "@ai-se/workflow-engine";

/**
 * D-3（T8-c）：任务结果出口脱敏（tasks.output 缺口）。
 *
 * 引擎把 executor 返回的 output 原样落库（`WorkflowEngine.persistTaskResult`），
 * 本装饰器在 server 侧出口统一过共享 sink（敏感键名 + 凭证形态串），引擎语义不变。
 */
export class RedactingWorkflowTaskExecutor implements WorkflowTaskExecutor {
  constructor(private readonly inner: WorkflowTaskExecutor) {}

  async execute(workflow: WorkflowRun, task: Task): Promise<TaskExecutionResult> {
    const result = await this.inner.execute(workflow, task);
    if (!result.output) return result;
    return { ...result, output: sanitizeLogData(result.output) as JsonObject };
  }

  cancel(task: Task): Promise<void> {
    return this.inner.cancel(task);
  }
}
