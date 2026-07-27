"use strict";

importScripts("core.js");

const Core = globalThis.MonoHeaderCore;
const STORAGE_KEY = "monoHeaderState";
const SESSION_STORAGE_KEY = "monoHeaderSessionKeepAlive";
const SESSION_HEADER_VALUES_KEY = "monoHeaderSessionHeaderValues";
const SESSION_HEADER_VALUES_VERSION = 1;
const SESSION_STORE_VERSION = 5;
const SESSION_ALARM_PREFIX = "monoheader-session-";
const SESSION_INTERVALS = new Set([5, 10, 15, 30]);
const SESSION_MODES = new Set(["request", "activity", "both"]);
const SESSION_WRITE_ACTIONS = new Set([
  "SET_SESSION_KEEP_ALIVE",
  "TEST_SESSION_KEEP_ALIVE",
  "RESET_SESSION_KEEP_ALIVE",
  "SAVE_SESSION_KEEP_ALIVE_PRESET",
  "DELETE_SESSION_KEEP_ALIVE_PRESET"
]);
const SESSION_SERIAL_ACTIONS = new Set([
  "GET_SESSION_KEEP_ALIVE",
  ...SESSION_WRITE_ACTIONS
]);
const SESSION_EXECUTION_TIMEOUT_MS = 5000;
const MAX_SESSION_TABS = 25;
const MAX_SESSION_PRESETS = 100;
let operationQueue = Promise.resolve();
let sessionOperationQueue = Promise.resolve();
let initializationPromise = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  queueOperation(() => initializeAndReconcile("Extension installed"));
});

chrome.runtime.onStartup.addListener(() => {
  queueOperation(() => initializeAndReconcile("Browser startup"));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || !String(alarm.name).startsWith(SESSION_ALARM_PREFIX)) return;
  queueSessionOperation(() => handleSessionAlarm(alarm)).catch((error) => {
    console.warn("MonoHeader session keep-alive alarm failed.", error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  queueSessionOperation(() => stopSessionKeepAliveForTab(tabId)).catch((error) => {
    console.warn("MonoHeader could not stop keep-alive for a closed tab.", error);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo || !changeInfo.url) return;
  queueSessionOperation(() => handleSessionTabUpdated(tabId, tab)).catch((error) => {
    console.warn("MonoHeader could not reconcile keep-alive after navigation.", error);
  });
});

initializationPromise = initializeAndReconcile("Service worker started").catch((error) => {
  console.error("MonoHeader could not reconcile runtime state during service worker startup.", error);
});
operationQueue = initializationPromise;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const action = message && message.action;
  const operation = action === "RESET"
    ? queueOperation(() => queueSessionOperation(() => handleMessage(message)))
    : isReadOnlyAction(action)
      ? handleMessage(message)
      : SESSION_SERIAL_ACTIONS.has(action)
        ? queueSessionOperation(() => handleMessage(message))
        : queueOperation(() => handleMessage(message));
  operation
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error("MonoHeader operation failed", error);
      sendResponse({
        ok: false,
        error: {
          name: error && error.name || "Error",
          message: friendlyError(error),
          validation: error && error.validation || null
        }
      });
    });
  return true;
});

function queueOperation(operation) {
  const next = operationQueue.then(operation, operation);
  operationQueue = next.catch(() => undefined);
  return next;
}

function queueSessionOperation(operation) {
  const next = sessionOperationQueue.then(operation, operation);
  sessionOperationQueue = next.catch(() => undefined);
  return next;
}

function isReadOnlyAction(action) {
  return action === "GET_STATE" ||
    action === "GET_RUNTIME";
}

async function handleMessage(message) {
  await initializationPromise;
  const action = message && message.action;
  switch (action) {
    case "GET_STATE": {
      const state = await loadState();
      return { state, runtime: await getRuntime(state) };
    }
    case "GET_RUNTIME": {
      const state = await loadState();
      return { runtime: await getRuntime(state) };
    }
    case "APPLY_STATE":
      return applyState(message.state, message.reason || "Applied changes");
    case "SET_ENABLED": {
      const state = await loadState();
      state.extensionEnabled = message.enabled === true;
      return applyState(state, state.extensionEnabled ? "Enabled MonoHeader" : "Paused MonoHeader");
    }
    case "SWITCH_PROFILE": {
      const state = await loadState();
      if (!state.profiles.some((profile) => profile.id === message.profileId)) {
        throw new Error("The selected profile no longer exists.");
      }
      state.activeProfileId = message.profileId;
      return applyState(state, "Switched active profile");
    }
    case "QUICK_ADD_HEADER":
      return quickAddHeader(message.header, message.value, message.sessionOnly === true);
    case "SET_RULE_ENABLED":
      return setRuleEnabled(
        message.profileId,
        message.ruleId,
        message.enabled === true
      );
    case "GET_SESSION_KEEP_ALIVE":
      return { sessionKeepAlive: await getSessionKeepAliveForTab(message.tabId) };
    case "SET_SESSION_KEEP_ALIVE":
      return {
        sessionKeepAlive: await setSessionKeepAliveForTab(
          message.tabId,
          message.enabled === true,
          message.intervalMinutes,
          message.targetPath,
          message.mode
        )
      };
    case "TEST_SESSION_KEEP_ALIVE":
      return testSessionKeepAliveForTab(
        message.tabId,
        message.targetPath,
        message.mode
      );
    case "RESET_SESSION_KEEP_ALIVE":
      await stopSessionKeepAliveForTab(message.tabId);
      return {
        sessionKeepAlive: await getSessionKeepAliveForTab(message.tabId)
      };
    case "SAVE_SESSION_KEEP_ALIVE_PRESET":
      return {
        sessionKeepAlive: await saveSessionPresetForTab(
          message.tabId,
          message.intervalMinutes,
          message.targetPath,
          message.mode
        )
      };
    case "DELETE_SESSION_KEEP_ALIVE_PRESET":
      return {
        sessionKeepAlive: await deleteSessionPresetForTab(message.tabId)
      };
    case "ROLLBACK": {
      const state = await loadState();
      if (!state.rollbackSnapshot) throw new Error("There is no previous applied configuration to restore.");
      const restored = Core.restoreSnapshot(state, state.rollbackSnapshot);
      return applyState(restored, "Rolled back to previous configuration", { preserveProvidedRollback: true });
    }
    case "CLEAR_DIAGNOSTICS": {
      const state = await loadState();
      state.diagnostics = [];
      await saveState(state);
      return { state, runtime: await getRuntime(state) };
    }
    case "RESET": {
      await clearAllSessionKeepAlives();
      const state = Core.createDefaultState();
      return applyState(state, "Restored factory defaults", { resetHistory: true });
    }
    default:
      throw new Error("Unknown MonoHeader request.");
  }
}

async function runMonoHeaderSessionCheck(input) {
  const config = input && typeof input === "object" ? input : {};
  const mode = ["request", "activity", "both"].includes(config.mode) ? config.mode : "activity";
  const requestEnabled = mode === "request" || mode === "both";
  const activityEnabled = mode === "activity" || mode === "both";
  const result = {
    ok: true,
    status: null,
    redirected: false,
    sameOrigin: true,
    requestSent: false,
    activitySent: false,
    error: ""
  };

  let pageTarget;
  try {
    pageTarget = new URL(globalThis.location.href);
  } catch (_error) {
    return { ...result, ok: false, sameOrigin: false, error: "The current page URL is unavailable." };
  }
  if (pageTarget.protocol !== "https:") {
    return { ...result, ok: false, sameOrigin: false, error: "Session keep-alive is limited to HTTPS pages." };
  }

  if (requestEnabled) {
    try {
      const normalizedPath = String(config.targetPath == null ? "" : config.targetPath).trim();
      const target = normalizedPath
        ? new URL(normalizedPath, pageTarget.origin)
        : pageTarget;
      if (target.origin !== pageTarget.origin || target.protocol !== "https:") {
        result.ok = false;
        result.sameOrigin = false;
        result.error = "The keep-alive request must stay on the current HTTPS site.";
      } else {
        const response = await fetch(target.href, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          redirect: "follow",
          mode: "same-origin"
        });
        const finalUrl = new URL(response.url || target.href);
        result.ok = response.ok;
        result.status = response.status;
        result.redirected = response.redirected;
        result.sameOrigin = finalUrl.origin === pageTarget.origin;
        result.requestSent = true;
        try {
          if (response.body) await response.body.cancel();
        } catch (_error) {
          // The response body is deliberately ignored; cancellation failure does not change the request result.
        }
      }
    } catch (_error) {
      result.ok = false;
      result.error = "The same-origin keep-alive request could not be completed.";
    }
  }

  if (activityEnabled) {
    try {
      const eventOptions = {
        bubbles: true,
        cancelable: false,
        composed: true,
        view: globalThis
      };
      globalThis.document.dispatchEvent(new MouseEvent("mousemove", eventOptions));
      globalThis.document.dispatchEvent(new MouseEvent("click", eventOptions));
      result.activitySent = true;
    } catch (_error) {
      result.ok = false;
      result.error = result.error || "The synthetic activity pulse could not be dispatched.";
    }
  }

  return result;
}

async function getSessionKeepAliveForTab(inputTabId) {
  const tabId = normalizeTabId(inputTabId);
  if (!tabId) return unsupportedSessionView("Open an HTTPS website to use session keep-alive.");
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    await stopSessionKeepAliveForTab(tabId);
    return unsupportedSessionView("The selected tab is no longer available.");
  }
  const tabInfo = getSessionTabInfo(tab);
  if (!tabInfo) {
    await stopSessionKeepAliveForTab(tabId);
    return unsupportedSessionView("Session keep-alive is available on HTTPS pages only.");
  }
  const store = await loadSessionStore();
  const entry = store.entries.find((item) => item.tabId === tabId);
  const preset = findSessionPreset(store, tabInfo.origin);
  if (entry && entry.origin !== tabInfo.origin) {
    await stopSessionKeepAliveForTab(tabId);
    return createSessionView(null, tabInfo, null, preset);
  }
  const alarm = entry ? await ensureSessionAlarm(entry) : null;
  return createSessionView(entry || null, tabInfo, alarm, preset);
}

async function setSessionKeepAliveForTab(inputTabId, enabled, inputInterval, inputTargetPath, inputMode) {
  const tabId = normalizeTabId(inputTabId);
  if (!tabId) throw new Error("Open an HTTPS website before enabling session keep-alive.");
  if (!enabled) {
    await stopSessionKeepAliveForTab(tabId);
    return getSessionKeepAliveForTab(tabId);
  }

  const intervalMinutes = Number(inputInterval);
  if (!SESSION_INTERVALS.has(intervalMinutes)) {
    throw new Error("Choose a keep-alive interval of 5, 10, 15, or 30 minutes.");
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    throw new Error("The selected tab is no longer available.");
  }
  const tabInfo = getSessionTabInfo(tab);
  if (!tabInfo) throw new Error("Session keep-alive is available on HTTPS pages only.");
  const mode = normalizeSessionMode(inputMode);
  const normalizedInputTargetPath = normalizeSessionTargetPath(inputTargetPath, tabInfo.origin);
  const targetPath = mode === "activity"
    ? ""
    : normalizedInputTargetPath;

  const store = await loadSessionStore();
  const existingIndex = store.entries.findIndex((item) => item.tabId === tabId);
  const previousEntry = existingIndex >= 0 ? store.entries[existingIndex] : null;
  if (existingIndex < 0 && store.entries.length >= MAX_SESSION_TABS) {
    throw new Error(`Session keep-alive is limited to ${MAX_SESSION_TABS} tabs.`);
  }
  const now = new Date().toISOString();
  const entry = normalizeSessionEntry({
    ...(existingIndex >= 0 ? store.entries[existingIndex] : {}),
    tabId,
    origin: tabInfo.origin,
    hostname: tabInfo.hostname,
    intervalMinutes,
    targetPath,
    mode,
    createdAt: existingIndex >= 0 ? store.entries[existingIndex].createdAt : now,
    updatedAt: now,
    lastStatus: existingIndex >= 0 ? store.entries[existingIndex].lastStatus : "pending",
    lastError: ""
  });
  if (existingIndex >= 0) store.entries[existingIndex] = entry;
  else store.entries.push(entry);
  await saveSessionStore(store);

  try {
    await ensureSessionAlarm(entry, {
      replace: !previousEntry || previousEntry.intervalMinutes !== intervalMinutes
    });
  } catch (error) {
    await stopSessionKeepAliveForTab(tabId);
    throw new Error(`Chrome could not schedule session keep-alive: ${friendlyError(error)}`);
  }
  const updated = await pingSessionKeepAlive(tabId, previousEntry ? "settings" : "enabled");
  const alarm = updated ? await chrome.alarms.get(sessionAlarmName(tabId)) : null;
  return createSessionView(
    updated,
    tabInfo,
    alarm,
    findSessionPreset(store, tabInfo.origin)
  );
}

async function testSessionKeepAliveForTab(inputTabId, inputTargetPath, inputMode) {
  const tabId = normalizeTabId(inputTabId);
  if (!tabId) throw new Error("Open an HTTPS website before testing session keep-alive.");
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    throw new Error("The selected tab is no longer available.");
  }
  const tabInfo = getSessionTabInfo(tab);
  if (!tabInfo) throw new Error("Session keep-alive is available on HTTPS pages only.");
  const mode = normalizeSessionMode(inputMode);
  const normalizedInputTargetPath = normalizeSessionTargetPath(inputTargetPath, tabInfo.origin);
  const targetPath = mode === "activity"
    ? ""
    : normalizedInputTargetPath;
  const check = await executeSessionKeepAliveCheck(tabId, mode, targetPath, "manual");

  const store = await loadSessionStore();
  const entryIndex = store.entries.findIndex((item) => (
    item.tabId === tabId && item.origin === tabInfo.origin
  ));
  let entry = entryIndex >= 0 ? store.entries[entryIndex] : null;
  if (entry) {
    entry = applySessionCheckToEntry(entry, check);
    store.entries[entryIndex] = entry;
    await saveSessionStore(store);
  }
  const alarm = entry ? await chrome.alarms.get(sessionAlarmName(tabId)) : null;
  return {
    sessionKeepAlive: createSessionView(
      entry,
      tabInfo,
      alarm,
      findSessionPreset(store, tabInfo.origin)
    ),
    sessionDiagnostic: createSessionDiagnostic(check, mode)
  };
}

async function saveSessionPresetForTab(inputTabId, inputInterval, inputTargetPath, inputMode) {
  const tabId = normalizeTabId(inputTabId);
  if (!tabId) throw new Error("Open an HTTPS website before saving a keep-alive preset.");
  const intervalMinutes = Number(inputInterval);
  if (!SESSION_INTERVALS.has(intervalMinutes)) {
    throw new Error("Choose a keep-alive interval of 5, 10, 15, or 30 minutes.");
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    throw new Error("The selected tab is no longer available.");
  }
  const tabInfo = getSessionTabInfo(tab);
  if (!tabInfo) throw new Error("Keep-alive presets are available on HTTPS pages only.");
  const mode = normalizeSessionMode(inputMode);
  const normalizedInputTargetPath = normalizeSessionTargetPath(inputTargetPath, tabInfo.origin);
  const targetPath = mode === "activity"
    ? ""
    : normalizedInputTargetPath;
  const store = await loadSessionStore();
  const existingIndex = store.presets.findIndex((preset) => preset.origin === tabInfo.origin);
  if (existingIndex < 0 && store.presets.length >= MAX_SESSION_PRESETS) {
    throw new Error(`Keep-alive presets are limited to ${MAX_SESSION_PRESETS} sites.`);
  }
  const now = new Date().toISOString();
  const preset = normalizeSessionPreset({
    origin: tabInfo.origin,
    intervalMinutes,
    targetPath,
    mode,
    createdAt: existingIndex >= 0 ? store.presets[existingIndex].createdAt : now,
    updatedAt: now
  });
  if (existingIndex >= 0) store.presets[existingIndex] = preset;
  else store.presets.push(preset);
  const saved = await saveSessionStore(store);
  const entry = saved.entries.find((item) => (
    item.tabId === tabId && item.origin === tabInfo.origin
  )) || null;
  const alarm = entry ? await chrome.alarms.get(sessionAlarmName(tabId)) : null;
  return createSessionView(entry, tabInfo, alarm, preset);
}

async function deleteSessionPresetForTab(inputTabId) {
  const tabId = normalizeTabId(inputTabId);
  if (!tabId) throw new Error("Open an HTTPS website before deleting a keep-alive preset.");
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    throw new Error("The selected tab is no longer available.");
  }
  const tabInfo = getSessionTabInfo(tab);
  if (!tabInfo) throw new Error("Keep-alive presets are available on HTTPS pages only.");
  const store = await loadSessionStore();
  const nextPresets = store.presets.filter((preset) => preset.origin !== tabInfo.origin);
  const saved = nextPresets.length === store.presets.length
    ? store
    : await saveSessionStore({ ...store, presets: nextPresets });
  const entry = saved.entries.find((item) => (
    item.tabId === tabId && item.origin === tabInfo.origin
  )) || null;
  const alarm = entry ? await chrome.alarms.get(sessionAlarmName(tabId)) : null;
  return createSessionView(entry, tabInfo, alarm, null);
}

async function handleSessionAlarm(alarm) {
  const tabId = normalizeTabId(String(alarm.name).slice(SESSION_ALARM_PREFIX.length));
  if (!tabId) {
    await chrome.alarms.clear(alarm.name);
    return;
  }
  const entry = await pingSessionKeepAlive(tabId, "scheduled");
  if (!entry) await chrome.alarms.clear(alarm.name);
}

async function handleSessionTabUpdated(tabId, tab) {
  const store = await loadSessionStore();
  const entry = store.entries.find((item) => item.tabId === tabId);
  if (!entry) return;
  const tabInfo = getSessionTabInfo(tab);
  if (!tabInfo || tabInfo.origin !== entry.origin) {
    await stopSessionKeepAliveForTab(tabId);
  }
}

async function pingSessionKeepAlive(tabId, trigger) {
  const store = await loadSessionStore();
  const entryIndex = store.entries.findIndex((item) => item.tabId === tabId);
  if (entryIndex < 0) return null;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    await stopSessionKeepAliveForTab(tabId);
    return null;
  }
  const tabInfo = getSessionTabInfo(tab);
  if (!tabInfo || tabInfo.origin !== store.entries[entryIndex].origin) {
    await stopSessionKeepAliveForTab(tabId);
    return null;
  }

  const check = await executeSessionKeepAliveCheck(
    tabId,
    store.entries[entryIndex].mode,
    store.entries[entryIndex].targetPath,
    trigger
  );

  const currentStore = await loadSessionStore();
  const currentIndex = currentStore.entries.findIndex((item) => item.tabId === tabId);
  if (currentIndex < 0) return null;
  currentStore.entries[currentIndex] = applySessionCheckToEntry(
    currentStore.entries[currentIndex],
    check
  );
  await saveSessionStore(currentStore);
  return currentStore.entries[currentIndex];
}

async function executeSessionKeepAliveCheck(tabId, mode, targetPath, trigger) {
  const attemptedAt = new Date().toISOString();
  let pingResult;
  try {
    const injectionResults = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        func: runMonoHeaderSessionCheck,
        args: [{ mode, targetPath }]
      }),
      SESSION_EXECUTION_TIMEOUT_MS,
      "The page did not complete the keep-alive check within five seconds."
    );
    pingResult = injectionResults && injectionResults[0] && injectionResults[0].result;
  } catch (error) {
    pingResult = { ok: false, error: friendlyError(error) };
  }
  const completedAt = new Date().toISOString();
  return classifySessionCheck(pingResult, attemptedAt, completedAt, trigger);
}

function classifySessionCheck(pingResult, attemptedAt, completedAt, trigger) {
  const httpStatus = Number.isInteger(pingResult && pingResult.status)
    ? pingResult.status
    : null;
  const result = {
    trigger: normalizeSessionTrigger(trigger),
    attemptedAt,
    completedAt,
    status: "error",
    httpStatus,
    requestSent: Boolean(pingResult && pingResult.requestSent),
    activitySent: Boolean(pingResult && pingResult.activitySent),
    redirected: Boolean(pingResult && pingResult.redirected),
    sameOrigin: pingResult && typeof pingResult.sameOrigin === "boolean"
      ? pingResult.sameOrigin
      : null,
    error: ""
  };
  if (!pingResult || pingResult.error) {
    result.error = cleanSessionText(
      pingResult && pingResult.error || "The keep-alive request did not return a result.",
      300
    );
  } else if (pingResult.sameOrigin !== true) {
    result.error = "The request left the configured site and was blocked.";
  } else if (pingResult.redirected === true) {
    result.status = "warning";
    result.error = "The request was redirected; the session may already have expired.";
  } else if (pingResult.ok === true) {
    result.status = "success";
  } else {
    result.error = httpStatus
      ? `The site returned HTTP ${httpStatus}.`
      : "The keep-alive request failed.";
  }
  return result;
}

function applySessionCheckToEntry(entry, check) {
  const updated = {
    ...entry,
    updatedAt: check.completedAt,
    lastAttemptAt: check.attemptedAt,
    lastCompletedAt: check.completedAt,
    lastTrigger: check.trigger,
    lastStatus: check.status,
    lastHttpStatus: check.httpStatus,
    lastRequestSent: check.requestSent,
    lastActivitySent: check.activitySent,
    lastRedirected: check.redirected,
    lastSameOrigin: check.sameOrigin,
    lastError: check.error
  };
  if (check.status === "success") {
    updated.lastSuccessAt = check.completedAt;
  }
  return normalizeSessionEntry(updated);
}

function createSessionDiagnostic(check, mode) {
  return {
    mode,
    trigger: check.trigger,
    attemptedAt: check.attemptedAt,
    completedAt: check.completedAt,
    status: check.status,
    httpStatus: check.httpStatus,
    requestSent: check.requestSent,
    activitySent: check.activitySent,
    redirected: check.redirected,
    sameOrigin: check.sameOrigin,
    error: check.error
  };
}

async function reconcileSessionKeepAlives() {
  const store = await loadSessionStore();
  const retained = [];
  for (const entry of store.entries) {
    try {
      const tab = await chrome.tabs.get(entry.tabId);
      const tabInfo = getSessionTabInfo(tab);
      if (!tabInfo || tabInfo.origin !== entry.origin) {
        await chrome.alarms.clear(sessionAlarmName(entry.tabId));
        continue;
      }
      retained.push(entry);
      await ensureSessionAlarm(entry);
    } catch (_error) {
      await chrome.alarms.clear(sessionAlarmName(entry.tabId));
    }
  }
  if (retained.length !== store.entries.length) {
    await saveSessionStore({ ...store, entries: retained });
  }
}

async function ensureSessionAlarm(entry, options) {
  const name = sessionAlarmName(entry.tabId);
  const existing = await chrome.alarms.get(name);
  const replace = Boolean(options && options.replace);
  const intervalChanged = !existing || Number(existing.periodInMinutes) !== entry.intervalMinutes;
  if (replace || intervalChanged) {
    await chrome.alarms.create(name, {
      periodInMinutes: entry.intervalMinutes
    });
    return chrome.alarms.get(name);
  }
  return existing;
}

async function stopSessionKeepAliveForTab(inputTabId) {
  const tabId = normalizeTabId(inputTabId);
  if (!tabId) return;
  const store = await loadSessionStore();
  const nextEntries = store.entries.filter((item) => item.tabId !== tabId);
  await chrome.alarms.clear(sessionAlarmName(tabId));
  if (nextEntries.length !== store.entries.length) {
    await saveSessionStore({ ...store, entries: nextEntries });
  }
}

async function clearAllSessionKeepAlives() {
  const store = await loadSessionStore();
  for (const entry of store.entries) {
    await chrome.alarms.clear(sessionAlarmName(entry.tabId));
  }
  await saveSessionStore({ version: SESSION_STORE_VERSION, entries: [], presets: [] });
}

async function loadSessionStore() {
  const stored = await chrome.storage.local.get(SESSION_STORAGE_KEY);
  return normalizeSessionStore(stored[SESSION_STORAGE_KEY]);
}

async function saveSessionStore(store) {
  const normalized = normalizeSessionStore(store);
  await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: normalized });
  return normalized;
}

function normalizeSessionStore(input) {
  const rawEntries = input && Array.isArray(input.entries) ? input.entries : [];
  const rawPresets = input && Array.isArray(input.presets) ? input.presets : [];
  const seenTabs = new Set();
  const seenOrigins = new Set();
  const entries = [];
  const presets = [];
  for (const rawEntry of rawEntries) {
    const entry = normalizeSessionEntry(rawEntry);
    if (!entry || seenTabs.has(entry.tabId)) continue;
    seenTabs.add(entry.tabId);
    entries.push(entry);
    if (entries.length >= MAX_SESSION_TABS) break;
  }
  for (const rawPreset of rawPresets) {
    const preset = normalizeSessionPreset(rawPreset);
    if (!preset || seenOrigins.has(preset.origin)) continue;
    seenOrigins.add(preset.origin);
    presets.push(preset);
    if (presets.length >= MAX_SESSION_PRESETS) break;
  }
  return { version: SESSION_STORE_VERSION, entries, presets };
}

function normalizeSessionEntry(input) {
  if (!input || typeof input !== "object") return null;
  const tabId = normalizeTabId(input.tabId);
  const origin = normalizeHttpsOrigin(input.origin);
  const intervalMinutes = Number(input.intervalMinutes);
  if (!tabId || !origin || !SESSION_INTERVALS.has(intervalMinutes)) return null;
  let hostname = "";
  try {
    hostname = new URL(origin).hostname;
  } catch (_error) {
    return null;
  }
  const mode = normalizeSessionMode(input.mode);
  let targetPath = "";
  if (mode !== "activity") {
    try {
      targetPath = normalizeSessionTargetPath(input.targetPath, origin);
    } catch (_error) {
      targetPath = "";
    }
  }
  return {
    tabId,
    origin,
    hostname,
    intervalMinutes,
    targetPath,
    mode,
    createdAt: normalizeSessionTimestamp(input.createdAt),
    updatedAt: normalizeSessionTimestamp(input.updatedAt),
    lastAttemptAt: normalizeOptionalSessionTimestamp(input.lastAttemptAt),
    lastCompletedAt: normalizeOptionalSessionTimestamp(input.lastCompletedAt),
    lastSuccessAt: normalizeOptionalSessionTimestamp(input.lastSuccessAt),
    lastTrigger: normalizeSessionTrigger(input.lastTrigger),
    lastStatus: ["pending", "success", "warning", "error"].includes(input.lastStatus)
      ? input.lastStatus
      : "pending",
    lastHttpStatus: Number.isInteger(input.lastHttpStatus) && input.lastHttpStatus >= 100 && input.lastHttpStatus <= 599
      ? input.lastHttpStatus
      : null,
    lastRequestSent: input.lastRequestSent === true,
    lastActivitySent: input.lastActivitySent === true,
    lastRedirected: input.lastRedirected === true,
    lastSameOrigin: typeof input.lastSameOrigin === "boolean" ? input.lastSameOrigin : null,
    lastError: cleanSessionText(input.lastError, 300)
  };
}

function normalizeSessionPreset(input) {
  if (!input || typeof input !== "object") return null;
  const origin = normalizeHttpsOrigin(input.origin);
  const intervalMinutes = Number(input.intervalMinutes);
  if (!origin || !SESSION_INTERVALS.has(intervalMinutes)) return null;
  const mode = normalizeSessionMode(input.mode);
  let targetPath = "";
  if (mode !== "activity") {
    try {
      targetPath = normalizeSessionTargetPath(input.targetPath, origin);
    } catch (_error) {
      return null;
    }
  }
  return {
    origin,
    intervalMinutes,
    targetPath,
    mode,
    createdAt: normalizeSessionTimestamp(input.createdAt),
    updatedAt: normalizeSessionTimestamp(input.updatedAt)
  };
}

function findSessionPreset(store, origin) {
  return store.presets.find((preset) => preset.origin === origin) || null;
}

function createSessionView(entry, tabInfo, alarm, preset) {
  const selectedSettings = entry || preset;
  return {
    supported: true,
    enabled: Boolean(entry),
    hostname: tabInfo.hostname,
    origin: tabInfo.origin,
    intervalMinutes: selectedSettings ? selectedSettings.intervalMinutes : 10,
    targetPath: selectedSettings ? selectedSettings.targetPath : "",
    mode: selectedSettings ? selectedSettings.mode : "activity",
    preset: preset ? {
      intervalMinutes: preset.intervalMinutes,
      targetPath: preset.targetPath,
      mode: preset.mode,
      updatedAt: preset.updatedAt
    } : null,
    lastAttemptAt: entry ? entry.lastAttemptAt : null,
    lastCompletedAt: entry ? entry.lastCompletedAt : null,
    lastSuccessAt: entry ? entry.lastSuccessAt : null,
    lastTrigger: entry ? entry.lastTrigger : null,
    lastStatus: entry ? entry.lastStatus : "off",
    lastHttpStatus: entry ? entry.lastHttpStatus : null,
    lastRequestSent: entry ? entry.lastRequestSent : false,
    lastActivitySent: entry ? entry.lastActivitySent : false,
    lastRedirected: entry ? entry.lastRedirected : false,
    lastSameOrigin: entry ? entry.lastSameOrigin : null,
    lastError: entry ? entry.lastError : "",
    alarmActive: Boolean(entry && alarm),
    alarmPeriodMinutes: entry && alarm && Number.isFinite(Number(alarm.periodInMinutes))
      ? Number(alarm.periodInMinutes)
      : null,
    nextCheckAt: entry ? normalizeAlarmTimestamp(alarm && alarm.scheduledTime) : null
  };
}

function unsupportedSessionView(reason) {
  return {
    supported: false,
    enabled: false,
    hostname: "",
    origin: "",
    intervalMinutes: 10,
    targetPath: "",
    mode: "activity",
    preset: null,
    lastAttemptAt: null,
    lastCompletedAt: null,
    lastSuccessAt: null,
    lastTrigger: null,
    lastStatus: "off",
    lastHttpStatus: null,
    lastRequestSent: false,
    lastActivitySent: false,
    lastRedirected: false,
    lastSameOrigin: null,
    lastError: cleanSessionText(reason, 300),
    alarmActive: false,
    alarmPeriodMinutes: null,
    nextCheckAt: null
  };
}

function normalizeAlarmTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp).toISOString();
}

function getSessionTabInfo(tab) {
  if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== "string") return null;
  const origin = normalizeHttpsOrigin(tab.url);
  if (!origin) return null;
  return {
    tabId: tab.id,
    origin,
    hostname: new URL(origin).hostname
  };
}

function normalizeHttpsOrigin(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" ? parsed.origin : "";
  } catch (_error) {
    return "";
  }
}

function normalizeSessionTargetPath(value, origin) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  if (raw.length > 1024) throw new Error("The session request path is limited to 1,024 characters.");
  let parsed;
  try {
    parsed = new URL(raw, `${origin}/`);
  } catch (_error) {
    throw new Error("Enter a valid session request path.");
  }
  if (parsed.protocol !== "https:" || parsed.origin !== origin) {
    throw new Error("The session request path must stay on the current HTTPS site.");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("The session request path cannot contain credentials or a fragment.");
  }
  const targetPath = `${parsed.pathname}${parsed.search}`;
  if (targetPath.length > 1024) throw new Error("The session request path is limited to 1,024 characters.");
  return targetPath;
}

function normalizeSessionMode(value) {
  return SESSION_MODES.has(value) ? value : "activity";
}

function normalizeSessionTrigger(value) {
  return ["enabled", "settings", "scheduled", "manual"].includes(value)
    ? value
    : null;
}

function normalizeTabId(value) {
  const tabId = Number(value);
  return Number.isInteger(tabId) && tabId > 0 ? tabId : null;
}

function normalizeSessionTimestamp(value) {
  const normalized = normalizeOptionalSessionTimestamp(value);
  return normalized || new Date().toISOString();
}

function normalizeOptionalSessionTimestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function cleanSessionText(value, maxLength) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout])
    .finally(() => clearTimeout(timer));
}

function sessionAlarmName(tabId) {
  return `${SESSION_ALARM_PREFIX}${tabId}`;
}

async function quickAddHeader(inputHeader, inputValue, sessionOnly) {
  const header = String(inputHeader == null ? "" : inputHeader).trim();
  const value = String(inputValue == null ? "" : inputValue);
  const modification = Core.createModification({
    target: "request",
    operation: "set",
    header,
    value,
    sessionOnly,
    sessionValueAvailable: sessionOnly
  });
  const validationErrors = Core.validateModification(modification, 0);
  if (header.length > 256) {
    validationErrors.push("Header names entered from the popup are limited to 256 characters.");
  }
  if (validationErrors.length) {
    const error = new Error(validationErrors.join("\n"));
    error.name = "ValidationError";
    throw error;
  }

  const state = await loadState();
  const profile = Core.getActiveProfile(state);
  if (!profile) throw new Error("No active profile is available.");
  const existing = profile.rules.find((rule) => isGlobalRequestSetRule(rule, header));
  let created = false;
  if (existing) {
    existing.enabled = true;
    existing.modifications[0].header = header;
    existing.modifications[0].value = value;
    existing.modifications[0].sessionOnly = sessionOnly;
    existing.modifications[0].sessionValueAvailable = sessionOnly;
  } else {
    const rule = Core.createRule({
      dnrId: state.nextDnrId,
      name: `Everywhere: ${header}`.slice(0, 120),
      description: "Global request header added from the toolbar popup.",
      enabled: true,
      priority: 10,
      match: {
        patternType: "urlFilter",
        pattern: "*",
        caseSensitive: false,
        requestDomains: [],
        excludedRequestDomains: [],
        initiatorDomains: [],
        excludedInitiatorDomains: [],
        resourceTypes: [...Core.DEFAULT_RESOURCE_TYPES],
        requestMethods: [],
        domainType: "all"
      },
      modifications: [modification]
    });
    profile.rules.unshift(rule);
    state.nextDnrId += 1;
    created = true;
  }
  profile.updatedAt = new Date().toISOString();
  const result = await applyState(
    state,
    `${created ? "Quick-added" : "Quick-updated"} ${header} for all requests`
  );
  return {
    ...result,
      quickAdd: {
        created,
        header,
        sessionOnly,
        applied: result.runtime.enabled
    }
  };
}

async function setRuleEnabled(inputProfileId, inputRuleId, enabled) {
  const profileId = String(inputProfileId == null ? "" : inputProfileId);
  const ruleId = String(inputRuleId == null ? "" : inputRuleId);
  if (!profileId || !ruleId) throw new Error("The selected rule could not be identified.");

  const state = await loadState();
  if (state.activeProfileId !== profileId) {
    throw new Error("The active profile changed. Reopen the popup and try again.");
  }
  const profile = state.profiles.find((item) => item.id === profileId);
  const rule = profile && profile.rules.find((item) => item.id === ruleId);
  if (!profile || !rule) {
    throw new Error("This rule is no longer available in the active profile.");
  }
  if (rule.enabled === enabled) {
    return {
      state,
      runtime: await getRuntime(state),
      warnings: []
    };
  }

  rule.enabled = enabled;
  profile.updatedAt = new Date().toISOString();
  return applyState(
    state,
    `${enabled ? "Enabled" : "Disabled"} rule ${rule.name}`
  );
}

function isGlobalRequestSetRule(rule, header) {
  if (!rule || !rule.match || !Array.isArray(rule.modifications) || rule.modifications.length !== 1) return false;
  const modification = rule.modifications[0];
  const match = rule.match;
  const allResourceTypes = Core.DEFAULT_RESOURCE_TYPES.every((type) => match.resourceTypes.includes(type));
  return (
    modification.target === "request" &&
    modification.operation === "set" &&
    modification.header.toLowerCase() === header.toLowerCase() &&
    match.patternType === "urlFilter" &&
    match.pattern === "*" &&
    match.caseSensitive === false &&
    match.requestDomains.length === 0 &&
    match.excludedRequestDomains.length === 0 &&
    match.initiatorDomains.length === 0 &&
    match.excludedInitiatorDomains.length === 0 &&
    allResourceTypes &&
    match.resourceTypes.length === Core.DEFAULT_RESOURCE_TYPES.length &&
    match.requestMethods.length === 0 &&
    match.domainType === "all"
  );
}

async function initializeAndReconcile(reason) {
  await restrictStorageAccess();
  await reconcileSessionKeepAlives();
  const state = await loadState();
  const compiled = Core.compileState(state);
  await validateRegexRules([...compiled.dynamicRules, ...compiled.sessionRules]);
  const [existingDynamic, existingSession] = await Promise.all([
    chrome.declarativeNetRequest.getDynamicRules(),
    chrome.declarativeNetRequest.getSessionRules()
  ]);
  if (
    Core.dnrSignature(existingDynamic) !== Core.dnrSignature(compiled.dynamicRules) ||
    Core.dnrSignature(existingSession) !== Core.dnrSignature(compiled.sessionRules)
  ) {
    await replaceRuleSets(
      existingDynamic,
      existingSession,
      compiled.dynamicRules,
      compiled.sessionRules
    );
    let reconciled = Core.addDeployment(
      state,
      Core.createDeployment(state, compiled, reason, "reconciled")
    );
    reconciled = Core.addDiagnostic(
      reconciled,
      Core.createDiagnostic("info", "Runtime", "Runtime rules were reconciled with the saved local configuration.")
    );
    try {
      await saveState(reconciled);
    } catch (error) {
      try {
        await replaceRuleSets(
          compiled.dynamicRules,
          compiled.sessionRules,
          existingDynamic,
          existingSession
        );
      } catch (rollbackError) {
        console.error("MonoHeader could not restore DNR rules after a storage failure.", rollbackError);
      }
      throw error;
    }
    await updateActionSafely(reconciled, compiled.logicalRuleCount);
    return reconciled;
  }
  await updateActionSafely(state, compiled.logicalRuleCount);
  return state;
}

async function applyState(input, reason, options) {
  const current = await loadState();
  let candidate = Core.normalizeState(input);
  if (!(options && options.resetHistory)) {
    candidate.deployments = current.deployments;
    candidate.diagnostics = current.diagnostics;
  }
  let compiled;
  try {
    compiled = Core.compileState(candidate);
    await validateRegexRules([...compiled.dynamicRules, ...compiled.sessionRules]);
  } catch (error) {
    await recordFailureSafely(current, "Compiler", "Configuration was not applied.", friendlyError(error));
    throw error;
  }

  const [existingDynamic, existingSession] = await Promise.all([
    chrome.declarativeNetRequest.getDynamicRules(),
    chrome.declarativeNetRequest.getSessionRules()
  ]);
  try {
    await replaceRuleSets(
      existingDynamic,
      existingSession,
      compiled.dynamicRules,
      compiled.sessionRules
    );
  } catch (error) {
    await recordFailureSafely(current, "Chrome DNR", "Chrome rejected the rule deployment.", friendlyError(error));
    throw new Error(`Chrome rejected the rule deployment: ${friendlyError(error)}`);
  }

  if (options && options.resetHistory) {
    candidate.rollbackSnapshot = null;
  } else if (!(options && options.preserveProvidedRollback)) {
    candidate.rollbackSnapshot = Core.configurationSnapshot(current);
  }
  if (options && options.resetHistory) {
    candidate.deployments = [];
    candidate.diagnostics = [];
  } else {
    const deployment = Core.createDeployment(candidate, compiled, reason, "success");
    candidate = Core.addDeployment(candidate, deployment);
    candidate = Core.addDiagnostic(
      candidate,
      Core.createDiagnostic(
        compiled.warnings.length ? "warning" : "info",
        "Deployment",
        compiled.warnings.length
          ? `Applied ${compiled.logicalRuleCount} rules with ${compiled.warnings.length} warning${compiled.warnings.length === 1 ? "" : "s"}.`
          : `Applied ${compiled.logicalRuleCount} rule${compiled.logicalRuleCount === 1 ? "" : "s"} successfully.`,
        compiled.warnings.join("\n")
      )
    );
  }
  try {
    await saveState(candidate);
  } catch (error) {
    try {
      await replaceRuleSets(
        compiled.dynamicRules,
        compiled.sessionRules,
        existingDynamic,
        existingSession
      );
    } catch (rollbackError) {
      console.error("MonoHeader could not restore DNR rules after a storage failure.", rollbackError);
      throw new Error(`Local state could not be saved, and Chrome could not restore the prior rules: ${friendlyError(rollbackError)}`);
    }
    throw new Error(`Local state could not be saved. The previous Chrome rules were restored: ${friendlyError(error)}`);
  }
  await updateActionSafely(candidate, compiled.logicalRuleCount);
  return {
    state: candidate,
    runtime: await getRuntime(candidate),
    warnings: compiled.warnings
  };
}

async function validateRegexRules(rules) {
  for (const rule of rules) {
    if (!rule.condition.regexFilter) continue;
    const result = await chrome.declarativeNetRequest.isRegexSupported({
      regex: rule.condition.regexFilter,
      isCaseSensitive: rule.condition.isUrlFilterCaseSensitive === true,
      requireCapturing: false
    });
    if (!result.isSupported) {
      const reason = result.reason ? ` (${result.reason})` : "";
      const error = new Error(`Regular expression in DNR rule ${rule.id} is not supported by Chrome${reason}.`);
      error.name = "ValidationError";
      throw error;
    }
  }
}

async function replaceDynamicRules(existing, nextRules) {
  const removeRuleIds = existing.map((rule) => rule.id);
  if (removeRuleIds.length === 0 && nextRules.length === 0) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: nextRules
  });
}

async function replaceSessionRules(existing, nextRules) {
  const removeRuleIds = existing.map((rule) => rule.id);
  if (removeRuleIds.length === 0 && nextRules.length === 0) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds,
    addRules: nextRules
  });
}

async function replaceRuleSets(existingDynamic, existingSession, nextDynamic, nextSession) {
  const dynamicChanged = Core.dnrSignature(existingDynamic) !== Core.dnrSignature(nextDynamic);
  const sessionChanged = Core.dnrSignature(existingSession) !== Core.dnrSignature(nextSession);
  let dynamicReplaced = false;
  try {
    if (dynamicChanged) {
      await replaceDynamicRules(existingDynamic, nextDynamic);
      dynamicReplaced = true;
    }
    if (sessionChanged) {
      await replaceSessionRules(existingSession, nextSession);
    }
  } catch (error) {
    if (dynamicReplaced) {
      try {
        await replaceDynamicRules(nextDynamic, existingDynamic);
      } catch (rollbackError) {
        console.error("MonoHeader could not restore dynamic rules after a session-rule failure.", rollbackError);
      }
    }
    throw error;
  }
}

async function recordFailure(state, source, message, details) {
  const withDiagnostic = Core.addDiagnostic(
    state,
    Core.createDiagnostic("error", source, message, details)
  );
  await saveState(withDiagnostic);
  await updateActionSafely(withDiagnostic);
}

async function recordFailureSafely(state, source, message, details) {
  try {
    await recordFailure(state, source, message, details);
  } catch (error) {
    console.error("MonoHeader could not retain a failure diagnostic.", error);
  }
}

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const state = Core.normalizeState(stored[STORAGE_KEY]);
  if (!stored[STORAGE_KEY]) await saveState(state);
  const sessionValues = await loadSessionHeaderValues();
  return Core.hydrateSessionHeaderValues(state, sessionValues);
}

async function saveState(state) {
  const normalized = Core.normalizeState(state);
  const localState = Core.sanitizeStateForLocalStorage(normalized);
  const nextSessionStore = {
    version: SESSION_HEADER_VALUES_VERSION,
    values: Core.extractSessionHeaderValues(normalized)
  };
  const previousSession = await chrome.storage.session.get(SESSION_HEADER_VALUES_KEY);
  await chrome.storage.session.set({ [SESSION_HEADER_VALUES_KEY]: nextSessionStore });
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: localState });
  } catch (error) {
    try {
      if (previousSession[SESSION_HEADER_VALUES_KEY] === undefined) {
        await chrome.storage.session.remove(SESSION_HEADER_VALUES_KEY);
      } else {
        await chrome.storage.session.set({
          [SESSION_HEADER_VALUES_KEY]: previousSession[SESSION_HEADER_VALUES_KEY]
        });
      }
    } catch (rollbackError) {
      console.error("MonoHeader could not restore session-only values after a local storage failure.", rollbackError);
    }
    throw error;
  }
  return normalized;
}

async function loadSessionHeaderValues() {
  const stored = await chrome.storage.session.get(SESSION_HEADER_VALUES_KEY);
  const raw = stored && stored[SESSION_HEADER_VALUES_KEY];
  if (!raw || raw.version !== SESSION_HEADER_VALUES_VERSION || !raw.values || typeof raw.values !== "object") {
    return {};
  }
  const values = {};
  Object.entries(raw.values).forEach(([modificationId, value]) => {
    const id = cleanSessionText(modificationId, 160);
    if (!id || typeof value !== "string") return;
    if (/[\r\n\u0000]/.test(value)) return;
    values[id] = value.slice(0, Core.MAX_HEADER_VALUE_LENGTH);
  });
  return values;
}

async function restrictStorageAccess() {
  if (chrome.storage.local.setAccessLevel) {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  }
  if (chrome.storage.session.setAccessLevel) {
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  }
}

async function getRuntime(state) {
  const [dynamicRules, sessionRules, storageBytes, sessionStorageBytes] = await Promise.all([
    chrome.declarativeNetRequest.getDynamicRules(),
    chrome.declarativeNetRequest.getSessionRules(),
    chrome.storage.local.getBytesInUse(null),
    chrome.storage.session.getBytesInUse(null)
  ]);
  const activeProfile = Core.getActiveProfile(state);
  const deployedRuleCount = new Set([
    ...dynamicRules.map((rule) => rule.id),
    ...sessionRules.map((rule) => rule.id)
  ]).size;
  const unavailableSessionValueCount = activeProfile
    ? activeProfile.rules
      .filter((rule) => state.extensionEnabled && rule.enabled)
      .reduce((count, rule) => count + rule.modifications.filter((modification) => (
        modification.sessionOnly && !modification.sessionValueAvailable
      )).length, 0)
    : 0;
  return {
    enabled: state.extensionEnabled,
    activeProfileId: activeProfile ? activeProfile.id : "",
    activeProfileName: activeProfile ? activeProfile.name : "No profile",
    deployedRuleCount,
    deployedDynamicRuleCount: dynamicRules.length,
    deployedSessionRuleCount: sessionRules.length,
    unavailableSessionValueCount,
    storageBytes,
    sessionStorageBytes,
    lastAppliedAt: state.deployments.length ? state.deployments[0].timestamp : null,
    lastStatus: state.diagnostics.length ? state.diagnostics[0].level : "info",
    maxRuleCount: Core.MAX_DYNAMIC_HEADER_RULES
  };
}

async function updateAction(state, knownRuleCount) {
  let count = knownRuleCount;
  if (typeof count !== "number") {
    const [dynamicRules, sessionRules] = await Promise.all([
      chrome.declarativeNetRequest.getDynamicRules(),
      chrome.declarativeNetRequest.getSessionRules()
    ]);
    count = new Set([
      ...dynamicRules.map((rule) => rule.id),
      ...sessionRules.map((rule) => rule.id)
    ]).size;
  }
  const enabled = state.extensionEnabled;
  await Promise.all([
    chrome.action.setBadgeText({ text: enabled ? (count > 0 ? String(Math.min(count, 999)) : "ON") : "OFF" }),
    chrome.action.setBadgeBackgroundColor({ color: enabled ? "#4f46e5" : "#64748b" }),
    chrome.action.setTitle({
      title: enabled
        ? `MonoHeader — ${count} active rule${count === 1 ? "" : "s"}`
        : "MonoHeader — paused"
    })
  ]);
}

async function updateActionSafely(state, knownRuleCount) {
  try {
    await updateAction(state, knownRuleCount);
  } catch (error) {
    console.warn("MonoHeader could not refresh its toolbar badge.", error);
  }
}

function friendlyError(error) {
  if (!error) return "An unknown error occurred.";
  if (error.validation && Array.isArray(error.validation.errors)) {
    return error.validation.errors.join("\n");
  }
  return String(error.message || error).replace(/^Error:\s*/i, "");
}
