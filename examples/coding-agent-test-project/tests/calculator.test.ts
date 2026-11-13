import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { add, calculateDiscount } from "../src/calculator.ts";

describe("calculator", () => {
  it("adds two numbers", () => {
    assert.equal(add(2, 3), 5);
  });

  it("applies the regular discount", () => {
    assert.equal(calculateDiscount(100, false), 10);
  });

  it("applies the premium discount", () => {
    assert.equal(calculateDiscount(100, true), 20);
  });
});
