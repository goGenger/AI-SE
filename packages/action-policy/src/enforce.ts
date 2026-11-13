import { ToolDefinition, ToolExecutionContext, ToolExecutionError } from "@ai-se/tool-runtime";
import {
  ActionPolicy,
  ActionPolicyDecision,
  ActionPolicyError,
  ExternalActionDeclaration,
  defaultActionPolicy,
  riskRank
} from "./policy";

/**
 * Phase 5.7-3: policy enforcement helpers.
 *
 *  - applyActionPolicy(): composition-time enforcement for a ToolDefinition
 *    set. Every definition's declared riskLevel is checked against the unified
 *    policy (a declaration BELOW the policy decision is a DENY — the definition
 *    set must not be built), the final riskLevel is the policy decision, and
 *    approval-requiring actions get the shared approval gate.
 *  - withApprovalGate(): execution-time gate for actions whose policy decision
 *    requires approval. It reuses the platform's existing approval
 *    convention — `context.metadata.approved === true`, the same flag the
 *    delivery tools and the deployment orchestrator already pass down — so no
 *    new approval entity, engine, or state machine is introduced.
 */

export type ApplyActionPolicyOptions =
  | { source: "browser"; policy?: ActionPolicy }
  | {
      source: "external";
      policy?: ActionPolicy;
      declarations: Record<string, ExternalActionDeclaration>;
    };

/**
 * Returns policy-checked copies of the definitions. Throws ActionPolicyError
 * (composition-time DENY) when an action is unknown to the policy or declares
 * a risk level below the policy decision.
 */
export function applyActionPolicy<TInput = unknown, TOutput = unknown>(
  definitions: ToolDefinition<TInput, TOutput>[],
  options: ApplyActionPolicyOptions
): ToolDefinition<TInput, TOutput>[] {
  const policy = options.policy ?? defaultActionPolicy;
  return definitions.map((definition) => {
    const decision =
      options.source === "browser"
        ? policy.resolveBrowser(definition.name)
        : policy.resolveExternal(definition.name, options.declarations[definition.name]);
    if (!decision) {
      throw new ActionPolicyError(
        `Action policy DENY: unknown ${options.source} action ${definition.name}`
      );
    }
    if (riskRank(definition.riskLevel) < riskRank(decision.riskLevel)) {
      throw new ActionPolicyError(
        `Action policy DENY: ${definition.name} declares ${definition.riskLevel} below the policy decision ${decision.riskLevel}`
      );
    }
    return withApprovalGate({ ...definition, riskLevel: decision.riskLevel }, decision);
  });
}

/**
 * Wraps one definition with the shared approval gate when the policy decision
 * requires approval. The gate runs BEFORE the action body: an unapproved call
 * throws TOOL_ERROR and produces zero downstream requests/actions.
 */
export function withApprovalGate<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>,
  decision: ActionPolicyDecision
): ToolDefinition<TInput, TOutput> {
  if (!decision.requiresApproval) return definition;
  const execute = definition.execute;
  return {
    ...definition,
    async execute(input: TInput, context: ToolExecutionContext): Promise<TOutput> {
      if (context.metadata?.approved !== true) {
        throw new ToolExecutionError(
          "TOOL_ERROR",
          `Action ${definition.name} requires human approval (risk ${decision.riskLevel}) before execution`
        );
      }
      return execute(input, context);
    }
  };
}
