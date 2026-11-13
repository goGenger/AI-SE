import {
  AgentArtifact,
  AgentRun,
  JsonObject,
  Project,
  ProvidedUiReference,
  Requirement,
  Specification,
  Task
} from "@ai-se/shared";
import { AgentDefinition } from "./AgentRegistry";

export interface TaskDependencyResult {
  taskId: string;
  taskKey: string;
  type: Task["type"];
  output?: JsonObject;
}

export interface TaskContext {
  project: Project;
  requirement?: Requirement;
  task: Task;
  specifications: Specification[];
  dependencyResults: TaskDependencyResult[];
  relevantFiles: string[];
  previousAttempts: Array<
    Pick<AgentRun, "id" | "status" | "currentIteration" | "retryCount" | "output" | "error">
  >;
  testResults: AgentArtifact[];
  reviewResults: AgentArtifact[];
  /**
   * UI 参照图元数据（无 base64）：提示 Agent「用户给过视觉参照」。
   * 像素级理解已在规划多模态阶段吸收进 UI_SPEC；此处避免把大图塞进文本 TaskContext。
   */
  uiReferences?: ProvidedUiReference[];
}

export function isolateTaskContext(definition: AgentDefinition, context: TaskContext): TaskContext {
  return {
    ...context,
    specifications: context.specifications.filter((specification) =>
      definition.specificationTypes.includes(specification.type)
    ),
    dependencyResults: context.dependencyResults.slice(-20),
    relevantFiles: context.relevantFiles.slice(0, 50),
    previousAttempts: context.previousAttempts.slice(0, 5),
    testResults: context.testResults.slice(-5),
    reviewResults: context.reviewResults.slice(-5)
  };
}
