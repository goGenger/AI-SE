import type { ToolRiskLevel } from "@ai-se/tool-runtime";

/**
 * Phase 5.7-3: unified Action Policy.
 *
 * ONE policy resolves {riskLevel, requiresApproval} for both Browser Actions
 * (5.7-1) and External Engineering Actions (5.7-2):
 *
 *   Action Metadata → Platform Action Policy → { riskLevel, requiresApproval }
 *   → ToolRuntime → Execution
 *
 * Rules (frozen by this phase):
 *  - LOW / MEDIUM / HIGH frozen table for the actions themselves (the wider
 *    ToolRiskLevel vocabulary keeps CRITICAL as a valid DECLARED level; the
 *    table never produces it and CRITICAL is treated as ≥ HIGH).
 *  - Risk is platform-declared only. An action name additionally carries a
 *    VERB FLOOR (read/search/list → LOW, create/update → MEDIUM,
 *    publish/commit/delete/deployment/write/push/merge → HIGH): a declaration
 *    may RAISE risk but can never lower it below the floor.
 *  - approvalRequired is DERIVED here: high-risk actions (HIGH / CRITICAL)
 *    always require human approval; a declaration may only raise it.
 *  - Fail closed: unknown browser action, unknown/invalid external
 *    declaration → DENY (no decision). Callers must treat "no decision" as
 *    "do not execute".
 *  - Neither agent arguments nor remote MCP metadata participate: browser
 *    metadata carries no declaration at all (arguments cannot lower risk),
 *    and the external declaration comes from the platform-owned catalog.
 */

export type ActionSource = "browser" | "external";

export interface ActionPolicyDecision {
  riskLevel: ToolRiskLevel;
  requiresApproval: boolean;
}

/** Platform declaration for an external action (from the ExternalToolCatalog). */
export interface ExternalActionDeclaration {
  riskLevel: ToolRiskLevel;
  /** Declared preference; may only RAISE the derived requirement, never lower it. */
  requiresApproval: boolean;
}

export type ActionMetadata =
  | { source: "browser"; action: string }
  | { source: "external"; action: string; declared: ExternalActionDeclaration };

export class ActionPolicyError extends Error {}

export const RISK_LEVELS: readonly ToolRiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

const RISK_ORDER: Record<ToolRiskLevel, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

export function riskRank(level: ToolRiskLevel): number {
  return RISK_ORDER[level];
}

export function maxRisk(a: ToolRiskLevel, b: ToolRiskLevel): ToolRiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

function requiresApprovalFor(risk: ToolRiskLevel): boolean {
  return risk === "HIGH" || risk === "CRITICAL";
}

/**
 * Frozen 5.7-3 verb → risk floors (docs/24 semantics). Tokens are matched
 * against every `[A-Za-z0-9]+` segment of the action name; the strongest match
 * wins, so `releases.publish` floors at HIGH even if declared LOW.
 */
export const ACTION_RISK_FLOORS: Readonly<Record<"LOW" | "MEDIUM" | "HIGH", readonly string[]>> = {
  LOW: [
    "observe",
    "screenshot",
    "navigate",
    "read",
    "list",
    "search",
    "status",
    "get",
    "fetch",
    "view",
    "inspect",
    "check",
    "health",
    "docs",
    "info",
    "lookup",
    "query"
  ],
  MEDIUM: [
    "click",
    "type",
    "create",
    "update",
    "edit",
    "modify",
    "add",
    "insert",
    "save",
    "comment",
    "send",
    "submit",
    "apply"
  ],
  HIGH: [
    "publish",
    "commit",
    "push",
    "merge",
    "delete",
    "remove",
    "drop",
    "destroy",
    "deploy",
    "deployment",
    "release",
    "rollback",
    "write"
  ]
};

/**
 * Frozen 5.7-3 browser action allowlist (the 5.7-1 action set). Browser risk
 * comes from this platform table ONLY — browser action metadata carries no
 * declaration, and tool arguments cannot introduce one.
 */
export const BROWSER_ACTION_POLICY: Readonly<Record<string, ActionPolicyDecision>> = {
  "browser.observe": { riskLevel: "LOW", requiresApproval: false },
  "browser.action.navigate": { riskLevel: "LOW", requiresApproval: false },
  "browser.action.screenshot": { riskLevel: "LOW", requiresApproval: false },
  "browser.action.click": { riskLevel: "MEDIUM", requiresApproval: false },
  "browser.action.type": { riskLevel: "MEDIUM", requiresApproval: false }
};

/** Strongest verb-floor risk found in the action name (undefined = unclassified). */
export function verbFloor(action: string): ToolRiskLevel | undefined {
  const tokens = action
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
  for (const level of ["HIGH", "MEDIUM", "LOW"] as const) {
    if (tokens.some((token) => ACTION_RISK_FLOORS[level].includes(token))) return level;
  }
  return undefined;
}

export interface ActionPolicyOptions {
  /** Platform browser table override (tests / future phases); default = frozen 5.7-3 table. */
  browserActions?: Readonly<Record<string, ActionPolicyDecision>>;
}

export class ActionPolicy {
  private readonly browserActions: Readonly<Record<string, ActionPolicyDecision>>;

  constructor(options: ActionPolicyOptions = {}) {
    this.browserActions = options.browserActions ?? BROWSER_ACTION_POLICY;
  }

  /**
   * Browser action decision or undefined (DENY). The platform table declares
   * the risk; the verb floor can only raise it.
   */
  resolveBrowser(action: string): ActionPolicyDecision | undefined {
    const declared = this.browserActions[action];
    if (!declared) return undefined; // unknown action → DENY
    const floor = verbFloor(action);
    const riskLevel = floor ? maxRisk(declared.riskLevel, floor) : declared.riskLevel;
    return {
      riskLevel,
      requiresApproval: declared.requiresApproval || requiresApprovalFor(riskLevel)
    };
  }

  /**
   * External action decision or undefined (DENY). `declared` is the
   * platform-owned catalog entry; invalid declarations fail closed, and the
   * verb floor prevents a misdeclaration from lowering risk.
   */
  resolveExternal(
    action: string,
    declared: ExternalActionDeclaration | undefined
  ): ActionPolicyDecision | undefined {
    if (
      !declared ||
      !RISK_LEVELS.includes(declared.riskLevel) ||
      typeof declared.requiresApproval !== "boolean"
    ) {
      return undefined; // fail closed
    }
    const floor = verbFloor(action);
    const riskLevel = floor ? maxRisk(declared.riskLevel, floor) : declared.riskLevel;
    return {
      riskLevel,
      requiresApproval: declared.requiresApproval || requiresApprovalFor(riskLevel)
    };
  }

  /** Unified entry point for both sources. undefined = DENY. */
  resolve(metadata: ActionMetadata): ActionPolicyDecision | undefined {
    if (metadata.source === "browser") {
      // Browser metadata deliberately carries no declaration: neither tool
      // arguments nor callers can propose a risk level.
      return this.resolveBrowser(metadata.action);
    }
    return this.resolveExternal(metadata.action, metadata.declared);
  }

  /** 5.7-3 approvalRequired derivation. undefined = DENY (fail closed). */
  approvalRequiredFor(metadata: ActionMetadata): boolean | undefined {
    return this.resolve(metadata)?.requiresApproval;
  }
}

export const defaultActionPolicy = new ActionPolicy();
