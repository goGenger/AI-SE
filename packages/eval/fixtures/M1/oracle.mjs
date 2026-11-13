import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const workspace = process.argv[2];
const { createApp } = await import(pathToFileURL(join(workspace, "src/app.mjs")).href);
const { createStore } = await import(pathToFileURL(join(workspace, "src/store.mjs")).href);

const server = createApp(createStore());
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const json = (path, init) => fetch(`${base}${path}`, init);

try {
  // 既有行为回归
  const created = await json("/todos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "A" })
  });
  assert.equal(created.status, 201);
  const itemA = await created.json();

  const createdB = await json("/todos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "B" })
  });
  const itemB = await createdB.json();

  const all = await (await json("/todos")).json();
  assert.equal(all.items.length, 2, "GET /todos 应返回全部");

  // PATCH
  const patched = await json(`/todos/${itemA.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ done: true })
  });
  assert.equal(patched.status, 200, "PATCH 应返回 200");
  const patchedBody = await patched.json();
  assert.equal(patchedBody.done, true);
  assert.equal(patchedBody.title, "A", "未给出的字段不应被改动");

  const renamed = await json(`/todos/${itemA.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "A2" })
  });
  const renamedBody = await renamed.json();
  assert.equal(renamedBody.title, "A2");
  assert.equal(renamedBody.done, true, "只更新给出的字段");

  assert.equal(
    (
      await json("/todos/9999", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    ).status,
    404
  );
  assert.equal(
    (
      await json(`/todos/${itemA.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{oops"
      })
    ).status,
    400
  );

  // 过滤
  const doneOnly = await (await json("/todos?done=true")).json();
  assert.deepEqual(
    doneOnly.items.map((item) => item.id),
    [itemA.id],
    "done=true 只返回已完成"
  );
  const openOnly = await (await json("/todos?done=false")).json();
  assert.deepEqual(
    openOnly.items.map((item) => item.id),
    [itemB.id],
    "done=false 只返回未完成"
  );

  // DELETE
  const deleted = await json(`/todos/${itemB.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 204, "DELETE 应返回 204");
  assert.equal((await json(`/todos/${itemB.id}`, { method: "DELETE" })).status, 404);
  const remaining = await (await json("/todos")).json();
  assert.deepEqual(
    remaining.items.map((item) => item.id),
    [itemA.id]
  );

  console.log("oracle M1: 全部断言通过");
} finally {
  server.close();
}
