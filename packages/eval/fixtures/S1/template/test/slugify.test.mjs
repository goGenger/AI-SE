import assert from "node:assert/strict";
import test from "node:test";
import { slugify } from "../src/slugify.mjs";

test("基础：空格转连字符并转小写", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("去掉首尾空白与多余连字符", () => {
  assert.equal(slugify("  Hello  World  "), "hello-world");
});

test("空输入返回空串", () => {
  assert.equal(slugify(""), "");
});
