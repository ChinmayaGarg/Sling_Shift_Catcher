const DEFAULTS = {
  enabled: true,
  keepPinnedTab: true,
  dryRun: true,
  // targetUrl: "https://app.getsling.com/messages/17153548/Winter-2026-shift-changes",
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
});
