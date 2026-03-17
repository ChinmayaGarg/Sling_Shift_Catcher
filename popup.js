const DEFAULTS = {
  enabled: true,
  keepPinnedTab: true,
  dryRun: true,
  //   targetUrl: "https://app.getsling.com/messages/17153548/Winter-2026-shift-changes",
  targetUrl: "https://app.getsling.com/messages/17748799/Tejaswini-Patel",
  replyText: "I can",
  // cooldownSec: 15,
  cooldownSec: 0,
  keywords: [
    "take my shift",
    "cover my shift",
    "can anyone take",
    "can anyone cover",
    "shift up for grabs",
    "shift available",
    "need someone to take",
    "anyone want my shift",
    "can someone take my shift",
    "can anyone pick up",
    "pick up my shift",
  ].join("\n"),
};

function setStatus(text, isError = false) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.style.color = isError ? "crimson" : "green";
}

async function loadSettings() {
  const data = await chrome.storage.sync.get(DEFAULTS);

  document.getElementById("enabled").checked = data.enabled;
  document.getElementById("keepPinnedTab").checked = data.keepPinnedTab;
  document.getElementById("dryRun").checked = data.dryRun;
  document.getElementById("targetUrl").value = data.targetUrl;
  document.getElementById("replyText").value = data.replyText;
  document.getElementById("cooldownSec").value = data.cooldownSec;
  document.getElementById("keywords").value = data.keywords;
}

async function saveSettings() {
  const payload = {
    enabled: document.getElementById("enabled").checked,
    keepPinnedTab: document.getElementById("keepPinnedTab").checked,
    dryRun: document.getElementById("dryRun").checked,
    targetUrl: document.getElementById("targetUrl").value.trim(),
    replyText: document.getElementById("replyText").value.trim() || "I can",
    cooldownSec: Number(document.getElementById("cooldownSec").value) || 15,
    keywords: document.getElementById("keywords").value.trim(),
  };

  await chrome.storage.sync.set(payload);
  setStatus("Saved");
}

async function openOrFocusWatcher() {
  const res = await chrome.runtime.sendMessage({
    type: "OPEN_OR_FOCUS_WATCHER",
  });
  if (!res?.ok) {
    setStatus(res?.error || "Could not open watcher tab", true);
    return;
  }
  setStatus("Watcher tab opened");
}

document.getElementById("saveBtn").addEventListener("click", saveSettings);
document
  .getElementById("openWatcherBtn")
  .addEventListener("click", openOrFocusWatcher);

loadSettings();
