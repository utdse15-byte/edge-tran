import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const skip = new Set(["node_modules"]);
const files = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    // .mjs was previously skipped, which left the repo's own tooling
    // (scripts/audit.mjs, scripts/mock-provider.mjs) unchecked.
    else if (entry.isFile() && /\.m?js$/.test(entry.name)) files.push(full);
  }
}

await walk(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}
console.log(`Syntax OK: ${files.length} JavaScript files`);
