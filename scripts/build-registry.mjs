import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const sourceRoot = path.join(root, "adapters");
const outputRoot = path.join(root, "registry");
const checkOnly = process.argv.includes("--check");

const entries = await readdir(sourceRoot, { withFileTypes: true });
const adapters = [];

for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
  const directory = path.join(sourceRoot, entry.name);
  const manifest = JSON.parse(await readFile(path.join(directory, "adapter.json"), "utf8"));
  if (manifest.id !== entry.name) throw new Error(`${entry.name}: directory and adapter ID must match`);
  const source = await readFile(path.join(directory, "adapter.js"), "utf8");
  const sha256 = createHash("sha256").update(source).digest("hex");
  adapters.push({
    ...manifest,
    source: `adapters/${manifest.id}/adapter.js`,
    sha256,
  });
}

const index = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  adapters,
};

if (checkOnly) {
  const existing = JSON.parse(await readFile(path.join(outputRoot, "index.json"), "utf8"));
  delete existing.generatedAt;
  delete index.generatedAt;
  if (JSON.stringify(existing) !== JSON.stringify(index)) {
    throw new Error("Registry output is stale; run pnpm registry:build");
  }
  console.log(`Registry is current (${adapters.length} adapter${adapters.length === 1 ? "" : "s"})`);
  process.exit(0);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
for (const adapter of adapters) {
  const target = path.join(outputRoot, "adapters", adapter.id);
  await mkdir(target, { recursive: true });
  await cp(path.join(sourceRoot, adapter.id, "adapter.js"), path.join(target, "adapter.js"));
}
await writeFile(path.join(outputRoot, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

console.log(`Built registry with ${adapters.length} adapter${adapters.length === 1 ? "" : "s"}`);
