(() => {
  if (window.__slingShiftCatcherLoaded) return;
  window.__slingShiftCatcherLoaded = true;

  const OWN_USER_PATH = "/users/21528734";
  const OWN_USER_NAME = "Chinmaya Garg";

  const STATE_KEY = "runtimeStateV4";

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
    maxMessageAgeMs: 2 * 60 * 1000,
    perAuthorCooldownMs: 30 * 60 * 1000,
    autoPauseAfterSend: true,
  };

  let settings = null;
  let observer = null;
  let scanTimer = null;
  let heartbeatTimer = null;
  let isProcessing = false;
  let suppressObserver = false;

  function log(...args) {
    console.log("[Sling Shift Catcher]", ...args);
  }

  function isExtensionContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function normalizeUrl(url) {
    return (url || "").replace(/\/+$/, "");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getRandomInt(min, max) {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
  }

  function splitKeywords(text) {
    return (text || "")
      .split("\n")
      .map((k) => normalizeText(k))
      .filter(Boolean);
  }

  function getAuthorCooldownKey(match) {
    return match.authorHref || match.authorName || "unknown-author";
  }

  function pruneOldAuthorReplyTimes(
    authorReplyTimes,
    now,
    perAuthorCooldownMs,
  ) {
    const pruned = {};

    for (const [key, ts] of Object.entries(authorReplyTimes || {})) {
      if (now - Number(ts) <= perAuthorCooldownMs) {
        pruned[key] = Number(ts);
      }
    }

    return pruned;
  }

  async function getSettings() {
    if (!isExtensionContextValid()) return DEFAULTS;
    return chrome.storage.sync.get(DEFAULTS);
  }

  async function getRuntimeState() {
    if (!isExtensionContextValid()) {
      return {
        seenSignatures: [],
        lastReplyAt: 0,
        authorReplyTimes: {},
      };
    }

    const data = await chrome.storage.local.get(STATE_KEY);
    const state = data[STATE_KEY] || {};

    return {
      seenSignatures: Array.isArray(state.seenSignatures)
        ? state.seenSignatures
        : [],
      lastReplyAt: Number(state.lastReplyAt) || 0,
      authorReplyTimes:
        state.authorReplyTimes && typeof state.authorReplyTimes === "object"
          ? state.authorReplyTimes
          : {},
    };
  }

  async function setRuntimeState(nextState) {
    log("Updating runtime state:", nextState);
    if (!isExtensionContextValid()) return;
    await chrome.storage.local.set({ [STATE_KEY]: nextState });
  }

  function onCorrectChat() {
    return normalizeUrl(location.href) === normalizeUrl(settings.targetUrl);
  }

  function getMessageItems() {
    return [
      ...document.querySelectorAll(
        'div[class*="conversationMessagesstyles__ItemWrapper"]',
      ),
    ];
  }

  function getMessageTextFromItem(item) {
    const content = item.querySelector(
      'div[class*="messageContentstyles__Wrapper"]',
    );
    return normalizeText(content?.innerText || "");
  }

  function getMessageAuthorData(item) {
    const authorEl = item.querySelector(
      'a[class*="messageAuthorstyles__Name"]',
    );

    return {
      authorName: normalizeText(authorEl?.innerText || ""),
      authorHref: authorEl?.getAttribute("href") || "",
    };
  }

  function getMessageTimeText(item) {
    const timeEl = item.querySelector(
      'time[class*="messagePoststyles__PostedAt"]',
    );

    return normalizeText(
      timeEl?.getAttribute("datetime") || timeEl?.innerText || "",
    );
  }

  async function turnOnDryRunAfterSuccessfulReply() {
    if (!isExtensionContextValid()) return;

    settings = {
      ...settings,
      dryRun: true,
    };

    await chrome.storage.sync.set({
      dryRun: true,
    });

    log("Auto-paused: dryRun turned ON after successful reply.");
  }

  const SHIFT_START_MIN = 9 * 60; // 9:00 AM
  const SHIFT_END_MAX = 22 * 60; // 10:00 PM

  function containsDayMention(text) {
    const t = normalizeText(text);

    const patterns = [
      /\b(mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|sun|sunday)\b/,
      /\b(today|tomorrow|tmrw|tonight|afternoon|evening)\b/,
      /\b\d{1,2}[/-]\d{1,2}\b/,
      /\b\d{1,2}:\d{2}\s?(am|pm)\b/,
      /\b\d{1,2}\s?(am|pm)\b/,
      /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/,
    ];

    return patterns.some((re) => re.test(t));
  }

  function parseLooseTimeToken(token, positionInRange) {
    if (!token) return null;

    const raw = token.trim().toLowerCase();

    // h:mm am/pm  OR  h:mm
    let m = raw.match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i);
    if (m) {
      let hour = Number(m[1]);
      const minute = Number(m[2]);
      const meridiem = m[3] ? m[3].toLowerCase() : null;

      if (minute < 0 || minute > 59) return null;

      if (meridiem) {
        if (hour < 1 || hour > 12) return null;
        if (meridiem === "am") {
          if (hour === 12) hour = 0;
        } else {
          if (hour !== 12) hour += 12;
        }
        return hour * 60 + minute;
      }

      // No am/pm
      if (hour === 12) return 12 * 60 + minute;

      if (hour >= 1 && hour <= 8) {
        return (hour + 12) * 60 + minute; // PM
      }

      if (hour >= 9 && hour <= 11) {
        if (positionInRange === "start") {
          return hour * 60 + minute; // AM
        }
        return (hour + 12) * 60 + minute; // PM
      }

      return null;
    }

    // h am/pm  OR  h
    m = raw.match(/^(\d{1,2})(?:\s*(am|pm))?$/i);
    if (m) {
      let hour = Number(m[1]);
      const meridiem = m[2] ? m[2].toLowerCase() : null;

      if (hour < 1 || hour > 12) return null;

      if (meridiem) {
        if (meridiem === "am") {
          if (hour === 12) hour = 0;
        } else {
          if (hour !== 12) hour += 12;
        }
        return hour * 60;
      }

      // No am/pm
      if (hour === 12) return 12 * 60;

      if (hour >= 1 && hour <= 8) {
        return (hour + 12) * 60; // PM
      }

      if (hour >= 9 && hour <= 11) {
        if (positionInRange === "start") {
          return hour * 60; // AM
        }
        return (hour + 12) * 60; // PM
      }
    }

    return null;
  }

  function extractShiftRange(text) {
    const t = normalizeText(text);

    const rangeRe =
      /\b(\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?)\s*(?:-|to)\s*(\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?)\b/i;

    const m = t.match(rangeRe);
    if (!m) return null;

    const rawStart = m[1];
    const rawEnd = m[2];

    const startMin = parseLooseTimeToken(rawStart, "start");
    const endMin = parseLooseTimeToken(rawEnd, "end");

    if (startMin == null || endMin == null) return null;
    if (endMin <= startMin) return null;

    return { rawStart, rawEnd, startMin, endMin };
  }

  function isAllowedShiftWindow(text) {
    const range = extractShiftRange(text);
    if (!range) return false;

    return range.startMin >= SHIFT_START_MIN && range.endMin <= SHIFT_END_MAX;
  }

  function hasGiveawayPhrase(text, keywords) {
    const t = normalizeText(text);
    return keywords.some((k) => t.includes(k));
  }

  function isEligibleShiftMessage(text, keywords) {
    const hasPhrase = hasGiveawayPhrase(text, keywords);
    const hasDay = containsDayMention(text);
    const hasAllowedRange = isAllowedShiftWindow(text);
    const hasBlockedWords = containsBlockedTestWords(text);
    // log(
    //   "isEligibleShiftMessage",
    //   text,
    //   !hasBlockedWords,
    //   hasPhrase,
    //   hasAllowedRange,
    //   hasDay,
    // );
    return !hasBlockedWords && hasPhrase && (hasAllowedRange || hasDay);
  }

  // function containsTimeOrDayMention(text) {
  //   const t = normalizeText(text);

  //   const patterns = [
  //     /\b(mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|sun|sunday)\b/,
  //     /\b(today|tomorrow|tonight|this morning|this afternoon|this evening)\b/,
  //     /\b\d{1,2}:\d{2}\s?(am|pm)\b/,
  //     /\b\d{1,2}\s?(am|pm)\b/,
  //     /\b\d{1,2}[/-]\d{1,2}\b/,
  //     /\bjan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december\b/,
  //   ];

  //   return patterns.some((re) => re.test(t));
  // }

  // function containsShiftContext(text) {
  //   const t = normalizeText(text);
  //   return /\b(shift|work|coverage|cover|open|pickup|pick up|close|closing|opening)\b/.test(
  //     t,
  //   );
  // }

  function containsBlockedTestWords(text) {
    const t = normalizeText(text);
    // log("Checking for blocked test words in:", text);
    return /\b(test|testing|bot|keyword|trigger|try this|checking|lol|haha|lmao|shadow|delivery|😀|😃|😄|😁|😆|😅|🤣|😂|🙂|😉|😊|😇|🥰|😍|🤩|😘|😗|☺️|😚|😙|🥲|😏)\b/.test(
      t,
    );
  }

  // function isLikelyRealShiftGiveaway(text) {
  //   const t = normalizeText(text);

  //   const hasKeyword = splitKeywords(settings.keywords).some((k) =>
  //     t.includes(k),
  //   );
  //   const hasTimeOrDate = containsTimeOrDayMention(t);
  //   // const hasShiftContext = containsShiftContext(t);
  //   const hasBlockedWords = containsBlockedTestWords(t);

  //   log("Candidate passed filters:", text);

  //   return hasKeyword && hasTimeOrDate && !hasBlockedWords;
  // }

  function parseSlingTimeToDate(timeText) {
    const raw = (timeText || "").trim();
    if (!raw) return null;

    const match = raw.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
    if (!match) return null;

    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const meridiem = match[3].toUpperCase();

    if (meridiem === "AM") {
      if (hours === 12) hours = 0;
    } else {
      if (hours !== 12) hours += 12;
    }

    const now = new Date();
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setHours(hours, minutes, 0, 0);

    // If it lands slightly in the future, assume it was yesterday near midnight.
    if (candidate.getTime() - now.getTime() > 60 * 1000) {
      candidate.setDate(candidate.getDate() - 1);
    }

    return candidate;
  }

  function getMessageAgeMsFromItem(item) {
    const timeText = getMessageTimeText(item);
    const postedAt = parseSlingTimeToDate(timeText);
    if (!postedAt) return null;

    return Date.now() - postedAt.getTime();
  }

  function isMessageWithinAgeLimit(item, maxAgeMs) {
    const ageMs = getMessageAgeMsFromItem(item);
    if (ageMs === null) return false;
    if (ageMs < 0) return false;
    return ageMs <= maxAgeMs;
  }

  function isOwnMessageItem(item) {
    const { authorName, authorHref } = getMessageAuthorData(item);

    return (
      authorHref === OWN_USER_PATH ||
      authorName === normalizeText(OWN_USER_NAME)
    );
  }

  function buildMessageSignature(item, index) {
    const text = getMessageTextFromItem(item);
    const { authorHref, authorName } = getMessageAuthorData(item);
    const timeText = getMessageTimeText(item);

    return [
      authorHref || authorName || "unknown-author",
      timeText || "no-time",
      text || "no-text",
      index,
    ].join("|");
  }

  function findNewestRelevantMessage(keywords, seenSignatures) {
    const items = getMessageItems();
    const matches = [];

    items.forEach((item, index) => {
      const text = getMessageTextFromItem(item);
      if (!text) return;

      if (isOwnMessageItem(item)) return;

      const eligible = isEligibleShiftMessage(text, keywords);
      if (!eligible) return;

      // if (!isLikelyRealShiftGiveaway(text)) return;

      const signature = buildMessageSignature(item, index);
      // log("Found candidate message:", text, "signature:", signature);
      if (seenSignatures.includes(signature)) return;

      const { authorName, authorHref } = getMessageAuthorData(item);
      const ageMs = getMessageAgeMsFromItem(item);

      matches.push({
        el: item,
        text,
        signature,
        authorName,
        authorHref,
        ageMs,
      });
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

      await sleep(250);

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

      const delay = getRandomInt(
        settings.minReplyDelayMs,
        settings.maxReplyDelayMs,
      );

      log("Waiting before send:", delay, "ms");
      await sleep(delay);

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
    if (!isExtensionContextValid()) return;
    if (isProcessing) return;
    if (!settings?.enabled) return;
    if (!onCorrectChat()) return;

    isProcessing = true;

    try {
      const runtimeState = await getRuntimeState();
      const now = Date.now();
      const cooldownMs = Math.max(0, Number(settings.cooldownSec || 0) * 1000);

      if (now - runtimeState.lastReplyAt < cooldownMs) {
        return;
      }

      const keywords = splitKeywords(settings.keywords);
      const match = findNewestRelevantMessage(
        keywords,
        runtimeState.seenSignatures,
      );

      if (!match) return;

      const authorKey = getAuthorCooldownKey(match);
      const prunedAuthorReplyTimes = pruneOldAuthorReplyTimes(
        runtimeState.authorReplyTimes,
        now,
        settings.perAuthorCooldownMs,
      );

      const lastReplyToAuthorAt = Number(
        prunedAuthorReplyTimes[authorKey] || 0,
      );

      if (now - lastReplyToAuthorAt < settings.perAuthorCooldownMs) {
        log(
          "Skipping author due to 30-minute cooldown:",
          match.authorName || match.authorHref || "unknown",
          "minutesRemaining:",
          Math.ceil(
            (settings.perAuthorCooldownMs - (now - lastReplyToAuthorAt)) /
              60000,
          ),
        );

        const nextState = {
          seenSignatures: [
            ...runtimeState.seenSignatures.slice(-99),
            match.signature,
          ],
          lastReplyAt: runtimeState.lastReplyAt,
          authorReplyTimes: prunedAuthorReplyTimes,
        };

        await setRuntimeState(nextState);
        return;
      }

      if (match.ageMs === null) {
        log(
          "Skipping message because timestamp could not be parsed:",
          match.text,
          "from:",
          match.authorName || match.authorHref || "unknown",
        );

        const nextState = {
          seenSignatures: [
            ...runtimeState.seenSignatures.slice(-99),
            match.signature,
          ],
          lastReplyAt: runtimeState.lastReplyAt,
          authorReplyTimes: prunedAuthorReplyTimes,
        };

        await setRuntimeState(nextState);
        return;
      }

      if (match.ageMs < 0 || match.ageMs > settings.maxMessageAgeMs) {
        log(
          "Skipping old message by timestamp:",
          match.text,
          "from:",
          match.authorName || match.authorHref || "unknown",
          "ageMs:",
          match.ageMs,
        );

        const nextState = {
          seenSignatures: [
            ...runtimeState.seenSignatures.slice(-99),
            match.signature,
          ],
          lastReplyAt: runtimeState.lastReplyAt,
          authorReplyTimes: prunedAuthorReplyTimes,
        };

        await setRuntimeState(nextState);
        return;
      }

      log(
        "Matched:",
        match.text,
        "from:",
        match.authorName || match.authorHref || "unknown",
        "ageMs:",
        match.ageMs,
      );

      const nextState = {
        seenSignatures: [
          ...runtimeState.seenSignatures.slice(-99),
          match.signature,
        ],
        lastReplyAt: runtimeState.lastReplyAt,
        authorReplyTimes: prunedAuthorReplyTimes,
      };

      await setRuntimeState(nextState);

      if (settings.dryRun) {
        log("Dry run. Would reply:", settings.replyText);
        return;
      }

      const sent = await replyNow(settings.replyText);

      if (sent) {
        const sentAt = Date.now();
        nextState.lastReplyAt = sentAt;
        nextState.authorReplyTimes = {
          ...nextState.authorReplyTimes,
          [authorKey]: sentAt,
        };
        if (settings.autoPauseAfterSend) {
          await turnOnDryRunAfterSuccessfulReply();
        }
        await setRuntimeState(nextState);
      } else {
        log("Reply attempt failed; message marked as attempted to avoid loop.");
      }
    } catch (err) {
      if (String(err).includes("Extension context invalidated")) {
        log("Old script context detected. Refresh the Sling tab.");
        return;
      }

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
      if (suppressObserver) return;
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
