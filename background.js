const DEFAULTS = {
  enabled: true,
  keepPinnedTab: true,
  dryRun: true,
  targetUrl:
    "https://app.getsling.com/messages/17153548/Winter-2026-shift-changes",
  // targetUrl: "https://app.getsling.com/messages/17748799/Tejaswini-Patel",
  replyText: "I can",
  // cooldownSec: 15,
  cooldownSec: 0,
  keywords: [
    "take my shift",
    "cover my shift",
    "can anyone take",
    "can any one take",
    "can any one cover",
    "can anyone cover",
    "shift up for grabs",
    "shift available",
    "need someone to take",
    "anyone want my shift",
    "can someone take my shift",
    "can anyone pick up",
    "pick up my shift",
    "Shift giveaway",
    "Shift open",
    "Shift needs coverage",
    "Shift coverage",
    "Shift give away",
    "anyone able to work",
    "any one able to work",
    "giveaway shift",
    "give away shift",
    "giveaway",
    "give away",
  ].join("\n"),
  freshWindowMs: 30000,
  minReplyDelayMs: 600,
  maxReplyDelayMs: 1200,
};

const ALARM_NAME = "ensure-sling-watcher-tab";
const WATCHER_TAB_KEY = "watcherTabId";

function log(...args) {
  console.log("[Sling Shift Catcher BG]", ...args);
}

async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

function normalizeUrl(url) {
  return (url || "").replace(/\/+$/, "");
}

function isTargetUrl(url, targetUrl) {
  return normalizeUrl(url) === normalizeUrl(targetUrl);
}

async function getStoredWatcherTabId() {
  const data = await chrome.storage.local.get(WATCHER_TAB_KEY);
  return data[WATCHER_TAB_KEY] || null;
}

async function setStoredWatcherTabId(tabId) {
  await chrome.storage.local.set({ [WATCHER_TAB_KEY]: tabId });
}

async function clearStoredWatcherTabId() {
  await chrome.storage.local.remove(WATCHER_TAB_KEY);
}

async function getTabSafe(tabId) {
  if (tabId === null || tabId === undefined) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function safeUpdateTab(tabId, updateProperties) {
  try {
    return await chrome.tabs.update(tabId, updateProperties);
  } catch (err) {
    log("tabs.update failed for tab", tabId, err);
    return null;
  }
}

async function findExistingTargetTab(targetUrl) {
  const tabs = await chrome.tabs.query({
    url: "https://app.getsling.com/messages/*",
  });

  return tabs.find((tab) => isTargetUrl(tab.url, targetUrl)) || null;
}

async function ensureWatcherTab({ activate = false } = {}) {
  const settings = await getSettings();

  if (!settings.enabled || !settings.keepPinnedTab) {
    return null;
  }

  const targetUrl = settings.targetUrl;
  let tab = null;

  const storedTabId = await getStoredWatcherTabId();

  if (storedTabId) {
    tab = await getTabSafe(storedTabId);

    if (tab && !isTargetUrl(tab.url, targetUrl)) {
      tab = null;
    }
  }

  if (!tab) {
    tab = await findExistingTargetTab(targetUrl);
  }

  if (!tab) {
    try {
      tab = await chrome.tabs.create({
        url: targetUrl,
        pinned: true,
        active: !!activate,
      });
      if (tab?.id !== undefined) {
        await setStoredWatcherTabId(tab.id);
      }
      log("Created pinned watcher tab:", tab?.id);
      return tab;
    } catch (err) {
      log("Failed to create watcher tab:", err);
      return null;
    }
  }

  const updates = {};
  if (!tab.pinned) updates.pinned = true;
  if (activate) updates.active = true;

  if (Object.keys(updates).length > 0 && tab.id !== undefined) {
    const updatedTab = await safeUpdateTab(tab.id, updates);
    if (updatedTab) {
      tab = updatedTab;
    } else {
      // tab vanished; recreate it
      try {
        const recreated = await chrome.tabs.create({
          url: targetUrl,
          pinned: true,
          active: !!activate,
        });
        if (recreated?.id !== undefined) {
          await setStoredWatcherTabId(recreated.id);
        }
        log("Recreated watcher tab:", recreated?.id);
        return recreated;
      } catch (err) {
        log("Failed to recreate watcher tab:", err);
        return null;
      }
    }
  }

  if (tab?.id !== undefined) {
    await setStoredWatcherTabId(tab.id);
  }

  log("Watcher tab ready:", tab?.id);
  return tab;
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  await ensureWatcherTab({ activate: false });
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  await ensureWatcherTab({ activate: false });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await ensureWatcherTab({ activate: false });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const storedTabId = await getStoredWatcherTabId();

  if (tabId === storedTabId) {
    await clearStoredWatcherTabId();

    const settings = await getSettings();
    if (settings.enabled && settings.keepPinnedTab) {
      await ensureWatcherTab({ activate: false });
    }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    const settings = await getSettings();
    if (!settings.enabled || !settings.keepPinnedTab) return;

    const targetUrl = settings.targetUrl;
    const currentUrl = tab.url || tab.pendingUrl || "";

    if (!currentUrl || !isTargetUrl(currentUrl, targetUrl)) return;

    await setStoredWatcherTabId(tabId);

    const freshTab = await getTabSafe(tabId);
    if (!freshTab) {
      log("onUpdated: tab disappeared before handling:", tabId);
      return;
    }

    if (!freshTab.pinned) {
      await safeUpdateTab(tabId, { pinned: true });
    }

    if (changeInfo.status === "complete") {
      log("Watcher tab finished loading:", tabId);
      // No manual executeScript needed because content.js is already
      // declared under content_scripts in manifest.json
    }
  } catch (err) {
    log("onUpdated handler error:", err);
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;

  const affectsWatcher =
    "enabled" in changes ||
    "keepPinnedTab" in changes ||
    "targetUrl" in changes;

  if (affectsWatcher) {
    await ensureWatcherTab({ activate: false });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OPEN_OR_FOCUS_WATCHER") {
    ensureWatcherTab({ activate: true })
      .then((tab) => sendResponse({ ok: true, tabId: tab?.id || null }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === "ENSURE_WATCHER_TAB") {
    ensureWatcherTab({ activate: false })
      .then((tab) => sendResponse({ ok: true, tabId: tab?.id || null }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === "SHIFT_REPLIED") {
    sendPhoneAlert(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === "POLL_REMOTE_CONTROL_NOW") {
    pollControlTopic()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(CONTROL_ALARM_NAME, { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(CONTROL_ALARM_NAME, { periodInMinutes: 0.5 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CONTROL_ALARM_NAME) {
    try {
      await pollControlTopic();
    } catch (err) {
      bgLog("Control poll failed:", err);
    }
  }
});

const NTFY_DEFAULTS = {
  ntfyEnabled: true,
  ntfyBaseUrl: "https://ntfy.sh",
  ntfyAlertTopic: "sling-alerts-h4x7w9q2k6m1p8z",
  ntfyControlTopic: "sling-control-h4x7w9q2k6m1p8z",
  ntfyToken: "", // optional: Bearer token if you protect the topics
};

const CONTROL_ALARM_NAME = "poll-ntfy-control-topic";
const NTFY_CONTROL_STATE_KEY = "ntfyControlState";

function bgLog(...args) {
  console.log("[Sling Shift Catcher BG]", ...args);
}

async function getAllSettings() {
  const base = await chrome.storage.sync.get(DEFAULTS);
  const ntfy = await chrome.storage.sync.get(NTFY_DEFAULTS);
  return { ...base, ...ntfy };
}

function getNtfyHeaders(settings, extra = {}) {
  const headers = { ...extra };
  if (settings.ntfyToken) {
    headers.Authorization = `Bearer ${settings.ntfyToken}`;
  }
  return headers;
}

async function getControlState() {
  const data = await chrome.storage.local.get(NTFY_CONTROL_STATE_KEY);
  return (
    data[NTFY_CONTROL_STATE_KEY] || {
      initialized: false,
      lastMessageId: null,
    }
  );
}

async function setControlState(nextState) {
  await chrome.storage.local.set({ [NTFY_CONTROL_STATE_KEY]: nextState });
}

function parseNdjson(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function primeControlCursor(settings) {
  const url =
    `${settings.ntfyBaseUrl}/${encodeURIComponent(settings.ntfyControlTopic)}` +
    `/json?poll=1&since=latest`;

  const res = await fetch(url, {
    method: "GET",
    headers: getNtfyHeaders(settings),
  });

  if (!res.ok) {
    throw new Error(`Prime control cursor failed: ${res.status}`);
  }

  const text = await res.text();
  const events = parseNdjson(text);
  const messages = events.filter((e) => e.event === "message");
  const lastMessageId = messages.length
    ? messages[messages.length - 1].id
    : null;

  await setControlState({
    initialized: true,
    lastMessageId,
  });

  bgLog("Control cursor primed. Last message id:", lastMessageId);
}

async function applyRemoteCommand(messageText) {
  const cmd = (messageText || "").trim().toLowerCase();

  if (cmd === "resume" || cmd === "resume_once") {
    await chrome.storage.sync.set({ dryRun: false, enabled: true });
    bgLog("Remote command applied: dryRun=false");
    return;
  }

  if (cmd === "pause" || cmd === "dry_run_on") {
    await chrome.storage.sync.set({ dryRun: true });
    bgLog("Remote command applied: dryRun=true");
    return;
  }

  bgLog("Ignoring unknown remote command:", cmd);
}

async function pollControlTopic() {
  const settings = await getAllSettings();
  if (!settings.ntfyEnabled) return;

  const state = await getControlState();

  if (!state.initialized) {
    await primeControlCursor(settings);
    return;
  }

  let url =
    `${settings.ntfyBaseUrl}/${encodeURIComponent(settings.ntfyControlTopic)}` +
    `/json?poll=1`;

  if (state.lastMessageId) {
    url += `&since=${encodeURIComponent(state.lastMessageId)}`;
  } else {
    url += `&since=latest`;
  }

  const res = await fetch(url, {
    method: "GET",
    headers: getNtfyHeaders(settings),
  });

  if (!res.ok) {
    throw new Error(`Poll control topic failed: ${res.status}`);
  }

  const text = await res.text();
  const events = parseNdjson(text);
  const messages = events.filter((e) => e.event === "message");

  if (!messages.length) return;

  let lastMessageId = state.lastMessageId;

  for (const msg of messages) {
    lastMessageId = msg.id || lastMessageId;
    await applyRemoteCommand(msg.message || "");
  }

  await setControlState({
    initialized: true,
    lastMessageId,
  });
}

async function sendPhoneAlert(payload) {
  const settings = await getAllSettings();
  if (!settings.ntfyEnabled) return;

  const author = payload?.authorName || "Someone";
  const text = payload?.text || "Shift message";
  const replyText = payload?.replyText || "I can";

  const action = {
    action: "http",
    label: "Resume once",
    url: `${settings.ntfyBaseUrl}/${encodeURIComponent(settings.ntfyControlTopic)}`,
    method: "POST",
    body: "resume_once",
    clear: true,
  };

  if (settings.ntfyToken) {
    action.headers = {
      Authorization: `Bearer ${settings.ntfyToken}`,
    };
  }

  const body = {
    topic: settings.ntfyAlertTopic,
    title: "Sling bot replied",
    message: `Replied "${replyText}" to ${author}: ${text}`,
    priority: 4,
    tags: ["white_check_mark", "calendar"],
    actions: [action],
  };

  const res = await fetch(`${settings.ntfyBaseUrl}/`, {
    method: "POST",
    headers: getNtfyHeaders(settings, {
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`ntfy alert failed: ${res.status}`);
  }

  bgLog("Phone alert sent.");
}
