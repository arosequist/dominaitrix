import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("background activates the full registry and reconciles later changes", async () => {
  let registry = JSON.parse(await readFile(new URL("../registry/index.json", import.meta.url), "utf8"));
  const sources = new Map();
  for (const adapter of registry.adapters) {
    sources.set(
      `https://dominaitrix-registry.s3.us-east-1.amazonaws.com/${adapter.source}`,
      await readFile(new URL(`../registry/${adapter.source}`, import.meta.url), "utf8"),
    );
  }

  const storage = {};
  const userScripts = new Map();
  const contentScripts = new Map();
  const listeners = {};
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;

  globalThis.chrome = {
    alarms: {
      create() {},
      onAlarm: { addListener(listener) { listeners.alarm = listener; } },
    },
    runtime: {
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } },
      onStartup: { addListener(listener) { listeners.startup = listener; } },
    },
    scripting: {
      async getRegisteredContentScripts(filter) {
        return select(contentScripts, filter?.ids);
      },
      async registerContentScripts(scripts) {
        for (const script of scripts) contentScripts.set(script.id, structuredClone(script));
      },
      async unregisterContentScripts({ ids }) {
        for (const id of ids) contentScripts.delete(id);
      },
    },
    storage: {
      local: {
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.map((key) => [key, structuredClone(storage[key])]));
        },
        async set(values) { Object.assign(storage, structuredClone(values)); },
      },
    },
    userScripts: {
      async configureWorld() {},
      async getScripts(filter) { return select(userScripts, filter?.ids); },
      async register(scripts) {
        for (const script of scripts) userScripts.set(script.id, structuredClone(script));
      },
      async unregister({ ids }) {
        for (const id of ids) userScripts.delete(id);
      },
      async update(scripts) {
        for (const script of scripts) userScripts.set(script.id, structuredClone(script));
      },
    },
  };
  globalThis.fetch = async (url) => {
    if (url === "https://dominaitrix-registry.s3.us-east-1.amazonaws.com/index.json") {
      return response({ json: structuredClone(registry) });
    }
    return response({ text: sources.get(url) });
  };

  try {
    await import(`../extension/background/index.js?test=${Date.now()}`);
    await listeners.installed();

    assert.deepEqual(Object.keys(storage.installedAdapters).sort(), registry.adapters.map(({ id }) => id).sort());
    assert.equal(userScripts.size, registry.adapters.length);
    assert.equal(contentScripts.size, registry.adapters.length);

    const removedAdapter = registry.adapters[0];
    const retained = registry.adapters[1];
    registry = {
      ...registry,
      adapters: [{ ...retained, version: "0.1.1" }, ...registry.adapters.slice(2)],
    };
    const result = await sendMessage(listeners.message, { type: "check-updates" });

    assert.deepEqual(result.added, []);
    assert.deepEqual(result.updated, [retained.id]);
    assert.deepEqual(result.removed, [removedAdapter.id]);
    assert.deepEqual(result.failed, []);
    assert.equal(storage.installedAdapters[retained.id].version, "0.1.1");
    assert.equal(storage.installedAdapters[removedAdapter.id], undefined);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("background reports the user scripts prerequisite without an uncaught startup error", async () => {
  const registry = JSON.parse(await readFile(new URL("../registry/index.json", import.meta.url), "utf8"));
  const storage = {};
  const listeners = {};
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;

  globalThis.chrome = {
    alarms: {
      create() {},
      onAlarm: { addListener(listener) { listeners.alarm = listener; } },
    },
    runtime: {
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } },
      onStartup: { addListener(listener) { listeners.startup = listener; } },
    },
    scripting: {},
    storage: {
      local: {
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.map((key) => [key, structuredClone(storage[key])]));
        },
        async set(values) { Object.assign(storage, structuredClone(values)); },
      },
    },
  };
  globalThis.fetch = async () => response({ json: structuredClone(registry) });

  try {
    await import(`../extension/background/index.js?test=no-user-scripts-${Date.now()}`);
    await listeners.installed();

    const state = await sendMessage(listeners.message, { type: "get-state" });
    assert.equal(state.userScriptsAvailable, false);

    const result = await sendMessage(listeners.message, { type: "check-updates" });
    assert.equal(result.failed.length, registry.adapters.length);
    assert.match(result.failed[0].error, /Allow User Scripts is off/);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

function select(items, ids) {
  const values = [...items.values()];
  return ids ? values.filter(({ id }) => ids.includes(id)) : values;
}

function response({ json, text }) {
  return {
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    async json() { return json; },
    async text() { return text; },
  };
}

async function sendMessage(listener, message) {
  return new Promise((resolve, reject) => {
    listener(message, {}, (response) => {
      if (response.ok) resolve(response.value);
      else reject(new Error(response.error));
    });
  });
}
