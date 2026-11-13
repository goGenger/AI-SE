import { buildSite } from "./build.mjs";

const contentDir = process.argv[2] ?? "content";
const outDir = process.argv[3] ?? "dist";
const written = await buildSite(contentDir, outDir);
console.log(`生成 ${written.length} 个页面：${written.join(", ")}`);
