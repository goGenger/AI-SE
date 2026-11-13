import {
  ApiSpecContent,
  ArchitectureSpecContent,
  DatabaseSpecContent,
  FunctionalSpecContent,
  Requirement,
  RequirementAnalysis,
  SlicePlan,
  TaskPlan,
  TechnicalSpecContent,
  UiSpecContent
} from "@ai-se/shared";

export const PLANNING_STAGES = [
  "requirement_analysis",
  "slice_planning",
  "functional_spec",
  "technical_spec",
  "architecture",
  "api_spec",
  "database_spec",
  "ui_spec",
  "task_planning"
] as const;

export type PlanningStage = (typeof PLANNING_STAGES)[number];
export type PlanningStatus = "running" | "succeeded" | "failed" | "cancelled";

/** 两级规划第二级：单切片的执行范围（进入图状态并注入阶段提示词）。 */
export interface PlanningSliceScope {
  key: string;
  title: string;
  goal: string;
  frKeys: string[];
}

export interface PlanningState {
  requirement: Requirement;
  projectId: string;
  requirementId: string;
  slice?: PlanningSliceScope;
  requirementAnalysis?: RequirementAnalysis;
  slicePlan?: SlicePlan;
  functionalSpec?: FunctionalSpecContent;
  technicalSpec?: TechnicalSpecContent;
  architectureSpec?: ArchitectureSpecContent;
  apiSpec?: ApiSpecContent;
  databaseSpec?: DatabaseSpecContent;
  uiSpec?: UiSpecContent;
  taskPlan?: TaskPlan;
  validationErrors: string[];
  currentStage: PlanningStage;
  status: PlanningStatus;
}

export interface PlanningGraphResult {
  requirementAnalysis: RequirementAnalysis;
  functionalSpec: FunctionalSpecContent;
  technicalSpec: TechnicalSpecContent;
  architectureSpec: ArchitectureSpecContent;
  apiSpec: ApiSpecContent;
  /** 第二级跳过 database_spec 的切片可缺省（slice.involvesData=false）。 */
  databaseSpec?: DatabaseSpecContent;
  /** 第二级跳过 ui_spec 的切片可缺省（slice.involvesUi=false）。 */
  uiSpec?: UiSpecContent;
  taskPlan: TaskPlan;
  validationErrors: string[];
}

/** 第一级（requirement_analysis + slice_planning）的结果。 */
export interface PlanningLevel1Result {
  requirementAnalysis: RequirementAnalysis;
  slicePlan: SlicePlan;
  validationErrors: string[];
}
