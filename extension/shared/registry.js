const MATCH_PATTERN = /^(https?|\*):\/\/([^/]+)\/.*$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function assertRegistry(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.adapters)) {
    throw new Error("Unsupported registry format");
  }

  const ids = new Set();
  for (const adapter of value.adapters) {
    assertAdapter(adapter);
    if (ids.has(adapter.id)) throw new Error(`Duplicate adapter ID: ${adapter.id}`);
    ids.add(adapter.id);
  }
  return value;
}

export function assertAdapter(adapter) {
  if (!adapter || !ID_PATTERN.test(adapter.id ?? "")) {
    throw new Error("Adapter has an invalid ID");
  }
  for (const key of ["name", "version", "description", "source"]) {
    if (typeof adapter[key] !== "string" || !adapter[key].trim()) {
      throw new Error(`${adapter.id}: missing ${key}`);
    }
  }
  if (adapter.source !== `adapters/${adapter.id}/adapter.js`) {
    throw new Error(`${adapter.id}: source must use its canonical relative path`);
  }
  if (!Array.isArray(adapter.matches) || adapter.matches.length === 0) {
    throw new Error(`${adapter.id}: matches must not be empty`);
  }
  for (const pattern of adapter.matches) {
    if (!MATCH_PATTERN.test(pattern)) throw new Error(`${adapter.id}: invalid match pattern ${pattern}`);
  }
  if (!SHA256_PATTERN.test(adapter.sha256 ?? "")) {
    throw new Error(`${adapter.id}: invalid SHA-256 digest`);
  }
  if (!["USER_SCRIPT", "MAIN"].includes(adapter.world)) {
    throw new Error(`${adapter.id}: invalid execution world`);
  }
  if (!Array.isArray(adapter.tools)) throw new Error(`${adapter.id}: tools must be an array`);
  return adapter;
}

export function resolveSourceUrl(indexUrl, source) {
  return new URL(source, indexUrl).href;
}

export function urlMatchesPattern(url, pattern) {
  try {
    const parsed = new URL(url);
    const match = pattern.match(MATCH_PATTERN);
    if (!match) return false;
    const [, scheme, hostPattern] = match;
    if (scheme !== "*" && parsed.protocol !== `${scheme}:`) return false;
    if (scheme === "*" && !["http:", "https:"].includes(parsed.protocol)) return false;

    const hostMatches = hostPattern === "*"
      || (hostPattern.startsWith("*.")
        ? parsed.hostname === hostPattern.slice(2) || parsed.hostname.endsWith(`.${hostPattern.slice(2)}`)
        : parsed.hostname === hostPattern);
    if (!hostMatches) return false;

    const pathPattern = pattern.slice(pattern.indexOf("/", pattern.indexOf("//") + 2));
    const escaped = pathPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${escaped}$`).test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }
}

export async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
