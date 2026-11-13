import { describe, expect, it } from "vitest";
import {
  BACKEND_NODE_PROFILE,
  CAPABILITY_PROFILES,
  DEFAULT_CAPABILITY_PROFILE,
  FRONTEND_VUE_PROFILE
} from "./index";

/**
 * `docs/236` §10 第 4 步：出网能力由 capability profile 声明。
 *
 * 2026-11-04 起产品默认 = `frontend-vue`（registry）。`backend-node` 仍声明 `none`，
 * 仅在显式 `CAPABILITY_PROFILE=backend-node` 时生效。
 *
 * `dependencyNetwork` 是**能力上限**，不等于「这条命令有网」——按命令分类在工具层（`docs/239`）。
 */
describe("docs/236 第 4 步：出网能力由 capability profile 声明", () => {
  it("`frontend-vue` 允许 install 走 registry", () => {
    expect(FRONTEND_VUE_PROFILE.dependencyNetwork).toBe("registry");
  });

  it("`backend-node` 显式选中时仍是 none", () => {
    expect(BACKEND_NODE_PROFILE.dependencyNetwork).toBe("none");
  });

  it("产品默认 frontend-vue ⇒ 不配 CAPABILITY_PROFILE 时允许 registry", () => {
    expect(DEFAULT_CAPABILITY_PROFILE).toBe(FRONTEND_VUE_PROFILE);
    expect(DEFAULT_CAPABILITY_PROFILE.dependencyNetwork).toBe("registry");
  });

  it("两个已知 profile 都显式声明了该字段（不留 undefined 让调用方猜）", () => {
    for (const profile of CAPABILITY_PROFILES) {
      expect(profile.dependencyNetwork, profile.id).toMatch(/^(none|registry)$/);
    }
  });
});
