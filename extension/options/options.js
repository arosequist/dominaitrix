import { MESSAGE } from "../shared/constants.js";

const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const state = await send(MESSAGE.getState);

form.elements.registryUrl.value = state.settings.registryUrl;
form.elements.autoUpdate.checked = state.settings.autoUpdate;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "";
  const settings = {
    registryUrl: form.elements.registryUrl.value.trim(),
    autoUpdate: form.elements.autoUpdate.checked,
  };

  try {
    await send(MESSAGE.saveSettings, { settings });
    status.textContent = "Saved";
  } catch (error) {
    status.textContent = error.message;
  }
});

async function send(type, detail = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...detail });
  if (!response?.ok) throw new Error(response?.error ?? "Extension request failed");
  return response.value;
}
