import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_POLICY,
  FRONTEND_VUE_PROFILE,
  L1_WORKFLOW_POLICY,
  resolveSliceWorkflowPolicy,
  SLICE_WORKFLOW_POLICY,
  WorkflowPolicySchema
} from "@ai-se/shared";
import {
  classifyAutonomyFailure,
  createAutonomyFailureRouter,
  decideGateFailureRepair,
  hasActionableFailureEvidence,
  hasObjectiveRedEvidence,
  canTypeSwitchPastExhaustion,
  isProvenUnfixableEnvGap,
  officialLooksLikeProbeFailure,
  officialLooksLikePackageWorkspaceFailure,
  officialLooksLikeCurrentEnvGap,
  isOfficialRedPointUnreachableByTaskType,
  isRepeatedOfficialEvidence,
  objectiveClosingOverride,
  resolveRepairFixTaskType,
  normalizeRequestedRepairType,
  repairHintForFailureClass,
  matchesTestAssertionFailure
} from "../services/gateFailureRepair";

const slicePolicy = WorkflowPolicySchema.parse({
  ...DEFAULT_WORKFLOW_POLICY,
  ...SLICE_WORKFLOW_POLICY
});

const failFast = WorkflowPolicySchema.parse(DEFAULT_WORKFLOW_POLICY);

describe("resolveSliceWorkflowPolicy", () => {
  it("defaults slice starts to REPLAN autonomy (not FAIL_FAST)", () => {
    const policy = resolveSliceWorkflowPolicy();
    expect(policy.failureStrategy).toBe("REPLAN");
    expect(policy.allowReplan).toBe(true);
    expect(policy.maxRetries).toBe(2);
    expect(policy.autonomyLevel).toBe("L1");
    expect(policy).toEqual(slicePolicy);
  });

  it("upgrades explicit FAIL_FAST (legacy inherit) to slice REPLAN autonomy", () => {
    const upgraded = resolveSliceWorkflowPolicy(failFast);
    expect(upgraded.failureStrategy).toBe("REPLAN");
    expect(upgraded.allowReplan).toBe(true);
    expect(upgraded.autonomyLevel).toBe("L1");
    expect(upgraded.maxRetries).toBe(2);
  });

  it("does not waive approvalRequired on the slice preset", () => {
    expect(Object.keys(SLICE_WORKFLOW_POLICY)).not.toContain("approvalRequired");
    expect(Object.keys(L1_WORKFLOW_POLICY)).not.toContain("approvalRequired");
  });
});

describe("hasActionableFailureEvidence", () => {
  it("detects exit 127 / missing bins / Approval withheld text", () => {
    expect(
      hasActionableFailureEvidence({
        summary:
          "Approval withheld; npm run type-check -> sh: 1: vue-tsc: not found; empty node_modules/.bin"
      })
    ).toBe(true);
    expect(hasActionableFailureEvidence({ errorType: "DEPENDENCIES_MISSING" })).toBe(true);
    expect(hasActionableFailureEvidence({ errorType: "AGENT_TIMEOUT" })).toBe(true);
    expect(
      hasActionableFailureEvidence({
        verification: { verdict: "failed", reason: "checks failed", checks: [] }
      })
    ).toBe(true);
  });

  it("rejects empty or non-actionable text", () => {
    expect(hasActionableFailureEvidence({ summary: "looks fine overall" })).toBe(false);
    expect(hasActionableFailureEvidence({})).toBe(false);
  });
});

describe("hasObjectiveRedEvidence / objectiveClosingOverride (AFC-1/AFC-2)", () => {
  const task06Summary =
    "Delivered persistence slice. npm run type-check fails only on the pre-existing TS2307 for missing storage.service; 2 [AC-12] cases in that file still fail because they exercise Task Store resetTasks.";

  it("AFC-1: SUCCESS + red self-report evidence → override FAILED", () => {
    expect(hasObjectiveRedEvidence({ summary: task06Summary })).toBe(true);
    const closing = objectiveClosingOverride({
      taskType: "FRONTEND",
      mode: "enforce",
      resultStatus: "succeeded",
      output: { summary: task06Summary, outcome: "SUCCESS" },
      profile: FRONTEND_VUE_PROFILE
    });
    expect(closing).not.toBeNull();
    expect(closing?.errorType).toBe("OBJECTIVE_EVIDENCE_FAILED");
    expect(closing?.fixTaskType).toBe("FRONTEND");
  });

  it("AFC-2: SUCCESS + clean summary → no override", () => {
    expect(
      hasObjectiveRedEvidence({
        summary: "All gates green: type-check, lint, test and build passed."
      })
    ).toBe(false);
    expect(
      objectiveClosingOverride({
        taskType: "FRONTEND",
        mode: "enforce",
        resultStatus: "succeeded",
        output: { summary: "All gates green: type-check, lint, test and build passed." },
        profile: FRONTEND_VUE_PROFILE
      })
    ).toBeNull();
  });

  it("observe mode does not force FAILED (slice uses enforce via L1)", () => {
    expect(
      objectiveClosingOverride({
        taskType: "FRONTEND",
        mode: "observe",
        resultStatus: "succeeded",
        output: { summary: task06Summary },
        profile: FRONTEND_VUE_PROFILE
      })
    ).toBeNull();
  });

  it("DEBUG is not objectively gated even under enforce (diagnosis must not be flipped by red product gates)", () => {
    expect(
      objectiveClosingOverride({
        taskType: "DEBUG",
        mode: "enforce",
        resultStatus: "succeeded",
        output: {
          summary: "Diagnosis complete; npm test still red pending missing TaskForm.vue",
          verification: { verdict: "failed", reason: "test failed" }
        },
        verificationVerdict: "failed",
        verificationReason: "test failed",
        profile: FRONTEND_VUE_PROFILE
      })
    ).toBeNull();
  });
});

describe("classifyAutonomyFailure (AFC-M2)", () => {
  it("AFC-4: exit 127 / native package → DEPENDENCIES_MISSING", () => {
    expect(
      classifyAutonomyFailure({
        summary: "sh: 1: vue-tsc: not found; Cannot find module @rollup/rollup-linux-arm64-gnu"
      })
    ).toBe("DEPENDENCIES_MISSING");
    expect(classifyAutonomyFailure({ errorType: "DEPENDENCIES_MISSING" })).toBe(
      "DEPENDENCIES_MISSING"
    );
  });

  it("AFC-5: timeout codes → AGENT_TIMEOUT", () => {
    expect(classifyAutonomyFailure({ errorType: "AGENT_TIMEOUT" })).toBe("AGENT_TIMEOUT");
    expect(classifyAutonomyFailure({ errorType: "TIMEOUT_ERROR" })).toBe("AGENT_TIMEOUT");
    expect(classifyAutonomyFailure({ summary: "agent run timed out after 900000ms" })).toBe(
      "AGENT_TIMEOUT"
    );
  });

  it("spec conflict signals → SPEC_CONFLICT", () => {
    expect(
      classifyAutonomyFailure({
        summary: "contradictory test expectations between foundation and persistence slice"
      })
    ).toBe("SPEC_CONFLICT");
  });

  it("assembly fixture signals (getActivePinia / No active Pinia) → TEST_FIXTURE_GAP", () => {
    expect(
      classifyAutonomyFailure({
        summary:
          "AC-15 failed: getActivePinia() was called with no active Pinia. Did you forget to install pinia?"
      })
    ).toBe("TEST_FIXTURE_GAP");
    expect(classifyAutonomyFailure({ errorType: "TEST_FIXTURE_GAP" })).toBe("TEST_FIXTURE_GAP");
    expect(repairHintForFailureClass("TEST_FIXTURE_GAP")).toMatch(/fixture\/setup/i);
  });

  it("README / docs assertion signals → DOCS_GAP", () => {
    expect(
      classifyAutonomyFailure({
        summary:
          "AC evidence green; remaining failures in tests/unit/readme.ac18.spec.ts — README missing 项目介绍 / 目录结构 / 不在本次交付范围"
      })
    ).toBe("DOCS_GAP");
    expect(
      classifyAutonomyFailure({
        summary: "engineering-gates.spec.ts README section still fails; Path is not writable: docs/delivery-report.md"
      })
    ).toBe("DOCS_GAP");
    expect(classifyAutonomyFailure({ errorType: "DOCS_GAP" })).toBe("DOCS_GAP");
    expect(repairHintForFailureClass("DOCS_GAP")).toMatch(/README\.md|docs\/\*\*/i);
  });

  it("Playwright browser missing → ENV_GAP (not DEPENDENCIES_MISSING / FRONTEND)", () => {
    expect(
      classifyAutonomyFailure({
        summary:
          "T-13 E2E BLOCKED: browserType.launch — Executable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1200/chrome-linux/headless_shell"
      })
    ).toBe("ENV_GAP");
    expect(classifyAutonomyFailure({ errorType: "ENV_GAP" })).toBe("ENV_GAP");
    expect(repairHintForFailureClass("ENV_GAP")).toMatch(/playwright install|FRONTEND REPLAN/i);
  });
});

describe("decideGateFailureRepair", () => {
  const foundationEvidence = {
    summary:
      "Re-reviewed slice-foundation. Every gate still exits 127: vue-tsc/eslint/vitest not found. Approval withheld."
  };

  it("error evidence + slice autonomy policy → enter REPLAN with FRONTEND fix", () => {
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 0,
      ...foundationEvidence,
      profile: FRONTEND_VUE_PROFILE,
      taskType: "REVIEW"
    });
    expect(decision.enter).toBe(true);
    if (decision.enter) {
      expect(decision.strategy).toBe("REPLAN");
      expect(decision.fixTaskType).toBe("FRONTEND");
      expect(decision.failureClass).toBe("DEPENDENCIES_MISSING");
      expect(decision.reason).toContain("Dependency/env repair");
    }
  });

  it("AFC-6: exhausted attempts → terminal failure (no infinite loop)", () => {
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: slicePolicy.maxRetries,
      ...foundationEvidence,
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(false);
    if (!decision.enter) {
      expect(decision.reason).toBe("repair-exhausted");
      expect(decision.failureClass).toBe("repair-exhausted");
    }
  });

  it("v8: exhausted TEST + REPLAN_REQUESTED + fixTaskType=FRONTEND → type-switch enter", () => {
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: slicePolicy.maxRetries,
      errorType: "REPLAN_REQUESTED",
      summary: "Diagnosis complete; TEST cannot go green without TaskForm.vue",
      explicitFixTaskType: "FRONTEND",
      taskType: "TEST",
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(true);
    if (decision.enter) {
      expect(decision.fixTaskType).toBe("FRONTEND");
      expect(decision.reason).toContain("type-switch");
    }
  });

  it("v8: type-switch not repeated when typeSwitchUsed already set", () => {
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: slicePolicy.maxRetries,
      errorType: "REPLAN_REQUESTED",
      summary: "still red",
      explicitFixTaskType: "FRONTEND",
      taskType: "TEST",
      typeSwitchUsed: true,
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(false);
    if (!decision.enter) expect(decision.reason).toBe("repair-exhausted");
  });

  it("TEST_FIXTURE_GAP on FRONTEND routes same-type repair with fixture hint", () => {
    expect(
      resolveRepairFixTaskType({
        failureClass: "TEST_FIXTURE_GAP",
        taskType: "FRONTEND",
        profile: FRONTEND_VUE_PROFILE
      })
    ).toBe("FRONTEND");
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 0,
      summary:
        "3 failed: getActivePinia was called with no active Pinia in tests/assembly/app-assembly.spec.ts",
      taskType: "FRONTEND",
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(true);
    if (decision.enter) {
      expect(decision.failureClass).toBe("TEST_FIXTURE_GAP");
      expect(decision.fixTaskType).toBe("FRONTEND");
      expect(decision.reason).toMatch(/Test fixture\/setup repair/i);
    }
  });

  it("DOCS_GAP routes to BUILD even when agent asks for FRONTEND", () => {
    expect(
      resolveRepairFixTaskType({
        failureClass: "DOCS_GAP",
        explicitFixTaskType: "FRONTEND",
        taskType: "FRONTEND",
        profile: FRONTEND_VUE_PROFILE
      })
    ).toBe("BUILD");
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 0,
      summary:
        "Slice AC green; readme.ac18.spec.ts fails — README.md lacks 项目介绍 and 目录结构",
      explicitFixTaskType: "FRONTEND",
      taskType: "FRONTEND",
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(true);
    if (decision.enter) {
      expect(decision.failureClass).toBe("DOCS_GAP");
      expect(decision.fixTaskType).toBe("BUILD");
      expect(decision.reason).toMatch(/Docs\/README repair/i);
    }
  });

  it("ENV_GAP routes to BUILD even when agent asks for FRONTEND", () => {
    expect(
      resolveRepairFixTaskType({
        failureClass: "ENV_GAP",
        explicitFixTaskType: "FRONTEND",
        taskType: "FRONTEND",
        profile: FRONTEND_VUE_PROFILE
      })
    ).toBe("BUILD");
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 0,
      summary:
        "browserType.launch failed: Executable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1/chrome-linux/headless_shell; E2E BLOCKED",
      explicitFixTaskType: "FRONTEND",
      taskType: "FRONTEND",
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(true);
    if (decision.enter) {
      expect(decision.failureClass).toBe("ENV_GAP");
      expect(decision.fixTaskType).toBe("BUILD");
      expect(decision.reason).toMatch(/Env\/browser repair/i);
    }
  });

  it("v8: BACKEND fixTaskType under frontend-vue is ignored; falls back to FRONTEND", () => {
    expect(
      resolveRepairFixTaskType({
        explicitFixTaskType: "BACKEND",
        profile: FRONTEND_VUE_PROFILE,
        taskType: "TEST"
      })
    ).toBe("FRONTEND");
    const switchDecision = canTypeSwitchPastExhaustion({
      executionAttempt: 2,
      maxRetries: 2,
      taskType: "TEST",
      explicitFixTaskType: "BACKEND",
      errorType: "REPLAN_REQUESTED",
      profile: FRONTEND_VUE_PROFILE
    });
    expect(switchDecision.allowed).toBe(true);
    expect(switchDecision.fixTaskType).toBe("FRONTEND");
  });

  it("AFC-10: production deploy approval is never auto-bypassed", () => {
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 0,
      ...foundationEvidence,
      taskType: "DEPLOY",
      deliveryEnvironment: "production",
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(false);
    if (!decision.enter) expect(decision.reason).toBe("production-deploy-approval");
    expect(
      resolveRepairFixTaskType({
        taskType: "DEPLOY",
        deliveryEnvironment: "production",
        profile: FRONTEND_VUE_PROFILE
      })
    ).toBeUndefined();
  });

  it("FAIL_FAST without allowReplan does not enter repair", () => {
    const decision = decideGateFailureRepair({
      policy: failFast,
      executionAttempt: 0,
      ...foundationEvidence,
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(false);
    if (!decision.enter) expect(decision.reason).toBe("policy-disallows-replan");
  });

  it("AFC-3: QA Approval withheld routes with GATE/deps class and evidence", () => {
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 0,
      summary: "Approval withheld; npm run lint failed with AC-16 not met",
      profile: FRONTEND_VUE_PROFILE,
      taskType: "REVIEW"
    });
    expect(decision.enter).toBe(true);
    if (decision.enter) {
      expect(decision.evidenceSummary.length).toBeGreaterThan(0);
      expect(decision.fixTaskType).toBe("FRONTEND");
    }
  });
});

describe("createAutonomyFailureRouter", () => {
  const router = createAutonomyFailureRouter(FRONTEND_VUE_PROFILE);
  const task = {
    id: "t1",
    projectId: "p1",
    taskKey: "T-QA",
    title: "QA",
    description: "",
    type: "REVIEW" as const,
    status: "FAILED" as const,
    priority: "MEDIUM" as const,
    input: { executionAttempt: 0 },
    output: {
      summary:
        "Approval withheld; npm run type-check -> sh: 1: vue-tsc: not found; empty node_modules/.bin"
    },
    retryCount: 0,
    version: 1,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z"
  };

  it("routes actionable gate failure to REPLAN with class + attempt", () => {
    const routed = router({ workflow: { policy: slicePolicy, id: "w1" }, task });
    expect(routed?.strategy).toBe("REPLAN");
    expect(routed?.failureClass).toBe("DEPENDENCIES_MISSING");
    expect(routed?.attempt).toBe(0);
    expect(routed?.evidenceSummary).toBeTruthy();
    expect(routed?.reason).toContain("Dependency/env repair");
  });

  it("fails closed when repair attempts are exhausted", () => {
    const exhausted = {
      ...task,
      input: { executionAttempt: slicePolicy.maxRetries }
    };
    const routed = router({ workflow: { policy: slicePolicy, id: "w1" }, task: exhausted });
    expect(routed?.strategy).toBe("FAIL");
    expect(routed?.failureClass).toBe("repair-exhausted");
    expect(routed?.reason).toMatch(/repair exhausted/i);
  });

  it("v8 router: exhausted + fixTaskType FRONTEND + REPLAN_REQUESTED → REPLAN not FAIL", () => {
    const exhausted = {
      ...task,
      type: "TEST" as const,
      input: { executionAttempt: slicePolicy.maxRetries },
      output: {
        summary: "TEST cannot go green; need TaskForm.vue",
        errorType: "REPLAN_REQUESTED",
        fixTaskType: "FRONTEND"
      }
    };
    const routed = router({ workflow: { policy: slicePolicy, id: "w1" }, task: exhausted });
    expect(routed?.strategy).toBe("REPLAN");
    expect(routed?.reason).toContain("type-switch");
  });

  it("AFC-10: does not route production DEPLOY (human gate untouched)", () => {
    const deploy = {
      ...task,
      type: "DEPLOY" as const,
      input: { executionAttempt: 0, delivery: { environment: "production", action: "DEPLOY" } }
    };
    expect(router({ workflow: { policy: slicePolicy, id: "w1" }, task: deploy })).toBeUndefined();
  });

  it("AFC-5: AGENT_TIMEOUT enters REPLAN autonomy", () => {
    const timed = {
      ...task,
      output: { summary: "agent timed out", errorType: "AGENT_TIMEOUT" }
    };
    const routed = router({ workflow: { policy: slicePolicy, id: "w1" }, task: timed });
    expect(routed?.strategy).toBe("REPLAN");
    expect(routed?.failureClass).toBe("AGENT_TIMEOUT");
  });

  it("DOCS_GAP router returns REPLAN via BUILD with fixTaskType", () => {
    const docsTask = {
      ...task,
      type: "FRONTEND" as const,
      sliceKey: "slice-foundation",
      output: {
        summary:
          "Remaining failures: tests/unit/readme.ac18.spec.ts — 项目介绍 / 目录结构 / 不在本次交付范围",
        fixTaskType: "FRONTEND"
      }
    };
    const routed = router({ workflow: { policy: slicePolicy, id: "w1" }, task: docsTask });
    expect(routed?.strategy).toBe("REPLAN");
    expect(routed?.failureClass).toBe("DOCS_GAP");
    expect(routed?.fixTaskType).toBe("BUILD");
  });

  it("ENV_GAP router returns REPLAN via BUILD with fixTaskType", () => {
    const envTask = {
      ...task,
      type: "FRONTEND" as const,
      sliceKey: "slice-dashboard-list",
      output: {
        summary:
          "E2E BLOCKED: browserType.launch Executable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1200",
        fixTaskType: "FRONTEND"
      }
    };
    const routed = router({ workflow: { policy: slicePolicy, id: "w1" }, task: envTask });
    expect(routed?.strategy).toBe("REPLAN");
    expect(routed?.failureClass).toBe("ENV_GAP");
    expect(routed?.fixTaskType).toBe("BUILD");
  });
});


describe("docs/255：已证明不可修的 ENV_GAP 不再开同类 BUILD", () => {
  const envGapInstallEvidence = {
    summary:
      "BUILD ran npm run test:e2e:install: run_lint timed out after 120s with no download progress. " +
      "browserType.launch: Executable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1248/" +
      "chrome-headless-shell-linux-arm64/chrome-headless-shell",
    verification: {
      failureCode: "ENV_GAP",
      reason: "Playwright browser binaries missing (ENV_GAP)",
      checks: [
        {
          name: "build",
          command: "npm run build",
          passed: true,
          timedOut: false
        },
        {
          name: "test",
          command: "npm run test:e2e:install",
          passed: false,
          timedOut: true,
          failureCode: "ENV_GAP",
          stderrTail: "Executable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1248/..."
        }
      ]
    }
  };

  it("detects a BUILD that already attempted an impossible playwright install", () => {
    expect(
      isProvenUnfixableEnvGap({
        taskType: "BUILD",
        failureClass: "ENV_GAP",
        ...envGapInstallEvidence
      })
    ).toBe(true);
  });

  it("does not treat a first FRONTEND ENV_GAP as unfixable (still allowed to open BUILD)", () => {
    expect(
      isProvenUnfixableEnvGap({
        taskType: "FRONTEND",
        failureClass: "ENV_GAP",
        summary: "Executable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1248/..."
      })
    ).toBe(false);
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 0,
      summary: "Executable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1248/; E2E BLOCKED",
      taskType: "FRONTEND",
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(true);
    if (decision.enter) expect(decision.fixTaskType).toBe("BUILD");
  });

  it("does not open a second identical ENV_GAP BUILD after install already failed", () => {
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 1,
      ...envGapInstallEvidence,
      taskType: "BUILD",
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(false);
    if (!decision.enter) {
      expect(decision.reason).toBe("unfixable-env-gap");
      expect(decision.failureClass).toBe("ENV_GAP");
    }
  });

  it("router FAILs instead of REPLANing another BUILD", () => {
    const router = createAutonomyFailureRouter(FRONTEND_VUE_PROFILE);
    const routed = router({
      workflow: { policy: slicePolicy, id: "wf-1" },
      task: {
        id: "t-13-replan-3",
        projectId: "p1",
        taskKey: "T-13-REPLAN-3",
        title: "Install browsers",
        description: "ENV_GAP",
        type: "BUILD",
        status: "FAILED",
        priority: "MEDIUM",
        input: { executionAttempt: 1 },
        output: {
          errorType: "ENV_GAP",
          summary: envGapInstallEvidence.summary,
          verification: envGapInstallEvidence.verification
        },
        retryCount: 0,
        version: 1,
        createdAt: "2026-11-10T01:00:00.000Z",
        updatedAt: "2026-11-10T01:00:00.000Z"
      }
    });
    expect(routed?.strategy).toBe("FAIL");
    expect(routed?.failureClass).toBe("ENV_GAP");
    expect(routed?.reason).toMatch(/Unfixable ENV_GAP/i);
  });
});

describe("docs/256：资源限额杀死浏览器不再开 BUILD 安装", () => {
  const crash =
    "Playwright workers died: Target crashed; pthread_create: Resource temporarily unavailable (11)";

  it("classifies a resource-limit kill as ENV_GAP", () => {
    expect(classifyAutonomyFailure({ summary: crash })).toBe("ENV_GAP");
  });

  it("does not enter a BUILD install REPLAN for a TEST resource-limit kill", () => {
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 0,
      taskType: "TEST",
      summary: crash,
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(false);
    if (!decision.enter) {
      expect(decision.reason).toBe("unfixable-env-gap");
      expect(decision.failureClass).toBe("ENV_GAP");
      expect(decision.detail).toMatch(/resource limits/i);
    }
  });

  it("treats BUILD as proven-unfixable when install already succeeded but the official e2e was killed", () => {
    expect(
      isProvenUnfixableEnvGap({
        taskType: "BUILD",
        failureClass: "ENV_GAP",
        summary:
          "npm run test:e2e:install exited 0 in 1.08s without downloading; Target crashed; pthread_create: Resource temporarily unavailable (11)",
        verification: {
          checks: [
            {
              name: "e2e",
              command: "npm run test:e2e -- --workers=2",
              passed: false,
              exitCode: 1,
              stderrTail:
                "Target crashed; pthread_create: Resource temporarily unavailable (11)"
            }
          ]
        }
      })
    ).toBe(true);
  });

  it("still opens BUILD for a first missing-binary ENV_GAP on TEST", () => {
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 0,
      taskType: "TEST",
      summary:
        "browserType.launch: Executable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1248/chrome-linux/headless_shell; E2E BLOCKED",
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(true);
    if (decision.enter) expect(decision.fixTaskType).toBe("BUILD");
  });
});

describe("docs/257：交付报告误判红 / E2E 断言分流 TEST", () => {
  const honestDeliveryReport = `
T-14 BUILD 完成。官方 npm run build 通过。
已重写 docs/delivery-report.md 为交付报告，含项目状态、功能完成情况、技术栈验证、
各项检查结果（9 行命令与退出码），四态 PASS/FAIL/NOT RUN/BLOCKED。
未声称未执行的检查通过。单测 0 FAIL；E2E 记录 24 passed / 7 failed / 0 BLOCKED。
写权限包含 README.md 与 Playwright 配置 playwright.config.ts。
项目介绍、目录结构已写入 README。
`;

  const assertionEvidence = `
Playwright E2E 31 tests: 24 passed, 7 failed, 0 BLOCKED.
Error: expect(locator).toHaveText()
Expected: "全部"
Received: "全部优先级"
locator.getByRole('button', { name: '编辑' }): Error: Timeout 30000ms exceeded
waiting for getByRole('button', { name: '删除' })
delivery report at docs/delivery-report.md; README 项目介绍 / 目录结构 already present.
Path is not writable was fixed earlier; Playwright 配置见 playwright.config.ts.
`;

  it("honest delivery-report four-state write-up is not objective red by itself", () => {
    const summary =
      "docs/delivery-report.md 整体重写为交付报告，含项目状态、功能完成情况、技术栈验证、各项检查结果（9 行命令与退出码）、已修复问题、未完成事项、已知问题、启动方式、最终结论，四态 PASS/FAIL/NOT RUN/BLOCKED。未声称未执行的检查通过。";
    expect(hasObjectiveRedEvidence({ summary })).toBe(false);
    expect(
      objectiveClosingOverride({
        taskType: "BUILD",
        mode: "enforce",
        resultStatus: "succeeded",
        output: { summary, outcome: "SUCCESS" },
        profile: FRONTEND_VUE_PROFILE
      })
    ).toBeNull();
  });

  it("0 BLOCKED plus a later Playwright config mention is not ENV_GAP or DOCS_GAP", () => {
    expect(classifyAutonomyFailure({ summary: honestDeliveryReport })).not.toBe("ENV_GAP");
    expect(classifyAutonomyFailure({ summary: honestDeliveryReport })).not.toBe("DOCS_GAP");
  });

  it("E2E Expected/Received and locator timeout route to TEST, not BUILD", () => {
    expect(matchesTestAssertionFailure(assertionEvidence)).toBe(true);
    expect(classifyAutonomyFailure({ summary: assertionEvidence })).toBe("GATE_FAILURE");
    expect(
      resolveRepairFixTaskType({
        failureClass: "GATE_FAILURE",
        profile: FRONTEND_VUE_PROFILE,
        taskType: "BUILD",
        evidenceText: assertionEvidence
      })
    ).toBe("TEST");
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 0,
      taskType: "BUILD",
      summary: assertionEvidence,
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(true);
    if (decision.enter) {
      expect(decision.failureClass).toBe("GATE_FAILURE");
      expect(decision.fixTaskType).toBe("TEST");
    }
  });

  it("official verifier E2E assertion failure on REVIEW still opens TEST", () => {
    const closing = objectiveClosingOverride({
      taskType: "REVIEW",
      mode: "enforce",
      resultStatus: "succeeded",
      output: { summary: "build green; e2e documented", outcome: "SUCCESS" },
      verificationVerdict: "failed",
      verificationFailureCode: "VERIFICATION_FAILED",
      verificationReason: assertionEvidence,
      profile: FRONTEND_VUE_PROFILE
    });
    expect(closing).not.toBeNull();
    expect(closing?.failureClass).toBe("GATE_FAILURE");
    expect(closing?.fixTaskType).toBe("TEST");
  });

  it("readme.ac assertion and missing-binary ENV_GAP still route to BUILD", () => {
    expect(
      classifyAutonomyFailure({
        summary:
          "remaining failures in tests/unit/readme.ac18.spec.ts — README missing 项目介绍 / 目录结构 / 不在本次交付范围"
      })
    ).toBe("DOCS_GAP");
    expect(
      classifyAutonomyFailure({
        summary: "11 e2e cases BLOCKED — playwright chromium missing"
      })
    ).toBe("ENV_GAP");
  });
});

describe("docs/261：过期 ENV_GAP 叙述与修复类型路由", () => {
  const staleT10 =
    "REVIEW requests CONFIG plus DOCUMENTATION. The execution report still declares 31 E2E cases with 29 BLOCKED and browserType.launch. The diagnosed ENV_GAP is cleared — chromium is present and working, smoke 2 passed. Remaining red ACs: missing .prettierignore; report file count 156 vs 167.";

  const missingPrettierignore =
    "tests/quality/t02-formatting-and-style-baseline.ac-16.spec.ts\nAssertionError: expected .prettierignore to exist\nExpected: true\nReceived: false\n4 failed, 151 passed";

  const fileCountMismatch =
    "tests/quality/t13-run-report-accuracy.ac-16.spec.ts\nAssertionError: expected 156 to be 167\nExpected: 167\nReceived: 156\n4 failed, 1462 passed";

  it("does not classify a stale 29 BLOCKED report plus ENV_GAP is cleared as ENV_GAP", () => {
    expect(classifyAutonomyFailure({ summary: staleT10 })).toBe("GATE_FAILURE");
  });

  it("routes missing .prettierignore and 156 vs 167 counts as GATE_FAILURE, not ENV_GAP", () => {
    expect(classifyAutonomyFailure({ summary: missingPrettierignore })).toBe("GATE_FAILURE");
    expect(classifyAutonomyFailure({ summary: fileCountMismatch })).toBe("GATE_FAILURE");
    expect(matchesTestAssertionFailure(missingPrettierignore)).toBe(true);
  });

  it("still classifies a genuine missing-chromium BLOCKED line as ENV_GAP", () => {
    expect(
      classifyAutonomyFailure({
        summary: "11 e2e cases BLOCKED — playwright chromium missing"
      })
    ).toBe("ENV_GAP");
  });

  it("maps CONFIG → BUILD and DOCUMENTATION → TEST", () => {
    expect(normalizeRequestedRepairType("CONFIG")).toBe("BUILD");
    expect(normalizeRequestedRepairType("DOCUMENTATION")).toBe("TEST");
    expect(normalizeRequestedRepairType("DOCS")).toBe("TEST");
    expect(normalizeRequestedRepairType("TEST")).toBe("TEST");
  });

  it("does not crush explicit CONFIG / TEST / DOCUMENTATION into BUILD for a stale ENV_GAP narrative", () => {
    expect(
      resolveRepairFixTaskType({
        failureClass: "ENV_GAP",
        explicitFixTaskType: "CONFIG",
        evidenceText: staleT10,
        profile: FRONTEND_VUE_PROFILE
      })
    ).toBe("BUILD");
    expect(
      resolveRepairFixTaskType({
        failureClass: "ENV_GAP",
        explicitFixTaskType: "DOCUMENTATION",
        evidenceText: staleT10,
        profile: FRONTEND_VUE_PROFILE
      })
    ).toBe("TEST");
    expect(
      resolveRepairFixTaskType({
        failureClass: "GATE_FAILURE",
        explicitFixTaskType: "TEST",
        evidenceText: staleT10,
        profile: FRONTEND_VUE_PROFILE
      })
    ).toBe("TEST");
  });

  it("still forces BUILD for a current missing-browser ENV_GAP, even if FRONTEND is requested", () => {
    expect(
      resolveRepairFixTaskType({
        failureClass: "ENV_GAP",
        explicitFixTaskType: "FRONTEND",
        evidenceText: "11 e2e cases BLOCKED — playwright chromium missing",
        profile: FRONTEND_VUE_PROFILE
      })
    ).toBe("BUILD");
  });
});


describe("docs/262：探测失败不得再派同一类型 TEST，同证据只修一轮", () => {
  const junkCommand =
    "npm run test -- 'Users/shixianbao/Desktop/study/taskflow-vue/tests/quality/t13-run-report-accuracy.ac-04-ac-06-ac-11-ac-14-ac-17.spec.ts' --testNamePattern '\\[AC-17\\]'";
  const officialProbeMiss = {
    summary: "Verification gate failed: checks failed: test, slice-boundary",
    verification: {
      verdict: "failed",
      reason: "checks failed: test, slice-boundary",
      checks: [
        {
          name: "test",
          command: junkCommand,
          passed: false,
          expected: "pass",
          outputDigest: "54a4ae207cb3c61b32e1dad195ffd7fd0c7fcb9359ef39db48fc8f614d74b7f2",
          uncoveredAcKeys: ["AC-17", "AC-18", "AC-19"]
        },
        {
          name: "slice-boundary",
          command: junkCommand,
          passed: false,
          expected: "pass",
          outputDigest: "54a4ae207cb3c61b32e1dad195ffd7fd0c7fcb9359ef39db48fc8f614d74b7f2"
        }
      ]
    }
  };

  it("classifies leftover Users/ official paths with 0 AC coverage as PROBE_FAILURE", () => {
    expect(
      classifyAutonomyFailure({
        errorType: "VERIFICATION_FAILED",
        ...officialProbeMiss
      })
    ).toBe("PROBE_FAILURE");
    expect(officialLooksLikeProbeFailure(officialProbeMiss.verification)).toBe(true);
  });

  it("does not open another TEST repair when the official command never reached canonical files", () => {
    expect(
      isOfficialRedPointUnreachableByTaskType({
        taskType: "TEST",
        failureClass: "PROBE_FAILURE",
        verification: officialProbeMiss.verification,
        summary: officialProbeMiss.summary
      })
    ).toBe(true);
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 1,
      errorType: "VERIFICATION_FAILED",
      ...officialProbeMiss,
      taskType: "TEST",
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(false);
    if (!decision.enter) {
      expect(decision.reason).toBe("unfixable-official-gate");
      expect(decision.failureClass).toBe("PROBE_FAILURE");
    }
  });

  it("same official digest + command + TEST write scope closes out instead of stacking REPLAN-4", () => {
    const prior = {
      digests: ["54a4ae207cb3c61b32e1dad195ffd7fd0c7fcb9359ef39db48fc8f614d74b7f2", "54a4ae207cb3c61b32e1dad195ffd7fd0c7fcb9359ef39db48fc8f614d74b7f2"],
      commands: [junkCommand, junkCommand]
    };
    // extractOfficialEvidenceFingerprint sorts unique? it does not unique, it sorts all.
    expect(
      isRepeatedOfficialEvidence({
        verification: officialProbeMiss.verification,
        priorOfficialEvidence: {
          digests: ["54a4ae207cb3c61b32e1dad195ffd7fd0c7fcb9359ef39db48fc8f614d74b7f2", "54a4ae207cb3c61b32e1dad195ffd7fd0c7fcb9359ef39db48fc8f614d74b7f2"].sort(),
          commands: [junkCommand, junkCommand].sort()
        }
      })
    ).toBe(true);
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 1,
      errorType: "VERIFICATION_FAILED",
      summary: officialProbeMiss.summary,
      verification: {
        ...officialProbeMiss.verification,
        // 即便尚未标 PROBE_FAILURE（历史 REPLAN-4 形态），同指纹也必须收口。
        checks: officialProbeMiss.verification.checks.map((check) => ({
          ...check,
          failureCode: undefined
        }))
      },
      taskType: "TEST",
      profile: FRONTEND_VUE_PROFILE,
      priorOfficialEvidence: {
        digests: ["54a4ae207cb3c61b32e1dad195ffd7fd0c7fcb9359ef39db48fc8f614d74b7f2", "54a4ae207cb3c61b32e1dad195ffd7fd0c7fcb9359ef39db48fc8f614d74b7f2"].sort(),
        commands: [junkCommand, junkCommand].sort()
      }
    });
    // 历史形态命令仍是非正规路径，会先被 unfixable-official-gate 拦住；两种收口均可。
    expect(decision.enter).toBe(false);
    if (!decision.enter) {
      expect(["repair-exhausted", "unfixable-official-gate"]).toContain(decision.reason);
    }
  });

  it("router FAILs instead of opening T-10-REPLAN-4 after the same official miss", () => {
    const router = createAutonomyFailureRouter(FRONTEND_VUE_PROFILE);
    const routed = router({
      workflow: { policy: slicePolicy, id: "wf-v11" },
      task: {
        id: "t-10-replan-3",
        projectId: "p1",
        taskKey: "T-10-REPLAN-3",
        title: "Fix quality slice",
        description: "TEST repair",
        type: "TEST",
        status: "FAILED",
        priority: "MEDIUM",
        input: { executionAttempt: 1 },
        output: {
          errorType: "VERIFICATION_FAILED",
          summary: officialProbeMiss.summary,
          verification: officialProbeMiss.verification
        },
        retryCount: 0,
        version: 1,
        createdAt: "2026-11-11T06:14:48.000Z",
        updatedAt: "2026-11-11T06:30:39.000Z"
      }
    });
    expect(routed?.strategy).toBe("FAIL");
    expect(routed?.failureClass).toBe("PROBE_FAILURE");
    expect(routed?.reason).toMatch(/Unfixable official gate/i);
  });

  it("still opens a first TEST repair for a real assertion failure on canonical files", () => {
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 0,
      errorType: "VERIFICATION_FAILED",
      summary: "Verification gate failed: checks failed: test",
      verification: {
        verdict: "failed",
        reason: "checks failed: test",
        checks: [
          {
            name: "test",
            command: "npm run test -- 'tests/quality/t13-run-report-accuracy.spec.ts'",
            passed: false,
            expected: "pass",
            outputDigest: "abc123",
            acResults: { "AC-17": "failed" }
          }
        ]
      },
      taskType: "REVIEW",
      profile: FRONTEND_VUE_PROFILE,
      explicitFixTaskType: "TEST"
    });
    expect(decision.enter).toBe(true);
    if (decision.enter) {
      expect(decision.failureClass).toBe("GATE_FAILURE");
      expect(decision.fixTaskType).toBe("TEST");
    }
  });

  it("docs write denied plus a docs red point is unreachable for TEST, but can retarget", () => {
    expect(
      isOfficialRedPointUnreachableByTaskType({
        taskType: "TEST",
        failureClass: "DOCS_GAP",
        summary: "Path is not writable: docs/test-report.md",
        verification: {
          writeScope: { deniedPaths: ["docs/test-report.md"] },
          reason: "Path is not writable: docs/test-report.md"
        }
      })
    ).toBe(true);
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 1,
      errorType: "DOCS_GAP",
      summary: "Path is not writable: docs/test-report.md; docs/delivery-report.md assertion failed",
      verification: {
        failureCode: "DOCS_GAP",
        reason: "Path is not writable: docs/test-report.md",
        writeScope: { deniedPaths: ["docs/test-report.md"] },
        checks: [
          {
            name: "test",
            command: "npm run test -- 'tests/quality/t13-run-report-accuracy.spec.ts'",
            passed: false,
            acResults: { "AC-17": "failed" }
          }
        ]
      },
      taskType: "TEST",
      profile: FRONTEND_VUE_PROFILE
    });
    // DOCS_GAP 可换到 BUILD 写 docs/**，不是再开一轮 TEST。
    expect(decision.enter).toBe(true);
    if (decision.enter) expect(decision.fixTaskType).toBe("BUILD");
  });
});


describe("docs/263：官方 pnpm workspace 错误不得收成不可修 ENV_GAP", () => {
  const agentEnvGapNarrative =
    "Documentation-truthfulness BUILD fix delivered for T-10 attempt 5. " +
    "ENV_GAP for E2E confirmed with hard evidence: npm run test:e2e -- tests/e2e/smoke.spec.ts --workers=2 exits 1 with " +
    "browserType.launch \"Executable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1254/" +
    "chrome-headless-shell-linux-arm64/chrome-headless-shell\", and the install path npm run test:e2e:install fails with " +
    "getaddrinfo EAI_AGAIN cdn.playwright.dev (runner has no network).";
  const officialPnpmWorkspaceMiss = {
    summary: agentEnvGapNarrative,
    verification: {
      verdict: "failed",
      reason: "checks failed: build, e2e, slice-boundary",
      checks: [
        {
          name: "build",
          command: "pnpm build",
          passed: false,
          expected: "pass",
          exitCode: 1,
          stderrTail: "ERROR  packages field missing or empty\nFor help, run: pnpm help run"
        },
        {
          name: "e2e",
          command: "pnpm test:e2e -- --workers=2",
          passed: false,
          expected: "pass",
          exitCode: 1,
          stderrTail: "ERROR  packages field missing or empty\nFor help, run: pnpm help run"
        },
        {
          name: "slice-boundary",
          command: "pnpm test -- 'tests/assembly/app-assembly.spec.ts'",
          passed: false,
          expected: "pass",
          exitCode: 1,
          stderrTail: "ERROR  packages field missing or empty\nFor help, run: pnpm help test"
        }
      ]
    }
  };

  it("classifies official packages-field-missing as GATE_FAILURE, not ENV_GAP", () => {
    expect(
      classifyAutonomyFailure({
        errorType: "VERIFICATION_FAILED",
        ...officialPnpmWorkspaceMiss
      })
    ).toBe("GATE_FAILURE");
    expect(officialLooksLikePackageWorkspaceFailure(officialPnpmWorkspaceMiss.verification)).toBe(
      true
    );
    expect(officialLooksLikeCurrentEnvGap(officialPnpmWorkspaceMiss.verification)).toBe(false);
  });

  it("isProvenUnfixableEnvGap ignores agent-only Playwright install narrative when official stderr is the pnpm workspace error", () => {
    expect(
      isProvenUnfixableEnvGap({
        taskType: "BUILD",
        failureClass: "ENV_GAP",
        ...officialPnpmWorkspaceMiss
      })
    ).toBe(false);
  });

  it("does not close the workflow as unfixable ENV_GAP; BUILD can still repair the workspace/lockfiles", () => {
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 1,
      errorType: "VERIFICATION_FAILED",
      ...officialPnpmWorkspaceMiss,
      taskType: "BUILD",
      profile: FRONTEND_VUE_PROFILE,
      explicitFixTaskType: "BUILD"
    });
    expect(decision.enter).toBe(true);
    if (decision.enter) {
      expect(decision.reason).not.toBe("unfixable-env-gap");
      expect(decision.failureClass).toBe("GATE_FAILURE");
      expect(decision.fixTaskType).toBe("BUILD");
    }
  });

  it("router REPLANs instead of FAILing unfixable ENV_GAP", () => {
    const router = createAutonomyFailureRouter(FRONTEND_VUE_PROFILE);
    const routed = router({
      workflow: { policy: slicePolicy, id: "wf-v11" },
      task: {
        id: "t-10-replan-5",
        projectId: "p1",
        taskKey: "T-10-REPLAN-5",
        title: "Docs + env repair",
        description: "BUILD repair",
        type: "BUILD",
        status: "FAILED",
        priority: "MEDIUM",
        input: { executionAttempt: 1 },
        output: {
          errorType: "VERIFICATION_FAILED",
          summary: officialPnpmWorkspaceMiss.summary,
          verification: officialPnpmWorkspaceMiss.verification,
          fixTaskType: "BUILD",
          failureClass: "ENV_GAP"
        },
        retryCount: 0,
        version: 1,
        createdAt: "2026-11-11T07:23:00.000Z",
        updatedAt: "2026-11-11T07:30:55.000Z"
      }
    });
    expect(routed?.strategy).toBe("REPLAN");
    expect(routed?.failureClass).toBe("GATE_FAILURE");
    expect(routed?.fixTaskType).toBe("BUILD");
    expect(routed?.reason ?? "").not.toMatch(/Unfixable ENV_GAP/i);
  });

  it("still treats official e2e missing-binary plus official install failure as unfixable ENV_GAP", () => {
    const officialE2e = {
      summary: agentEnvGapNarrative,
      verification: {
        failureCode: "ENV_GAP",
        reason: "Playwright browser binaries missing (ENV_GAP)",
        checks: [
          {
            name: "e2e",
            command: "npm run test:e2e:install",
            passed: false,
            timedOut: true,
            failureCode: "ENV_GAP",
            stderrTail:
              "getaddrinfo EAI_AGAIN cdn.playwright.dev\nExecutable doesn't exist at /opt/ms-playwright/chromium_headless_shell-1254/..."
          }
        ]
      }
    };
    expect(classifyAutonomyFailure({ errorType: "VERIFICATION_FAILED", ...officialE2e })).toBe(
      "ENV_GAP"
    );
    expect(
      isProvenUnfixableEnvGap({
        taskType: "BUILD",
        failureClass: "ENV_GAP",
        ...officialE2e
      })
    ).toBe(true);
  });

  it("agent-only Playwright install narrative without official e2e/install checks is not proven unfixable", () => {
    expect(
      isProvenUnfixableEnvGap({
        taskType: "BUILD",
        failureClass: "ENV_GAP",
        summary: agentEnvGapNarrative
      })
    ).toBe(false);
  });
});

describe("docs/264：官方 e2e ENV_GAP 不依赖安装命令文本，截断日志也能收口", () => {
  const officialE2eEnvGapNoInstall = {
    summary: "BUILD finished; official e2e still ENV_GAP",
    verification: {
      failureCode: "ENV_GAP",
      reason: "Playwright browser binaries missing (ENV_GAP)",
      checks: [
        {
          name: "build",
          command: "npm run build",
          passed: true
        },
        {
          name: "e2e",
          command: "npm run test:e2e -- --workers=2",
          passed: false,
          expected: "pass",
          exitCode: 1,
          failureCode: "ENV_GAP",
          stdoutTail: "",
          stderrTail: ""
        }
      ]
    }
  };

  it("officialLooksLikeCurrentEnvGap honors stamped failureCode=ENV_GAP when tails are empty", () => {
    expect(officialLooksLikeCurrentEnvGap(officialE2eEnvGapNoInstall.verification)).toBe(true);
  });

  it("isProvenUnfixableEnvGap after BUILD when official e2e is ENV_GAP without install-command text", () => {
    expect(
      isProvenUnfixableEnvGap({
        taskType: "BUILD",
        failureClass: "ENV_GAP",
        ...officialE2eEnvGapNoInstall
      })
    ).toBe(true);
  });

  it("does not open another BUILD install loop for official contract-mismatch ENV_GAP", () => {
    const decision = decideGateFailureRepair({
      policy: slicePolicy,
      executionAttempt: 1,
      ...officialE2eEnvGapNoInstall,
      verification: {
        ...officialE2eEnvGapNoInstall.verification,
        checks: [
          {
            name: "e2e",
            command: "npm run test:e2e -- --workers=2",
            passed: false,
            failureCode: "ENV_GAP",
            stderrTail:
              "PLAYWRIGHT_CONTRACT_MISMATCH: product Playwright 1.65.0 requires chromium-1254; platform contract is 1.64.1 / chromium-1248"
          }
        ]
      },
      taskType: "BUILD",
      profile: FRONTEND_VUE_PROFILE
    });
    expect(decision.enter).toBe(false);
    if (!decision.enter) {
      expect(decision.reason).toBe("unfixable-env-gap");
      expect(decision.failureClass).toBe("ENV_GAP");
    }
  });

  it("still does not treat official pnpm workspace errors as unfixable ENV_GAP", () => {
    expect(
      officialLooksLikeCurrentEnvGap({
        failureCode: "ENV_GAP",
        checks: [
          {
            name: "e2e",
            command: "pnpm test:e2e -- --workers=2",
            passed: false,
            stderrTail: "ERROR  packages field missing or empty"
          }
        ]
      })
    ).toBe(false);
  });
});



describe("docs/265：官方视觉失败走 VISUAL / FRONTEND，不得收成 ENV_GAP", () => {
  const visualVerification = {
    verdict: "failed",
    failureCode: "VISUAL_DEFAULT_SKIN",
    reason: "checks failed: visual",
    checks: [
      {
        name: "visual",
        command: "node -e OFFICIAL_VISUAL_GATE npm run preview",
        passed: false,
        failureCode: "VISUAL_DEFAULT_SKIN",
        stderrTail:
          "日期面板含默认大日历插画。browserType.launch leftover in capture log must not become ENV_GAP."
      }
    ]
  };

  it("classifies official visual failure as VISUAL even if capture logs mention Playwright", () => {
    expect(
      classifyAutonomyFailure({
        errorType: "VISUAL_DEFAULT_SKIN",
        summary: "已按 UI 图实现",
        verification: visualVerification
      })
    ).toBe("VISUAL");
    expect(
      classifyAutonomyFailure({
        errorType: "VISUAL_BASELINE_MISSING",
        verification: {
          failureCode: "VISUAL_BASELINE_MISSING",
          checks: [
            { name: "visual", passed: false, failureCode: "VISUAL_BASELINE_MISSING" }
          ]
        }
      })
    ).toBe("VISUAL");
    expect(repairHintForFailureClass("VISUAL")).toMatch(/design-intent|FRONTEND|pixel/i);
  });

  it("routes VISUAL repair to FRONTEND and not BUILD / ENV_GAP", () => {
    expect(
      resolveRepairFixTaskType({
        failureClass: "VISUAL",
        profile: FRONTEND_VUE_PROFILE,
        taskType: "TEST",
        evidenceText: "VISUAL_DEFAULT_SKIN: 默认日期面板"
      })
    ).toBe("FRONTEND");
  });
});
