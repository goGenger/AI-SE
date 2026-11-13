import { loadData, saveData } from "./persist.mjs";
import { createApp } from "./app.mjs";
import { fromJSON } from "./store.mjs";

const args = process.argv.slice(2);
const dataFile = args.includes("--data") ? args[args.indexOf("--data") + 1] : null;
const port = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : 0;

const data = dataFile ? await loadData(dataFile) : { items: [], nextId: 1 };
const store = fromJSON(data);
const app = createApp(store, {
  persist: dataFile ? (current) => saveData(dataFile, current.toJSON()) : null
});
app.listen(port, () => {
  console.log(`api listening on ${app.address().port}`);
});
