import {
  DEFAULT_CAPABILITY_PROFILE,
  profileConsumesApi,
  type CapabilityProfile
} from "@ai-se/shared";
import {
  CONFLICT_RESOLUTIONS_CLAUSE,
  PROVIDED_TECHNICAL_DOCUMENTS_CLAUSE
} from "./provided-documents.prompt";

const GENERATE_API_SPEC_LINES = [
  "Role: API designer.",
  "Input: requirement, functional spec, technical spec, and architecture.",
  "Output Schema: ApiSpec.",
  "Constraints: use explicit HTTP method, path, request, response, and errors.",
  "Only include APIs needed by the stated PRD.",
  "Applicability: if the deliverable exposes no server/API surface (e.g. a static offline",
  'page or a single self-contained file), return {"endpoints": []}. An empty list is the',
  "CORRECT answer — never invent endpoints to fill the schema.",
  PROVIDED_TECHNICAL_DOCUMENTS_CLAUSE,
  CONFLICT_RESOLUTIONS_CLAUSE
];

const CONSUME_API_SPEC_LINES = [
  "Role: Frontend API encapsulation planner.",
  "Input: requirement, functional spec, technical spec, architecture, and provided TRD / API contracts / encapsulation examples.",
  "Output Schema: ApiSpec.",
  "This capability profile consumes API contracts as input; it does not generate a backend API.",
  "Follow `providedTechnicalDocs` and any encapsulation examples in the TRD as authoritative. Plan how the frontend will encapsulate those interfaces in the `encapsulation` field (source, client, pages, optional notes) and how they connect to pages.",
  "List in `endpoints` only interfaces grounded in the provided documents or the PRD, using explicit HTTP method, path, request, response, and errors when the contract states them.",
  "Do not invent a server-side API, backend service, or endpoint that the documents do not state.",
  "If no API contract or encapsulation example is provided, do not invent endpoints. An empty `endpoints` list is the CORRECT answer. Plan a thin frontend client only to the extent the PRD/TRD actually specifies, and record the missing contract in `apiContractGaps` (optional topic, and a short note). Recording the gap is valid; pretending a contract already exists is not. Do not refuse to produce the plan just because a contract is missing.",
  PROVIDED_TECHNICAL_DOCUMENTS_CLAUSE,
  CONFLICT_RESOLUTIONS_CLAUSE
];

export function apiSpecPrompt(options: { profile?: CapabilityProfile } = {}): string {
  const profile = options.profile ?? DEFAULT_CAPABILITY_PROFILE;
  const lines = profileConsumesApi(profile) ? CONSUME_API_SPEC_LINES : GENERATE_API_SPEC_LINES;
  return lines.join("\n");
}

/** 默认合成（产品默认 profile = frontend-vue，走消费模式）。 */
export const API_SPEC_PROMPT = apiSpecPrompt();
