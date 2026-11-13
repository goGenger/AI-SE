import { createApp } from "./app.mjs";
import { createStore } from "./store.mjs";

const port = Number(process.env.PORT ?? 0);
const server = createApp(createStore());
server.listen(port, () => {
  console.log(`todo service listening on ${server.address().port}`);
});
