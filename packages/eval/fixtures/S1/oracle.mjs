import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const workspace = process.argv[2];
const { slugify } = await import(pathToFileURL(join(workspace, "src/slugify.mjs")).href);

const cases = [
  ["Hello World", "hello-world"],
  ["  Hello  World  ", "hello-world"],
  ["", ""],
  ["   ", ""],
  ["A--B__C", "a-b-c"],
  ["foo/bar.baz", "foo-bar-baz"],
  ["中文 标题", "中文-标题"],
  ["Hello\tWorld\nAgain", "hello-world-again"],
  ["---a---", "a"],
  ["Ünïcode Ëxample", "ünïcode-ëxample"]
];
for (const [input, expected] of cases) {
  assert.equal(slugify(input), expected, `slugify(${JSON.stringify(input)})`);
}
console.log(`oracle S1: ${cases.length} 个断言通过`);
