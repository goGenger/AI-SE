import { describe, expect, it } from "vitest";
import {
  isEscalatablePlanningFailure,
  parsePlanningEscalationReason,
  parsePlanningSplitReason,
  planningEscalationReason,
  planningSplitReason
} from "../services/planningService";

/**
 * F1-3 / F1-4：需求级审批的 reason 前缀路由契约（单测）。
 * 前缀即路由：`[planning-escalation:<sliceKey>]`（升级重试）/ `[planning-split:<sliceKey>|<deploySliceKey>]`（拆分）。
 */
describe("规划审批 reason 契约（F1-3 / F1-4）", () => {
  it("升级 reason 往返：格式化为切片重试契约；非前缀/空切片拒绝", () => {
    const reason = planningEscalationReason("SLICE-2");
    expect(reason.startsWith("[planning-escalation:SLICE-2]")).toBe(true);
    expect(parsePlanningEscalationReason(reason)).toEqual({ sliceKey: "SLICE-2" });

    expect(
      parsePlanningEscalationReason("Slice plan requires human confirmation (gate 1)")
    ).toBeNull();
    expect(parsePlanningEscalationReason("[planning-escalation:] no key")).toBeNull();
    expect(parsePlanningEscalationReason("[planning-escalation:SLICE-2 missing close")).toBeNull();
  });

  it("拆分 reason 往返：携带两段切片键；缺段/错前缀拒绝", () => {
    const reason = planningSplitReason("SLICE-5", "SLICE-5-deploy");
    expect(reason.startsWith("[planning-split:SLICE-5|SLICE-5-deploy]")).toBe(true);
    expect(parsePlanningSplitReason(reason)).toEqual({
      sliceKey: "SLICE-5",
      deploySliceKey: "SLICE-5-deploy"
    });

    expect(parsePlanningSplitReason("[planning-escalation:SLICE-5] retry")).toBeNull();
    expect(parsePlanningSplitReason("[planning-split:SLICE-5] missing deploy key")).toBeNull();
    expect(parsePlanningSplitReason("[planning-split:|SLICE-5-deploy] empty key")).toBeNull();
  });

  /**
   * N-51（`docs/232` §9.20 F1）：升级重试的门槛从「只认 VALIDATION_ERROR」放开到超时。
   * 超时是瞬态的，校验失败恰恰最不瞬态；旧口径让瞬态失败成了唯一不重试的一类。
   */
  it("N-51：超时与校验失败可升级重试", () => {
    expect(isEscalatablePlanningFailure("VALIDATION_ERROR")).toBe(true);
    expect(isEscalatablePlanningFailure("TIMEOUT_ERROR")).toBe(true);
    expect(isEscalatablePlanningFailure("PLANNING_ERROR")).toBe(false);
    expect(isEscalatablePlanningFailure("CANCELLED_ERROR")).toBe(false);
  });

  /**
   * N-69（`docs/232` §10）：**解析形态的 `PLANNING_ERROR` 也要重试**。
   *
   * 第九次回归实测：slice-2 的模型三次采样全部吐坏 JSON（`{"requirements:[{"`），切片直接终态失败、
   * 整轮掐死。解析失败是采样级偶发，与超时同类；但 `PLANNING_ERROR` 还包含非解析类失败，
   * 所以只按消息放开这一种形态。
   */
  it("N-69：解析失败的 PLANNING_ERROR 可升级，其它 PLANNING_ERROR 仍终态", () => {
    expect(
      isEscalatablePlanningFailure(
        "PLANNING_ERROR",
        'Failed to parse. Text: "{"requirements:[{""'
      )
    ).toBe(true);
    expect(
      isEscalatablePlanningFailure("PLANNING_ERROR", "OUTPUT_PARSING_FAILURE: could not parse JSON")
    ).toBe(true);
    // 非解析类：provider 拒绝、权限、未知异常都保持终态，不进重试循环。
    expect(
      isEscalatablePlanningFailure("PLANNING_ERROR", "400 This response_format type is unavailable")
    ).toBe(false);
    expect(isEscalatablePlanningFailure("PLANNING_ERROR", "")).toBe(false);
  });

  it("N-51：升级 reason 带上错误码，便于批次账本区分超时与校验失败", () => {
    const reason = planningEscalationReason("SLICE-4", "TIMEOUT_ERROR");
    expect(reason).toContain("(TIMEOUT_ERROR)");
    expect(parsePlanningEscalationReason(reason)).toEqual({ sliceKey: "SLICE-4" });
  });


  it("embeds a clipped failure detail while keeping the escalation prefix parseable", () => {
    const reason = planningEscalationReason(
      "slice-01-app-shell",
      "PLANNING_ERROR",
      'Failed to parse. Text: {"pages":[{"additionalElements":[]}]} Unrecognized key'
    );
    expect(parsePlanningEscalationReason(reason)).toEqual({ sliceKey: "slice-01-app-shell" });
    expect(reason).toContain("Detail:");
    expect(reason.length).toBeLessThanOrEqual(500);
  });
});
