export const STORAGE_KEYS = Object.freeze({
  settings: "settings",
  installed: "installedAdapters",
  registry: "registryCache",
  telemetry: "telemetryEvents",
});

export const DEFAULT_SETTINGS = Object.freeze({
  registryUrl: "https://dominaitrix-registry.s3.us-east-1.amazonaws.com/index.json",
  autoUpdate: true,
  telemetryLimit: 500,
});

export const ALARMS = Object.freeze({
  registry: "registry-update",
});

export const MESSAGE = Object.freeze({
  getState: "get-state",
  checkUpdates: "check-updates",
  saveSettings: "save-settings",
  telemetry: "adapter-telemetry",
});
