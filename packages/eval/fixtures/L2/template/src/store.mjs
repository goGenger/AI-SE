export function createStore(initial = { items: [], nextId: 1 }) {
  const items = new Map(initial.items.map((item) => [item.id, item]));
  let nextId = initial.nextId;

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
    put(id, patch) {
      throw new Error("put 尚未实现");
    },
    remove(id) {
      throw new Error("remove 尚未实现");
    },
    toJSON() {
      throw new Error("toJSON 尚未实现");
    }
  };
}

export function fromJSON(data) {
  return createStore(data);
}
