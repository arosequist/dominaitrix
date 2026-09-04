import { execFileSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const roots = ["extension", "adapters", "scripts", "test"];
const sourceFiles = [];

for (const root of roots) await collect(path.resolve(root));
for (const file of sourceFiles.filter((file) => /\.(?:js|mjs)$/.test(file))) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

for (const file of sourceFiles.filter((file) => file.endsWith(".json"))) {
  JSON.parse(await readFile(file, "utf8"));
}

const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Chrome extension must use Manifest V3");
for (const permission of ["scripting", "storage", "userScripts"]) {
  if (!manifest.permissions.includes(permission)) throw new Error(`Missing extension permission: ${permission}`);
}
for (const origin of ["http://*/*", "https://*/*"]) {
  if (!manifest.host_permissions?.includes(origin)) throw new Error(`Missing host permission: ${origin}`);
}
if (manifest.optional_host_permissions?.length) throw new Error("Site access must not require per-site permission prompts");

try {
  await access("extension/registry");
  throw new Error("Generated registry must not be bundled in the extension");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

console.log(`Checked ${sourceFiles.length} project files`);

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(target);
    else if (/\.(?:js|mjs|json)$/.test(entry.name)) sourceFiles.push(target);
  }
}
