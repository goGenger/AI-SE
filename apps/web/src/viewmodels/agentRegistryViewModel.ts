import { AgentArtifactType, AgentEvaluationMetrics, AgentType } from "@ai-se/shared";

export function formatRate(value?: number): string {
  return value === undefined ? "暂无数据" : `${Math.round(value * 100)}%`;
}

export function metricCards(metrics: AgentEvaluationMetrics | null) {
  return [
    { label: "Agent 成功率", value: formatRate(metrics?.agentSuccessRate) },
    { label: "任务成功率", value: formatRate(metrics?.taskSuccessRate) },
    { label: "工具成功率", value: formatRate(metrics?.toolSuccessRate) },
    { label: "测试通过率", value: formatRate(metrics?.testPassRate) },
    { label: "评审通过率", value: formatRate(metrics?.reviewPassRate) },
    { label: "修复成功率", value: formatRate(metrics?.repairSuccessRate) }
  ];
}

const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  PLANNER: "规划",
  FRONTEND: "前端",
  BACKEND: "后端",
  DATABASE: "数据库",
  QA: "QA",
  REVIEWER: "评审",
  DEVOPS: "运维"
};

export function agentTypeLabel(type: AgentType): string {
  return AGENT_TYPE_LABELS[type] ?? type;
}

export function agentAvailabilityLabel(status: "available" | string): string {
  return status === "available" ? "可用" : status;
}

const ARTIFACT_TYPE_LABELS: Record<AgentArtifactType, string> = {
  CODE_DIFF: "代码差异",
  TEST_RESULT: "测试结果",
  REVIEW_RESULT: "评审结果",
  BUILD_RESULT: "构建结果",
  DOCUMENTATION: "文档",
  GENERATED_FILE: "生成文件"
};

export function artifactTypeLabel(type: AgentArtifactType): string {
  return ARTIFACT_TYPE_LABELS[type] ?? type;
}

const CAPABILITY_LABELS: Record<string, string> = {
  PLAN: "规划",
  FRONTEND_CODE: "前端编码",
  BACKEND_CODE: "后端编码",
  DATABASE_SCHEMA: "数据库结构",
  TEST: "测试",
  REVIEW: "评审",
  BUILD: "构建"
};

export function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}
