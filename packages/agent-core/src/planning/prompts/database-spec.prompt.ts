import {
  CONFLICT_RESOLUTIONS_CLAUSE,
  PROVIDED_TECHNICAL_DOCUMENTS_CLAUSE
} from "./provided-documents.prompt";

export const DATABASE_SPEC_PROMPT = [
  "Role: Database designer.",
  "Input: requirement, functional spec, technical spec, architecture, and API spec.",
  "Output Schema: DatabaseSpec.",
  "Constraints: list tables, columns, indexes, and relations.",
  "Do not introduce stores that are not required by the requirement.",
  "Applicability: if the PRD persists nothing (static content, client-only state), return",
  '{"tables": []}. An empty list is the CORRECT answer — never invent a table (such as one',
  "that merely stores the deliverable) to satisfy the schema.",
  PROVIDED_TECHNICAL_DOCUMENTS_CLAUSE,
  CONFLICT_RESOLUTIONS_CLAUSE
].join("\n");
