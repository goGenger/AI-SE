import { z } from "zod";
import { MCPContractError } from "../contracts";

/**
 * Phase 5.5-2: minimal, strict JSON Schema → Zod converter.
 *
 * Covers the constructs actually emitted by the fake/third-party MCP servers
 * in this repo (object / properties / required / additionalProperties, string,
 * number / integer, boolean, array / items, enum, const, and the common
 * length/range keywords). Anything validation-bearing that is NOT supported
 * fails explicitly with JSONSchemaConversionError — validation is never
 * silently loosened.
 *
 * Benign annotation keywords (title, description, default, ...) are ignored.
 */

export class JSONSchemaConversionError extends MCPContractError {
  constructor(
    public readonly path: string,
    message: string
  ) {
    super(`JSON Schema ${path}: ${message}`);
  }
}

type JsonSchemaValue = Record<string, unknown>;

const ANNOTATION_KEYS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "default",
  "examples",
  "$comment",
  "readOnly",
  "writeOnly",
  "deprecated",
  "annotations"
]);

/** Validation-bearing keywords this converter implements. */
const SUPPORTED_VALIDATION_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems"
]);

function unsupportedKey(schema: JsonSchemaValue, path: string): string | undefined {
  for (const key of Object.keys(schema)) {
    if (ANNOTATION_KEYS.has(key) || SUPPORTED_VALIDATION_KEYS.has(key)) continue;
    return `${path}.${key}`;
  }
  return undefined;
}

function assertSupported(schema: JsonSchemaValue, path: string): void {
  const key = unsupportedKey(schema, path);
  if (key) {
    throw new JSONSchemaConversionError(
      path,
      `unsupported keyword ${key.split(".").at(-1)}; refusing to weaken validation`
    );
  }
}

function assertArray(value: unknown, path: string, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new JSONSchemaConversionError(path, `${what} must be an array`);
  }
  return value;
}

function schemaAt(value: unknown, path: string, what: string): JsonSchemaValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JSONSchemaConversionError(path, `${what} must be an object`);
  }
  return value as JsonSchemaValue;
}

function literalSchema(value: unknown, path: string): z.ZodType<unknown> {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return z.literal(value as string | number | boolean | null);
  }
  throw new JSONSchemaConversionError(
    path,
    `const value must be a JSON primitive, got ${typeof value}`
  );
}

function enumSchema(values: unknown, path: string): z.ZodType<unknown> {
  const entries = assertArray(values, path, "enum");
  if (entries.length === 0) {
    throw new JSONSchemaConversionError(path, "empty enum is not supported");
  }
  if (entries.every((entry) => typeof entry === "string")) {
    return z.enum(entries as unknown as [string, ...string[]]);
  }
  // Heterogeneous or non-string enums: an exact union of literals.
  const options: z.ZodType<unknown>[] = entries.map((entry) => literalSchema(entry, path));
  return z.union(
    options as unknown as [z.ZodType<unknown>, z.ZodType<unknown>, ...z.ZodType<unknown>[]]
  );
}

function numericSchema(
  schema: JsonSchemaValue,
  path: string,
  integer: boolean
): z.ZodType<unknown> {
  if (typeof schema.enum !== "undefined") return enumSchema(schema.enum, `${path}.enum`);
  let result: z.ZodType<unknown> = integer ? z.number().int() : z.number();
  if (typeof schema.minimum === "number") result = result.pipe(z.number().min(schema.minimum));
  if (typeof schema.maximum === "number") result = result.pipe(z.number().max(schema.maximum));
  return result;
}

function stringSchema(schema: JsonSchemaValue, path: string): z.ZodType<unknown> {
  if (typeof schema.enum !== "undefined") return enumSchema(schema.enum, `${path}.enum`);
  if (typeof schema.const !== "undefined") return literalSchema(schema.const, `${path}.const`);
  let result: z.ZodType<unknown> = z.string();
  if (typeof schema.minLength === "number") result = result.pipe(z.string().min(schema.minLength));
  if (typeof schema.maxLength === "number") result = result.pipe(z.string().max(schema.maxLength));
  return result;
}

function arraySchema(schema: JsonSchemaValue, path: string): z.ZodType<unknown> {
  const itemSchema =
    typeof schema.items === "undefined"
      ? z.unknown()
      : convert(schemaAt(schema.items, `${path}.items`, "items"), `${path}.items`);
  let result: z.ZodType<unknown> = z.array(itemSchema);
  if (typeof schema.minItems === "number")
    result = result.pipe(z.array(itemSchema).min(schema.minItems));
  if (typeof schema.maxItems === "number")
    result = result.pipe(z.array(itemSchema).max(schema.maxItems));
  return result;
}

function objectSchema(schema: JsonSchemaValue, path: string): z.ZodType<unknown> {
  const properties =
    typeof schema.properties === "undefined"
      ? {}
      : schemaAt(schema.properties, `${path}.properties`, "properties");
  const requiredEntries =
    typeof schema.required === "undefined"
      ? []
      : assertArray(schema.required, `${path}.required`, "required");
  for (const entry of requiredEntries) {
    if (typeof entry !== "string") {
      throw new JSONSchemaConversionError(`${path}.required`, "required entries must be strings");
    }
  }
  const required = new Set(requiredEntries as string[]);

  const shape: Record<string, z.ZodType<unknown>> = {};
  for (const [key, value] of Object.entries(properties)) {
    const child = schemaAt(value, `${path}.properties.${key}`, `properties.${key}`);
    shape[key] = convert(child, `${path}.properties.${key}`);
    if (!required.has(key)) {
      shape[key] = shape[key].optional();
    }
  }
  for (const key of required) {
    if (!(key in shape)) {
      throw new JSONSchemaConversionError(
        `${path}.required`,
        `required property "${key}" has no properties entry`
      );
    }
  }

  const base = z.object(shape);
  let object: z.ZodType<unknown> = base.passthrough(); // JSON Schema: absent additionalProperties = true

  if (typeof schema.additionalProperties === "boolean") {
    object = schema.additionalProperties ? base.passthrough() : base.strict();
  } else if (
    typeof schema.additionalProperties === "object" &&
    schema.additionalProperties !== null
  ) {
    const additional = convert(
      schema.additionalProperties as JsonSchemaValue,
      `${path}.additionalProperties`
    );
    object =
      Object.keys(shape).length > 0 ? base.catchall(additional) : z.record(z.string(), additional);
  }

  return object;
}

function convert(schema: unknown, path: string): z.ZodType<unknown> {
  const value = schemaAt(schema, path, "schema");
  assertSupported(value, path);

  if (typeof value.const !== "undefined") return literalSchema(value.const, `${path}.const`);
  if (typeof value.enum !== "undefined") return enumSchema(value.enum, `${path}.enum`);

  const type = value.type;
  if (type === undefined) {
    // Schema with only annotations: accept anything.
    return z.unknown();
  }
  if (typeof type !== "string") {
    throw new JSONSchemaConversionError(
      `${path}.type`,
      `type must be a string, got ${JSON.stringify(type)}; union types are not supported`
    );
  }

  switch (type) {
    case "object":
      return objectSchema(value, path);
    case "string":
      return stringSchema(value, path);
    case "number":
    case "integer":
      return numericSchema(value, path, type === "integer");
    case "boolean":
      if (typeof value.enum !== "undefined") return enumSchema(value.enum, `${path}.enum`);
      return z.boolean();
    case "array":
      return arraySchema(value, path);
    case "null":
      return z.null();
    default:
      throw new JSONSchemaConversionError(`${path}.type`, `unsupported type "${type}"`);
  }
}

/**
 * Converts an MCP-reported JSON Schema (the inputSchema of tools/list) into a
 * Zod schema for the existing Tool Runtime. Throws JSONSchemaConversionError
 * for anything it cannot represent safely.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodType<unknown> {
  if (
    schema === undefined ||
    schema === null ||
    (typeof schema === "object" && Object.keys(schema as object).length === 0)
  ) {
    return z.unknown();
  }
  return convert(schema, "$");
}
