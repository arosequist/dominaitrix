(() => {
  const CHANNEL = "__dominaitrix_health_v1__";
  const controllers = new Map();

  class AdapterError extends Error {
    constructor(category, code, message) {
      super(message);
      this.name = "AdapterError";
      this.category = category;
      this.code = code;
    }
  }

  function report(meta, event) {
    const duration = Number(event.durationMs ?? 0);
    const payload = {
      adapterId: meta.id,
      adapterVersion: meta.version,
      tool: String(event.tool ?? ""),
      phase: String(event.phase),
      outcome: String(event.outcome),
      category: String(event.category ?? ""),
      code: String(event.code ?? ""),
      durationBucket: duration < 100 ? "lt100ms" : duration < 500 ? "100-499ms" : duration < 2000 ? "500-1999ms" : "gte2000ms",
      origin: location.origin,
      route: String((typeof meta.route === "function" ? meta.route() : meta.route) ?? ""),
      timestamp: new Date().toISOString(),
      chromeVersion: navigator.userAgent.match(/(?:Chrome|Chromium)\/([0-9]+)/)?.[1] ?? "",
    };
    window.postMessage({ channel: CHANNEL, event: payload }, location.origin);
  }

  function classify(error) {
    if (error instanceof AdapterError) return { category: error.category, code: error.code };
    if (error?.name === "AbortError") return { category: "cancelled", code: "aborted" };
    return { category: "unexpected", code: error?.name || "error" };
  }

  function required(selector, root = document) {
    const node = root.querySelector(selector);
    if (!node) throw new AdapterError("dom", "selector_missing", `Required element not found: ${selector}`);
    return node;
  }

  async function json(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      ...options,
      headers: { accept: "application/json", ...options.headers },
    });
    if (response.status === 401 || response.status === 403) {
      throw new AdapterError("auth", `http_${response.status}`, "The site rejected the authenticated request");
    }
    if (response.status === 409) throw new AdapterError("state", "stale_state", "The site state changed before the action completed");
    if (!response.ok) throw new AdapterError("http", `http_${response.status}`, `Request failed with HTTP ${response.status}`);
    return response.json();
  }

  function context(meta) {
    return Object.freeze({
      dom: Object.freeze({ required, all: (selector, root = document) => [...root.querySelectorAll(selector)] }),
      http: Object.freeze({ json }),
      error: (category, code, message) => new AdapterError(category, code, message),
      report: (event) => report(meta, event),
    });
  }

  async function defineAdapter(definition) {
    const meta = definition?.meta;
    if (!meta?.id || !meta?.version || !Array.isArray(definition.tools)) {
      throw new Error("Invalid DOMinAItrix adapter definition");
    }

    if (!document.modelContext?.registerTool) {
      report(meta, { phase: "initialization", outcome: "failure", category: "platform", code: "webmcp_unavailable" });
      return;
    }

    controllers.get(meta.id)?.abort();
    const controller = new AbortController();
    controllers.set(meta.id, controller);
    const ctx = context(meta);

    for (const tool of definition.tools) {
      if (typeof tool.execute !== "function") throw new Error(`${tool.name} is missing execute()`);
      const registered = {
        name: tool.name,
        title: tool.title ?? "",
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        annotations: tool.annotations,
        execute: async (args, invocation) => {
          const started = performance.now();
          try {
            const result = await tool.execute(args, { ...invocation, ctx });
            report(meta, { tool: tool.name, phase: "execution", outcome: "success", durationMs: performance.now() - started });
            return result;
          } catch (error) {
            const classified = classify(error);
            report(meta, { tool: tool.name, phase: "execution", outcome: "failure", ...classified, durationMs: performance.now() - started });
            throw error;
          }
        },
      };

      try {
        await document.modelContext.registerTool(registered, { signal: controller.signal });
        report(meta, { tool: tool.name, phase: "registration", outcome: "success" });
      } catch (error) {
        const classified = classify(error);
        report(meta, { tool: tool.name, phase: "registration", outcome: "failure", ...classified });
      }
    }
  }

  Object.defineProperty(globalThis, "DOMinAItrix", {
    value: Object.freeze({ defineAdapter, AdapterError }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
