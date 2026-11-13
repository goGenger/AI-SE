import type { CreateIncidentInput, IncidentListQuery as RepoListQuery } from "@ai-se/database";
import { createLogger, sanitizeLogData } from "@ai-se/observability";
import type {
  AlertIngest,
  AlertIngestResult,
  Incident,
  IncidentDiagnosis,
  IncidentRemediateResult,
  IncidentRemediationDecision,
  IncidentStatus
} from "@ai-se/shared";
import { IncidentRemediationDecisionSchema } from "@ai-se/shared";
import { AppError } from "../http/errors";
import { IncidentAgent } from "./incidentAgent";
import { IncidentEvidenceCollector } from "./incidentEvidenceCollector";
import type { IncidentFixWorkflowOpenInput, IncidentFixWorkflowOpenResult } from "./incidentFixWorkflowOpener";
import {
  buildStagingFixTaskPlan,
  findForbiddenRemediationPlanViolation,
  isWhitelistedFaultType,
  remediationNotifyReason,
  resolveIncidentFaultType,
  resolveRemediationAutoStart
} from "./incidentRemediationPolicy";

export interface IncidentListQuery {
  projectId?: string;
  status?: IncidentStatus;
  source?: string;
  fingerprint?: string;
  limit?: number;
}

/** Narrow persistence port so API tests can use an in-memory double. */
export interface IncidentStore {
  findActiveByFingerprint(source: string, fingerprint: string): Promise<Incident | null>;
  create(input: CreateIncidentInput): Promise<Incident>;
  appendAlertEvent(input: { incidentId: string; alert: AlertIngest }): Promise<void>;
  findById(id: string): Promise<Incident | null>;
  findMany(query?: RepoListQuery): Promise<Incident[]>;
  saveDiagnosis?(input: {
    id: string;
    diagnosis: IncidentDiagnosis;
    status?: IncidentStatus;
  }): Promise<Incident>;
  saveRemediation?(input: {
    id: string;
    remediation: IncidentRemediationDecision;
    status?: IncidentStatus;
    linkedWorkflowRunId?: string;
  }): Promise<Incident>;
}

export interface IncidentRemediateOptions {
  projectId?: string;
  /**
   * When set, forces whether to start the created workflow after open.
   * When omitted, 8-D uses `autoRemediateEnabled` + whitelist (default off ⇒ do not start).
   */
  startWorkflow?: boolean;
  workspacePath?: string;
}

function defaultTitle(alert: AlertIngest): string {
  if (alert.title) return alert.title;
  const named = alert.labels.alertname ?? alert.labels.alertName;
  if (named) return named.slice(0, 300);
  return `${alert.source}:${alert.fingerprint}`.slice(0, 300);
}

const logger = createLogger();

/**
 * Phase 8 IncidentService: 8-A alert→incident, 8-B read-only diagnose,
 * 8-C whitelist-controlled staging fix workflow, 8-D optional auto-start (no second runtime).
 */
export class IncidentService {
  constructor(
    private readonly incidents: IncidentStore,
    private readonly diagnosis?: {
      collector: IncidentEvidenceCollector;
      agent?: IncidentAgent;
    },
    private readonly remediation?: {
      openFixWorkflow: (input: IncidentFixWorkflowOpenInput) => Promise<IncidentFixWorkflowOpenResult>;
      /**
       * 8-D: from `INCIDENT_AUTO_REMEDIATE` (default false). When true, whitelisted
       * remediate calls auto-start the staging-bound workflow unless startWorkflow=false.
       * Never bypasses production approval.
       */
      autoRemediateEnabled?: boolean;
    }
  ) {}

  async ingestAlert(alert: AlertIngest): Promise<AlertIngestResult> {
    const existing = await this.incidents.findActiveByFingerprint(alert.source, alert.fingerprint);
    if (existing) {
      await this.incidents.appendAlertEvent({ incidentId: existing.id, alert });
      return { incident: existing, deduplicated: true };
    }

    try {
      const created = await this.incidents.create({
        projectId: alert.projectId,
        source: alert.source,
        fingerprint: alert.fingerprint,
        severity: alert.severity,
        title: defaultTitle(alert),
        summary: alert.summary,
        labels: alert.labels,
        raw: alert.raw
      });
      await this.incidents.appendAlertEvent({ incidentId: created.id, alert });
      return { incident: created, deduplicated: false };
    } catch (error) {
      // Race: another writer won the partial unique index — treat as dedupe.
      const raced = await this.incidents.findActiveByFingerprint(alert.source, alert.fingerprint);
      if (raced) {
        await this.incidents.appendAlertEvent({ incidentId: raced.id, alert });
        return { incident: raced, deduplicated: true };
      }
      throw error;
    }
  }

  async list(query: IncidentListQuery = {}): Promise<Incident[]> {
    return this.incidents.findMany(query);
  }

  async get(id: string, scope: { projectId?: string } = {}): Promise<Incident> {
    const incident = await this.incidents.findById(id);
    if (!incident) {
      throw new AppError(404, "INCIDENT_NOT_FOUND", "Incident not found");
    }
    if (scope.projectId && incident.projectId && scope.projectId !== incident.projectId) {
      throw new AppError(
        403,
        "INCIDENT_ACCESS_DENIED",
        "Incident belongs to a different project scope"
      );
    }
    return incident;
  }

  /**
   * 8-B: collect evidence → Incident Agent diagnosis → persist on incident.
   * Status advances open|diagnosing → diagnosing. Never creates deployments.
   */
  async diagnose(id: string, scope: { projectId?: string } = {}): Promise<Incident> {
    if (!this.diagnosis || !this.incidents.saveDiagnosis) {
      throw new AppError(
        503,
        "INCIDENT_DIAGNOSIS_UNAVAILABLE",
        "Incident diagnosis is not configured on this server"
      );
    }

    const incident = await this.get(id, scope);
    if (incident.status === "resolved" || incident.status === "cancelled") {
      throw new AppError(
        409,
        "INCIDENT_NOT_DIAGNOSABLE",
        `Incident status ${incident.status} cannot be diagnosed`
      );
    }
    if (incident.status === "mitigating") {
      throw new AppError(
        409,
        "INCIDENT_NOT_DIAGNOSABLE",
        "Incident is already mitigating; diagnosis is read-only for open/diagnosing"
      );
    }

    const evidence = await this.diagnosis.collector.collect(incident);
    const agent = this.diagnosis.agent ?? new IncidentAgent();
    let diagnosis: IncidentDiagnosis;
    try {
      diagnosis = agent.diagnose({ incident, evidence });
    } catch (error) {
      const message = error instanceof Error ? error.message : "diagnosis failed";
      if (message.includes("INCIDENT_DIAGNOSIS_INSUFFICIENT_EVIDENCE")) {
        throw new AppError(422, "INCIDENT_DIAGNOSIS_INSUFFICIENT_EVIDENCE", message);
      }
      throw error;
    }

    const saved = await this.incidents.saveDiagnosis({
      id: incident.id,
      diagnosis,
      status: "diagnosing"
    });

    logger.info(
      {
        incidentId: saved.id,
        evidenceKinds: [...new Set(diagnosis.evidence.map((item) => item.sourceKind))],
        recommendedAction: sanitizeLogData(diagnosis.recommendedAction)
      },
      "incident diagnosis persisted"
    );

    return saved;
  }

  /**
   * 8-C/8-D: whitelist → open staging-bound fix workflow via existing Runtime;
   * non-whitelist → NOTIFY_ONLY (no workflow). 8-D optional auto-start when
   * `autoRemediateEnabled` is on (config default off). Never opens a second
   * executor, never bypasses production approval (SRE-09…15).
   */
  async remediate(id: string, options: IncidentRemediateOptions = {}): Promise<IncidentRemediateResult> {
    if (!this.incidents.saveRemediation) {
      throw new AppError(
        503,
        "INCIDENT_REMEDIATION_UNAVAILABLE",
        "Incident remediation persistence is not configured on this server"
      );
    }

    const incident = await this.get(id, { projectId: options.projectId });
    if (incident.status === "resolved" || incident.status === "cancelled") {
      throw new AppError(
        409,
        "INCIDENT_NOT_REMEDIABLE",
        `Incident status ${incident.status} cannot be remediated`
      );
    }

    // Idempotent: already opened a fix workflow.
    if (
      incident.remediation?.decision === "OPENED_STAGING_FIX_WORKFLOW" &&
      incident.linkedWorkflowRunId
    ) {
      return {
        incident,
        remediation: IncidentRemediationDecisionSchema.parse(incident.remediation)
      };
    }
    if (incident.remediation?.decision === "NOTIFY_ONLY") {
      return {
        incident,
        remediation: IncidentRemediationDecisionSchema.parse(incident.remediation)
      };
    }

    if (!incident.diagnosis) {
      throw new AppError(
        409,
        "INCIDENT_DIAGNOSIS_REQUIRED",
        "Run POST /api/incidents/:id/diagnose before remediation"
      );
    }

    const projectId = options.projectId ?? incident.projectId;
    const faultType = resolveIncidentFaultType(incident);
    const decidedAt = new Date().toISOString();

    if (!isWhitelistedFaultType(faultType)) {
      const remediation = IncidentRemediationDecisionSchema.parse({
        decision: "NOTIFY_ONLY",
        ...(faultType ? { faultType } : {}),
        whitelisted: false,
        reason: remediationNotifyReason(faultType),
        decidedAt
      });
      const saved = await this.incidents.saveRemediation({
        id: incident.id,
        remediation
        // keep diagnosing / open — do not advance to mitigating
      });
      logger.info(
        { incidentId: saved.id, faultType: faultType ?? null, decision: remediation.decision },
        "incident remediation notify-only"
      );
      return { incident: saved, remediation };
    }

    if (!projectId) {
      throw new AppError(
        400,
        "INCIDENT_PROJECT_REQUIRED",
        "Whitelisted remediation requires incident.projectId or ?projectId="
      );
    }
    if (!this.remediation) {
      throw new AppError(
        503,
        "INCIDENT_REMEDIATION_UNAVAILABLE",
        "Incident fix-workflow opener is not configured on this server"
      );
    }

    const taskPlan = buildStagingFixTaskPlan(incident);
    const forbidden = findForbiddenRemediationPlanViolation(taskPlan);
    if (forbidden) {
      throw new AppError(500, "INCIDENT_REMEDIATION_PLAN_FORBIDDEN", forbidden);
    }

    const autoRemediateEnabled = this.remediation.autoRemediateEnabled === true;
    const { start, autoStarted } = resolveRemediationAutoStart({
      autoRemediateEnabled,
      faultType,
      ...(options.startWorkflow !== undefined ? { startWorkflow: options.startWorkflow } : {})
    });

    const opened = await this.remediation.openFixWorkflow({
      projectId,
      title: `SRE fix: ${incident.title}`.slice(0, 160),
      description: `Controlled remediation for incident ${incident.id}`.slice(0, 1000),
      rawContent: [
        `Incident: ${incident.id}`,
        `Fingerprint: ${incident.fingerprint}`,
        `Fault type: ${faultType}`,
        `Diagnosis summary: ${incident.diagnosis.summary}`,
        `Fix plan: ${incident.diagnosis.fixPlan}`,
        "Constraints: staging VERIFY must pass before production; production waits for approval.",
        `Auto-remediate flag: ${autoRemediateEnabled ? "on" : "off"} (default off; production never auto-approved).`
      ].join("\n"),
      taskPlan,
      approvalTaskKeys: ["PRODUCTION"],
      start,
      ...(options.workspacePath ? { workspacePath: options.workspacePath } : {})
    });

    const reason = autoStarted
      ? "Fault type is on INCIDENT_REMEDIATION_WHITELIST and INCIDENT_AUTO_REMEDIATE is on; opened and auto-started staging-bound delivery workflow via WorkflowService (production remains WAITING_APPROVAL)."
      : start
        ? "Fault type is on INCIDENT_REMEDIATION_WHITELIST; opened and started staging-bound delivery workflow via WorkflowService (production remains WAITING_APPROVAL)."
        : "Fault type is on INCIDENT_REMEDIATION_WHITELIST; opened staging-bound delivery workflow via WorkflowService (not auto-started; production remains WAITING_APPROVAL).";

    const remediation = IncidentRemediationDecisionSchema.parse({
      decision: "OPENED_STAGING_FIX_WORKFLOW",
      faultType,
      whitelisted: true,
      reason,
      workflowRunId: opened.workflowRunId,
      requirementId: opened.requirementId,
      started: opened.started,
      autoStarted,
      autoRemediateEnabled,
      decidedAt
    });
    const saved = await this.incidents.saveRemediation({
      id: incident.id,
      remediation,
      status: "mitigating",
      linkedWorkflowRunId: opened.workflowRunId
    });

    logger.info(
      {
        incidentId: saved.id,
        faultType,
        workflowRunId: opened.workflowRunId,
        started: opened.started,
        autoStarted,
        autoRemediateEnabled
      },
      "incident remediation opened staging fix workflow"
    );

    return { incident: saved, remediation };
  }
}
