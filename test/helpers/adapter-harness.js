import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";

export async function loadAdapter(adapterPath, html, options = {}) {
  const { document, window } = parseHTML(html);
  if (options.cookie !== undefined) {
    Object.defineProperty(document, "cookie", { configurable: true, value: String(options.cookie), writable: true });
  }
  const registered = [];
  const messages = [];
  document.modelContext = {
    registerTool: async (tool) => { registered.push(tool); },
  };
  window.postMessage = (message) => messages.push(message);

  const sandbox = {
    AbortController,
    DOMException,
    Response,
    TextEncoder,
    URL,
    URLSearchParams,
    clearTimeout,
    console,
    document,
    fetch: options.fetch ?? fetch,
    location: new URL(options.url ?? "https://example.com/"),
    navigator: { userAgent: "Chrome/153.0.0.0" },
    performance,
    setTimeout,
    window,
  };
  const context = vm.createContext(sandbox);
  const runtime = await readFile(new URL("../../extension/runtime/adapter-runtime.js", import.meta.url), "utf8");
  const adapter = await readFile(new URL(adapterPath, import.meta.url), "utf8");
  vm.runInContext(runtime, context);
  vm.runInContext(adapter, context);
  await new Promise((resolve) => setImmediate(resolve));

  return {
    document,
    messages,
    tools: Object.fromEntries(registered.map((tool) => [tool.name, tool])),
  };
}

export function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}
