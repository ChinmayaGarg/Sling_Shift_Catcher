const DEFAULTS = {
  enabled: true,
  keepPinnedTab: true,
  dryRun: true,
  targetUrl:
    "https://app.getsling.com/messages/17153548/Winter-2026-shift-changes",
  // targetUrl: "https://app.getsling.com/messages/17748799/Tejaswini-Patel",
  replyText: "I can",
  cooldownSec: 0,
  keywords: [
    "take my shift",
    "cover my shift",
    "can anyone take",
    "can any one take",
    "can anyone cover",
    "can any one cover",
    "shift up for grabs",
    "shift available",
    "need someone to take",
    "anyone want my shift",
    "can someone take my shift",
    "can anyone pick up",
    "pick up my shift",
    "shift giveaway",
    "shift open",
    "shift needs coverage",
    "shift coverage",
    "shift give away",
    "anyone able to work",
    "any one able to work",
    "giveaway shift",
    "give away shift",
    "giveaway",
    "give away",
  ].join("\n"),

  busyWindowsEnabled: true,
  busyWindowsAnyDay: [],
  busyWindowsByDay: {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: [],
  },
};

function setStatus(text, isError = false) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.style.color = isError ? "crimson" : "green";
}

function parseLinesToArray(value) {
  return (value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function arrayToTextarea(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

async function loadSettings() {
  const data = await chrome.storage.sync.get(DEFAULTS);

  const byDay = {
    ...DEFAULTS.busyWindowsByDay,
    ...(data.busyWindowsByDay || {}),
  };

  document.getElementById("enabled").checked = data.enabled;
  document.getElementById("keepPinnedTab").checked = data.keepPinnedTab;
  document.getElementById("dryRun").checked = data.dryRun;
  document.getElementById("targetUrl").value = data.targetUrl;
  document.getElementById("replyText").value = data.replyText;
  document.getElementById("cooldownSec").value = data.cooldownSec;
  document.getElementById("keywords").value = data.keywords;

  document.getElementById("busyWindowsEnabled").checked =
    data.busyWindowsEnabled;
  document.getElementById("busyWindowsAnyDay").value = arrayToTextarea(
    data.busyWindowsAnyDay,
  );

  document.getElementById("mondayBusy").value = arrayToTextarea(byDay.monday);
  document.getElementById("tuesdayBusy").value = arrayToTextarea(byDay.tuesday);
  document.getElementById("wednesdayBusy").value = arrayToTextarea(
    byDay.wednesday,
  );
  document.getElementById("thursdayBusy").value = arrayToTextarea(
    byDay.thursday,
  );
  document.getElementById("fridayBusy").value = arrayToTextarea(byDay.friday);
  document.getElementById("saturdayBusy").value = arrayToTextarea(
    byDay.saturday,
  );
  document.getElementById("sundayBusy").value = arrayToTextarea(byDay.sunday);
}

async function saveSettings() {
  const payload = {
    enabled: document.getElementById("enabled").checked,
    keepPinnedTab: document.getElementById("keepPinnedTab").checked,
    dryRun: document.getElementById("dryRun").checked,
    targetUrl: document.getElementById("targetUrl").value.trim(),
    replyText: document.getElementById("replyText").value.trim() || "I can",
    cooldownSec: Number(document.getElementById("cooldownSec").value) || 0,
    keywords: document.getElementById("keywords").value.trim(),

    busyWindowsEnabled: document.getElementById("busyWindowsEnabled").checked,
    busyWindowsAnyDay: parseLinesToArray(
      document.getElementById("busyWindowsAnyDay").value,
    ),
    busyWindowsByDay: {
      monday: parseLinesToArray(document.getElementById("mondayBusy").value),
      tuesday: parseLinesToArray(document.getElementById("tuesdayBusy").value),
      wednesday: parseLinesToArray(
        document.getElementById("wednesdayBusy").value,
      ),
      thursday: parseLinesToArray(
        document.getElementById("thursdayBusy").value,
      ),
      friday: parseLinesToArray(document.getElementById("fridayBusy").value),
      saturday: parseLinesToArray(
        document.getElementById("saturdayBusy").value,
      ),
      sunday: parseLinesToArray(document.getElementById("sundayBusy").value),
    },
  };

  await chrome.storage.sync.set(payload);
  setStatus("Saved");
}

async function openOrFocusWatcher() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "OPEN_OR_FOCUS_WATCHER",
    });

    if (!res?.ok) {
      setStatus(res?.error || "Could not open watcher tab", true);
      return;
    }

    setStatus("Watcher tab opened");
  } catch (err) {
    setStatus(String(err), true);
  }
}

document.getElementById("saveBtn").addEventListener("click", saveSettings);
document
  .getElementById("openWatcherBtn")
  .addEventListener("click", openOrFocusWatcher);

loadSettings();
