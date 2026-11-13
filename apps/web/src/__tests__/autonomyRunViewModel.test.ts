import { describe, expect, it } from "vitest";
import type { AutonomyRunRecord } from "../api/autonomyRuns";
import {
  autonomyDiagnosisText,
  autonomyFailureLabel,
  autonomyListMeta,
  autonomyOutcomeLabel,
  autonomyOutcomeTone,
  autonomyRepairTaskLine,
  autonomyRoundLabel,
  autonomySliceRequirementLabel,
  autonomyTriggerReasonDistinct,
  autonomyWorkflowLinkLabel,
  filterAutonomyRuns,
  formatAutonomyDateTime
} from "../viewmodels/autonomyRunViewModel";

function run(partial: Partial<AutonomyRunRecord> = {}): AutonomyRunRecord {
  return {
    id: "wf:T-01",
    triggeredAt: "2026-11-06T01:43:00.000Z",
    projectId: "p1",
    projectName: "taskflow-vue",
    requirementId: "r1",
    requirementName: "TaskFlow",
    workflowId: "wf",
    workflowStatus: "FAILED",
    planningVersion: 8,
    sliceKey: "slice-task-crud",
    sourceTaskKey: "T-01",
    sourceTaskTitle: "骨架",
    sourceTaskType: "FRONTEND",
    sourceTaskId: "t1",
    triggerReason: "AGENT_TIMEOUT",
    failureClass: "AGENT_TIMEOUT",
    errorType: "AGENT_TIMEOUT",
    diagnosisSummary: "ok",
    repairTasks: [],
    round: 2,
    maxRetries: 2,
    outcome: "repaired",
    link: "/workflows/wf",
    ...partial
  };
}

describe("autonomyRunViewModel", () => {
  it("maps outcomes to Chinese labels and tones", () => {
    expect(autonomyOutcomeLabel("repaired")).toBe("已修复");
    expect(autonomyOutcomeLabel("exhausted")).toBe("已耗尽");
    expect(autonomyOutcomeLabel("in_progress")).toBe("修复中");
    expect(autonomyOutcomeLabel("failed")).toBe("失败");
    expect(autonomyOutcomeLabel("weird")).toBe("weird");

    expect(autonomyOutcomeTone("repaired")).toBe("success");
    expect(autonomyOutcomeTone("exhausted")).toBe("error");
    expect(autonomyOutcomeTone("in_progress")).toBe("warning");
    expect(autonomyOutcomeTone("unknown")).toBe("neutral");
  });

  it("reuses failure-class labels and builds list meta / round text", () => {
    expect(autonomyFailureLabel("AGENT_TIMEOUT")).toBe("Agent 超时");
    expect(autonomyFailureLabel("repair-exhausted")).toBe("修复轮次耗尽");
    expect(autonomyListMeta(run())).toBe("taskflow-vue · slice-task-crud");
    expect(autonomyListMeta(run())).not.toContain("T-01");
    expect(autonomyListMeta(run({ sliceKey: null }))).toBe("taskflow-vue · v8");
    expect(autonomyRoundLabel(run())).toBe("第 2 / 2 轮");
    expect(autonomyRoundLabel(run({ round: null }))).toBe("—");
  });

  it("formats dates and never shows [object Object] in diagnosis", () => {
    expect(formatAutonomyDateTime(undefined)).toBe("-");
    expect(formatAutonomyDateTime("not-a-date")).toBe("not-a-date");
    const formatted = formatAutonomyDateTime("2026-11-06T01:43:00.000Z");
    expect(formatted).not.toBe("-");
    expect(autonomyDiagnosisText({ a: 1 })).toBe('{"a":1}');
    expect(autonomyDiagnosisText("x [object Object] y")).toBe("x  y");
    expect(autonomyDiagnosisText(null)).toBe("—");
  });

  it("renders repair task lines without repeating taskKey", () => {
    expect(
      autonomyRepairTaskLine({
        taskKey: "T-02-DEBUG-1-REPLAN-2",
        type: "FRONTEND",
        status: "READY",
        fixTaskType: "FRONTEND",
        typeRetargeted: true
      })
    ).toBe("FRONTEND · READY · → FRONTEND · 类型已切换");
    expect(
      autonomyRepairTaskLine({
        taskKey: "T-02-DEBUG-1",
        type: "DEBUG",
        status: "SUCCESS"
      })
    ).toBe("DEBUG · SUCCESS");
  });

  it("builds readable workflow link labels and detects duplicate trigger reasons", () => {
    expect(autonomyWorkflowLinkLabel(run())).toBe("TaskFlow / slice-task-crud");
    expect(
      autonomyWorkflowLinkLabel(
        run({ requirementName: null, sliceKey: null, workflowId: "d30eeea0-abcd-1234" })
      )
    ).toBe("d30eeea0…");
    expect(autonomyTriggerReasonDistinct("timeout", "diagnosis essay")).toBe(true);
    expect(autonomyTriggerReasonDistinct("same", "same")).toBe(false);
    expect(autonomyTriggerReasonDistinct(null, "diagnosis")).toBe(false);
  });

  it("filters runs by project, workflow, and outcome", () => {
    const a = run({ id: "wf1:T-01", projectId: "p1", workflowId: "wf1", outcome: "repaired" });
    const b = run({
      id: "wf2:T-02",
      projectId: "p2",
      projectName: "other",
      workflowId: "wf2",
      outcome: "exhausted",
      sourceTaskKey: "T-02"
    });
    const c = run({
      id: "wf1:T-03",
      projectId: "p1",
      workflowId: "wf1",
      outcome: "failed",
      sourceTaskKey: "T-03"
    });
    const all = [a, b, c];

    expect(filterAutonomyRuns(all, {})).toEqual(all);
    expect(filterAutonomyRuns(all, { projectId: "p1" }).map((r) => r.id)).toEqual([
      "wf1:T-01",
      "wf1:T-03"
    ]);
    expect(filterAutonomyRuns(all, { workflowId: "wf2" }).map((r) => r.id)).toEqual(["wf2:T-02"]);
    expect(filterAutonomyRuns(all, { outcome: "failed" }).map((r) => r.id)).toEqual(["wf1:T-03"]);
    expect(
      filterAutonomyRuns(all, { projectId: "p1", outcome: "repaired" }).map((r) => r.id)
    ).toEqual(["wf1:T-01"]);
    expect(filterAutonomyRuns(all, { projectId: "   " })).toEqual(all);
  });

  it("builds slice/requirement table labels", () => {
    expect(autonomySliceRequirementLabel(run())).toBe("slice-task-crud · v8");
    expect(autonomySliceRequirementLabel(run({ sliceKey: null }))).toBe("TaskFlow · v8");
    expect(
      autonomySliceRequirementLabel(run({ sliceKey: null, requirementName: null }))
    ).toBe("— · v8");
  });
});
