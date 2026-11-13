import {
  AgentRunDetailView,
  AgentRunStreamPayload,
  AnalyzeRequirementResult,
  ConflictResolution,
  ConflictResolutionInput,
  CreateRequirementInput,
  Requirement,
  RequirementAcceptanceCriteriaView,
  RequirementSlicesView,
  RequirementTasksView,
  RequirementTraceabilityView,
  Specification
} from "@ai-se/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { getAgentRun, listAgentRuns, openAgentRunStream } from "../api/agentRuns";
import {
  analyzeRequirement,
  createRequirement as createRequirementRequest,
  getRequirement,
  listRequirementAcceptanceCriteria,
  listRequirementConflictResolutions,
  listRequirementSlices,
  listRequirementSpecifications,
  listRequirementTasks,
  listRequirementTraceability,
  listRequirements,
  startRequirementSliceWorkflow,
  upsertRequirementConflictResolutions
} from "../api/requirements";
import { decideApproval } from "../api/workflows";

interface RequirementsState {
  requirements: Requirement[];
  selectedRequirement: Requirement | null;
  specifications: Specification[];
  taskGraph: RequirementTasksView;
  slices: RequirementSlicesView;
  acceptanceCriteria: RequirementAcceptanceCriteriaView;
  traceability: RequirementTraceabilityView;
  conflictResolutions: ConflictResolution[];
  currentAgentRun: AgentRunDetailView | null;
  loading: boolean;
  detailLoading: boolean;
  creating: boolean;
  analyzing: boolean;
  startingSliceWorkflow: boolean;
  resolvingConflicts: boolean;
  error: string;
}

let eventSource: EventSource | null = null;
let poller: ReturnType<typeof setInterval> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "需求请求失败";
}

function emptyTaskGraph(): RequirementTasksView {
  return { tasks: [], dependencies: [] };
}

function emptySlicesView(): RequirementSlicesView {
  return { slices: [], approval: null };
}

function emptyAcceptanceCriteriaView(): RequirementAcceptanceCriteriaView {
  return { criteria: [] };
}

function emptyTraceabilityView(): RequirementTraceabilityView {
  return {
    requirementId: "",
    generatedAt: "",
    summary: { total: 0, passed: 0, failed: 0, unverified: 0, noTest: 0 },
    criteria: []
  };
}

function isTerminal(status: AgentRunDetailView["run"]["status"]): boolean {
  return ["succeeded", "failed", "cancelled", "timed_out"].includes(status);
}

function stopRealtime(): void {
  eventSource?.close();
  eventSource = null;
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
}

function syncRequirementInList(
  requirements: Requirement[],
  requirement: Requirement
): Requirement[] {
  const index = requirements.findIndex((entry) => entry.id === requirement.id);
  if (index < 0) {
    return [requirement, ...requirements];
  }
  const next = requirements.slice();
  next[index] = { ...next[index], ...requirement };
  return next;
}

function isPlanningAgentRun(input: AgentRunDetailView["run"]["input"] | Record<string, unknown>): boolean {
  return input.runtime === "planning-agent" && typeof input.requirementId === "string";
}

export const useRequirementsStore = defineStore("requirements", {
  state: (): RequirementsState => ({
    requirements: [],
    selectedRequirement: null,
    specifications: [],
    taskGraph: emptyTaskGraph(),
    slices: emptySlicesView(),
    acceptanceCriteria: emptyAcceptanceCriteriaView(),
    traceability: emptyTraceabilityView(),
    conflictResolutions: [],
    currentAgentRun: null,
    loading: false,
    detailLoading: false,
    creating: false,
    analyzing: false,
    startingSliceWorkflow: false,
    resolvingConflicts: false,
    error: ""
  }),
  actions: {
    async loadRequirements(projectId: string) {
      this.loading = true;
      this.error = "";
      try {
        this.requirements = await listRequirements(projectId);
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.loading = false;
      }
    },

    async loadRequirement(id: string) {
      this.detailLoading = true;
      this.error = "";
      try {
        this.selectedRequirement = await getRequirement(id);
        // 列表与详情共用同一条 requirement 记录，避免「列表已分析 / 详情分析中」分裂。
        this.requirements = syncRequirementInList(this.requirements, this.selectedRequirement);
        await this.loadPlanningArtifacts(id);
        await this.attachLatestPlanningRun(id);
      } catch (error) {
        this.selectedRequirement = null;
        this.specifications = [];
        this.taskGraph = emptyTaskGraph();
        this.slices = emptySlicesView();
        this.acceptanceCriteria = emptyAcceptanceCriteriaView();
        this.traceability = emptyTraceabilityView();
        this.conflictResolutions = [];
        this.error = errorMessage(error);
      } finally {
        this.detailLoading = false;
      }
    },

    async loadPlanningArtifacts(requirementId: string) {
      const [specifications, taskGraph, slices, acceptanceCriteria, traceability, conflictResolutions] =
        await Promise.all([
          listRequirementSpecifications(requirementId),
          listRequirementTasks(requirementId),
          // 单级模式（无切片路由/空列表）回退为空视图，不阻塞既有展示。
          listRequirementSlices(requirementId).catch(
            (): RequirementSlicesView => emptySlicesView()
          ),
          listRequirementAcceptanceCriteria(requirementId).catch(
            (): RequirementAcceptanceCriteriaView => emptyAcceptanceCriteriaView()
          ),
          listRequirementTraceability(requirementId).catch(
            (): RequirementTraceabilityView => emptyTraceabilityView()
          ),
          listRequirementConflictResolutions(requirementId).catch(
            (): ConflictResolution[] => []
          )
        ]);
      this.specifications = specifications;
      this.taskGraph = taskGraph;
      this.slices = slices;
      this.acceptanceCriteria = acceptanceCriteria;
      this.traceability = traceability;
      this.conflictResolutions = conflictResolutions;
    },


    /** 产品补齐：手动启动 / 重试切片工作流（sliceKey + 服务端用的 planningVersion）。 */
    async startSliceWorkflow(sliceKey: string, workspacePath = "") {
      if (!this.selectedRequirement) {
        return null;
      }
      this.startingSliceWorkflow = true;
      this.error = "";
      try {
        const workflow = await startRequirementSliceWorkflow(
          this.selectedRequirement.id,
          sliceKey,
          workspacePath ? { workspacePath } : {}
        );
        await this.loadRequirement(this.selectedRequirement.id);
        return workflow;
      } catch (error) {
        this.error = errorMessage(error);
        return null;
      } finally {
        this.startingSliceWorkflow = false;
      }
    },


    /** 提交 PRD/TRD 冲突裁决（跟 PRD / 跟 TRD / 自定义）；下次分析/切片规划会回灌。 */
    async saveConflictResolutions(resolutions: ConflictResolutionInput[]) {
      if (!this.selectedRequirement) {
        return null;
      }
      this.resolvingConflicts = true;
      this.error = "";
      try {
        const saved = await upsertRequirementConflictResolutions(
          this.selectedRequirement.id,
          resolutions
        );
        this.conflictResolutions = saved;
        return saved;
      } catch (error) {
        this.error = errorMessage(error);
        return null;
      } finally {
        this.resolvingConflicts = false;
      }
    },
    /** N2 关口 1：批准 → 进入第二级；拒绝（comment = 修改意见）→ 重做第一级。 */
    async decideSliceApproval(action: "approve" | "reject", comment = "") {
      const approval = this.slices.approval;
      if (!approval || !this.selectedRequirement) {
        return;
      }

      this.error = "";
      try {
        await decideApproval(approval.id, action, comment ? { comment } : {});
        await this.loadRequirement(this.selectedRequirement.id);
      } catch (error) {
        this.error = errorMessage(error);
      }
    },

    async createRequirement(projectId: string, input: CreateRequirementInput) {
      this.creating = true;
      this.error = "";
      try {
        const requirement = await createRequirementRequest(projectId, input);
        this.requirements = [
          requirement,
          ...this.requirements.filter((entry) => entry.id !== requirement.id)
        ];
        await this.loadRequirement(requirement.id);
        return requirement;
      } catch (error) {
        this.error = errorMessage(error);
        return null;
      } finally {
        this.creating = false;
      }
    },

    async analyzeSelectedRequirement(regenerate = false): Promise<AnalyzeRequirementResult | null> {
      if (!this.selectedRequirement) {
        return null;
      }

      this.analyzing = true;
      this.error = "";
      try {
        const result = await analyzeRequirement(this.selectedRequirement.id, { regenerate });
        this.selectedRequirement = {
          ...this.selectedRequirement,
          status: result.status,
          version: result.version ?? this.selectedRequirement.version
        };
        this.requirements = syncRequirementInList(this.requirements, this.selectedRequirement);
        if (result.agentRunId) {
          await this.loadAgentRun(result.agentRunId);
          this.startRealtime(result.agentRunId);
        }
        return result;
      } catch (error) {
        this.error = errorMessage(error);
        return null;
      } finally {
        this.analyzing = false;
      }
    },

    applyAgentRunSnapshot(snapshot: AgentRunStreamPayload) {
      this.currentAgentRun = snapshot;

      const requirementId = snapshot.run.input.requirementId;
      if (typeof requirementId === "string" && isTerminal(snapshot.run.status)) {
        stopRealtime();
        void this.loadRequirement(requirementId);
      }
    },

    async loadAgentRun(agentRunId: string) {
      this.currentAgentRun = await getAgentRun(agentRunId);
    },

    startRealtime(agentRunId: string) {
      stopRealtime();
      if (typeof EventSource === "undefined") {
        this.startPolling(agentRunId);
        return;
      }

      eventSource = openAgentRunStream(
        agentRunId,
        (snapshot) => this.applyAgentRunSnapshot(snapshot),
        () => {
          eventSource?.close();
          eventSource = null;
          this.startPolling(agentRunId);
        }
      );
    },

    startPolling(agentRunId: string) {
      if (poller) {
        return;
      }

      poller = setInterval(() => {
        void getAgentRun(agentRunId)
          .then((detail) => {
            this.applyAgentRunSnapshot(detail);
          })
          .catch((error: unknown) => {
            this.error = errorMessage(error);
          });
      }, 2_000);
    },

    /**
     * 打开详情时挂上该需求最近一次 planning-agent 运行：
     * - 分析中：续接 SSE/轮询，进度事件能跟着走
     * - 失败/待确认：带回错误或审批相关事件，详情进度有依据
     */
    async attachLatestPlanningRun(requirementId: string) {
      try {
        const runs = await listAgentRuns();
        const matching = runs
          .filter(
            (entry) =>
              isPlanningAgentRun(entry.input) && entry.input.requirementId === requirementId
          )
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
        const latest = matching[0];
        if (!latest) {
          if (this.currentAgentRun?.run.input.requirementId !== requirementId) {
            this.currentAgentRun = null;
          }
          return;
        }

        if (this.currentAgentRun?.run.id === latest.id && !isTerminal(latest.status)) {
          // 已在跟踪同一次运行，不打断 SSE。
          return;
        }

        await this.loadAgentRun(latest.id);
        if (!isTerminal(latest.status)) {
          this.startRealtime(latest.id);
        } else {
          stopRealtime();
        }
      } catch {
        // 进度挂载失败不阻塞详情主体（列表/规格/切片仍可用）。
      }
    },

    stopRealtime() {
      stopRealtime();
    }
  }
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useRequirementsStore, import.meta.hot));
}

