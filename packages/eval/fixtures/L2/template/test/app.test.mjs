import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.mjs";
import { createStore } from "../src/store.mjs";

function withServer(run) {
  return new Promise((resolve, reject) => {
    const server = createApp(createStore());
    server.listen(0, "127.0.0.1", async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        await run(base);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

test("POST 后 GET 能列出", () =>
  withServer(async (base) => {
    await fetch(`${base}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "A" })
    });
    const payload = await (await fetch(`${base}/items`)).json();
    assert.equal(payload.items.length, 1);
  }));
