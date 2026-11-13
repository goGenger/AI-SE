import type {
  ApiSpecContent,
  CapabilityProfile,
  ProvidedTechnicalDocument,
  Requirement
} from "@ai-se/shared";
import { profileConsumesApi } from "@ai-se/shared";

export const INVENTED_API_ENDPOINT_ERROR_PREFIX =
  "Consumed API plan invents an endpoint that is not grounded in the provided TRD, API contract, or requirement:";

export interface ConsumedApiSpecValidationInput {
  profile: CapabilityProfile;
  apiSpec: ApiSpecContent;
  providedTechnicalDocs?: ReadonlyArray<Pick<ProvidedTechnicalDocument, "fileName" | "text">>;
  requirement?: Pick<Requirement, "title" | "description" | "rawContent">;
}

/**
 * Normalize path parameter syntax so `/api/todos/:id` and `/api/todos/{id}` compare equal.
 * Apply this to a single path, never to a whole document — brace rewriting would eat code blocks.
 */
export function normalizeApiPathForGrounding(path: string): string {
  return path
    .trim()
    .toLowerCase()
    .replace(/\{[^}]+\}/g, ":param")
    .replace(/:[a-z0-9_]+/gi, ":param")
    .replace(/\/+$/, "");
}

function groundingCorpus(input: ConsumedApiSpecValidationInput): string {
  const parts: string[] = [];
  if (input.requirement) {
    parts.push(input.requirement.title, input.requirement.description, input.requirement.rawContent);
  }
  for (const doc of input.providedTechnicalDocs ?? []) {
    parts.push(doc.fileName, doc.text);
  }
  return parts.join("\n");
}

function pathSearchVariants(path: string): string[] {
  const lower = path.trim().toLowerCase().replace(/\/+$/, "");
  const asBrace = lower.replace(/:[a-z0-9_]+/gi, (match) => `{${match.slice(1)}}`);
  const asColon = lower.replace(/\{[^}]+\}/g, (match) => `:${match.slice(1, -1)}`);
  return [...new Set([lower, asBrace, asColon])];
}

function extractNormalizedPaths(text: string): Set<string> {
  const paths = new Set<string>();
  const matches = text.toLowerCase().match(/\/[a-z0-9/_\-.:{}]+/gi) ?? [];
  for (const match of matches) {
    const trimmed = match.replace(/[.,;:'"`)\]]+$/g, "");
    const normalized = normalizeApiPathForGrounding(trimmed);
    if (normalized.length >= 2) {
      paths.add(normalized);
    }
  }
  return paths;
}

export function isEndpointGroundedInCorpus(
  endpoint: { method: string; path: string },
  corpus: string
): boolean {
  const path = endpoint.path.trim().toLowerCase().replace(/\/+$/, "");
  if (path.length < 2) {
    return false;
  }
  const lowerCorpus = corpus.toLowerCase();
  if (pathSearchVariants(path).some((variant) => lowerCorpus.includes(variant))) {
    return true;
  }
  return extractNormalizedPaths(corpus).has(normalizeApiPathForGrounding(path));
}

/**
 * docs/269：消费 API 的能力面不得发明服务端接口。
 *
 * 硬规则：
 * - 生成 API 的 profile（如 backend-node）：本校验不生效，保持既有「生成接口规格」行为；
 * - 端点的 path 必须能在提供的技术文档 / TRD 或需求正文里找到（参数写法会归一化）；
 * - 没有契约时，空 `endpoints` 是正确输出，不因缺契约而拒绝规划；
 * - 记下 `apiContractGaps` 即可继续，不得用虚构端点假装契约已有。
 */
export function validateConsumedApiSpec(input: ConsumedApiSpecValidationInput): string[] {
  if (!profileConsumesApi(input.profile)) {
    return [];
  }

  const corpus = groundingCorpus(input);
  const errors: string[] = [];
  for (const endpoint of input.apiSpec.endpoints) {
    if (!isEndpointGroundedInCorpus(endpoint, corpus)) {
      errors.push(`${INVENTED_API_ENDPOINT_ERROR_PREFIX} ${endpoint.method} ${endpoint.path}`);
    }
  }
  return errors;
}
