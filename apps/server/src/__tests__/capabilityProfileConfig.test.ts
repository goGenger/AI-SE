import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";

/**
 * `docs/235` §6.5 补步：**能力 profile 的选择**。
 *
 * 1. 缺省是 `frontend-vue`（产品默认：不做后端开发任务；2026-11-04 起）；
 * 2. 能显式选回 `backend-node`（遗留 E1）；
 * 3. **未知 id 启动即失败**——静默退回默认会让一整批读数被记到错误的口径下，且事后无法分辨。
 */
const base = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

describe("CAPABILITY_PROFILE（docs/235 §6.5）", () => {
  it("缺省是 frontend-vue，且 BACKEND / DATABASE 不在可规划面", () => {
    const profile = loadConfig(base).capabilityProfile;
    expect(profile.id).toBe("frontend-vue");
    expect(profile.taskTypes.plannable).not.toContain("BACKEND");
    expect(profile.taskTypes.plannable).not.toContain("DATABASE");
    expect(profile.taskTypes.fixFallback).toBe("FRONTEND");
  });

  it("可以显式选回 backend-node（遗留 E1）", () => {
    const config = loadConfig({ ...base, CAPABILITY_PROFILE: "backend-node" });
    expect(config.capabilityProfile.id).toBe("backend-node");
    expect(config.capabilityProfile.taskTypes.plannable).toContain("BACKEND");
    expect(config.capabilityProfile.taskTypes.fixFallback).toBe("BACKEND");
  });

  it("可以选中 frontend-vue", () => {
    const config = loadConfig({ ...base, CAPABILITY_PROFILE: "frontend-vue" });
    expect(config.capabilityProfile.id).toBe("frontend-vue");
    expect(config.capabilityProfile.taskTypes.fixFallback).toBe("FRONTEND");
    expect(config.capabilityProfile.boundaryCheck).toBe("ui");
  });

  it("未知 id 抛错，且错误里点名了已知的 profile（fail-closed，不静默退回默认）", () => {
    expect(() => loadConfig({ ...base, CAPABILITY_PROFILE: "backend-java" })).toThrow(
      /Unknown capability profile "backend-java"/
    );
    expect(() => loadConfig({ ...base, CAPABILITY_PROFILE: "backend-java" })).toThrow(
      /backend-node/
    );
  });
});
