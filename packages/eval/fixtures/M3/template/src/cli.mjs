import { readFile } from "node:fs/promises";
import { mergeConfig } from "./merge.mjs";

const [basePath, overridePath] = process.argv.slice(2);
const base = JSON.parse(await readFile(basePath, "utf8"));
const override = JSON.parse(await readFile(overridePath, "utf8"));
console.log(JSON.stringify(mergeConfig(base, override), null, 2));
