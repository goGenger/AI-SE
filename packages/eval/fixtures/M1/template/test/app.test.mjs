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

test("POST 创建后 GET 能列出", () =>
  withServer(async (base) => {
    const created = await fetch(`${base}/todos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "写文档" })
    });
    assert.equal(created.status, 201);
    const listed = await fetch(`${base}/todos`);
    const payload = await listed.json();
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].title, "写文档");
  }));

test("未知路径 404", () =>
  withServer(async (base) => {
    const response = await fetch(`${base}/nope`);
    assert.equal(response.status, 404);
  }));
