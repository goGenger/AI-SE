import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const workspace = process.argv[2];
const { mergeConfig } = await import(pathToFileURL(join(workspace, "src/merge.mjs")).href);

const base = { name: "app", nested: { a: 1, b: 2 }, list: [1, 2, 3], keep: "yes" };
const override = { nested: { b: 9, c: 3 }, list: [9], keep: undefined, added: null };
const merged = mergeConfig(base, override);

assert.deepEqual(merged, {
  name: "app",
  nested: { a: 1, b: 9, c: 3 },
  list: [9],
  keep: "yes",
  added: null
});

assert.deepEqual(
  base,
  { name: "app", nested: { a: 1, b: 2 }, list: [1, 2, 3], keep: "yes" },
  "base 不得被修改"
);
assert.deepEqual(override.list, [9], "override 不得被修改");

assert.deepEqual(mergeConfig({ a: 1 }, null), null, "override 为 null → 返回 null");
assert.deepEqual(mergeConfig({ a: 1 }, undefined), { a: 1 }, "override 为 undefined → base 深拷贝");
assert.deepEqual(mergeConfig([1, 2], { a: 1 }), { a: 1 }, "base 非对象 → 返回 override 拷贝");

const deepCopy = mergeConfig({ nested: { a: 1 } }, {});
deepCopy.nested.a = 99;
assert.equal(mergeConfig({ nested: { a: 1 } }, {}).nested.a, 1, "返回全新对象");

console.log("oracle M3: 全部断言通过");
