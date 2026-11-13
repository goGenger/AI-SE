import { AgentArtifactType, JsonObject } from "@ai-se/shared";

export type ProfessionalOutcomeStatus = "SUCCESS" | "FAILED" | "RETRY" | "REPLAN";

export interface AgentIssue {
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  file?: string;
  description: string;
  recommendation: string;
}

export interface AgentArtifactDraft {
  type: AgentArtifactType;
  name: string;
  content: JsonObject;
  metadata?: JsonObject;
}

export interface ProfessionalOutcome {
  status: ProfessionalOutcomeStatus;
  summary: string;
  artifacts: AgentArtifactDraft[];
  issues: AgentIssue[];
  recommendations: string[];
  /**
   * N-22（`docs/199`）：`status === "REPLAN"` 时**应当创建的任务类型**。
   * 与 `outcomeSchema.ts` 的 `SubmitResultSchema.fixTaskType` 是同一契约的两处表述
   * （zod schema 供 JSON-Schema 转换，本接口供 TS 消费方）——**两处必须同步**。
   */
  fixTaskType?: string;
  metadata: JsonObject;
}
