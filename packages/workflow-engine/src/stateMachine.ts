import { TaskStatus, WorkflowStatus } from "@ai-se/shared";

const WORKFLOW_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  PENDING: ["RUNNING", "CANCELLED"],
  RUNNING: ["PAUSED", "WAITING_APPROVAL", "SUCCESS", "FAILED", "CANCELLED"],
  PAUSED: ["RUNNING", "CANCELLED"],
  WAITING_APPROVAL: ["RUNNING", "PAUSED", "FAILED", "CANCELLED"],
  SUCCESS: [],
  // 唯一用途 = WorkflowEngine.retry(人工重试出口);start()/resume() 已显式收紧,不能走这条边。
  FAILED: ["RUNNING"],
  CANCELLED: []
};

const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ["READY", "WAITING_APPROVAL", "BLOCKED", "CANCELLED"],
  READY: ["RUNNING", "WAITING_APPROVAL", "CANCELLED"],
  // RUNNING -> RETRYING 是**崩溃恢复**边：进程在任务执行中死掉后，恢复路径把它重新排队。
  // N-37：恢复必须消耗重试预算（`recoverRunningTasks` 同时 `retry_count + 1`）。
  // 预算耗尽时 RUNNING/RETRYING -> FAILED（硬停，禁止每次进程重启无限重跑同一 Diagnose）。
  RUNNING: ["SUCCESS", "FAILED", "CANCELLED", "RETRYING"],
  WAITING_APPROVAL: ["READY", "FAILED", "CANCELLED"],
  SUCCESS: [],
  FAILED: ["RETRYING"],
  RETRYING: ["READY", "WAITING_APPROVAL", "BLOCKED", "CANCELLED", "FAILED"],
  // 新增 PENDING:BLOCKED 是派生态,重试时重置后由调度器重算(幂等)。
  BLOCKED: ["CANCELLED", "PENDING"],
  CANCELLED: []
};

export function canTransitionWorkflow(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertWorkflowTransition(from: WorkflowStatus, to: WorkflowStatus): void {
  if (!canTransitionWorkflow(from, to)) {
    throw new Error(`Invalid workflow transition: ${from} -> ${to}`);
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}
