import { MESSAGE } from "../shared/constants.js";
import { urlMatchesPattern } from "../shared/registry.js";

const elements = {
  site: document.querySelector("#site"),
  adapters: document.querySelector("#adapters"),
  notice: document.querySelector("#notice"),
  health: document.querySelector("#health"),
  update: document.querySelector("#update"),
  export: document.querySelector("#export"),
  settings: document.querySelector("#settings"),
};

let state;
let currentUrl = "";

await refresh();

elements.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
elements.update.addEventListener("click", async () => {
  await withButton(elements.update, async () => {
    const result = await send(MESSAGE.checkUpdates);
    showNotice(syncSummary(result));
    await refresh();
  });
});
elements.export.addEventListener("click", exportHealth);

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentUrl = tab?.url ?? "";
  elements.site.textContent = hostname(currentUrl);
  state = await send(MESSAGE.getState);
  renderAdapters();
  renderHealth();
  if (!state.userScriptsAvailable) {
    showNotice("Enable Allow User Scripts in DOMinAItrix's extension details, reload the extension, then reload this tab.");
  }
}

function renderAdapters() {
  const adapters = state.registry.adapters.filter((adapter) =>
    adapter.matches.some((pattern) => urlMatchesPattern(currentUrl, pattern)));
  elements.adapters.replaceChildren();

  if (!adapters.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No curated adapter matches this page.";
    elements.adapters.append(empty);
    return;
  }

  for (const adapter of adapters) {
    const card = document.createElement("article");
    card.className = "adapter";
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = adapter.name;
    const description = document.createElement("p");
    description.textContent = adapter.description;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${adapter.tools.length} tool${adapter.tools.length === 1 ? "" : "s"} · v${adapter.version}`;
    copy.append(name, description, meta);

    const installed = state.userScriptsAvailable && Boolean(state.installed[adapter.id]);
    const status = document.createElement("span");
    status.className = installed ? "adapter-status" : "adapter-status adapter-status--error";
    status.textContent = installed ? "Active" : state.userScriptsAvailable ? "Unavailable" : "Setup required";
    card.append(copy, status);
    elements.adapters.append(card);
  }
}

function syncSummary(result) {
  const changed = result.added.length + result.updated.length + result.removed.length;
  if (result.failed.length) {
    const reasons = new Set(result.failed.map(({ error }) => error));
    if (reasons.size === 1) return result.failed[0].error;
    return `${result.failed.length} adapter${result.failed.length === 1 ? "" : "s"} could not be activated.`;
  }
  if (!changed) return "Adapters are current.";
  return `${changed} adapter${changed === 1 ? "" : "s"} synchronized.`;
}

function renderHealth() {
  const failures = state.telemetry.filter((event) => event.outcome === "failure");
  if (!state.telemetry.length) {
    elements.health.textContent = "No adapter events recorded.";
  } else if (!failures.length) {
    elements.health.textContent = `${state.telemetry.length} recent events, no failures.`;
  } else {
    const latest = failures.at(-1);
    elements.health.textContent = `${failures.length} failure${failures.length === 1 ? "" : "s"}; latest: ${latest.adapterId} / ${latest.code || latest.category}.`;
  }
}

async function exportHealth() {
  const payload = JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), events: state.telemetry }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `dominaitrix-health-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function withButton(button, action) {
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = false;
  }
}

function showNotice(message) {
  elements.notice.textContent = message;
  elements.notice.hidden = false;
}

function hostname(value) {
  try { return new URL(value).hostname; } catch { return "This page"; }
}

async function send(type, detail = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...detail });
  if (!response?.ok) throw new Error(response?.error ?? "Extension request failed");
  return response.value;
}
