import {
  CONFLICT_RESOLUTIONS_CLAUSE,
  PROVIDED_TECHNICAL_DOCUMENTS_CLAUSE
} from "./provided-documents.prompt";

export const TECHNICAL_SPEC_PROMPT = [
  "Role: Technical designer.",
  "Input: requirement analysis and functional requirements.",
  "Output Schema: TechnicalSpec.",
  "Constraints: identify minimal technical requirements needed to implement the PRD.",
  "Do not add RAG, vector databases, CI/CD, Kubernetes, or production automation.",
  PROVIDED_TECHNICAL_DOCUMENTS_CLAUSE,
  CONFLICT_RESOLUTIONS_CLAUSE
].join("\n");
