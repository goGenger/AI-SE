import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig } from "../src/merge.mjs";

test("标量覆盖", () => {
  assert.deepEqual(mergeConfig({ a: 1 }, { a: 2 }), { a: 2 });
});

test("嵌套对象递归合并", () => {
  assert.deepEqual(mergeConfig({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
});
