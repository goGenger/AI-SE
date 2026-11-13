export function createStore() {
  const items = new Map();
  let nextId = 1;

  return {
    add(title) {
      const item = { id: nextId, title, done: false };
      nextId += 1;
      items.set(item.id, item);
      return item;
    },
    list() {
      return [...items.values()];
    },
    get(id) {
      return items.get(id) ?? null;
    },
    update(id, patch) {
      throw new Error("update 尚未实现");
    },
    remove(id) {
      throw new Error("remove 尚未实现");
    }
  };
}
