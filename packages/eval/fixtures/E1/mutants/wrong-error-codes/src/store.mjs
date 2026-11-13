// JSON 文件存储（DATA_DIR/db.json）：启动加载、变更后原子写入（tmp + rename）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "db.json");
  const state = { users: [], tasks: [] };

  if (existsSync(file)) {
    const loaded = JSON.parse(readFileSync(file, "utf8"));
    state.users = Array.isArray(loaded.users) ? loaded.users : [];
    state.tasks = Array.isArray(loaded.tasks) ? loaded.tasks : [];
  }

  function persist() {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, file);
  }

  return { state, persist, file };
}
