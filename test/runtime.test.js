import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("adapter runtime registers and executes the smoke-test tool", async () => {
  const registered = [];
  const messages = [];
  const nodes = {
    h1: { textContent: "Example Domain" },
    "a[href]": { href: "https://www.iana.org/help/example-domains" },
  };
  const window = { postMessage: (message) => messages.push(message) };
  const sandbox = {
    AbortController,
    DOMException,
    TextEncoder,
    clearTimeout,
    console,
    fetch,
    location: { origin: "https://example.com" },
    navigator: { userAgent: "Chrome/153.0.0.0" },
    performance,
    setTimeout,
    window,
    document: {
      querySelector: (selector) => nodes[selector] ?? null,
      querySelectorAll: () => [],
      modelContext: {
        registerTool: async (tool) => { registered.push(tool); },
      },
    },
  };
  window.window = window;

  const runtime = await readFile(new URL("../extension/runtime/adapter-runtime.js", import.meta.url), "utf8");
  const adapter = await readFile(new URL("../adapters/example-com/adapter.js", import.meta.url), "utf8");
  const context = vm.createContext(sandbox);
  vm.runInContext(runtime, context);
  vm.runInContext(adapter, context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "inspect_example_page");
  const result = await registered[0].execute({}, { signal: new AbortController().signal });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    content: [{
      type: "text",
      text: JSON.stringify({
        heading: "Example Domain",
        link: "https://www.iana.org/help/example-domains",
      }),
    }],
  });
  assert.equal(messages.some((message) => message.event?.phase === "registration"), true);
  assert.equal(messages.some((message) => message.event?.phase === "execution" && message.event?.outcome === "success"), true);
});
