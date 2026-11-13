import {
  INCIDENT_AUTO_REMEDIATE_WHITELIST,
  INCIDENT_REMEDIATION_WHITELIST,
  IncidentRemediationFaultTypeSchema,
  type Incident,
  type IncidentRemediationFaultType,
  type TaskPlan
} from "@ai-se/shared";

/**
 * Phase 8-C/8-D whitelist + staging-bound delivery plan factory (docs/242 SRE-09…15).
 *
 * Production DEPLOY is included so the existing WorkflowRepository /
 * WorkflowEngine approval rules apply (`environment === "production"` ⇒
 * `approvalRequired`). Staging VERIFY failure blocks PRODUCTION via task
 * dependencies — no parallel executor.
 *
 * 8-D: when `INCIDENT_AUTO_REMEDIATE` is on, remediating a whitelisted fault
 * type may auto-start the workflow through staging VERIFY. Production still
 * waits for approval; the written whitelist is not expanded.
 */

const WHITELIST = new Set<string>(INCIDENT_REMEDIATION_WHITELIST);
const AUTO_WHITELIST = new Set<string>(INCIDENT_AUTO_REMEDIATE_WHITELIST);

/** Resolve fault type from alert labels (canonical: faultType). */
export function resolveIncidentFaultType(incident: Incident): string | undefined {
  const raw = incident.labels.faultType ?? incident.labels.fault_type;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isWhitelistedFaultType(
  faultType: string | undefined
): faultType is IncidentRemediationFaultType {
  if (!faultType) return false;
  return WHITELIST.has(faultType) && IncidentRemediationFaultTypeSchema.safeParse(faultType).success;
}

/** 8-D: auto-start eligible = same written table as 8-C (not a wider set). */
export function isAutoRemediateFaultType(
  faultType: string | undefined
): faultType is IncidentRemediationFaultType {
  if (!isWhitelistedFaultType(faultType)) return false;
  return AUTO_WHITELIST.has(faultType);
}

/**
 * Decide whether to call WorkflowService.start after create.
 * - Explicit `startWorkflow` wins.
 * - Else auto-start only when server flag is on AND fault type is on the written auto table.
 * Default (flag off, no explicit start) ⇒ false (8-C behavior).
 */
export function resolveRemediationAutoStart(input: {
  autoRemediateEnabled: boolean;
  faultType: string | undefined;
  startWorkflow?: boolean;
}): { start: boolean; autoStarted: boolean } {
  if (input.startWorkflow === true) {
    return {
      start: true,
      autoStarted: false
    };
  }
  if (input.startWorkflow === false) {
    return { start: false, autoStarted: false };
  }
  if (input.autoRemediateEnabled && isAutoRemediateFaultType(input.faultType)) {
    return { start: true, autoStarted: true };
  }
  return { start: false, autoStarted: false };
}

/** Canonical staging → verify → production delivery plan (SRE-10 / SRE-13). */
export function buildStagingFixTaskPlan(incident: Incident): TaskPlan {
  const fault = resolveIncidentFaultType(incident) ?? "unknown";
  return {
    summary: `Phase 8 controlled remediation for ${incident.fingerprint} (${fault})`,
    tasks: [
      {
        id: "CI",
        title: "CI release",
        description: `Build/CI for incident ${incident.id} (${fault}). Reuses DeliveryOrchestrator CI action.`,
        type: "BUILD",
        priority: "HIGH",
        dependencies: [],
        estimatedComplexity: 2,
        acceptanceCriteria: ["CI succeeds and publishes a releasable artifact"],
        sourceSpecTypes: ["TECHNICAL"],
        delivery: { action: "CI", ref: "main" }
      },
      {
        id: "STAGING",
        title: "Deploy staging",
        description: "Deploy the CI artifact to staging only.",
        type: "DEPLOY",
        priority: "HIGH",
        dependencies: ["CI"],
        estimatedComplexity: 2,
        acceptanceCriteria: ["Staging health checks pass"],
        sourceSpecTypes: ["ARCHITECTURE"],
        delivery: { action: "DEPLOY", environment: "staging" }
      },
      {
        id: "VERIFY",
        title: "Verify staging",
        description: "Staging VERIFY gate; failure must not promote to production (SRE-11).",
        type: "TEST",
        priority: "HIGH",
        dependencies: ["STAGING"],
        estimatedComplexity: 2,
        acceptanceCriteria: ["Staging verify / E2E passes"],
        sourceSpecTypes: ["FUNCTIONAL"],
        delivery: { action: "VERIFY", environment: "staging" }
      },
      {
        id: "PRODUCTION",
        title: "Deploy production (approval required)",
        description:
          "Production deploy. Existing delivery rules force WAITING_APPROVAL (SRE-12/SRE-13). Do not bypass Policy/Approval — even when INCIDENT_AUTO_REMEDIATE is on.",
        type: "DEPLOY",
        priority: "HIGH",
        dependencies: ["VERIFY"],
        estimatedComplexity: 3,
        acceptanceCriteria: ["Production deploy approved and healthy"],
        sourceSpecTypes: ["ARCHITECTURE"],
        delivery: { action: "DEPLOY", environment: "production" }
      }
    ]
  };
}

/**
 * SRE-15 / docs/13 禁止项抽样：staging 修复计划不得含 shell / secrets / 绕过审批的生产动作。
 * Returns the first violation message, or null when clean.
 */
export function findForbiddenRemediationPlanViolation(plan: TaskPlan): string | null {
  for (const task of plan.tasks) {
    const blob = `${task.title}\n${task.description}\n${JSON.stringify(task.delivery ?? {})}`.toLowerCase();
    if (blob.includes("production shell") || blob.includes("arbitrary shell") || /\brm\s+-rf\b/.test(blob)) {
      return `Forbidden production shell pattern in task ${task.id}`;
    }
    if (blob.includes("secret") && (blob.includes("mutate") || blob.includes("modify") || blob.includes("delete"))) {
      return `Forbidden secrets mutation pattern in task ${task.id}`;
    }
    if (task.id === "PRODUCTION") {
      const env = task.delivery && "environment" in task.delivery ? task.delivery.environment : undefined;
      if (env !== "production") {
        return "PRODUCTION task must target environment=production so approval rules apply";
      }
      if (task.delivery?.action === "DEPLOY" && (task as { skipApproval?: boolean }).skipApproval === true) {
        return "PRODUCTION task must not skip approval";
      }
    }
  }
  const production = plan.tasks.find((task) => task.id === "PRODUCTION");
  if (!production) return "Fix plan missing PRODUCTION approval gate task";
  if (!production.dependencies.includes("VERIFY")) {
    return "PRODUCTION must depend on VERIFY (staging verify failure must not promote)";
  }
  return null;
}

export function remediationNotifyReason(faultType: string | undefined): string {
  if (!faultType) {
    return "No labels.faultType set; incident stays notify-only (not on 8-C whitelist).";
  }
  return `Fault type "${faultType}" is not in INCIDENT_REMEDIATION_WHITELIST; notify-only, no fix workflow.`;
}
