import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const workspace = process.argv[2];
const { parseCsvLine } = await import(pathToFileURL(join(workspace, "src/csv.mjs")).href);

const cases = [
  ["a,b,c", ["a", "b", "c"]],
  ['a,"b,c",d', ["a", "b,c", "d"]],
  ['"a""b"', ['a"b']],
  ["", []],
  ["a,", ["a", ""]],
  [",a", ["", "a"]],
  ['" leading",x', [" leading", "x"]],
  ['a,"b""c,d",e', ["a", 'b"c,d', "e"]],
  [null, []],
  [undefined, []]
];
for (const [input, expected] of cases) {
  assert.deepEqual(parseCsvLine(input), expected, `parseCsvLine(${JSON.stringify(input)})`);
}
console.log(`oracle S3: ${cases.length} 个断言通过`);
