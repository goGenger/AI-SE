import { describe, expect, it } from "vitest";
import { formatRate, metricCards } from "../viewmodels/agentRegistryViewModel";

describe("agent registry view model", () => {
  it("formats real metric values and empty states", () => {
    expect(formatRate(0.875)).toBe("88%");
    expect(formatRate()).toBe("暂无数据");
    expect(metricCards({ agentSuccessRate: 1 })).toHaveLength(6);
  });
});
