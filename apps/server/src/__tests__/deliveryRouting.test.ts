import { createLogger } from "@ai-se/observability";
import { Task } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { DeploymentOrchestrator } from "../services/deploymentOrchestrator";

/**
 * N-31（`docs/215`）：**`VERIFY` 挂在 `REVIEW` 上时，交付编排必须仍然接手。**
 *
 * 实测现场（批次 `l1-m4s`，run 1 与 run 2 各一次）：最终切片规划出
 * `TP-12` = `type: "REVIEW"` + `input.delivery = { action: "VERIFY", environment: "staging" }`。
 * 旧的 `canHandle` 要求 `TEST` + `VERIFY` 才认，于是：
 *
 *   1. 返回 false ⇒ 任务交给职业 agent（查库确认执行者 runtime 是 `professional-deep-agent`）；
 *   2. 它做的是一次**代码评审**（原话「Reviewed the staging slice … without modifying any file」）；
 *   3. 任务自报 SUCCESS ⇒ 批次指标把 staging VERIFY 读成**成功**，而验证从未执行。
 *
 * 所以这里测的是**接线本身**，不是某个纯函数：`canHandle` 一旦退回按 `task.type` 分派，
 * 上面三步会原样复现，而任何只测别处的用例都不会红。
 */

function orchestrator(): DeploymentOrchestrator {
  return new DeploymentOrchestrator({
    deployments: {} as never,
    projects: {} as never,
    workflows: {} as never,
    agentRuns: {} as never,
    toolCalls: {} as never,
    requestId: (async () => undefined) as never,
    operations: {} as never,
    ciProvider: "local",
    sandbox: {} as never,
    logger: createLogger()
  });
}

function task(type: Task["type"], delivery?: Record<string, unknown>): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    taskKey: "TP-12",
    title: "Verify staging",
    description: "",
    type,
    status: "RUNNING",
    priority: "MEDIUM",
    input: delivery === undefined ? {} : { delivery },
    retryCount: 0,
    version: 1,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z"
  };
}

describe("DeploymentOrchestrator.canHandle（N-31）", () => {
  it("REVIEW + VERIFY/staging ⇒ 接手（现场的缺陷形状）", () => {
    expect(
      orchestrator().canHandle(
        task("REVIEW", { action: "VERIFY", environment: "staging" })
      )
    ).toBe(true);
  });

  it("既有配对行为不变：TEST+VERIFY / BUILD+CI / DEPLOY+DEPLOY", () => {
    const subject = orchestrator();
    expect(subject.canHandle(task("TEST", { action: "VERIFY", environment: "staging" }))).toBe(
      true
    );
    expect(subject.canHandle(task("BUILD", { action: "CI" }))).toBe(true);
    expect(subject.canHandle(task("DEPLOY", { action: "DEPLOY", environment: "staging" }))).toBe(
      true
    );
  });

  it("**类型不再参与判定**：同一交付块挂在任何类型上都由编排器接手", () => {
    const subject = orchestrator();
    for (const type of ["BACKEND", "FRONTEND", "DATABASE", "ANALYSIS", "DESIGN"] as const) {
      expect(subject.canHandle(task(type, { action: "VERIFY", environment: "staging" }))).toBe(
        true
      );
      expect(subject.canHandle(task(type, { action: "DEPLOY", environment: "staging" }))).toBe(
        true
      );
    }
  });

  it("没有交付块 ⇒ 不接手（仍走职业 agent，行为不变）", () => {
    const subject = orchestrator();
    expect(subject.canHandle(task("BUILD"))).toBe(false);
    expect(subject.canHandle(task("TEST"))).toBe(false);
    expect(subject.canHandle(task("REVIEW"))).toBe(false);
  });

  it("交付块不合法 ⇒ 不接手（宁可不认，也不猜）", () => {
    const subject = orchestrator();
    // 非 CI 动作必须带 environment（DeliveryTaskSchema 的 superRefine）。
    expect(subject.canHandle(task("REVIEW", { action: "VERIFY" }))).toBe(false);
    // action 不在枚举内。
    expect(subject.canHandle(task("REVIEW", { action: "NOTIFY", environment: "staging" }))).toBe(
      false
    );
    // 多余字段（schema 是 strict）。
    expect(
      subject.canHandle(task("REVIEW", { action: "VERIFY", environment: "staging", extra: 1 }))
    ).toBe(false);
  });
});
