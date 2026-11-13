import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayName } from "../src/user.ts";
import type { User } from "../src/user.ts";

describe("displayName", () => {
  it("returns a trimmed name", () => {
    const user: User = { id: "user-1", name: " Ada ", isPremiumUser: true };
    assert.equal(displayName(user), "Ada");
  });

  it("falls back when a name is blank", () => {
    const user: User = { id: "user-2", name: " ", isPremiumUser: false };
    assert.equal(displayName(user), "Anonymous");
  });
});
