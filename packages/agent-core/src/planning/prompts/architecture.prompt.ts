import {
  DEFAULT_CAPABILITY_PROFILE,
  profileConsumesApi,
  profileEnablesDataLayer,
  type CapabilityProfile
} from "@ai-se/shared";
import {
  CONFLICT_RESOLUTIONS_CLAUSE,
  PROVIDED_TECHNICAL_DOCUMENTS_CLAUSE
} from "./provided-documents.prompt";

const GENERATE_ARCHITECTURE_LINES = [
  "Role: Application architect.",
  "Input: requirement, functional spec, and technical spec.",
  "Output Schema: ArchitectureSpec.",
  "Constraints: list components, responsibilities, dependencies, and data flow.",
  "Keep the architecture implementable by later phases without executing code now.",
  "Applicability: describe only components that really exist in the deliverable. If there is",
  "no meaningful component structure (e.g. one self-contained static file), return",
  '{"components": [], "dataFlow": []} instead of inventing an architecture.',
  PROVIDED_TECHNICAL_DOCUMENTS_CLAUSE,
  CONFLICT_RESOLUTIONS_CLAUSE
];

const CONSUME_ARCHITECTURE_LINES = [
  "Role: Application architect for a frontend capability profile.",
  "Input: requirement, functional spec, and technical spec.",
  "Output Schema: ArchitectureSpec.",
  "Constraints: list frontend components, responsibilities, dependencies, and data flow, including the client or encapsulation layer that talks to provided APIs.",
  "Do not invent backend services, databases, or a server-side API. Provided TRD / API contracts are inputs to consume, not services to design.",
  "Keep the architecture implementable by later frontend phases without executing code now.",
  "Applicability: describe only components that really exist in the deliverable. If there is",
  "no meaningful component structure (e.g. one self-contained static file), return",
  '{"components": [], "dataFlow": []} instead of inventing an architecture.',
  PROVIDED_TECHNICAL_DOCUMENTS_CLAUSE,
  CONFLICT_RESOLUTIONS_CLAUSE
];

export function architecturePrompt(options: { profile?: CapabilityProfile } = {}): string {
  const profile = options.profile ?? DEFAULT_CAPABILITY_PROFILE;
  const consumeFrontend = profileConsumesApi(profile) || !profileEnablesDataLayer(profile);
  const lines = consumeFrontend ? CONSUME_ARCHITECTURE_LINES : GENERATE_ARCHITECTURE_LINES;
  return lines.join("\n");
}

/** 默认合成（产品默认 profile = frontend-vue，不发明后端架构）。 */
export const ARCHITECTURE_PROMPT = architecturePrompt();
