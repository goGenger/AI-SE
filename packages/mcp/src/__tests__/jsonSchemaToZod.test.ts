import { describe, expect, it } from "vitest";
import { JSONSchemaConversionError, jsonSchemaToZod } from "../integration/jsonSchemaToZod";

describe("jsonSchemaToZod", () => {
  it("maps empty/absent schemas to z.unknown()", () => {
    expect(jsonSchemaToZod(undefined).safeParse({ anything: 1 }).success).toBe(true);
    expect(jsonSchemaToZod({}).safeParse([1, 2]).success).toBe(true);
  });

  it("maps a strict object with required properties", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        message: { type: "string" },
        count: { type: "integer" }
      },
      required: ["message"],
      additionalProperties: false
    });

    expect(schema.safeParse({ message: "hi", count: 2 }).success).toBe(true);
    expect(schema.safeParse({ message: "hi" }).success).toBe(true);
    expect(schema.safeParse({ count: 2 }).success).toBe(false); // message required
    expect(schema.safeParse({ message: "hi", extra: 1 }).success).toBe(false); // strict
  });

  it("maps a record-style schema (additionalProperties without properties)", () => {
    const schema = jsonSchemaToZod({ type: "object", additionalProperties: {} });
    expect(schema.safeParse({ a: 1, b: "x" }).success).toBe(true);
  });

  it("allows extra keys when additionalProperties is absent (JSON Schema default: true)", () => {
    // The official SDK reports record schemas as {type:"object", properties:{}}.
    const schema = jsonSchemaToZod({ type: "object", properties: { message: { type: "string" } } });
    expect(schema.safeParse({ message: "hi", extra: 42 }).success).toBe(true);
    expect(schema.safeParse({ message: 1 }).success).toBe(false);
  });

  it("applies string min/max length and number min/max", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string", minLength: 2, maxLength: 4 },
        age: { type: "number", minimum: 0, maximum: 150 }
      },
      required: ["name", "age"],
      additionalProperties: false
    });

    expect(schema.safeParse({ name: "abc", age: 30 }).success).toBe(true);
    expect(schema.safeParse({ name: "a", age: 30 }).success).toBe(false);
    expect(schema.safeParse({ name: "abc", age: -1 }).success).toBe(false);
    expect(schema.safeParse({ name: "abc", age: 30.5 }).success).toBe(true); // number, not integer
  });

  it("maps arrays with items and length bounds", () => {
    const schema = jsonSchemaToZod({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 3
    });
    expect(schema.safeParse(["a", "b"]).success).toBe(true);
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse(["a", "b", "c", "d"]).success).toBe(false);
    expect(schema.safeParse([1]).success).toBe(false);
  });

  it("maps string enums", () => {
    const schema = jsonSchemaToZod({ type: "string", enum: ["a", "b"] });
    expect(schema.safeParse("a").success).toBe(true);
    expect(schema.safeParse("c").success).toBe(false);
  });

  it("maps const and literal unions", () => {
    expect(jsonSchemaToZod({ const: 7 }).safeParse(7).success).toBe(true);
    expect(jsonSchemaToZod({ const: 7 }).safeParse(8).success).toBe(false);
    const union = jsonSchemaToZod({ enum: ["a", 1, true] });
    expect(union.safeParse("a").success).toBe(true);
    expect(union.safeParse(1).success).toBe(true);
    expect(union.safeParse(true).success).toBe(true);
    expect(union.safeParse("b").success).toBe(false);
  });

  it("maps nested objects recursively", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        inner: {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
          additionalProperties: false
        }
      },
      required: ["inner"],
      additionalProperties: false
    });
    expect(schema.safeParse({ inner: { x: 1 } }).success).toBe(true);
    expect(schema.safeParse({ inner: { x: "nope" } }).success).toBe(false);
  });

  it("fails explicitly on unsupported validation keywords", () => {
    const cases: Record<string, unknown>[] = [
      { type: "object", patternProperties: { "^x": { type: "string" } } },
      { type: "string", pattern: "^a" },
      { type: "string", format: "email" },
      { type: "object", properties: { a: { $ref: "#/$defs/a" } } },
      { oneOf: [{ type: "string" }, { type: "number" }] },
      { type: ["string", "null"] },
      { type: "object", minProperties: 1 },
      { type: "number", multipleOf: 2 }
    ];

    for (const input of cases) {
      expect(() => jsonSchemaToZod(input)).toThrow(JSONSchemaConversionError);
    }
  });

  it("fails explicitly when required lists a property without a definition", () => {
    expect(() =>
      jsonSchemaToZod({ type: "object", required: ["missing"], additionalProperties: false })
    ).toThrow(JSONSchemaConversionError);
  });

  it("ignores benign annotation keywords", () => {
    const schema = jsonSchemaToZod({
      type: "string",
      title: "Name",
      description: "A display name",
      default: "x",
      examples: ["a"],
      $schema: "https://json-schema.org/draft/2020-12/schema"
    });
    expect(schema.safeParse("value").success).toBe(true);
    expect(schema.safeParse(1).success).toBe(false);
  });
});
