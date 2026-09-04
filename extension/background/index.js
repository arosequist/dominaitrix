import { ALARMS, DEFAULT_SETTINGS, MESSAGE, STORAGE_KEYS } from "../shared/constants.js";
import { assertRegistry, resolveSourceUrl, sha256 } from "../shared/registry.js";

const UPDATE_PERIOD_MINUTES = 6 * 60;
const USER_SCRIPTS_UNAVAILABLE = "Allow User Scripts is off for DOMinAItrix. Enable it in the extension's Details page, reload the extension, then reload this tab.";

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await configureUserScriptWorld();
  chrome.alarms.create(ALARMS.registry, { periodInMinutes: UPDATE_PERIOD_MINUTES });
  await syncAdapters().catch(console.error);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await configureUserScriptWorld();
  const settings = await getSettings();
  if (settings.autoUpdate) await syncAdapters().catch(console.error);
});

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name === ALARMS.registry) {
    const settings = await getSettings();
    if (settings.autoUpdate) await syncAdapters().catch(console.error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case MESSAGE.getState:
      return getState();
    case MESSAGE.checkUpdates:
      return syncAdapters();
    case MESSAGE.saveSettings:
      return saveSettings(message.settings);
    case MESSAGE.telemetry:
      return recordTelemetry(message.event);
    default:
      throw new Error("Unknown extension message");
  }
}

async function ensureDefaults() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.installed, STORAGE_KEYS.telemetry]);
  const next = {};
  if (!stored[STORAGE_KEYS.settings]) next[STORAGE_KEYS.settings] = { ...DEFAULT_SETTINGS };
  if (!stored[STORAGE_KEYS.installed]) next[STORAGE_KEYS.installed] = {};
  if (!stored[STORAGE_KEYS.telemetry]) next[STORAGE_KEYS.telemetry] = [];
  if (Object.keys(next).length) await chrome.storage.local.set(next);
}

async function configureUserScriptWorld() {
  if (!chrome.userScripts?.configureWorld) return;
  await chrome.userScripts.configureWorld({ worldId: "dominaitrix", messaging: false });
}

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...stored[STORAGE_KEYS.settings] };
}

async function saveSettings(candidate) {
  const settings = {
    ...await getSettings(),
    registryUrl: normalizeRegistryUrl(candidate.registryUrl),
    autoUpdate: Boolean(candidate.autoUpdate),
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  await syncAdapters();
  return settings;
}

async function getState() {
  const settings = await getSettings();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.installed, STORAGE_KEYS.telemetry, STORAGE_KEYS.registry]);
  return {
    settings,
    installed: stored[STORAGE_KEYS.installed] ?? {},
    telemetry: stored[STORAGE_KEYS.telemetry] ?? [],
    registry: stored[STORAGE_KEYS.registry]?.registry ?? { schemaVersion: 1, adapters: [] },
    userScriptsAvailable: hasUserScriptsApi(),
  };
}

async function fetchRegistry(registryUrl) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.registry);
  const cached = stored[STORAGE_KEYS.registry];
  const headers = {};
  if (cached?.registryUrl === registryUrl && cached.etag) headers["if-none-match"] = cached.etag;

  const response = await fetch(registryUrl, { cache: "no-cache", headers });
  if (response.status === 304 && cached?.registry) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.registry]: { ...cached, checkedAt: new Date().toISOString() },
    });
    return cached.registry;
  }
  if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
  const registry = assertRegistry(await response.json());
  await chrome.storage.local.set({
    [STORAGE_KEYS.registry]: {
      registry,
      registryUrl,
      etag: response.headers?.get?.("etag") ?? "",
      fetchedAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
    },
  });
  return registry;
}

async function installAdapter(adapter, registryUrl) {
  requireUserScriptsApi();
  const sourceUrl = resolveSourceUrl(registryUrl, adapter.source);
  const response = await fetch(sourceUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Adapter source returned HTTP ${response.status}`);
  const source = await response.text();
  const digest = await sha256(source);
  if (digest !== adapter.sha256) throw new Error(`Integrity check failed for ${adapter.id}`);

  const scriptId = userScriptId(adapter.id);
  const script = {
    id: scriptId,
    matches: adapter.matches,
    js: [{ file: "runtime/adapter-runtime.js" }, { code: source }],
    runAt: "document_idle",
    world: adapter.world,
  };
  if (adapter.world === "USER_SCRIPT") script.worldId = "dominaitrix";

  const existing = await chrome.userScripts.getScripts({ ids: [scriptId] });
  if (existing.length) await chrome.userScripts.update([script]);
  else await chrome.userScripts.register([script]);

  await registerTelemetryBridge(adapter);

  const stored = await chrome.storage.local.get(STORAGE_KEYS.installed);
  const installed = stored[STORAGE_KEYS.installed] ?? {};
  installed[adapter.id] = {
    version: adapter.version,
    sha256: adapter.sha256,
    installedAt: new Date().toISOString(),
    world: adapter.world,
    matches: adapter.matches,
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.installed]: installed });
  return installed[adapter.id];
}

async function registerTelemetryBridge(adapter) {
  const id = contentScriptId(adapter.id);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
  await chrome.scripting.registerContentScripts([{
    id,
    matches: adapter.matches,
    js: ["runtime/telemetry-bridge.js"],
    runAt: "document_start",
    persistAcrossSessions: true,
    world: "ISOLATED",
  }]);
}

async function unregisterAdapter(adapterId) {
  requireUserScriptsApi();
  const scriptId = userScriptId(adapterId);
  const contentId = contentScriptId(adapterId);
  const scripts = await chrome.userScripts.getScripts({ ids: [scriptId] });
  if (scripts.length) await chrome.userScripts.unregister({ ids: [scriptId] });
  const contentScripts = await chrome.scripting.getRegisteredContentScripts({ ids: [contentId] });
  if (contentScripts.length) await chrome.scripting.unregisterContentScripts({ ids: [contentId] });

  const stored = await chrome.storage.local.get(STORAGE_KEYS.installed);
  const installed = stored[STORAGE_KEYS.installed] ?? {};
  delete installed[adapterId];
  await chrome.storage.local.set({ [STORAGE_KEYS.installed]: installed });
  return true;
}

async function syncAdapters() {
  const settings = await getSettings();
  const registry = await fetchRegistry(settings.registryUrl);
  if (!hasUserScriptsApi()) {
    return {
      added: [],
      updated: [],
      removed: [],
      failed: registry.adapters.map(({ id }) => ({ adapterId: id, error: USER_SCRIPTS_UNAVAILABLE })),
    };
  }
  const stored = await chrome.storage.local.get(STORAGE_KEYS.installed);
  const installed = stored[STORAGE_KEYS.installed] ?? {};
  const added = [];
  const updated = [];
  const removed = [];
  const failed = [];
  const registeredUserScripts = new Set(
    (await chrome.userScripts.getScripts()).map((script) => script.id),
  );
  const registeredContentScripts = new Set(
    (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id),
  );

  for (const adapter of registry.adapters) {
    const current = installed[adapter.id];
    const registrationIsCurrent = current?.sha256 === adapter.sha256
      && current.version === adapter.version
      && current.world === adapter.world
      && JSON.stringify(current.matches) === JSON.stringify(adapter.matches)
      && registeredUserScripts.has(userScriptId(adapter.id))
      && registeredContentScripts.has(contentScriptId(adapter.id));
    if (registrationIsCurrent) continue;
    try {
      await installAdapter(adapter, settings.registryUrl);
      (current ? updated : added).push(adapter.id);
    } catch (error) {
      failed.push({ adapterId: adapter.id, error: error.message });
    }
  }

  const publishedIds = new Set(registry.adapters.map((adapter) => adapter.id));
  for (const adapterId of Object.keys(installed)) {
    if (publishedIds.has(adapterId)) continue;
    try {
      await unregisterAdapter(adapterId);
      removed.push(adapterId);
    } catch (error) {
      failed.push({ adapterId, error: error.message });
    }
  }

  return { added, updated, removed, failed };
}

async function recordTelemetry(candidate) {
  const event = sanitizeTelemetry(candidate);
  const settings = await getSettings();
  const stored = await chrome.storage.local.get(STORAGE_KEYS.telemetry);
  const events = [...(stored[STORAGE_KEYS.telemetry] ?? []), event]
    .slice(-settings.telemetryLimit);
  await chrome.storage.local.set({ [STORAGE_KEYS.telemetry]: events });
  return true;
}

function sanitizeTelemetry(value) {
  const allowed = [
    "adapterId", "adapterVersion", "tool", "phase", "outcome", "category",
    "code", "durationBucket", "origin", "route", "timestamp", "chromeVersion",
  ];
  const event = {};
  for (const key of allowed) {
    if (typeof value?.[key] === "string") event[key] = value[key].slice(0, 160);
  }
  if (!event.adapterId || !event.phase || !event.outcome) throw new Error("Invalid telemetry event");
  return event;
}

function normalizeRegistryUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Registry URL must use HTTPS");
  return url.href;
}

function userScriptId(adapterId) {
  return `dominaitrix-${adapterId}`;
}

function contentScriptId(adapterId) {
  return `dominaitrix-health-${adapterId}`;
}

function hasUserScriptsApi() {
  return typeof chrome.userScripts?.getScripts === "function";
}

function requireUserScriptsApi() {
  if (!hasUserScriptsApi()) throw new Error(USER_SCRIPTS_UNAVAILABLE);
}
