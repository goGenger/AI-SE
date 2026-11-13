import assert from "node:assert/strict";
import test from "node:test";
import { parseCsvLine } from "../src/csv.mjs";

test("简单逗号分隔", () => {
  assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
});

test("引号包裹的字段可含逗号", () => {
  assert.deepEqual(parseCsvLine('a,"b,c",d'), ["a", "b,c", "d"]);
});

test("空行返回空数组", () => {
  assert.deepEqual(parseCsvLine(""), []);
});
