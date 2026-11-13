import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE, type CapabilityProfile } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import { taskPlanningPrompt } from "./prompts/task-planning.prompt";

/**
 * N-33（`docs/217`）：**交付动作必须写进提示词，否则规划器照语义猜，猜出来的是错的契约。**
 *
 * 实测批次 `l1-m4t`（run 1 与 run 2 连续两次）：最终切片把「验证 staging 环境」规划成
 * `type=DEPLOY, delivery={"action":"DEPLOY","environment":"staging"}` —— 标题是对的、契约是错的。
 * `DeliveryOrchestrator` 照契约又部署了一次，而 staging 段判据找的是 `action === "VERIFY"`
 * ⇒ 找不到 ⇒ **staging 段恒为 0**，尽管两次 run 的真交付率都是 100%。
 *
 * 旧文案只列四个任务名，从没说过 `delivery.action` 填什么。这条用例守的就是「必须写出来」。
 */
describe("taskPlanningPrompt 交付块契约（N-33）", () => {
  const prompt = taskPlanningPrompt(); // 产品默认 = frontend-vue（止于 staging）

  it("默认（frontend-vue）给出三个交付块，且明确无 production", () => {
    expect(prompt).toContain('(1) CI: type BUILD, delivery {"action":"CI"}');
    expect(prompt).toContain(
      '(2) Staging deploy: type DEPLOY, delivery {"action":"DEPLOY","environment":"staging"}'
    );
    expect(prompt).toContain(
      '(3) Staging verify: type TEST, delivery {"action":"VERIFY","environment":"staging"}'
    );
    expect(prompt).toContain("This project has NO production environment");
    expect(prompt).not.toContain("(4) Production deploy");
  });

  it("显式 backend-node 仍给出四个交付块（含 production）", () => {
    const backendPrompt = taskPlanningPrompt({ profile: BACKEND_NODE_PROFILE });
    expect(backendPrompt).toContain('(1) CI: type BUILD, delivery {"action":"CI"}');
    expect(backendPrompt).toContain(
      '(4) Production deploy: type DEPLOY, delivery {"action":"DEPLOY","environment":"production"}'
    );
    expect(backendPrompt).not.toContain("This profile consumes API contracts as input");
  });

  it("点名 staging verify 的动作必须是 VERIFY 而不是 DEPLOY（缺陷的原始形状）", () => {
    expect(prompt).toContain('the action MUST be "VERIFY", not "DEPLOY"');
    expect(prompt).toContain("a DEPLOY action here deploys staging again instead of verifying it");
  });

  it("未绑定仓库 / 非最终切片的变体仍然禁止规划交付链（既有行为不变）", () => {
    expect(taskPlanningPrompt({ deliveryConfigured: false })).toContain("NO Git repository bound");
    expect(taskPlanningPrompt({ isFinalSlice: false })).toContain("This is NOT the final slice");
    // 两种禁止变体都不得再鼓励规划交付任务。
    expect(taskPlanningPrompt({ isFinalSlice: false })).not.toContain("Staging verify");
  });
});

/**
 * `docs/235` §6 第 1 步：可规划类型清单由能力 profile 渲染。
 * 2026-11-04 起产品默认 = frontend-vue；显式 backend-node 仍渲染迁移前完整清单。
 */
describe("docs/235：可规划类型来自能力 profile", () => {
  it("默认 profile（frontend-vue）清单不含 BACKEND / DATABASE", () => {
    expect(taskPlanningPrompt()).toContain(
      "Plannable task types: ANALYSIS, DESIGN, FRONTEND, TEST, REVIEW, BUILD, DEPLOY. DEBUG"
    );
    const line =
      taskPlanningPrompt().split("\n").find((l) => l.startsWith("Plannable task types:")) ?? "";
    expect(line).not.toMatch(/\b(BACKEND|DATABASE)\b/);
  });

  it("显式 backend-node 仍渲染迁移前完整清单", () => {
    expect(taskPlanningPrompt({ profile: BACKEND_NODE_PROFILE })).toContain(
      "Plannable task types: ANALYSIS, DESIGN, DATABASE, BACKEND, FRONTEND, TEST, REVIEW, BUILD, DEPLOY. DEBUG"
    );
  });

  it("自定义 profile 收窄清单（前端 profile 的形状）", () => {
    const profile: CapabilityProfile = {
      ...BACKEND_NODE_PROFILE,
      taskTypes: {
        ...BACKEND_NODE_PROFILE.taskTypes,
        plannable: ["ANALYSIS", "DESIGN", "FRONTEND", "TEST", "REVIEW", "BUILD", "DEPLOY"]
      }
    };
    const prompt = taskPlanningPrompt({ profile });
    expect(prompt).toContain(
      "Plannable task types: ANALYSIS, DESIGN, FRONTEND, TEST, REVIEW, BUILD, DEPLOY."
    );
    expect(prompt).not.toContain("DATABASE, BACKEND");
  });

  it("frontend-vue profile：清单里不再出现 BACKEND / DATABASE（第 2 步的落点）", () => {
    const prompt = taskPlanningPrompt({ profile: FRONTEND_VUE_PROFILE });
    expect(prompt).toContain(
      "Plannable task types: ANALYSIS, DESIGN, FRONTEND, TEST, REVIEW, BUILD, DEPLOY."
    );
    // 逐词判定：只断言子串会被 "FRONTEND" 里的 "END" 干扰，按整行 + 词边界看。
    const plannableLine =
      prompt.split("\n").find((line) => line.startsWith("Plannable task types:")) ?? "";
    expect(plannableLine).not.toBe("");
    expect(plannableLine).not.toMatch(/\b(BACKEND|DATABASE)\b/);
    // 产品默认（不传 profile）= frontend-vue：清单不含 BACKEND / DATABASE。
    const defaultLine =
      taskPlanningPrompt().split("\n").find((line) => line.startsWith("Plannable task types:")) ??
      "";
    expect(defaultLine).not.toMatch(/\b(BACKEND|DATABASE)\b/);
    expect(prompt).toContain("This profile consumes API contracts as input");
    expect(prompt).toContain("Plan frontend interface encapsulation");
    expect(prompt).toContain("never plan BACKEND or DATABASE tasks");
  });
});

/**
 * N-73（`docs/232` §10）：**交付链止于 staging 的 profile 不能要求规划生产部署。**
 *
 * `FRONTEND_VUE_PROFILE.delivery.chain` 只有 CI / staging DEPLOY / staging VERIFY；
 * 提示词若仍写「四个交付任务」，规划器会排出一个没有环境可落的生产部署
 * （`DELIVERY_ENVIRONMENT_MISSING`）。
 */
describe("N-73：交付链止于 staging 的 profile", () => {
  it("frontend-vue：三个交付任务，且明确不要 production", () => {
    const prompt = taskPlanningPrompt({ profile: FRONTEND_VUE_PROFILE });
    expect(prompt).toContain('(1) CI: type BUILD, delivery {"action":"CI"}');
    expect(prompt).toContain(
      '(2) Staging deploy: type DEPLOY, delivery {"action":"DEPLOY","environment":"staging"}'
    );
    expect(prompt).toContain(
      '(3) Staging verify: type TEST, delivery {"action":"VERIFY","environment":"staging"}'
    );
    expect(prompt).toContain("This project has NO production environment");
    expect(prompt).not.toContain("(4) Production deploy");
  });

  it("backend-node（链里有 production）仍是四个交付任务", () => {
    expect(taskPlanningPrompt({ profile: BACKEND_NODE_PROFILE })).toContain(
      "(4) Production deploy: type DEPLOY"
    );
  });
});
