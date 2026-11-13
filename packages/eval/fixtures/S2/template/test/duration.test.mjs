import assert from "node:assert/strict";
import test from "node:test";
import { parseDuration } from "../src/duration.mjs";

test("小时加分钟", () => {
  assert.equal(parseDuration("1h30m"), 5400000);
});

test("纯数字按毫秒", () => {
  assert.equal(parseDuration("500"), 500);
});

test("非法输入返回 null", () => {
  assert.equal(parseDuration("abc"), null);
});
