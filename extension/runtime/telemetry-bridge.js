(() => {
  const CHANNEL = "__dominaitrix_health_v1__";
  let windowStartedAt = Date.now();
  let eventCount = 0;

  window.addEventListener("message", (message) => {
    if (message.source !== window || message.origin !== location.origin) return;
    if (message.data?.channel !== CHANNEL || !message.data.event) return;

    const now = Date.now();
    if (now - windowStartedAt > 60_000) {
      windowStartedAt = now;
      eventCount = 0;
    }
    if (++eventCount > 120) return;

    chrome.runtime.sendMessage({ type: "adapter-telemetry", event: message.data.event }).catch(() => {});
  });
})();
