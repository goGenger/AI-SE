import { describe, expect, it } from "vitest";
import {
  evidenceSourceKindLabel,
  faultTypeLabel,
  formatIncidentDateTime,
  incidentLabelChips,
  incidentSeverityLabel,
  incidentSeverityTone,
  incidentStatusLabel,
  incidentStatusTone,
  recommendedActionLabel,
  remediationDecisionLabel,
  yesNoLabel
} from "../viewmodels/incidentViewModel";

describe("incident view model", () => {
  it("maps known status / severity to Chinese and keeps unknowns", () => {
    expect(incidentStatusLabel("open")).toBe("开启");
    expect(incidentStatusLabel("diagnosing")).toBe("诊断中");
    expect(incidentStatusLabel("mitigating")).toBe("修复中");
    expect(incidentStatusLabel("resolved")).toBe("已解决");
    expect(incidentStatusLabel("cancelled")).toBe("已取消");
    expect(incidentStatusLabel("weird_status")).toBe("weird_status");

    expect(incidentSeverityLabel("critical")).toBe("严重");
    expect(incidentSeverityLabel("info")).toBe("信息");
    expect(incidentSeverityLabel("purple")).toBe("purple");
  });

  it("maps status / severity to StatusBadge tones", () => {
    expect(incidentStatusTone("open")).toBe("error");
    expect(incidentStatusTone("diagnosing")).toBe("warning");
    expect(incidentStatusTone("resolved")).toBe("success");
    expect(incidentStatusTone("cancelled")).toBe("neutral");
    expect(incidentStatusTone("unknown")).toBe("neutral");

    expect(incidentSeverityTone("critical")).toBe("error");
    expect(incidentSeverityTone("medium")).toBe("warning");
    expect(incidentSeverityTone("info")).toBe("neutral");
  });

  it("maps remediation / fault / evidence / action enums", () => {
    expect(remediationDecisionLabel("OPENED_STAGING_FIX_WORKFLOW")).toBe(
      "已开预发修复工作流"
    );
    expect(remediationDecisionLabel("NOTIFY_ONLY")).toBe("仅通知");
    expect(remediationDecisionLabel("OTHER")).toBe("OTHER");

    expect(faultTypeLabel("staging_verify_flaky")).toBe("预发验证不稳定");
    expect(faultTypeLabel("arbitrary")).toBe("arbitrary");

    expect(evidenceSourceKindLabel("workflow_trace")).toBe("工作流轨迹");
    expect(evidenceSourceKindLabel("mystery")).toBe("mystery");

    expect(recommendedActionLabel("await_human_review_then_propose_staging_fix")).toBe(
      "人工复核后提出预发修复"
    );
    expect(recommendedActionLabel("collect_more_telemetry_then_rediagnose")).toBe(
      "补充遥测后重新诊断"
    );
    expect(recommendedActionLabel("custom_slug")).toBe("custom_slug");
  });

  it("builds label chips with Chinese keys for known fault types", () => {
    expect(
      incidentLabelChips({ faultType: "ci_release_missing", service: "api" })
    ).toEqual([
      {
        key: "faultType",
        keyLabel: "故障类型",
        value: "ci_release_missing",
        valueLabel: "CI 发布缺失"
      },
      {
        key: "service",
        keyLabel: "服务",
        value: "api",
        valueLabel: "api"
      }
    ]);
  });

  it("formats dates in zh-CN and yes/no", () => {
    expect(yesNoLabel(true)).toBe("是");
    expect(yesNoLabel(false)).toBe("否");
    expect(formatIncidentDateTime(undefined)).toBe("-");
    expect(formatIncidentDateTime("not-a-date")).toBe("not-a-date");
    const formatted = formatIncidentDateTime("2026-11-05T13:00:00.000Z");
    expect(formatted).not.toBe("-");
    expect(formatted).not.toMatch(/T/);
  });
});
