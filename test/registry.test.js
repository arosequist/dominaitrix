import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertRegistry, resolveSourceUrl, sha256, urlMatchesPattern } from "../extension/shared/registry.js";

test("matches Chrome-style site patterns", () => {
  assert.equal(urlMatchesPattern("https://fantasy.espn.com/football/draft?league=1", "https://fantasy.espn.com/football/*"), true);
  assert.equal(urlMatchesPattern("http://sub.example.com/path", "*://*.example.com/*"), true);
  assert.equal(urlMatchesPattern("https://evil.example.net/path", "*://*.example.com/*"), false);
});

test("resolves remote adapter sources", () => {
  assert.equal(
    resolveSourceUrl("https://cdn.example/registry/index.json", "adapters/example/adapter.js"),
    "https://cdn.example/registry/adapters/example/adapter.js",
  );
});

test("generated registry is valid and source digests match", async () => {
  const index = JSON.parse(await readFile(new URL("../registry/index.json", import.meta.url), "utf8"));
  assertRegistry(index);
  for (const adapter of index.adapters) {
    const source = await readFile(new URL(`../registry/${adapter.source}`, import.meta.url), "utf8");
    assert.equal(await sha256(source), adapter.sha256);
  }
});

test("registry rejects adapter source redirects", () => {
  assert.throws(() => assertRegistry({
    schemaVersion: 1,
    adapters: [{
      id: "example",
      name: "Example",
      version: "1.0.0",
      description: "Example adapter",
      source: "https://unrelated.example/adapter.js",
      matches: ["https://example.com/*"],
      sha256: "0".repeat(64),
      world: "USER_SCRIPT",
      tools: [],
    }],
  }), /canonical relative path/);
});
