import { describe, expect, it } from "vitest";
import {
  BACKEND_NODE_PROFILE,
  CAPABILITY_PROFILES,
  DEFAULT_CAPABILITY_PROFILE,
  FRONTEND_VUE_PROFILE,
  isProfileAllowedRepairType,
  profileConsumesApi,
  profileEnablesDataLayer,
  WORK_TASK_TYPES,
  resolveCapabilityProfile,
  type CapabilityProfile
} from "./index";

/**
 * `docs/235` §6 第 1 步的验收判据：**零行为变化**。
 *
 * `backend-node` 的每个字段都必须与迁移前的硬编码**逐字一致**；任何一处不相等，
 * 都意味着这一步偷偷改了行为，而不是只改了「能力面表达在哪」。
 */
describe("docs/235：backend-node 与迁移前的硬编码逐字等价", () => {
  it("可规划类型清单与规划提示词原文的清单一致", () => {
    expect(BACKEND_NODE_PROFILE.taskTypes.plannable.join(", ")).toBe(
      "ANALYSIS, DESIGN, DATABASE, BACKEND, FRONTEND, TEST, REVIEW, BUILD, DEPLOY"
    );
  });

  it("工作类型与 `WORK_TASK_TYPES` 同源", () => {
    expect(WORK_TASK_TYPES).toBe(BACKEND_NODE_PROFILE.taskTypes.work);
    expect([...WORK_TASK_TYPES]).toEqual(["BACKEND", "FRONTEND", "DATABASE"]);
  });

  it("检查候选与迁移前的 `CHECK_CANDIDATES` 相同", () => {
    expect(BACKEND_NODE_PROFILE.checks).toEqual({
      BACKEND: ["build", "test"],
      FRONTEND: ["build", "lint"],
      TEST: ["test"],
      BUILD: ["build"]
    });
  });

  it("回退类型、agent 集合、边界门与解析器保持原样", () => {
    expect(BACKEND_NODE_PROFILE.taskTypes.fixFallback).toBe("BACKEND");
    expect([...BACKEND_NODE_PROFILE.agents]).toEqual([
      "PLANNER",
      "BACKEND",
      "DATABASE",
      "FRONTEND",
      "QA",
      "REVIEWER",
      "DEVOPS"
    ]);
    expect(BACKEND_NODE_PROFILE.testParser).toBe("node-tap");
    expect(BACKEND_NODE_PROFILE.boundaryCheck).toBe("server");
  });

  it("backend-node 仍可显式解析（遗留 E1 / 回滚入口）", () => {
    expect(resolveCapabilityProfile("backend-node")).toBe(BACKEND_NODE_PROFILE);
  });

  it("交付链与规划提示词的四段交付块逐段对应", () => {
    // 提示词里写死的是 CI → staging 部署 → staging 验证 → production 部署（N-33 的原始缺陷就出在
    // 第 3 段被规划成 DEPLOY）。这条断言钉住「声明与文案是同一件事」。
    expect(BACKEND_NODE_PROFILE.delivery.chain).toEqual([
      { action: "CI" },
      { action: "DEPLOY", environment: "staging" },
      { action: "VERIFY", environment: "staging" },
      { action: "DEPLOY", environment: "production" }
    ]);
  });
});

/**
 * `docs/235` §6 第 2 步：`frontend-vue`（"只做前端" 的完整表达）。
 *
 * 逐字段断言不是重复劳动——**每个字段都是一次裁决**，删掉任何一个都意味着这次转向的某条边界
 * 悄悄回到默认值（最典型的是 `fixFallback` 回退到 BACKEND：每修一次 REVIEW 失败就造一个
 * 没有人能承接的任务）。
 */
describe("docs/235：frontend-vue 的能力面", () => {
  it("可规划类型不含 BACKEND / DATABASE", () => {
    expect([...FRONTEND_VUE_PROFILE.taskTypes.plannable]).toEqual([
      "ANALYSIS",
      "DESIGN",
      "FRONTEND",
      "TEST",
      "REVIEW",
      "BUILD",
      "DEPLOY"
    ]);
  });

  it("写范围与修复回退都只有 FRONTEND", () => {
    expect([...FRONTEND_VUE_PROFILE.taskTypes.work]).toEqual(["FRONTEND"]);
    expect(FRONTEND_VUE_PROFILE.taskTypes.fixFallback).toBe("FRONTEND");
  });

  it("backend / database agent 不在启用集合里（定义仍保留，§5.2 层 2）", () => {
    expect([...FRONTEND_VUE_PROFILE.agents]).toEqual([
      "PLANNER",
      "FRONTEND",
      "QA",
      "REVIEWER",
      "DEVOPS"
    ]);
  });

  it("前端任务的逐任务门包含 test（§5.1 的必选项）", () => {
    expect(FRONTEND_VUE_PROFILE.checks.FRONTEND).toContain("test");
    // 反向对照：backend-node 今天没有，这正是本步要改的缺口。
    expect(BACKEND_NODE_PROFILE.checks.FRONTEND).not.toContain("test");
  });

  it("API 契约是输入而不是生成物", () => {
    expect(FRONTEND_VUE_PROFILE.specs.consume).toEqual(["API"]);
    expect(FRONTEND_VUE_PROFILE.specs.generate).not.toContain("API");
    expect(FRONTEND_VUE_PROFILE.specs.generate).not.toContain("DATABASE");
    expect(profileConsumesApi(FRONTEND_VUE_PROFILE)).toBe(true);
    // 反向对照：backend-node 把 API 当生成物、且不从外部消费任何规格。
    expect(BACKEND_NODE_PROFILE.specs.generate).toContain("API");
    expect([...BACKEND_NODE_PROFILE.specs.consume]).toEqual([]);
    expect(profileConsumesApi(BACKEND_NODE_PROFILE)).toBe(false);
  });

  it("解析器、边界门与夹具档位换成前端的一套", () => {
    expect(FRONTEND_VUE_PROFILE.testParser).toBe("vitest");
    expect(FRONTEND_VUE_PROFILE.boundaryCheck).toBe("ui");
    expect(FRONTEND_VUE_PROFILE.fixtureTier).toBe("F1");
  });

  it("交付链止于 staging 验证，不含 production", () => {
    expect(FRONTEND_VUE_PROFILE.delivery.chain).toEqual([
      { action: "CI" },
      { action: "DEPLOY", environment: "staging" },
      { action: "VERIFY", environment: "staging" }
    ]);
  });

  it("产品默认是 frontend-vue（可规划面不含 BACKEND / DATABASE）", () => {
    expect(DEFAULT_CAPABILITY_PROFILE).toBe(FRONTEND_VUE_PROFILE);
    expect(DEFAULT_CAPABILITY_PROFILE.id).toBe("frontend-vue");
    expect(DEFAULT_CAPABILITY_PROFILE.taskTypes.plannable).not.toContain("BACKEND");
    expect(DEFAULT_CAPABILITY_PROFILE.taskTypes.plannable).not.toContain("DATABASE");
  });
});

/**
 * 结构性不变量：**任何** profile 都必须满足，否则「回退」与「可规划」会各说各话。
 *
 * 这些不变式是给后面新增 profile（Java / Python 等，`docs/235` §9 明确暂不实现）留的守卫：
 * 只要取值越界，这里先红，而不是等到运行期出现一个谁都接不住的任务。
 */
describe("docs/235：profile 的结构性不变量", () => {
  const profiles: readonly CapabilityProfile[] = [BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE];

  it("工作类型与回退类型都在可规划集合内", () => {
    for (const profile of profiles) {
      expect(profile.taskTypes.work.length, profile.id).toBeGreaterThan(0);
      for (const type of profile.taskTypes.work) {
        expect(profile.taskTypes.plannable, `${profile.id}:${type}`).toContain(type);
      }
      expect(profile.taskTypes.plannable, profile.id).toContain(profile.taskTypes.fixFallback);
    }
  });

  it("检查候选只挂在可规划类型上", () => {
    for (const profile of profiles) {
      for (const type of Object.keys(profile.checks)) {
        expect(profile.taskTypes.plannable, `${profile.id}:${type}`).toContain(type);
      }
    }
  });

  it("交付链以 CI 起头，且非 CI 步骤都带环境", () => {
    for (const profile of profiles) {
      expect(profile.delivery.chain[0]?.action, profile.id).toBe("CI");
      for (const step of profile.delivery.chain) {
        if (step.action !== "CI") {
          expect(step.environment, `${profile.id}:${step.action}`).toBeDefined();
        }
      }
    }
  });
});

/**
 * `docs/235` §6.5：**选择机制的唯一入口**。
 *
 * 解析只在一处发生（配置层），因此这里必须保证：已知 id 能拿到同一实例、未知 id 直接抛错。
 * 抛错而不是退回默认，是这条链上最重要的一条——否则「配错了」与「没配」从外面看完全一样。
 */
describe("docs/235 §6.5：resolveCapabilityProfile", () => {
  it("已知 id 解析到同一个对象（不是副本）", () => {
    expect(resolveCapabilityProfile("backend-node")).toBe(BACKEND_NODE_PROFILE);
    expect(resolveCapabilityProfile("frontend-vue")).toBe(FRONTEND_VUE_PROFILE);
  });

  it("未知 id 抛错，并列出已知的 profile", () => {
    expect(() => resolveCapabilityProfile("backend-java")).toThrow(/Unknown capability profile/);
    expect(() => resolveCapabilityProfile("backend-java")).toThrow(/backend-node/);
    expect(() => resolveCapabilityProfile("backend-java")).toThrow(/frontend-vue/);
    // 空串也走同一条路（配置写成空值时不能静默通过）。
    expect(() => resolveCapabilityProfile("")).toThrow(/Unknown capability profile/);
  });

  it("已知 profile 清单与默认值一致，且 id 唯一", () => {
    expect(CAPABILITY_PROFILES).toContain(DEFAULT_CAPABILITY_PROFILE);
    const ids = CAPABILITY_PROFILES.map((profile) => profile.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("isProfileAllowedRepairType", () => {
  it("allows FRONTEND/TEST/REVIEW on frontend-vue and rejects BACKEND/DATABASE", () => {
    expect(isProfileAllowedRepairType("FRONTEND", FRONTEND_VUE_PROFILE)).toBe(true);
    expect(isProfileAllowedRepairType("TEST", FRONTEND_VUE_PROFILE)).toBe(true);
    expect(isProfileAllowedRepairType("REVIEW", FRONTEND_VUE_PROFILE)).toBe(true);
    expect(isProfileAllowedRepairType("BACKEND", FRONTEND_VUE_PROFILE)).toBe(false);
    expect(isProfileAllowedRepairType("DATABASE", FRONTEND_VUE_PROFILE)).toBe(false);
    expect(isProfileAllowedRepairType("IMPLEMENTATION", FRONTEND_VUE_PROFILE)).toBe(false);
  });

  it("allows BACKEND on backend-node", () => {
    expect(isProfileAllowedRepairType("BACKEND", BACKEND_NODE_PROFILE)).toBe(true);
  });
});

describe("docs/268：profileEnablesDataLayer", () => {
  it("frontend-vue does not enable database or backend work", () => {
    expect(profileEnablesDataLayer(FRONTEND_VUE_PROFILE)).toBe(false);
    expect(profileEnablesDataLayer(DEFAULT_CAPABILITY_PROFILE)).toBe(false);
  });

  it("backend-node enables database and backend work", () => {
    expect(profileEnablesDataLayer(BACKEND_NODE_PROFILE)).toBe(true);
  });
});

describe("docs/269：profileConsumesApi", () => {
  it("frontend-vue consumes API and does not generate it", () => {
    expect(profileConsumesApi(FRONTEND_VUE_PROFILE)).toBe(true);
    expect(profileConsumesApi(DEFAULT_CAPABILITY_PROFILE)).toBe(true);
  });

  it("backend-node generates API and therefore is not in consume mode", () => {
    expect(profileConsumesApi(BACKEND_NODE_PROFILE)).toBe(false);
  });

  it("a profile that both generates and consumes API is treated as generate", () => {
    const hybrid: CapabilityProfile = {
      ...FRONTEND_VUE_PROFILE,
      id: "hybrid-api",
      specs: {
        generate: [...FRONTEND_VUE_PROFILE.specs.generate, "API"],
        consume: ["API"]
      }
    };
    expect(profileConsumesApi(hybrid)).toBe(false);
  });
});
