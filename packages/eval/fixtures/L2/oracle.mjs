import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
const { loadData, saveData } = await import(pathToFileURL(join(workspace, "src/persist.mjs")).href);
const { createApp } = await import(pathToFileURL(join(workspace, "src/app.mjs")).href);
const { fromJSON } = await import(pathToFileURL(join(workspace, "src/store.mjs")).href);

const dir = await mkdtemp(join(tmpdir(), "l2-oracle-"));
const dataFile = join(dir, "nested", "data.json");

assert.deepEqual(await loadData(dataFile), { items: [], nextId: 1 }, "缺文件返回默认值");
const brokenFile = join(dir, "broken.json");
await writeFile(brokenFile, "{not json");
assert.deepEqual(await loadData(brokenFile), { items: [], nextId: 1 }, "损坏文件返回默认值");

async function startApp() {
  const data = await loadData(dataFile);
  const store = fromJSON(data);
  const server = createApp(store, { persist: (current) => saveData(dataFile, current.toJSON()) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

let app = await startApp();
try {
  const created = await fetch(`${app.base}/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "A" })
  });
  assert.equal(created.status, 201);
  const item = await created.json();

  const put = await fetch(`${app.base}/items/${item.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "A2", done: true })
  });
  assert.equal(put.status, 200, "PUT 应返回 200");
  const updated = await put.json();
  assert.equal(updated.title, "A2");
  assert.equal(updated.done, true);
  assert.equal(
    (
      await fetch(`${app.base}/items/9999`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    ).status,
    404
  );

  const stats = await (await fetch(`${app.base}/stats`)).json();
  assert.deepEqual(stats, { count: 1, doneCount: 1 }, "stats 计数");
} finally {
  app.server.close();
}

const persisted = JSON.parse(await readFile(dataFile, "utf8"));
assert.equal(persisted.items.length, 1, "写盘后重新读回");
assert.equal(persisted.items[0].title, "A2");

app = await startApp();
try {
  const items = await (await fetch(`${app.base}/items`)).json();
  assert.equal(items.items.length, 1, "重启后数据仍在");
  assert.equal(items.items[0].done, true);
} finally {
  app.server.close();
}

console.log("oracle L2: 全部断言通过");
