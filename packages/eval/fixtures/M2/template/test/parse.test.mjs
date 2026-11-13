import assert from "node:assert/strict";
import test from "node:test";
import { parseTable } from "../src/parse.mjs";

test("解析表头与数据行", () => {
  const table = parseTable("| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.deepEqual(table.headers, ["A", "B"]);
  assert.deepEqual(table.rows, [["1", "2"]]);
});
