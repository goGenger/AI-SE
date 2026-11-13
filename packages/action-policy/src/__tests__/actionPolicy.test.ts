import { ToolRuntime, type ToolDefinition, type ToolExecutionContext } from "@ai-se/tool-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ActionPolicy,
  ActionPolicyError,
  applyActionPolicy,
  BROWSER_ACTION_POLICY,
  defaultActionPolicy,
  type ActionMetadata,
  type ExternalActionDeclaration,
  verbFloor
} from "../index";

/** Phase 5.7-3: unified Action Policy unit coverage. */

const fakeSandbox = {
  async runCommand() {
    return { command: "", exitCode: 0, stdout: "", stderr: "", duration: 0, timedOut: false };
  }
};

function makeContext(
  metadata: Record<string, unknown> = {},
  overrides: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
  return {
    requestId: "req-policy-1",
    taskId: "task-1",
    agentRunId: "run-1",
    toolCallId: "call-1",
    actor: "policy-test",
    workspacePath: "/workspace",
    sandbox: fakeSandbox,
    metadata,
    ...overrides
  };
}

function stubDefinition(
  name: string,
  riskLevel: ToolDefinition<unknown, unknown>["riskLevel"],
  onExecute: () => void = () => undefined
): ToolDefinition<unknown, unknown> {
  return {
    name,
    description: `stub ${name}`,
    riskLevel,
    inputSchema: z.object({}).passthrough(),
    async execute() {
      onExecute();
      return { ok: true };
    }
  };
}

describe("5.7-3 unified risk mapping (frozen table)", () => {
  it("maps read/search/list actions to LOW, create/update to MEDIUM, destructive verbs to HIGH", () => {
    expect(
      defaultActionPolicy.resolveExternal("issues.list", {
        riskLevel: "LOW",
        requiresApproval: false
      })
    ).toEqual({
      riskLevel: "LOW",
      requiresApproval: false
    });
    expect(
      defaultActionPolicy.resolveExternal("issues.create", {
        riskLevel: "MEDIUM",
        requiresApproval: false
      })
    ).toEqual({ riskLevel: "MEDIUM", requiresApproval: false });
    for (const action of [
      "releases.publish",
      "repo.commit",
      "repo.push",
      "branch.merge",
      "issues.delete",
      "site.deploy",
      "release.rollback",
      "file.write"
    ]) {
      const decision = defaultActionPolicy.resolveExternal(action, {
        riskLevel: "LOW",
        requiresApproval: false
      });
      expect(decision, action).toEqual({ riskLevel: "HIGH", requiresApproval: true });
    }
  });

  it("the frozen table only produces LOW/MEDIUM/HIGH; CRITICAL stays a declared-only level", () => {
    const decisions = Object.values(BROWSER_ACTION_POLICY);
    expect(decisions.every((entry) => ["LOW", "MEDIUM", "HIGH"].includes(entry.riskLevel))).toBe(
      true
    );
    const critical = defaultActionPolicy.resolveExternal("db.destroy.production", {
      riskLevel: "CRITICAL",
      requiresApproval: true
    });
    expect(critical).toEqual({ riskLevel: "CRITICAL", requiresApproval: true });
  });

  it("verb floors classify by name tokens (strongest wins)", () => {
    expect(verbFloor("browser.action.click")).toBe("MEDIUM");
    expect(verbFloor("browser.observe")).toBe("LOW");
    expect(verbFloor("releases.publish")).toBe("HIGH");
    expect(verbFloor("issues.fail")).toBeUndefined();
  });
});

describe("5.7-3 browser action risk", () => {
  it("the 5.7-1 browser action set resolves through the frozen platform table", () => {
    expect(defaultActionPolicy.resolveBrowser("browser.observe")).toEqual({
      riskLevel: "LOW",
      requiresApproval: false
    });
    expect(defaultActionPolicy.resolveBrowser("browser.action.navigate")).toEqual({
      riskLevel: "LOW",
      requiresApproval: false
    });
    expect(defaultActionPolicy.resolveBrowser("browser.action.screenshot")).toEqual({
      riskLevel: "LOW",
      requiresApproval: false
    });
    expect(defaultActionPolicy.resolveBrowser("browser.action.click")).toEqual({
      riskLevel: "MEDIUM",
      requiresApproval: false
    });
    expect(defaultActionPolicy.resolveBrowser("browser.action.type")).toEqual({
      riskLevel: "MEDIUM",
      requiresApproval: false
    });
  });

  it("unknown browser actions DENY (fail closed)", () => {
    expect(defaultActionPolicy.resolveBrowser("browser.action.delete")).toBeUndefined();
    expect(defaultActionPolicy.resolveBrowser("browser.doAnything")).toBeUndefined();
    expect(
      defaultActionPolicy.approvalRequiredFor({ source: "browser", action: "browser.unknown" })
    ).toBeUndefined();
  });

  it("browser metadata cannot propose a risk level (spoofing denied)", () => {
    // The browser arm carries no declaration; a caller-forged one is ignored.
    const forged = {
      source: "browser",
      action: "browser.action.click",
      declared: { riskLevel: "LOW", requiresApproval: false }
    } as unknown as ActionMetadata;
    expect(defaultActionPolicy.resolve(forged)).toEqual({
      riskLevel: "MEDIUM",
      requiresApproval: false
    });
  });
});

describe("5.7-3 external action risk (declaration is an input, never the authority)", () => {
  it("a declaration can raise risk but never lower it below the verb floor", () => {
    // Misdeclared LOW → floor HIGH wins (task's release/publish defaults).
    expect(
      defaultActionPolicy.resolveExternal("releases.publish", {
        riskLevel: "LOW",
        requiresApproval: false
      })
    ).toEqual({ riskLevel: "HIGH", requiresApproval: true });
    // Declared MEDIUM on a floor-LOW action stands (raise allowed).
    expect(
      defaultActionPolicy.resolveExternal("issues.list", {
        riskLevel: "MEDIUM",
        requiresApproval: false
      })
    ).toEqual({ riskLevel: "MEDIUM", requiresApproval: false });
  });

  it("approvalRequired is DERIVED from risk; a declared false cannot waive high risk", () => {
    expect(
      defaultActionPolicy.resolveExternal("issues.delete", {
        riskLevel: "MEDIUM",
        requiresApproval: false
      })
    ).toEqual({ riskLevel: "HIGH", requiresApproval: true });
    // Declared raises the requirement too.
    expect(
      defaultActionPolicy.resolveExternal("issues.create", {
        riskLevel: "MEDIUM",
        requiresApproval: true
      })
    ).toEqual({ riskLevel: "MEDIUM", requiresApproval: true });
  });

  it("undeclared / invalid declarations DENY (fail closed)", () => {
    expect(defaultActionPolicy.resolveExternal("issues.list", undefined)).toBeUndefined();
    expect(
      defaultActionPolicy.resolveExternal("issues.list", {
        riskLevel: "SEVERE" as never,
        requiresApproval: false
      })
    ).toBeUndefined();
    expect(
      defaultActionPolicy.resolveExternal("issues.list", {
        riskLevel: "LOW",
        requiresApproval: "yes" as never
      })
    ).toBeUndefined();
  });

  it("approvalRequiredFor mirrors the decision for both sources", () => {
    const released: ExternalActionDeclaration = { riskLevel: "HIGH", requiresApproval: true };
    expect(
      defaultActionPolicy.approvalRequiredFor({
        source: "external",
        action: "releases.publish",
        declared: released
      })
    ).toBe(true);
    expect(
      defaultActionPolicy.approvalRequiredFor({
        source: "external",
        action: "issues.list",
        declared: { riskLevel: "LOW", requiresApproval: false }
      })
    ).toBe(false);
  });
});

describe("5.7-3 enforcement: applyActionPolicy + shared approval gate", () => {
  it("applies policy decisions to a browser definition set and rejects spoofed-low declarations", () => {
    const policy = new ActionPolicy({
      browserActions: {
        "browser.observe": { riskLevel: "LOW", requiresApproval: false },
        "browser.action.click": { riskLevel: "MEDIUM", requiresApproval: false },
        "browser.action.publishPage": { riskLevel: "HIGH", requiresApproval: true }
      }
    });
    const [observe, click, publish] = applyActionPolicy(
      [
        stubDefinition("browser.observe", "LOW"),
        stubDefinition("browser.action.click", "MEDIUM"),
        stubDefinition("browser.action.publishPage", "HIGH")
      ],
      { source: "browser", policy }
    );
    expect(observe.riskLevel).toBe("LOW");
    expect(click.riskLevel).toBe("MEDIUM");
    expect(publish.riskLevel).toBe("HIGH");

    // The policy is authoritative: an over-declared definition is normalized down.
    const [normalized] = applyActionPolicy([stubDefinition("browser.action.click", "HIGH")], {
      source: "browser",
      policy
    });
    expect(normalized.riskLevel).toBe("MEDIUM");

    // A definition declaring BELOW the policy is a composition-time DENY.
    expect(() =>
      applyActionPolicy([stubDefinition("browser.action.click", "LOW")], {
        source: "browser",
        policy
      })
    ).toThrow(ActionPolicyError);
    expect(() =>
      applyActionPolicy([stubDefinition("browser.action.publishPage", "LOW")], {
        source: "browser",
        policy
      })
    ).toThrow(/below the policy decision HIGH/);
    // Unknown action → DENY.
    expect(() =>
      applyActionPolicy([stubDefinition("browser.action.delete", "HIGH")], {
        source: "browser",
        policy
      })
    ).toThrow(/unknown browser action/);
  });

  it("external sets apply declarations through the same policy (and deny undeclared actions)", () => {
    const declarations: Record<string, ExternalActionDeclaration> = {
      "issues.list": { riskLevel: "LOW", requiresApproval: false },
      "releases.publish": { riskLevel: "HIGH", requiresApproval: true }
    };
    const [list, publish] = applyActionPolicy(
      [stubDefinition("issues.list", "LOW"), stubDefinition("releases.publish", "HIGH")],
      { source: "external", declarations }
    );
    expect(list.riskLevel).toBe("LOW");
    expect(publish.riskLevel).toBe("HIGH");
    expect(() =>
      applyActionPolicy([stubDefinition("issues.hidden", "LOW")], {
        source: "external",
        declarations
      })
    ).toThrow(/unknown external action/);
  });

  it("approval gate: unapproved high-risk calls fail with zero execution; approved calls run", async () => {
    let executed = 0;
    const policy = new ActionPolicy({
      browserActions: { "browser.action.risky": { riskLevel: "HIGH", requiresApproval: true } }
    });
    const [risky] = applyActionPolicy(
      [stubDefinition("browser.action.risky", "HIGH", () => (executed += 1))],
      { source: "browser", policy }
    );
    const runtime = new ToolRuntime({ tools: [risky] });

    const denied = await runtime.execute("browser.action.risky", {}, makeContext());
    expect(denied.success).toBe(false);
    expect(denied.error?.code).toBe("TOOL_ERROR");
    expect(denied.error?.message).toContain("requires human approval");
    expect(denied.audit.riskLevel).toBe("HIGH");
    expect(executed).toBe(0); // zero downstream execution

    const approved = await runtime.execute(
      "browser.action.risky",
      {},
      makeContext({ approved: true })
    );
    expect(approved.success).toBe(true);
    expect(executed).toBe(1);

    // A non-boolean approval flag does not count.
    const forged = await runtime.execute(
      "browser.action.risky",
      {},
      makeContext({ approved: "true" })
    );
    expect(forged.success).toBe(false);
    expect(executed).toBe(1);
  });
});
