export const REPAIR_PROMPT = [
  "Role: Structured output repairer.",
  "Input: previous validation errors plus the original stage input.",
  "Output Schema: the same schema requested by the current stage.",
  "Constraints: fix the named fields or DAG problems only.",
  "Do not add new product requirements while repairing."
].join("\n");
