(() => {
  if (window.__slingShiftCatcherLoaded) {
    return;
  }
  let suppressObserver = false;
  window.__slingShiftCatcherLoaded = true;

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
  };

  const STATE_KEY = "runtimeStateV2";

  const MESSAGE_CANDIDATE_SELECTORS = [
    '[data-testid*="message"]',
    '[class*="message"]',
    '[role="listitem"]',
    "article",
    "li",
  ];

  const COMPOSER_SELECTORS = [
    'div[role="textbox"][data-slate-editor="true"][contenteditable="true"]',
  ];

  const SEND_BUTTON_SELECTORS = [
    'button[aria-label*="send" i]',
    '[role="button"][aria-label*="send" i]',
    'button[type="submit"]',
    "button",
  ];

  let settings = null;
  let observer = null;
  let scanTimer = null;
  let heartbeatTimer = null;
  let isProcessing = false;

  function log(...args) {
    console.log("[Sling Shift Catcher]", ...args);
  }

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function normalizeUrl(url) {
    return (url || "").replace(/\/+$/, "");
  }

  function hashText(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (h << 5) - h + text.charCodeAt(i);
      h |= 0;
    }
    return String(h);
  }

  function dispatchSlateEvents(composer, text) {
    try {
      composer.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: text,
          inputType: "insertText",
        }),
      );
    } catch {}

    try {
      composer.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: text,
          inputType: "insertText",
        }),
      );
    } catch {
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    }

    composer.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function placeCaretAtEnd(node) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function getComposerPlainText(composer) {
    return (composer?.innerText || composer?.textContent || "")
      .replace(/\u200B/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function selectComposerContents(composer) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function writeToSlateComposer(composer, text) {
    composer.focus();
    composer.click();

    // Select current editor contents
    selectComposerContents(composer);

    let inserted = false;

    try {
      document.execCommand("selectAll", false, null);
    } catch {}

    try {
      document.execCommand("delete", false, null);
    } catch {}

    try {
      inserted = document.execCommand("insertText", false, text);
    } catch {
      inserted = false;
    }

    // Fire events after the native edit attempt
    try {
      composer.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: text,
          inputType: "insertText",
        }),
      );
    } catch {}

    try {
      composer.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: text,
          inputType: "insertText",
        }),
      );
    } catch {
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    }

    composer.dispatchEvent(new Event("change", { bubbles: true }));

    const finalText = getComposerPlainText(composer);
    log("Composer visible text after insert:", JSON.stringify(finalText));

    return inserted && finalText === text;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  }

  function buildMessageSignature(el, text, index) {
    const explicitId =
      el.getAttribute("data-message-id") ||
      el.getAttribute("data-id") ||
      el.id ||
      "";

    const timeText =
      el.querySelector("time")?.getAttribute("datetime") ||
      el.querySelector("time")?.innerText ||
      "";

    if (explicitId) {
      return `id:${explicitId}`;
    }

    return `sig:${index}:${hashText(`${timeText}|${text}`)}`;
  }

  function splitKeywords(text) {
    return text
      .split("\n")
      .map((k) => normalizeText(k))
      .filter(Boolean);
  }

  async function getSettings() {
    return chrome.storage.sync.get(DEFAULTS);
  }

  async function getRuntimeState() {
    const data = await chrome.storage.local.get(STATE_KEY);
    const state = data[STATE_KEY] || {};

    return {
      seenSignatures: Array.isArray(state.seenSignatures)
        ? state.seenSignatures
        : [],
      lastReplyAt: Number(state.lastReplyAt) || 0,
    };
  }

  async function setRuntimeState(nextState) {
    await chrome.storage.local.set({ [STATE_KEY]: nextState });
  }

  function onCorrectChat() {
    return normalizeUrl(location.href) === normalizeUrl(settings.targetUrl);
  }

  function getAllMessageCandidates() {
    const results = [];
    const seen = new Set();

    for (const selector of MESSAGE_CANDIDATE_SELECTORS) {
      document.querySelectorAll(selector).forEach((el) => {
        if (!seen.has(el)) {
          seen.add(el);
          results.push(el);
        }
      });
    }

    return results.filter((el) => {
      const text = normalizeText(el.innerText);
      return isVisible(el) && text.length >= 8 && text.length <= 600;
    });
  }

  function findNewestRelevantMessage(keywords, seenSignatures) {
    const candidates = getAllMessageCandidates();
    const matches = [];

    candidates.forEach((el, index) => {
      const text = normalizeText(el.innerText);
      if (!text) return;

      const matchesKeyword = keywords.some((k) => text.includes(k));
      if (!matchesKeyword) return;

      const signature = buildMessageSignature(el, text, index);
      if (seenSignatures.includes(signature)) return;

      matches.push({ el, text, signature });
    });

    return matches.length ? matches[matches.length - 1] : null;
  }

  function pickBestComposer() {
    return document.querySelector(
      'div[role="textbox"][data-slate-editor="true"][contenteditable="true"]',
    );
  }

  function pickBestSendButton() {
    const footer = document.querySelector(
      'div[class*="conversationLayoutstyles__Footer"]',
    );

    if (!footer) return null;

    const buttons = [...footer.querySelectorAll('button[type="button"]')];

    return buttons.find((btn) => btn.innerText.trim() === "Send") || null;
  }

  function setNativeInputValue(input, value) {
    const prototype = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

    if (descriptor?.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function writeToComposer(composer, text) {
    if (!composer) return false;

    if (
      composer.matches(
        'div[role="textbox"][data-slate-editor="true"][contenteditable="true"]',
      )
    ) {
      return writeToSlateComposer(composer, text);
    }

    if (composer.isContentEditable) {
      composer.focus();
      composer.textContent = text;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if ("value" in composer) {
      const prototype = Object.getPrototypeOf(composer);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

      if (descriptor?.set) {
        descriptor.set.call(composer, text);
      } else {
        composer.value = text;
      }

      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    return false;
  }

  function pressEnter(composer) {
    composer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
      }),
    );

    composer.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
      }),
    );
  }

  async function replyNow(replyText) {
    const composer = pickBestComposer();

    if (!composer) {
      log("Composer not found.");
      return false;
    }

    suppressObserver = true;

    try {
      const wrote = writeToComposer(composer, replyText);
      log("Composer write result:", wrote);

      await new Promise((resolve) => setTimeout(resolve, 250));

      const persistedText = getComposerPlainText(composer);
      log("Composer persisted text:", JSON.stringify(persistedText));

      if (persistedText !== replyText) {
        log("Slate rejected the edit; text did not persist.");
        return false;
      }

      const sendButton = pickBestSendButton();

      if (!sendButton) {
        log("Send button not found.");
        return false;
      }

      const disabled =
        sendButton.disabled ||
        sendButton.hasAttribute("disabled") ||
        sendButton.getAttribute("aria-disabled") === "true";

      log("Send button found. Disabled:", disabled);

      if (disabled) {
        log("Send button still disabled after typing.");
        return false;
      }

      sendButton.focus();
      sendButton.click();
      log("Reply sent.");
      return true;
    } finally {
      setTimeout(() => {
        suppressObserver = false;
      }, 800);
    }
  }

  async function processChat() {
    if (isProcessing) return;
    if (!settings?.enabled) return;
    if (!onCorrectChat()) return;

    isProcessing = true;

    try {
      const runtimeState = await getRuntimeState();
      const now = Date.now();
      const cooldownMs = Math.max(1000, settings.cooldownSec * 1000);

      if (now - runtimeState.lastReplyAt < cooldownMs) {
        return;
      }

      const keywords = splitKeywords(settings.keywords);
      const match = findNewestRelevantMessage(
        keywords,
        runtimeState.seenSignatures,
      );

      if (!match) return;

      log("Matched:", match.text);

      // Mark it immediately so observer/heartbeat does not keep retrying it
      const nextState = {
        seenSignatures: [
          ...runtimeState.seenSignatures.slice(-99),
          match.signature,
        ],
        lastReplyAt: runtimeState.lastReplyAt,
      };

      await setRuntimeState(nextState);

      if (settings.dryRun) {
        log("Dry run. Would reply:", settings.replyText);
        return;
      }

      const sent = await replyNow(settings.replyText);

      if (sent) {
        nextState.lastReplyAt = Date.now();
        await setRuntimeState(nextState);
      } else {
        log("Reply attempt failed; message marked as attempted to avoid loop.");
      }
    } catch (err) {
      log("processChat error:", err);
    } finally {
      isProcessing = false;
    }
  }

  function scheduleProcess(delay = 400) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      processChat();
    }, delay);
  }

  function startObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      if (suppressObserver) return;
      scheduleProcess(350);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    log("DOM observer connected.");
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!document.body) return;

      if (!observer) {
        startObserver();
      }

      scheduleProcess(200);
    }, 5000);
  }

  async function init() {
    settings = await getSettings();

    if (!onCorrectChat()) {
      log("Wrong chat URL. Current:", location.href);
      return;
    }

    log("Watching pinned Sling tab:", location.href);
    startObserver();
    startHeartbeat();
    scheduleProcess(700);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;

      let reloadNeeded = false;
      for (const key of Object.keys(changes)) {
        if (key in DEFAULTS) {
          reloadNeeded = true;
          break;
        }
      }

      if (reloadNeeded) {
        getSettings().then((fresh) => {
          settings = fresh;
          log("Settings updated.");
          scheduleProcess(250);
        });
      }
    });

    window.addEventListener("focus", () => scheduleProcess(200));
    document.addEventListener("visibilitychange", () => scheduleProcess(200));
  }

  init().catch((err) => log("init error:", err));
})();
