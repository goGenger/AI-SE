import { access } from "node:fs/promises";

await Promise.all([access("server.mjs"), access("health-status.txt")]);
