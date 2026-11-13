import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("delivery fixture has an explicit health mode", async () => {
  const mode = (await readFile("health-status.txt", "utf8")).trim();
  assert.ok(["healthy", "broken"].includes(mode));
});
