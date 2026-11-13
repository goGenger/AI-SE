import { BACKEND_NODE_PROFILE, FRONTEND_VUE_PROFILE, type Task } from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  OFFICIAL_VISUAL_GATE_MARKER,
  buildOfficialVisualCommand,
  buildVisualInventory,
  evaluateOfficialVisualIntent,
  isOfficialVisualFailureCode,
  isUiFacingVisualWork,
  officialVisualFromVerification,
  parseOfficialVisualOutput,
  type OfficialVisualBaseline,
  type OfficialVisualCapture,
  type VisualInventoryEntry
} from "../services/officialVisualGate";

function task(type: Task["type"]): Task {
  const now = new Date().toISOString();
  return {
    id: `task-${type}`,
    projectId: "p",
    taskKey: "T1",
    title: type,
    description: "",
    type,
    status: "SUCCESS",
    priority: "MEDIUM",
    input: {},
    retryCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now
  };
}

const pageBaseline: OfficialVisualBaseline = {
  fileName: "task-list.png",
  mimeType: "image/png",
  note: "任务列表主页面"
};

const dialogDateBaseline: OfficialVisualBaseline = {
  fileName: "edit-dialog-datepicker.png",
  mimeType: "image/png",
  note: "编辑任务对话框与日期面板"
};

function inventoryWith(
  baselines: OfficialVisualBaseline[],
  requirementText?: string
): VisualInventoryEntry[] {
  return buildVisualInventory({ baselines, requirementText });
}

function passingCapture(states: OfficialVisualCapture["states"]): OfficialVisualCapture {
  return {
    booted: true,
    usedFileProtocol: false,
    pageStatus: 200,
    browser: "playwright",
    protocol: "http:",
    appUrl: "http://127.0.0.1:47001/",
    states
  };
}

describe("isUiFacingVisualWork", () => {
  it("treats frontend-vue / ui boundary as UI-facing even without a FRONTEND task list", () => {
    expect(isUiFacingVisualWork({ profile: FRONTEND_VUE_PROFILE, sliceTasks: [task("TEST")] })).toBe(
      true
    );
  });

  it("allows backend-only slices with no frontend work to have no baseline", () => {
    expect(
      isUiFacingVisualWork({
        profile: BACKEND_NODE_PROFILE,
        sliceTasks: [task("BACKEND"), task("TEST")]
      })
    ).toBe(false);
  });

  it("treats a backend profile slice that still has a FRONTEND task as UI-facing", () => {
    expect(
      isUiFacingVisualWork({
        profile: BACKEND_NODE_PROFILE,
        sliceTasks: [task("FRONTEND"), task("TEST")]
      })
    ).toBe(true);
  });
});

describe("buildVisualInventory", () => {
  it("requires the main page when any UI baseline is attached, and marks undeclared states as not-in-scope", () => {
    const inventory = inventoryWith([pageBaseline], "纯列表页，不涉及编辑");
    const byKind = Object.fromEntries(inventory.map((entry) => [entry.kind, entry]));
    expect(byKind.page?.status).toBe("required");
    expect(byKind.page?.baselineFileName).toBe("task-list.png");
    expect(byKind.dialog?.status).toBe("not-in-scope");
    expect(byKind["date-panel"]?.status).toBe("not-in-scope");
    expect(byKind.dialog?.source).toBe("inferred-not-in-scope");
  });

  it("requires dialog and date-panel when baselines or requirement text declare them", () => {
    const inventory = inventoryWith(
      [pageBaseline, dialogDateBaseline],
      "支持在对话框里用日期选择器编辑任务"
    );
    const byKind = Object.fromEntries(inventory.map((entry) => [entry.kind, entry]));
    expect(byKind.dialog?.status).toBe("required");
    expect(byKind["date-panel"]?.status).toBe("required");
    expect(byKind["date-panel"]?.baselineFileName).toBe("edit-dialog-datepicker.png");
  });

  it("fails closed when requirement text declares a date panel but no baseline is attached", () => {
    const inventory = inventoryWith([pageBaseline], "编辑对话框里要打开日期面板选择截止日期");
    const date = inventory.find((entry) => entry.kind === "date-panel");
    expect(date?.status).toBe("required");
    expect(date?.baselineFileName).toBeUndefined();
  });

  it("honors an explicit 不含 mark instead of inferring a required state", () => {
    const inventory = inventoryWith(
      [
        pageBaseline,
        { fileName: "notes.txt.png", mimeType: "image/png", note: "日期面板本需求不含" }
      ],
      "列表页"
    );
    expect(inventory.find((entry) => entry.kind === "date-panel")?.status).toBe("not-in-scope");
    expect(inventory.find((entry) => entry.kind === "date-panel")?.source).toBe(
      "explicit-out-of-scope"
    );
  });
});

describe("evaluateOfficialVisualIntent", () => {
  const reqText = "列表、编辑对话框和日期面板";
  const baselines = [pageBaseline, dialogDateBaseline];
  const inventory = inventoryWith(baselines, reqText);

  function opened(kind: OfficialVisualCapture["states"][number]["kind"], features = {}) {
    return { kind, opened: true, features, screenshotRef: `${kind}.png` };
  }

  it("fails UI-facing work with no baselines as VISUAL_BASELINE_MISSING and does not skip", () => {
    const result = evaluateOfficialVisualIntent({
      uiFacing: true,
      baselines: [],
      inventory: inventoryWith([], reqText)
    });
    expect(result.passed).toBe(false);
    expect(result.skipped).toBeFalsy();
    expect(result.failureCode).toBe("VISUAL_BASELINE_MISSING");
  });

  it("fails when a declared key state has no baseline, even if other images exist", () => {
    const result = evaluateOfficialVisualIntent({
      uiFacing: true,
      baselines: [pageBaseline],
      inventory: inventoryWith([pageBaseline], "必须提供日期面板")
    });
    expect(result.passed).toBe(false);
    expect(result.failureCode).toBe("VISUAL_BASELINE_MISSING");
    expect(result.reason).toContain("date-panel");
  });

  it("skips and passes for non-UI work with no baselines", () => {
    const result = evaluateOfficialVisualIntent({
      uiFacing: false,
      baselines: [],
      inventory: inventoryWith([])
    });
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("not-ui-facing");
    expect(result.failureCode).toBeUndefined();
  });

  it("fails default Element Plus date-panel skin (illustration / oversized arrows / unwrapped)", () => {
    const capture = passingCapture([
      opened("page"),
      opened("dialog"),
      opened("date-panel", {
        defaultPickerPanel: true,
        pickerIllustration: true,
        oversizedPickerArrows: true,
        unwrappedElDateEditor: true,
        wrapperContractPresent: false
      })
    ]);
    const result = evaluateOfficialVisualIntent({
      uiFacing: true,
      baselines,
      inventory,
      capture
    });
    expect(result.passed).toBe(false);
    expect(result.failureCode).toBe("VISUAL_DEFAULT_SKIN");
    expect(result.reason).toMatch(/插画|箭头|封装/);
  });

  it("does not fail on slight spacing, color, or pixel-diff signals alone", () => {
    const capture = passingCapture([
      opened("page", { minorSpacingDrift: true, minorColorDrift: true, pixelDiffRatio: 0.08 }),
      opened("dialog"),
      opened("date-panel", { wrapperContractPresent: true })
    ]);
    const result = evaluateOfficialVisualIntent({
      uiFacing: true,
      baselines,
      inventory,
      capture
    });
    expect(result.passed).toBe(true);
    expect(result.failureCode).toBeUndefined();
    expect(result.reason).toMatch(/轻微|像素差/);
  });

  it("fails when a required key state cannot be opened", () => {
    const capture = passingCapture([
      opened("page"),
      opened("dialog"),
      { kind: "date-panel", opened: false, detail: "date panel not visible" }
    ]);
    const result = evaluateOfficialVisualIntent({
      uiFacing: true,
      baselines,
      inventory,
      capture
    });
    expect(result.passed).toBe(false);
    expect(result.failureCode).toBe("VISUAL_STATE_UNREACHABLE");
  });

  it("fails file:// capture even if states look opened", () => {
    const result = evaluateOfficialVisualIntent({
      uiFacing: true,
      baselines,
      inventory,
      capture: {
        booted: true,
        usedFileProtocol: true,
        pageStatus: 200,
        browser: "playwright",
        protocol: "file:",
        states: [opened("page"), opened("dialog"), opened("date-panel")]
      }
    });
    expect(result.passed).toBe(false);
    expect(result.failureCode).toBe("VISUAL_CAPTURE_FAILED");
    expect(result.reason).toContain("file://");
  });

  it("does not mark visual green when no official capture exists", () => {
    const result = evaluateOfficialVisualIntent({
      uiFacing: true,
      baselines,
      inventory
    });
    expect(result.passed).toBe(false);
    expect(result.failureCode).toBe("VISUAL_JUDGE_UNAVAILABLE");
  });

  it("can pass with deterministic checks when no VLM judge is configured", () => {
    const result = evaluateOfficialVisualIntent({
      uiFacing: true,
      baselines,
      inventory,
      capture: passingCapture([opened("page"), opened("dialog"), opened("date-panel")]),
      judge: { available: false }
    });
    expect(result.passed).toBe(true);
    expect(result.judged).toBe("deterministic");
    expect(result.reason).toMatch(/未配置视觉判断器|确定性/);
  });

  it("fails an available intent judge that reports a clear mismatch, not a 2% pixel ratio", () => {
    const result = evaluateOfficialVisualIntent({
      uiFacing: true,
      baselines,
      inventory,
      capture: passingCapture([
        opened("page", { pixelDiffRatio: 0.02 }),
        opened("dialog"),
        opened("date-panel")
      ]),
      judge: { available: true, intentMismatch: true, detail: "信息层级和主色与基线明显不符" }
    });
    expect(result.passed).toBe(false);
    expect(result.failureCode).toBe("VISUAL_INTENT_MISMATCH");
  });
});

describe("parseOfficialVisualOutput / command marker", () => {
  it("parses the last JSON capture line and keeps default-skin features", () => {
    const stdout = [
      "server started",
      JSON.stringify({
        booted: true,
        usedFileProtocol: false,
        pageStatus: 200,
        browser: "playwright",
        protocol: "http:",
        appUrl: "http://127.0.0.1:1/",
        states: [
          {
            kind: "date-panel",
            opened: true,
            features: { pickerIllustration: true, defaultPickerPanel: true }
          }
        ]
      })
    ].join("\n");
    const parsed = parseOfficialVisualOutput(stdout);
    expect(parsed?.booted).toBe(true);
    expect(parsed?.states[0]?.features?.pickerIllustration).toBe(true);
  });

  it("embeds the official visual marker so tests and logs can recognize the command", () => {
    const inventory = inventoryWith([pageBaseline]);
    const command = buildOfficialVisualCommand({
      startCommand: "npm run preview",
      port: 47001,
      inventory
    });
    expect(command).toContain(OFFICIAL_VISUAL_GATE_MARKER);
    expect(command).toContain("npm run preview");
    expect(command).not.toContain("file://");
  });
});

describe("officialVisualFromVerification", () => {
  it("reads the official visual check, ignoring an agent self-report elsewhere in the record", () => {
    const visual = officialVisualFromVerification({
      verdict: "failed",
      reason: "checks failed: visual",
      checks: [
        {
          name: "visual",
          passed: false,
          failureCode: "VISUAL_DEFAULT_SKIN",
          visual: { passed: false, failureCode: "VISUAL_DEFAULT_SKIN", reason: "默认日期面板" }
        }
      ]
    });
    expect(visual?.passed).toBe(false);
    expect(visual?.failureCode).toBe("VISUAL_DEFAULT_SKIN");
    expect(isOfficialVisualFailureCode("VISUAL_DEFAULT_SKIN")).toBe(true);
  });
});
