# Architecture

## Runtime flow

1. The service worker fetches a static registry index.
2. The user grants site access once when installing the extension, allowing current and future curated adapters to run without per-site prompts.
3. The extension automatically downloads every published adapter and verifies its SHA-256 digest.
4. `chrome.userScripts` installs the shared runtime and adapters into their matching pages.
5. Each adapter registers tools through `document.modelContext.registerTool()`.
6. Tool handlers read live application state and may use same-origin HTTP calls or DOM interaction.
7. A separately isolated content script relays minimized health events to local extension storage.

Adapters default to Chrome's `USER_SCRIPT` execution world. An adapter may request `MAIN` only when it must access application-owned JavaScript state or functions. Main-world adapters remain unable to call extension APIs.

## Boundaries

- The extension does not provide an AI agent. A WebMCP-capable agent must discover and invoke the registered tools.
- WebMCP is feature-detected. On unsupported pages the adapter reports `webmcp_unavailable` and does nothing else.
- Adapter source is trusted publisher code. Integrity verification detects a source/index mismatch, but compromise of the publisher or registry storage remains inside the trust boundary.
- Remote adapter execution is intended for transparent sideloaded/user-script use. Chrome Web Store policy may reject a registry-driven extension if reviewers determine that its scripts are not genuinely user-provided.
- A site can disable WebMCP with Permissions Policy or use an incompatible document configuration.
- Private site APIs are implementation details and may change without warning. Adapters should verify resulting application state rather than treating an HTTP 2xx response as sufficient.
