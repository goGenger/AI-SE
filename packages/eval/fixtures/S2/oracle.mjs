import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const workspace = process.argv[2];
const { parseDuration } = await import(pathToFileURL(join(workspace, "src/duration.mjs")).href);

const cases = [
  ["1h30m", 5400000],
  ["2h", 7200000],
  ["90m", 5400000],
  ["1s", 1000],
  ["250ms", 250],
  ["500", 500],
  ["1H 30M", 5400000],
  ["1h30m15s250ms", 5415250],
  ["", null],
  ["abc", null],
  ["-5m", null],
  ["1.5h", null],
  ["1h1h", null],
  ["1x", null]
];
for (const [input, expected] of cases) {
  assert.equal(parseDuration(input), expected, `parseDuration(${JSON.stringify(input)})`);
}
console.log(`oracle S2: ${cases.length} 个断言通过`);
