/**
 * Phase 5.6-5 Repair: the REAL Auto Fix / Re-plan loop runner.
 *
 * Composition root for the frozen 5.6-5 data layer (issue classification,
 * fix drafts, three-state outcome, loop advancement, audit trail) over the
 * existing execution machinery:
 *
 *   Visual Issue → Fix Task → Frontend Agent → ToolRuntime → Docker Sandbox
 *   → Code Change → Build/Test → Browser Runtime → Candidate Screenshot
 *   → Visual Evaluation (reference screenshot vs candidate screenshot)
 *   → RESOLVED / NEW_ISSUE / REGRESSED
 *
 * Evaluation inputs are the REAL rendered screenshots: the candidate side is
 * produced by analyzing the captured candidate screenshot bytes (injectable
 * analyzer — the 5.6-1 screenshot chain with a real VLM in production), never
 * by parsing the page HTML. Nothing here re-implements agents, tasks,
 * governance or evaluation — every step delegates to @ai-se/agent-core,
 * @ai-se/tool-runtime, @ai-se/sandbox, @ai-se/browser and @ai-se/visual.
 * Code changes ONLY happen through the Agent → ToolRuntime → Sandbox path;
 * success is decided by the re-evaluation, never by the agent's self-report.
 */
import {
  buildFrontendAgentTask,
  frontendTaskTargetPage,
  type Agent,
  type AgentRunOptions,
  type FrontendWorkspaceConventions
} from "@ai-se/agent-core";
import type { BrowserSession } from "@ai-se/browser";
import type { Sandbox } from "@ai-se/sandbox";
import type { JsonObject, VisualAnalysisReport, VisualInputRecord, VisualSpecification } from "@ai-se/shared";
import type { WorkflowFailureStrategy, WorkflowStatus } from "@ai-se/shared";
import { ToolRuntime, type ToolResult } from "@ai-se/tool-runtime";
import {
  advanceFixLoop,
  buildFixTaskDrafts,
  determineFixOutcome,
  evaluateVisuals,
  initialFixLoopState,
  serializeFixAuditTrailMd,
  visualIssuesFromReport,
  type EvaluationReport,
  type EvaluationScore,
  type EvaluationSide,
  type FixLoopState,
  type FixTaskDraft,
  type LoopOutcome,
  type LoopStatus,
  type MatchOptions,
  type VisualIssue
} from "@ai-se/visual";
import type { ViewportName } from "@ai-se/visual";

/** Analysis of the CURRENT page state (specification + report), produced by
 * the caller from the REAL candidate screenshot (5.6-1 screenshot chain with
 * a real VLM in production; deterministic doubles in tests). */
export interface CandidateAnalysis {
  record: VisualInputRecord;
  specification: VisualSpecification;
  analysis: VisualAnalysisReport;
  knownGapSections: string[];
}

/** Input handed to the candidate screenshot analyzer for one capture. */
export interface CandidateAnalysisInput {
  /** 0 = pre-fix baseline capture; 1..n = post-round captures. */
  round: number;
  /** `screenshot://…` asset ref of the captured candidate screenshot. */
  assetRef: string;
  /** REAL screenshot bytes (PNG base64) — the evidence evaluation pairs. */
  base64: string;
  viewport: { width: number; height: number };
}

/** One round of the loop — full traceability record. */
export interface FixRoundRecord {
  round: number;
  /** Issues that triggered this round (from the previous evaluation). */
  issues: VisualIssue[];
  fixCandidateIds: string[];
  submitted: {
    taskKey: string;
    pageFile: string;
    submissionRisk: FixTaskDraft["submissionRisk"];
    autoSubmitted: boolean;
  } | null;
  agent: {
    status: string;
    iterations: number;
    toolCalls: Array<{ toolName: string; success: boolean; errorCode: string | null }>;
  } | null;
  codeChanges: Array<{ tool: string; path: string; bytes: number | null }>;
  build: { ok: boolean; command: string; cwd: string };
  test: { ok: boolean; command: string; cwd: string };
  browser: {
    finalUrl: string;
    assetRef: string;
    bytes: number;
    settled: "networkidle" | "timeout";
    consoleErrors: number;
    networkErrors: number;
  } | null;
  evaluation: {
    score: EvaluationScore;
    outcome: LoopOutcome;
    resolvedIssues: string[];
    unchangedIssues: string[];
    newIssues: string[];
    /** Screenshot asset the candidate side was evaluated from. */
    candidateSource: string;
    /** Reference screenshot asset this candidate was scored against. */
    referenceSource: string;
  } | null;
  /** Loop status after this round was applied. */
  status: LoopStatus;
}

export interface VisualFixLoopHandoff {
  required: boolean;
  /** Existing workflow vocabulary for the surrounding chain. */
  workflowStatus: WorkflowStatus;
  failureStrategy: WorkflowFailureStrategy;
  reason: string;
}

export interface VisualFixLoopResult {
  state: FixLoopState;
  rounds: FixRoundRecord[];
  handoff: VisualFixLoopHandoff;
  /** Markdown audit trail per executed round (existing 5.6-5 serializer). */
  audits: string[];
  initial: {
    source: string;
    score: EvaluationScore;
    issues: VisualIssue[];
  };
}

export interface VisualFixLoopDependencies {
  /** Fresh agent per round (deterministic test doubles configure per round). */
  createFixAgent: (round: number) => Agent;
  toolRuntime: ToolRuntime;
  sandbox: Sandbox;
  workspacePath: string;
  actor: string;
  projectId: string;
  browser: BrowserSession;
  /** Live page URL the Browser loads for candidate screenshots. */
  pageUrl: string;
  /** Reference (design target) side for Visual Evaluation. */
  reference: EvaluationSide;
  /**
   * Candidate side analyzer over the CANDIDATE SCREENSHOT bytes. Production:
   * the 5.6-1 screenshot analysis chain with a real VLM provider. HTML/DOM
   * parsing must NOT substitute for the screenshot bytes here.
   */
  analyzeCandidateScreenshot: (input: CandidateAnalysisInput) => Promise<CandidateAnalysis>;
  conventions: FrontendWorkspaceConventions;
  matchOptions?: MatchOptions;
  viewportName: ViewportName;
  maxRounds?: number;
  agentRunOptions?: AgentRunOptions;
  onRound?: (record: FixRoundRecord) => void | Promise<void>;
}

function dataOf(result: ToolResult): JsonObject {
  return typeof result.data === "object" && result.data !== null
    ? (result.data as JsonObject)
    : {};
}

function pathOf(result: ToolResult): string {
  const value = dataOf(result).path;
  return typeof value === "string" ? value : "";
}

function bytesOf(result: ToolResult): number | null {
  const value = dataOf(result).bytes;
  return typeof value === "number" ? value : null;
}

export async function runVisualFixLoop(
  dependencies: VisualFixLoopDependencies
): Promise<VisualFixLoopResult> {
  const rounds: FixRoundRecord[] = [];
  const audits: string[] = [];
  let state = initialFixLoopState();
  if (dependencies.maxRounds !== undefined) {
    state = { ...state, maxRounds: dependencies.maxRounds };
  }

  const captureCandidate = async (round: number): Promise<{
    side: EvaluationSide;
    report: EvaluationReport;
    browser: NonNullable<FixRoundRecord["browser"]>;
  }> => {
    const navigation = await dependencies.browser.goto(dependencies.pageUrl);
    const settled = await dependencies.browser.waitForRender();
    const shot = await dependencies.browser.screenshot();
    const assetRef = dependencies.browser.assetRefFor(shot);
    // The candidate side is derived from the REAL screenshot bytes — the
    // screenshot is the evidence, never the page HTML.
    const candidateInfo = await dependencies.analyzeCandidateScreenshot({
      round,
      assetRef,
      base64: shot.base64,
      viewport: dependencies.reference.record.viewport
    });
    const side: EvaluationSide = {
      record: candidateInfo.record,
      base64: shot.base64,
      analysis: candidateInfo.analysis,
      specification: candidateInfo.specification,
      knownGapSections: candidateInfo.knownGapSections
    };
    const { report } = evaluateVisuals({
      reference: dependencies.reference,
      candidate: side,
      settled: settled.settled
    });
    return {
      side,
      report,
      browser: {
        finalUrl: navigation.finalUrl,
        assetRef,
        bytes: shot.buffer.length,
        settled: settled.settled,
        consoleErrors: shot.consoleErrorCountSinceLast,
        networkErrors: shot.networkErrorCountSinceLast
      }
    };
  };

  // ── Initial evaluation: what is wrong with the page right now? ────────────
  const initial = await captureCandidate(0);
  let previousReport = initial.report;
  let previousIssues = visualIssuesFromReport(initial.report, dependencies.viewportName);
  let previousCandidateSource = initial.side.record.source;
  const initialResult = {
    source: initial.side.record.source,
    score: initial.report.score,
    issues: previousIssues.issues
  };

  const todo = (): VisualFixLoopHandoff => ({
    required: false,
    workflowStatus: "SUCCESS",
    failureStrategy: "FAIL_FAST",
    reason:
      state.status === "DONE"
        ? "visual fix loop resolved (or nothing to fix)"
        : "loop finished"
  });
  const handoff = (): VisualFixLoopHandoff => ({
    required: true,
    workflowStatus: "WAITING_APPROVAL",
    failureStrategy: "REPLAN",
    reason:
      state.status === "STALLED"
        ? `no visual progress for ${state.stallThreshold} consecutive rounds — human / re-plan required`
        : `visual fix loop reached maxRounds=${state.maxRounds} without resolution — human / re-plan required`
  });

  if (previousIssues.fixCandidateIds.length === 0) {
    state = { ...state, status: "DONE" };
    return { state, rounds, handoff: todo(), audits, initial: initialResult };
  }

  // ── Fix rounds: Fix Task → Agent → Build/Test → Browser → Evaluation ──────
  while (state.status === "RUNNING") {
    const roundNo = state.round + 1;
    const roundIssues = previousIssues.issues;
    const roundFixCandidateIds = previousIssues.fixCandidateIds;
    const { drafts } = buildFixTaskDrafts({
      issues: roundIssues,
      specifications: [
        { viewportName: dependencies.viewportName, specification: dependencies.reference.specification }
      ],
      matchOptions: dependencies.matchOptions
    });
    const produced = drafts[0];
    const submittedDraft: FixTaskDraft | null = produced
      ? { ...produced, autoSubmitted: true }
      : null;

    let agentRecord: FixRoundRecord["agent"] = null;
    let codeChanges: FixRoundRecord["codeChanges"] = [];
    let build: FixRoundRecord["build"] = {
      ok: false,
      command: dependencies.conventions.buildCommand,
      cwd: dependencies.conventions.appRoot
    };
    let test: FixRoundRecord["test"] = {
      ok: false,
      command: dependencies.conventions.testCommand,
      cwd: dependencies.conventions.appRoot
    };
    let browserRecord: FixRoundRecord["browser"] = null;
    let evaluationRecord: FixRoundRecord["evaluation"] = null;
    let outcome: LoopOutcome = "PENDING";

    if (submittedDraft) {
      const taskText = buildFrontendAgentTask(submittedDraft.draft, dependencies.conventions);
      const agent = dependencies.createFixAgent(roundNo);
      const agentResult = await agent.run(
        taskText,
        {
          requestId: `fix-loop-round-${roundNo}`,
          projectId: dependencies.projectId,
          taskId: `fix-task-round-${roundNo}`,
          agentRunId: `fix-run-round-${roundNo}`,
          actor: dependencies.actor,
          workspacePath: dependencies.workspacePath,
          sandbox: dependencies.sandbox
        },
        dependencies.agentRunOptions
      );
      agentRecord = {
        status: agentResult.status,
        iterations: agentResult.iterations,
        toolCalls: agentResult.toolResults.map((entry) => ({
          toolName: entry.toolName,
          success: entry.success,
          errorCode: entry.error?.code ?? null
        }))
      };
      codeChanges = agentResult.toolResults
        .filter(
          (entry) =>
            entry.success && (entry.toolName === "write_file" || entry.toolName === "edit_file")
        )
        .map((entry) => ({ tool: entry.toolName, path: pathOf(entry), bytes: bytesOf(entry) }));

      // Independent verification through the SAME ToolRuntime/Sandbox path —
      // never trust the agent's self-report.
      const verifyContext = (toolCallId: string) => ({
        requestId: `fix-loop-round-${roundNo}`,
        projectId: dependencies.projectId,
        taskId: `fix-task-round-${roundNo}`,
        agentRunId: `fix-run-round-${roundNo}`,
        toolCallId,
        actor: dependencies.actor,
        workspacePath: dependencies.workspacePath,
        sandbox: dependencies.sandbox
      });
      const buildResult = await dependencies.toolRuntime.execute(
        "run_build",
        {
          command: dependencies.conventions.buildCommand,
          cwd: dependencies.conventions.appRoot,
          timeoutMs: 60_000
        },
        verifyContext(`fix-loop-${roundNo}-build`)
      );
      build = { ok: buildResult.success, command: dependencies.conventions.buildCommand, cwd: dependencies.conventions.appRoot };
      const testResult = await dependencies.toolRuntime.execute(
        "run_unit_test",
        {
          command: dependencies.conventions.testCommand,
          cwd: dependencies.conventions.appRoot,
          timeoutMs: 60_000
        },
        verifyContext(`fix-loop-${roundNo}-test`)
      );
      test = { ok: testResult.success, command: dependencies.conventions.testCommand, cwd: dependencies.conventions.appRoot };

      if (build.ok && test.ok) {
        const after = await captureCandidate(roundNo);
        browserRecord = after.browser;
        const verdict = determineFixOutcome(
          { report: previousReport, viewportName: dependencies.viewportName },
          { report: after.report, viewportName: dependencies.viewportName }
        );
        outcome = verdict.outcome;
        evaluationRecord = {
          score: after.report.score,
          outcome: verdict.outcome,
          resolvedIssues: verdict.resolvedIssues,
          unchangedIssues: verdict.unchangedIssues,
          newIssues: verdict.newIssues,
          candidateSource: after.side.record.source,
          referenceSource: dependencies.reference.record.source
        };
        audits.push(
          serializeFixAuditTrailMd(
            {
              pageName: dependencies.reference.specification.page.name,
              round: roundNo,
              referenceSource: dependencies.reference.record.source,
              candidateSource: after.side.record.source,
              issues: roundIssues,
              submittedDraft,
              beforeReport: previousReport,
              afterReport: after.report,
              outcome
            },
            { serializeReport: (report) => report.score }
          )
        );
        previousReport = after.report;
        previousIssues = visualIssuesFromReport(after.report, dependencies.viewportName);
        previousCandidateSource = after.side.record.source;
      }
    }

    state = advanceFixLoop(state, {
      round: roundNo,
      submittedFixes: submittedDraft ? 1 : 0,
      outcome,
      reports: {
        referenceSource: dependencies.reference.record.source,
        candidateSource: previousCandidateSource
      }
    });
    const record: FixRoundRecord = {
      round: roundNo,
      issues: roundIssues,
      fixCandidateIds: roundFixCandidateIds,
      submitted: submittedDraft
        ? {
            taskKey: submittedDraft.draft.taskKey,
            pageFile: frontendTaskTargetPage(submittedDraft.draft, dependencies.conventions).pageFile,
            submissionRisk: submittedDraft.submissionRisk,
            autoSubmitted: submittedDraft.autoSubmitted
          }
        : null,
      agent: agentRecord,
      codeChanges,
      build,
      test,
      browser: browserRecord,
      evaluation: evaluationRecord,
      status: state.status
    };
    rounds.push(record);
    await dependencies.onRound?.(record);
  }

  return {
    state,
    rounds,
    handoff: state.status === "DONE" ? todo() : handoff(),
    audits,
    initial: initialResult
  };
}
