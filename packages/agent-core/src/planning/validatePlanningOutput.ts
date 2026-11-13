import {
  ApiSpecContent,
  DatabaseSpecContent,
  FunctionalSpecContent,
  TechnicalSpecContent
} from "@ai-se/shared";

export interface PlanningSpecificationValidationInput {
  functionalSpec: FunctionalSpecContent;
  technicalSpec: TechnicalSpecContent;
  apiSpec: ApiSpecContent;
  databaseSpec?: DatabaseSpecContent;
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates];
}

export function validatePlanningSpecifications(
  input: PlanningSpecificationValidationInput
): string[] {
  const errors: string[] = [];

  for (const id of duplicateValues(input.functionalSpec.requirements.map((entry) => entry.id))) {
    errors.push(`Duplicate functional requirement id: ${id}`);
  }

  for (const id of duplicateValues(input.technicalSpec.requirements.map((entry) => entry.id))) {
    errors.push(`Duplicate technical requirement id: ${id}`);
  }

  const endpointKeys = input.apiSpec.endpoints.map((endpoint) => {
    return `${endpoint.method} ${endpoint.path}`;
  });
  for (const endpoint of duplicateValues(endpointKeys)) {
    errors.push(`Duplicate API endpoint: ${endpoint}`);
  }

  for (const tableName of duplicateValues(
    (input.databaseSpec?.tables ?? []).map((table) => table.name)
  )) {
    errors.push(`Duplicate database table: ${tableName}`);
  }

  return errors;
}
