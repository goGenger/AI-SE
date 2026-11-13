import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const workspace = process.argv[2];
const { renderTable } = await import(pathToFileURL(join(workspace, "src/render.mjs")).href);

const table = {
  headers: ["Name", "Qty"],
  rows: [
    ["apple", "3"],
    ["pear", "12"]
  ]
};
const expected = ["| Name  | Qty |", "| ----- | --- |", "| apple | 3   |", "| pear  | 12  |"].join(
  "\n"
);
assert.equal(renderTable(table), expected, "基本对齐渲染");

const aligned = renderTable(
  { headers: ["L", "C", "R"], rows: [["x", "y", "z"]] },
  { align: ["left", "center", "right"] }
);
assert.equal(
  aligned,
  ["| L   | C   | R   |", "| :-- | :-: | --: |", "| x   | y   | z   |"].join("\n"),
  "对齐标记"
);

const escaped = renderTable({ headers: ["A"], rows: [["a|b"], ["c\nd"]] });
assert.equal(
  escaped,
  ["| A      |", "| ------ |", "| a\\|b   |", "| c<br>d |"].join("\n"),
  "转义与换行"
);

const empty = renderTable({ headers: ["A", "B"], rows: [] });
assert.equal(empty, ["| A   | B   |", "| --- | --- |"].join("\n"), "空数据只输出表头与分隔行");

console.log("oracle M2: 全部断言通过");
