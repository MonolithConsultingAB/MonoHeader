"use strict";

if (typeof globalThis.MonoHeaderAPI === "undefined" && typeof importScripts === "function") {
  importScripts("platform.js");
}
if (typeof globalThis.MonoHeaderCore === "undefined" && typeof importScripts === "function") {
  importScripts("core.js");
}

const ExtensionAPI = globalThis.MonoHeaderAPI || globalThis.browser || globalThis.chrome;
const BrowserName = globalThis.MonoHeaderPlatform && globalThis.MonoHeaderPlatform.browserName ||
  (typeof globalThis.browser !== "undefined" ? "Firefox" : "Chrome");
const Core = globalThis.MonoHeaderCore;
const STORAGE_KEY = "monoHeaderState";
const SESSION_STORAGE_KEY = "monoHeaderSessionKeepAlive";
const SESSION_HEADER_VALUES_KEY = "monoHeaderSessionHeaderValues";
const SESSION_HEADER_VALUES_VERSION = 1;
const SESSION_STORE_VERSION = 6;
const SESSION_ALARM_PREFIX = "monoheader-session-";
const SESSION_INTERVALS = new Set([5, 10, 15, 30]);
const SESSION_MODES = new Set(["request", "activity", "both"]);
const SESSION_PRESET_SCOPES = new Set(["exact", "domain", "subdomains", "global"]);
const SESSION_WRITE_ACTIONS = new Set([
  "SET_SESSION_KEEP_ALIVE",
  "TEST_SESSION_KEEP_ALIVE",
  "RESET_SESSION_KEEP_ALIVE",
  "SAVE_SESSION_KEEP_ALIVE_PRESET",
  "DELETE_SESSION_KEEP_ALIVE_PRESET",
  "SAVE_SESSION_KEEP_ALIVE_CONFIG",
  "DELETE_SESSION_KEEP_ALIVE_CONFIG",
  "SET_SESSION_KEEP_ALIVE_PRESET_AUTO_START"
]);
const SESSION_SERIAL_ACTIONS = new Set([
  "GET_SESSION_KEEP_ALIVE",
  "GET_SESSION_KEEP_ALIVE_CONFIG",
  "TEST_SESSION_KEEP_ALIVE_PATTERN",
  ...SESSION_WRITE_ACTIONS
]);
const SESSION_EXECUTION_TIMEOUT_MS = 5000;
const MAX_SESSION_TABS = 25;
const MAX_SESSION_PRESETS = 100;
let operationQueue = Promise.resolve();
let sessionOperationQueue = Promise.resolve();
let initializationPromise = Promise.resolve();

ExtensionAPI.runtime.onInstalled.addListener(() => {
  queueOperation(() => initializeAndReconcile("Extension installed"));
});

ExtensionAPI.runtime.onStartup.addListener(() => {
  queueOperation(() => initializeAndReconcile("Browser startup"));
});

ExtensionAPI.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || !String(alarm.name).startsWith(SESSION_ALARM_PREFIX)) return;
  queueSessionOperation(() => handleSessionAlarm(alarm)).catch((error) => {
    console.warn("MonoHeader session keep-alive alarm failed.", error);
  });
});

ExtensionAPI.tabs.onRemoved.addListener((tabId) => {
  queueSessionOperation(() => stopSessionKeepAliveForTab(tabId, { clearPause: true })).catch((error) => {
    console.warn("MonoHeader could not stop keep-alive for a closed tab.", error);
  });
});

ExtensionAPI.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo || (!changeInfo.url && changeInfo.status !== "complete")) return;
  queueSessionOperation(() => handleSessionTabUpdated(tabId, changeInfo, tab)).catch((error) => {
    console.warn("MonoHeader could not reconcile keep-alive after navigation.", error);
  });
});

initializationPromise = initializeAndReconcile("Background runtime started").catch((error) => {
  console.error("MonoHeader could not reconcile runtime state during background startup.", error);
});
operationQueue = initializationPromise;

ExtensionAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    case "GET_SESSION_KEEP_ALIVE_CONFIG":
      return { sessionKeepAliveConfig: await getSessionKeepAliveConfig() };
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
      await stopSessionKeepAliveForTab(message.tabId, { pauseAutomatic: true });
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
    case "SAVE_SESSION_KEEP_ALIVE_CONFIG":
      return {
        sessionKeepAliveConfig: await saveSessionKeepAliveConfig(
          message.preset,
          message.originalKey,
          message.confirmGlobal === true
        )
      };
    case "DELETE_SESSION_KEEP_ALIVE_CONFIG":
      return {
        sessionKeepAliveConfig: await deleteSessionKeepAliveConfig(message.presetKey)
      };
    case "SET_SESSION_KEEP_ALIVE_PRESET_AUTO_START":
      return setSessionKeepAlivePresetAutoStart(
        message.presetKey,
        message.enabled === true,
        message.confirmGlobal === true,
        message.tabId
      );
    case "TEST_SESSION_KEEP_ALIVE_PATTERN":
      return {
        sessionPatternTest: await testSessionKeepAlivePattern(
          message.url,
          message.draftPreset || null
        )
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
    tab = await ExtensionAPI.tabs.get(tabId);
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
  const preset = findExactSessionPreset(store, tabInfo.origin);
  const matchedPreset = findEffectiveSessionPreset(store, tabInfo);
  const pause = findSessionPause(store, tabId, tabInfo.origin, matchedPreset);
  if (entry && entry.origin !== tabInfo.origin) {
    await stopSessionKeepAliveForTab(tabId, { clearPause: true });
    const refreshedStore = await loadSessionStore();
    return createSessionView(
      null,
      tabInfo,
      null,
      findExactSessionPreset(refreshedStore, tabInfo.origin),
      findEffectiveSessionPreset(refreshedStore, tabInfo),
      null
    );
  }
  const alarm = entry ? await ensureSessionAlarm(entry) : null;
  return createSessionView(entry || null, tabInfo, alarm, preset, matchedPreset, pause);
}

async function setSessionKeepAliveForTab(inputTabId, enabled, inputInterval, inputTargetPath, inputMode) {
  const tabId = normalizeTabId(inputTabId);
  if (!tabId) throw new Error("Open an HTTPS website before enabling session keep-alive.");
  if (!enabled) {
    await stopSessionKeepAliveForTab(tabId, { pauseAutomatic: true });
    return getSessionKeepAliveForTab(tabId);
  }

  const intervalMinutes = Number(inputInterval);
  if (!SESSION_INTERVALS.has(intervalMinutes)) {
    throw new Error("Choose a keep-alive interval of 5, 10, 15, or 30 minutes.");
  }
  let tab;
  try {
    tab = await ExtensionAPI.tabs.get(tabId);
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
    lastError: "",
    automatic: false,
    sourcePresetKey: null
  });
  if (existingIndex >= 0) store.entries[existingIndex] = entry;
  else store.entries.push(entry);
  store.pauses = store.pauses.filter((pause) => pause.tabId !== tabId);
  await saveSessionStore(store);

  try {
    await ensureSessionAlarm(entry, {
      replace: !previousEntry || previousEntry.intervalMinutes !== intervalMinutes
    });
  } catch (error) {
    await stopSessionKeepAliveForTab(tabId);
    throw new Error(`${BrowserName} could not schedule session keep-alive: ${friendlyError(error)}`);
  }
  const updated = await pingSessionKeepAlive(tabId, previousEntry ? "settings" : "enabled");
  const alarm = updated ? await ExtensionAPI.alarms.get(sessionAlarmName(tabId)) : null;
  return createSessionView(
    updated,
    tabInfo,
    alarm,
    findExactSessionPreset(store, tabInfo.origin),
    findEffectiveSessionPreset(store, tabInfo),
    null
  );
}

async function testSessionKeepAliveForTab(inputTabId, inputTargetPath, inputMode) {
  const tabId = normalizeTabId(inputTabId);
  if (!tabId) throw new Error("Open an HTTPS website before testing session keep-alive.");
  let tab;
  try {
    tab = await ExtensionAPI.tabs.get(tabId);
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
  const alarm = entry ? await ExtensionAPI.alarms.get(sessionAlarmName(tabId)) : null;
  return {
    sessionKeepAlive: createSessionView(
      entry,
      tabInfo,
      alarm,
      findExactSessionPreset(store, tabInfo.origin),
      findEffectiveSessionPreset(store, tabInfo),
      findSessionPause(store, tabId, tabInfo.origin, findEffectiveSessionPreset(store, tabInfo))
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
    tab = await ExtensionAPI.tabs.get(tabId);
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
  const exactKey = sessionPresetKey({ scope: "exact", pattern: tabInfo.origin });
  const existingIndex = store.presets.findIndex((preset) => sessionPresetKey(preset) === exactKey);
  if (existingIndex < 0 && store.presets.length >= MAX_SESSION_PRESETS) {
    throw new Error(`Keep-alive presets are limited to ${MAX_SESSION_PRESETS} sites.`);
  }
  const existingPreset = existingIndex >= 0 ? store.presets[existingIndex] : null;
  const now = new Date().toISOString();
  const preset = normalizeSessionPreset({
    scope: "exact",
    pattern: tabInfo.origin,
    name: existingPreset && existingPreset.name || tabInfo.hostname,
    autoStart: existingPreset && existingPreset.autoStart === true,
    excludedHosts: [],
    intervalMinutes,
    targetPath,
    mode,
    createdAt: existingPreset ? existingPreset.createdAt : now,
    updatedAt: now
  });
  if (existingIndex >= 0) store.presets[existingIndex] = preset;
  else store.presets.push(preset);
  await saveSessionStore(store);
  await reconcileSessionKeepAlives();
  return getSessionKeepAliveForTab(tabId);
}

async function deleteSessionPresetForTab(inputTabId) {
  const tabId = normalizeTabId(inputTabId);
  if (!tabId) throw new Error("Open an HTTPS website before deleting a keep-alive preset.");
  let tab;
  try {
    tab = await ExtensionAPI.tabs.get(tabId);
  } catch (_error) {
    throw new Error("The selected tab is no longer available.");
  }
  const tabInfo = getSessionTabInfo(tab);
  if (!tabInfo) throw new Error("Keep-alive presets are available on HTTPS pages only.");
  const store = await loadSessionStore();
  const exactKey = sessionPresetKey({ scope: "exact", pattern: tabInfo.origin });
  const nextPresets = store.presets.filter((preset) => sessionPresetKey(preset) !== exactKey);
  if (nextPresets.length !== store.presets.length) {
    await saveSessionStore({ ...store, presets: nextPresets });
    await reconcileSessionKeepAlives();
  }
  return getSessionKeepAliveForTab(tabId);
}

async function getSessionKeepAliveConfig() {
  const store = await loadSessionStore();
  let tabs = [];
  try {
    tabs = await ExtensionAPI.tabs.query({});
  } catch (_error) {
    tabs = [];
  }
  const tabInfos = tabs.map(getSessionTabInfo).filter(Boolean);
  const presets = [...store.presets]
    .sort(compareSessionPresetSpecificity)
    .map((preset) => {
      const key = sessionPresetKey(preset);
      const matchingTabIds = tabInfos
        .filter((tabInfo) => sessionPresetMatchesTab(preset, tabInfo))
        .map((tabInfo) => tabInfo.tabId);
      const effectiveTabIds = tabInfos
        .filter((tabInfo) => {
          const effective = findEffectiveSessionPreset(store, tabInfo);
          return effective && sessionPresetKey(effective) === key;
        })
        .map((tabInfo) => tabInfo.tabId);
      return {
        ...sessionPresetSummary(preset),
        createdAt: preset.createdAt,
        matchingTabCount: matchingTabIds.length,
        effectiveTabCount: effectiveTabIds.length,
        activeTabCount: store.entries.filter((entry) => (
          entry.automatic &&
          entry.sourcePresetKey === key
        )).length,
        pausedTabCount: store.pauses.filter((pause) => pause.presetKey === key).length
      };
    });
  return {
    version: SESSION_STORE_VERSION,
    presets,
    activeTabCount: store.entries.length,
    automaticTabCount: store.entries.filter((entry) => entry.automatic).length,
    pausedTabCount: store.pauses.length,
    precedence: "Exact origin, then the most-specific domain or wildcard, then all HTTPS sites."
  };
}

async function saveSessionKeepAliveConfig(inputPreset, inputOriginalKey, confirmGlobal) {
  const rawPreset = inputPreset && typeof inputPreset === "object" ? inputPreset : {};
  if (!SESSION_PRESET_SCOPES.has(rawPreset.scope)) {
    throw new Error("Choose an exact origin, domain, subdomain wildcard, or all HTTPS sites.");
  }
  if (rawPreset.scope === "global" && rawPreset.autoStart === true && !confirmGlobal) {
    throw new Error("Confirm that keep-alive should start automatically on every HTTPS site.");
  }
  const rawExcludedHosts = Array.isArray(rawPreset.excludedHosts)
    ? rawPreset.excludedHosts
    : String(rawPreset.excludedHosts == null ? "" : rawPreset.excludedHosts).split(/[\n,]+/);
  for (const excludedHost of rawExcludedHosts) {
    const raw = cleanSessionText(excludedHost, 255).toLowerCase();
    if (!raw) continue;
    const hostname = raw.startsWith("*.") ? raw.slice(2) : raw;
    if (!normalizeSessionHostnamePattern(hostname)) {
      throw new Error(`Invalid excluded host: ${raw}`);
    }
  }
  const normalized = normalizeSessionPreset({
    ...rawPreset,
    createdAt: rawPreset.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  if (!normalized) {
    throw new Error("The keep-alive site rule is invalid. Check its site pattern, interval, and request path.");
  }
  const store = await loadSessionStore();
  const originalKey = cleanSessionText(inputOriginalKey, 120);
  const nextKey = sessionPresetKey(normalized);
  const originalIndex = originalKey
    ? store.presets.findIndex((preset) => sessionPresetKey(preset) === originalKey)
    : -1;
  const duplicateIndex = store.presets.findIndex((preset) => sessionPresetKey(preset) === nextKey);
  if (duplicateIndex >= 0 && duplicateIndex !== originalIndex) {
    throw new Error("A keep-alive rule already exists for that site pattern.");
  }
  if (originalIndex < 0 && duplicateIndex < 0 && store.presets.length >= MAX_SESSION_PRESETS) {
    throw new Error(`Keep-alive presets are limited to ${MAX_SESSION_PRESETS} sites.`);
  }
  if (originalIndex >= 0) {
    normalized.createdAt = store.presets[originalIndex].createdAt;
    store.presets[originalIndex] = normalized;
  } else if (duplicateIndex >= 0) {
    normalized.createdAt = store.presets[duplicateIndex].createdAt;
    store.presets[duplicateIndex] = normalized;
  } else {
    store.presets.push(normalized);
  }
  await saveSessionStore(store);
  await reconcileSessionKeepAlives();
  return getSessionKeepAliveConfig();
}

async function deleteSessionKeepAliveConfig(inputPresetKey) {
  const presetKey = cleanSessionText(inputPresetKey, 120);
  if (!presetKey) throw new Error("Choose a keep-alive site rule to delete.");
  const store = await loadSessionStore();
  const presets = store.presets.filter((preset) => sessionPresetKey(preset) !== presetKey);
  if (presets.length === store.presets.length) {
    throw new Error("That keep-alive site rule no longer exists.");
  }
  const pauses = store.pauses.filter((pause) => pause.presetKey !== presetKey);
  await saveSessionStore({ ...store, presets, pauses });
  await reconcileSessionKeepAlives();
  return getSessionKeepAliveConfig();
}

async function setSessionKeepAlivePresetAutoStart(inputPresetKey, enabled, confirmGlobal, inputTabId) {
  const presetKey = cleanSessionText(inputPresetKey, 120);
  const store = await loadSessionStore();
  const index = store.presets.findIndex((preset) => sessionPresetKey(preset) === presetKey);
  if (index < 0) throw new Error("That keep-alive site rule no longer exists.");
  if (enabled && store.presets[index].scope === "global" && !confirmGlobal) {
    throw new Error("Confirm that keep-alive should start automatically on every HTTPS site.");
  }
  store.presets[index] = normalizeSessionPreset({
    ...store.presets[index],
    autoStart: enabled,
    updatedAt: new Date().toISOString()
  });
  if (!enabled) {
    store.pauses = store.pauses.filter((pause) => pause.presetKey !== presetKey);
  }
  await saveSessionStore(store);
  await reconcileSessionKeepAlives();
  const result = {
    sessionKeepAliveConfig: await getSessionKeepAliveConfig()
  };
  const tabId = normalizeTabId(inputTabId);
  if (tabId) result.sessionKeepAlive = await getSessionKeepAliveForTab(tabId);
  return result;
}

async function testSessionKeepAlivePattern(inputUrl, inputDraftPreset) {
  const origin = normalizeHttpsOrigin(inputUrl);
  if (!origin) throw new Error("Enter a complete HTTPS URL to test.");
  const parsed = new URL(String(inputUrl));
  const tabInfo = {
    tabId: 0,
    origin,
    hostname: parsed.hostname.toLowerCase()
  };
  const store = await loadSessionStore();
  let draftPreset = null;
  if (inputDraftPreset) {
    const originalKey = cleanSessionText(inputDraftPreset.originalKey, 120);
    draftPreset = normalizeSessionPreset({
      ...inputDraftPreset,
      intervalMinutes: Number(inputDraftPreset.intervalMinutes) || 10,
      mode: inputDraftPreset.mode || "activity",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    if (!draftPreset) throw new Error("The draft site pattern is invalid.");
    const draftKey = sessionPresetKey(draftPreset);
    store.presets = store.presets.filter((preset) => {
      const key = sessionPresetKey(preset);
      return key !== draftKey && (!originalKey || key !== originalKey);
    });
    store.presets.push(draftPreset);
  }
  const effective = findEffectiveSessionPreset(store, tabInfo);
  const matching = store.presets
    .filter((preset) => sessionPresetMatchesTab(preset, tabInfo))
    .sort(compareSessionPresetSpecificity);
  const draftMatches = draftPreset ? sessionPresetMatchesTab(draftPreset, tabInfo) : null;
  return {
    url: parsed.href,
    origin,
    hostname: tabInfo.hostname,
    matched: Boolean(effective),
    draftMatches,
    effectivePreset: sessionPresetSummary(effective),
    matchingPresets: matching.map(sessionPresetSummary),
    explanation: effective
      ? `“${effective.name}” wins because ${sessionPresetDisplayPattern(effective)} is the most specific matching rule.`
      : "No keep-alive site rule matches this HTTPS URL."
  };
}

async function handleSessionAlarm(alarm) {
  const tabId = normalizeTabId(String(alarm.name).slice(SESSION_ALARM_PREFIX.length));
  if (!tabId) {
    await ExtensionAPI.alarms.clear(alarm.name);
    return;
  }
  const entry = await pingSessionKeepAlive(tabId, "scheduled");
  if (!entry) await ExtensionAPI.alarms.clear(alarm.name);
}

async function handleSessionTabUpdated(tabId, changeInfo, tab) {
  const store = await loadSessionStore();
  const entry = store.entries.find((item) => item.tabId === tabId);
  const tabInfo = getSessionTabInfo(tab);
  const originChanged = Boolean(entry && (!tabInfo || tabInfo.origin !== entry.origin));
  if (originChanged) {
    await stopSessionKeepAliveForTab(tabId, { clearPause: true });
  } else if (changeInfo && changeInfo.url) {
    const pause = store.pauses.find((item) => item.tabId === tabId);
    if (pause && (!tabInfo || pause.origin !== tabInfo.origin)) {
      await removeSessionPause(tabId);
    }
  }
  if (changeInfo && changeInfo.status !== "complete") return;
  await reconcileSessionKeepAliveForTab(tabId, tab);
}

async function pingSessionKeepAlive(tabId, trigger) {
  const store = await loadSessionStore();
  const entryIndex = store.entries.findIndex((item) => item.tabId === tabId);
  if (entryIndex < 0) return null;
  let tab;
  try {
    tab = await ExtensionAPI.tabs.get(tabId);
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
      ExtensionAPI.scripting.executeScript({
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
  let tabs = [];
  try {
    tabs = await ExtensionAPI.tabs.query({});
  } catch (_error) {
    tabs = [];
  }
  const tabsById = new Map(
    tabs
      .filter((tab) => tab && Number.isInteger(tab.id))
      .map((tab) => [tab.id, tab])
  );
  const retainedEntries = [];
  for (const entry of store.entries) {
    let tab = tabsById.get(entry.tabId);
    if (!tab) {
      try {
        tab = await ExtensionAPI.tabs.get(entry.tabId);
      } catch (_error) {
        tab = null;
      }
    }
    const tabInfo = getSessionTabInfo(tab);
    if (!tabInfo || tabInfo.origin !== entry.origin) {
      await ExtensionAPI.alarms.clear(sessionAlarmName(entry.tabId));
      continue;
    }
    retainedEntries.push(entry);
  }
  const retainedPauses = store.pauses.filter((pause) => {
    const tabInfo = getSessionTabInfo(tabsById.get(pause.tabId));
    if (!tabInfo || tabInfo.origin !== pause.origin) return false;
    const matchedPreset = findEffectiveSessionPreset(store, tabInfo);
    return Boolean(matchedPreset && matchedPreset.autoStart && sessionPresetKey(matchedPreset) === pause.presetKey);
  });
  if (
    retainedEntries.length !== store.entries.length ||
    retainedPauses.length !== store.pauses.length
  ) {
    await saveSessionStore({
      ...store,
      entries: retainedEntries,
      pauses: retainedPauses
    });
  }

  const seenTabs = new Set();
  for (const tab of tabs) {
    if (!tab || !Number.isInteger(tab.id) || seenTabs.has(tab.id)) continue;
    seenTabs.add(tab.id);
    await reconcileSessionKeepAliveForTab(tab.id, tab);
  }
  for (const entry of retainedEntries) {
    if (seenTabs.has(entry.tabId)) continue;
    try {
      const tab = await ExtensionAPI.tabs.get(entry.tabId);
      await reconcileSessionKeepAliveForTab(entry.tabId, tab);
    } catch (_error) {
      await stopSessionKeepAliveForTab(entry.tabId, { clearPause: true });
    }
  }
}

async function reconcileSessionKeepAliveForTab(inputTabId, suppliedTab) {
  const tabId = normalizeTabId(inputTabId);
  if (!tabId) return null;
  let tab = suppliedTab;
  if (!tab) {
    try {
      tab = await ExtensionAPI.tabs.get(tabId);
    } catch (_error) {
      await stopSessionKeepAliveForTab(tabId, { clearPause: true });
      return null;
    }
  }
  const tabInfo = getSessionTabInfo(tab);
  if (!tabInfo) {
    await stopSessionKeepAliveForTab(tabId, { clearPause: true });
    return null;
  }
  const store = await loadSessionStore();
  const entryIndex = store.entries.findIndex((item) => item.tabId === tabId);
  const entry = entryIndex >= 0 ? store.entries[entryIndex] : null;
  if (entry && entry.origin !== tabInfo.origin) {
    await stopSessionKeepAliveForTab(tabId, { clearPause: true });
    return reconcileSessionKeepAliveForTab(tabId, tab);
  }
  if (entry && !entry.automatic) {
    await ensureSessionAlarm(entry);
    return entry;
  }

  const matchedPreset = findEffectiveSessionPreset(store, tabInfo);
  const pause = findSessionPause(store, tabId, tabInfo.origin, matchedPreset);
  if (!matchedPreset || !matchedPreset.autoStart || pause) {
    if (entry && entry.automatic) await stopSessionKeepAliveForTab(tabId);
    return null;
  }
  if (tab && tab.status === "loading") return entry;

  const presetKey = sessionPresetKey(matchedPreset);
  const targetPath = matchedPreset.mode === "activity"
    ? ""
    : normalizeSessionTargetPath(matchedPreset.targetPath, tabInfo.origin);
  const settingsChanged = Boolean(entry && (
    entry.sourcePresetKey !== presetKey ||
    entry.intervalMinutes !== matchedPreset.intervalMinutes ||
    entry.targetPath !== targetPath ||
    entry.mode !== matchedPreset.mode
  ));
  const now = new Date().toISOString();
  const automaticEntry = normalizeSessionEntry({
    ...(entry || {}),
    tabId,
    origin: tabInfo.origin,
    hostname: tabInfo.hostname,
    intervalMinutes: matchedPreset.intervalMinutes,
    targetPath,
    mode: matchedPreset.mode,
    automatic: true,
    sourcePresetKey: presetKey,
    createdAt: entry ? entry.createdAt : now,
    updatedAt: now,
    lastStatus: entry ? entry.lastStatus : "pending",
    lastError: settingsChanged ? "" : entry && entry.lastError
  });
  if (!entry && store.entries.length >= MAX_SESSION_TABS) {
    return null;
  }
  if (entryIndex >= 0) store.entries[entryIndex] = automaticEntry;
  else store.entries.push(automaticEntry);
  store.pauses = store.pauses.filter((item) => item.tabId !== tabId);
  await saveSessionStore(store);
  await ensureSessionAlarm(automaticEntry, { replace: settingsChanged });
  if (!entry || settingsChanged) {
    return pingSessionKeepAlive(tabId, "automatic");
  }
  return automaticEntry;
}

async function ensureSessionAlarm(entry, options) {
  const name = sessionAlarmName(entry.tabId);
  const existing = await ExtensionAPI.alarms.get(name);
  const replace = Boolean(options && options.replace);
  const intervalChanged = !existing || Number(existing.periodInMinutes) !== entry.intervalMinutes;
  if (replace || intervalChanged) {
    await ExtensionAPI.alarms.create(name, {
      periodInMinutes: entry.intervalMinutes
    });
    return ExtensionAPI.alarms.get(name);
  }
  return existing;
}

async function stopSessionKeepAliveForTab(inputTabId, options) {
  const tabId = normalizeTabId(inputTabId);
  if (!tabId) return;
  const store = await loadSessionStore();
  const entry = store.entries.find((item) => item.tabId === tabId);
  const nextEntries = store.entries.filter((item) => item.tabId !== tabId);
  let nextPauses = store.pauses;
  if (options && options.clearPause) {
    nextPauses = nextPauses.filter((pause) => pause.tabId !== tabId);
  } else if (options && options.pauseAutomatic && entry && entry.automatic && entry.sourcePresetKey) {
    nextPauses = nextPauses.filter((pause) => pause.tabId !== tabId);
    nextPauses.push(normalizeSessionPause({
      tabId,
      origin: entry.origin,
      presetKey: entry.sourcePresetKey,
      createdAt: new Date().toISOString()
    }));
  }
  await ExtensionAPI.alarms.clear(sessionAlarmName(tabId));
  if (
    nextEntries.length !== store.entries.length ||
    nextPauses.length !== store.pauses.length ||
    nextPauses.some((pause, index) => pause !== store.pauses[index])
  ) {
    await saveSessionStore({ ...store, entries: nextEntries, pauses: nextPauses.filter(Boolean) });
  }
}

async function removeSessionPause(inputTabId) {
  const tabId = normalizeTabId(inputTabId);
  if (!tabId) return;
  const store = await loadSessionStore();
  const pauses = store.pauses.filter((pause) => pause.tabId !== tabId);
  if (pauses.length !== store.pauses.length) {
    await saveSessionStore({ ...store, pauses });
  }
}

async function clearAllSessionKeepAlives() {
  const store = await loadSessionStore();
  for (const entry of store.entries) {
    await ExtensionAPI.alarms.clear(sessionAlarmName(entry.tabId));
  }
  await saveSessionStore({ version: SESSION_STORE_VERSION, entries: [], presets: [], pauses: [] });
}

async function loadSessionStore() {
  const stored = await ExtensionAPI.storage.local.get(SESSION_STORAGE_KEY);
  return normalizeSessionStore(stored[SESSION_STORAGE_KEY]);
}

async function saveSessionStore(store) {
  const normalized = normalizeSessionStore(store);
  await ExtensionAPI.storage.local.set({ [SESSION_STORAGE_KEY]: normalized });
  return normalized;
}

function normalizeSessionStore(input) {
  const rawEntries = input && Array.isArray(input.entries) ? input.entries : [];
  const rawPresets = input && Array.isArray(input.presets) ? input.presets : [];
  const rawPauses = input && Array.isArray(input.pauses) ? input.pauses : [];
  const seenTabs = new Set();
  const seenPresetKeys = new Set();
  const seenPauseTabs = new Set();
  const entries = [];
  const presets = [];
  const pauses = [];
  for (const rawEntry of rawEntries) {
    const entry = normalizeSessionEntry(rawEntry);
    if (!entry || seenTabs.has(entry.tabId)) continue;
    seenTabs.add(entry.tabId);
    entries.push(entry);
    if (entries.length >= MAX_SESSION_TABS) break;
  }
  for (const rawPreset of rawPresets) {
    const preset = normalizeSessionPreset(rawPreset);
    const key = preset && sessionPresetKey(preset);
    if (!preset || !key || seenPresetKeys.has(key)) continue;
    seenPresetKeys.add(key);
    presets.push(preset);
    if (presets.length >= MAX_SESSION_PRESETS) break;
  }
  for (const rawPause of rawPauses) {
    const pause = normalizeSessionPause(rawPause);
    if (!pause || seenPauseTabs.has(pause.tabId)) continue;
    seenPauseTabs.add(pause.tabId);
    pauses.push(pause);
    if (pauses.length >= MAX_SESSION_TABS) break;
  }
  return { version: SESSION_STORE_VERSION, entries, presets, pauses };
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
    automatic: input.automatic === true,
    sourcePresetKey: input.automatic === true
      ? cleanSessionText(input.sourcePresetKey, 120) || null
      : null,
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
  const legacyOrigin = normalizeHttpsOrigin(input.origin);
  const scope = SESSION_PRESET_SCOPES.has(input.scope)
    ? input.scope
    : legacyOrigin
      ? "exact"
      : "";
  if (!scope) return null;
  let pattern = "";
  if (scope === "exact") {
    pattern = normalizeHttpsOrigin(input.pattern || legacyOrigin);
  } else if (scope === "global") {
    pattern = "*";
  } else {
    pattern = normalizeSessionHostnamePattern(input.pattern);
  }
  const intervalMinutes = Number(input.intervalMinutes);
  if (!pattern || !SESSION_INTERVALS.has(intervalMinutes)) return null;
  const mode = normalizeSessionMode(input.mode);
  let targetPath = "";
  if (mode !== "activity") {
    try {
      const validationOrigin = scope === "exact"
        ? pattern
        : scope === "global"
          ? "https://example.invalid"
          : `https://${pattern}`;
      targetPath = normalizeSessionTargetPath(input.targetPath, validationOrigin);
    } catch (_error) {
      return null;
    }
  }
  const excludedHosts = scope === "exact"
    ? []
    : normalizeSessionExcludedHosts(input.excludedHosts);
  return {
    scope,
    pattern,
    name: cleanSessionText(input.name, 80) || sessionPresetDefaultName(scope, pattern),
    autoStart: input.autoStart === true,
    excludedHosts,
    intervalMinutes,
    targetPath,
    mode,
    createdAt: normalizeSessionTimestamp(input.createdAt),
    updatedAt: normalizeSessionTimestamp(input.updatedAt)
  };
}

function normalizeSessionPause(input) {
  if (!input || typeof input !== "object") return null;
  const tabId = normalizeTabId(input.tabId);
  const origin = normalizeHttpsOrigin(input.origin);
  const presetKey = cleanSessionText(input.presetKey, 120);
  if (!tabId || !origin || !presetKey) return null;
  return {
    tabId,
    origin,
    presetKey,
    createdAt: normalizeSessionTimestamp(input.createdAt)
  };
}

function findExactSessionPreset(store, origin) {
  const key = sessionPresetKey({ scope: "exact", pattern: origin });
  return store.presets.find((preset) => sessionPresetKey(preset) === key) || null;
}

function findEffectiveSessionPreset(store, tabInfo) {
  if (!store || !Array.isArray(store.presets) || !tabInfo) return null;
  return store.presets
    .filter((preset) => sessionPresetMatchesTab(preset, tabInfo))
    .sort(compareSessionPresetSpecificity)[0] || null;
}

function findSessionPause(store, tabId, origin, preset) {
  if (!preset) return null;
  const presetKey = sessionPresetKey(preset);
  return store.pauses.find((pause) => (
    pause.tabId === tabId &&
    pause.origin === origin &&
    pause.presetKey === presetKey
  )) || null;
}

function createSessionView(entry, tabInfo, alarm, preset, matchedPreset, pause) {
  const selectedSettings = entry || preset || matchedPreset;
  return {
    supported: true,
    enabled: Boolean(entry),
    hostname: tabInfo.hostname,
    origin: tabInfo.origin,
    intervalMinutes: selectedSettings ? selectedSettings.intervalMinutes : 10,
    targetPath: selectedSettings ? selectedSettings.targetPath : "",
    mode: selectedSettings ? selectedSettings.mode : "activity",
    preset: sessionPresetSummary(preset),
    matchedPreset: sessionPresetSummary(matchedPreset),
    automatic: Boolean(entry && entry.automatic),
    automaticManaged: Boolean(matchedPreset && matchedPreset.autoStart),
    autoPaused: Boolean(pause),
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
    matchedPreset: null,
    automatic: false,
    automaticManaged: false,
    autoPaused: false,
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

function sessionPresetKey(preset) {
  if (!preset || !SESSION_PRESET_SCOPES.has(preset.scope)) return "";
  return `${preset.scope}|${String(preset.pattern || "").toLowerCase()}`;
}

function sessionPresetSummary(preset) {
  if (!preset) return null;
  return {
    key: sessionPresetKey(preset),
    name: preset.name,
    scope: preset.scope,
    pattern: preset.pattern,
    displayPattern: sessionPresetDisplayPattern(preset),
    autoStart: preset.autoStart,
    excludedHosts: [...preset.excludedHosts],
    intervalMinutes: preset.intervalMinutes,
    targetPath: preset.targetPath,
    mode: preset.mode,
    updatedAt: preset.updatedAt
  };
}

function sessionPresetDisplayPattern(preset) {
  if (!preset) return "";
  if (preset.scope === "global") return "All HTTPS sites";
  if (preset.scope === "subdomains") return `*.${preset.pattern}`;
  if (preset.scope === "domain") return `${preset.pattern} + subdomains`;
  return preset.pattern;
}

function sessionPresetDefaultName(scope, pattern) {
  if (scope === "global") return "All HTTPS sites";
  if (scope === "subdomains") return `Subdomains of ${pattern}`;
  if (scope === "domain") return pattern;
  try {
    return new URL(pattern).hostname;
  } catch (_error) {
    return pattern;
  }
}

function normalizeSessionHostnamePattern(value) {
  let raw = cleanSessionText(value, 253).toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("*.")) raw = raw.slice(2);
  if (raw.includes("://")) {
    try {
      raw = new URL(raw).hostname.toLowerCase();
    } catch (_error) {
      return "";
    }
  }
  raw = raw.replace(/\.$/, "");
  if (
    !raw ||
    raw.length > 253 ||
    raw.includes("/") ||
    raw.includes(":") ||
    !/^[a-z0-9.-]+$/.test(raw) ||
    raw.startsWith(".") ||
    raw.includes("..")
  ) {
    return "";
  }
  const labels = raw.split(".");
  if (labels.some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    return "";
  }
  return raw;
}

function normalizeSessionExcludedHosts(input) {
  const rawItems = Array.isArray(input)
    ? input
    : String(input == null ? "" : input).split(/[\n,]+/);
  const seen = new Set();
  const excludedHosts = [];
  for (const rawItem of rawItems) {
    let raw = cleanSessionText(rawItem, 255).toLowerCase();
    if (!raw) continue;
    const wildcard = raw.startsWith("*.");
    if (wildcard) raw = raw.slice(2);
    const hostname = normalizeSessionHostnamePattern(raw);
    if (!hostname) continue;
    const normalized = wildcard ? `*.${hostname}` : hostname;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    excludedHosts.push(normalized);
    if (excludedHosts.length >= 50) break;
  }
  return excludedHosts;
}

function sessionPresetMatchesTab(preset, tabInfo) {
  if (!preset || !tabInfo || !tabInfo.origin || !tabInfo.hostname) return false;
  const hostname = tabInfo.hostname.toLowerCase();
  let matches = false;
  if (preset.scope === "exact") {
    matches = preset.pattern === tabInfo.origin;
  } else if (preset.scope === "domain") {
    matches = hostname === preset.pattern || hostname.endsWith(`.${preset.pattern}`);
  } else if (preset.scope === "subdomains") {
    matches = hostname !== preset.pattern && hostname.endsWith(`.${preset.pattern}`);
  } else if (preset.scope === "global") {
    matches = true;
  }
  if (!matches) return false;
  return !preset.excludedHosts.some((excluded) => {
    if (excluded.startsWith("*.")) {
      const base = excluded.slice(2);
      return hostname !== base && hostname.endsWith(`.${base}`);
    }
    return hostname === excluded;
  });
}

function compareSessionPresetSpecificity(left, right) {
  const scopeRank = {
    exact: 4,
    subdomains: 3,
    domain: 2,
    global: 1
  };
  const rankDifference = (scopeRank[right.scope] || 0) - (scopeRank[left.scope] || 0);
  if (left.scope === "exact" || right.scope === "exact" || left.scope === "global" || right.scope === "global") {
    if (rankDifference) return rankDifference;
  }
  const leftPatternLength = left.pattern === "*" ? 0 : left.pattern.length;
  const rightPatternLength = right.pattern === "*" ? 0 : right.pattern.length;
  if (leftPatternLength !== rightPatternLength) return rightPatternLength - leftPatternLength;
  if (rankDifference) return rankDifference;
  return sessionPresetKey(left).localeCompare(sessionPresetKey(right));
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
  return ["enabled", "settings", "scheduled", "manual", "automatic"].includes(value)
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
    ExtensionAPI.declarativeNetRequest.getDynamicRules(),
    ExtensionAPI.declarativeNetRequest.getSessionRules()
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
    ExtensionAPI.declarativeNetRequest.getDynamicRules(),
    ExtensionAPI.declarativeNetRequest.getSessionRules()
  ]);
  try {
    await replaceRuleSets(
      existingDynamic,
      existingSession,
      compiled.dynamicRules,
      compiled.sessionRules
    );
  } catch (error) {
    await recordFailureSafely(current, `${BrowserName} DNR`, `${BrowserName} rejected the rule deployment.`, friendlyError(error));
    throw new Error(`${BrowserName} rejected the rule deployment: ${friendlyError(error)}`);
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
      throw new Error(`Local state could not be saved, and ${BrowserName} could not restore the prior rules: ${friendlyError(rollbackError)}`);
    }
    throw new Error(`Local state could not be saved. The previous ${BrowserName} rules were restored: ${friendlyError(error)}`);
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
    const result = await ExtensionAPI.declarativeNetRequest.isRegexSupported({
      regex: rule.condition.regexFilter,
      isCaseSensitive: rule.condition.isUrlFilterCaseSensitive === true,
      requireCapturing: false
    });
    if (!result.isSupported) {
      const reason = result.reason ? ` (${result.reason})` : "";
      const error = new Error(`Regular expression in DNR rule ${rule.id} is not supported by ${BrowserName}${reason}.`);
      error.name = "ValidationError";
      throw error;
    }
  }
}

async function replaceDynamicRules(existing, nextRules) {
  const removeRuleIds = existing.map((rule) => rule.id);
  if (removeRuleIds.length === 0 && nextRules.length === 0) return;
  await ExtensionAPI.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: nextRules
  });
}

async function replaceSessionRules(existing, nextRules) {
  const removeRuleIds = existing.map((rule) => rule.id);
  if (removeRuleIds.length === 0 && nextRules.length === 0) return;
  await ExtensionAPI.declarativeNetRequest.updateSessionRules({
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
  const stored = await ExtensionAPI.storage.local.get(STORAGE_KEY);
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
  const previousSession = await ExtensionAPI.storage.session.get(SESSION_HEADER_VALUES_KEY);
  await ExtensionAPI.storage.session.set({ [SESSION_HEADER_VALUES_KEY]: nextSessionStore });
  try {
    await ExtensionAPI.storage.local.set({ [STORAGE_KEY]: localState });
  } catch (error) {
    try {
      if (previousSession[SESSION_HEADER_VALUES_KEY] === undefined) {
        await ExtensionAPI.storage.session.remove(SESSION_HEADER_VALUES_KEY);
      } else {
        await ExtensionAPI.storage.session.set({
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
  const stored = await ExtensionAPI.storage.session.get(SESSION_HEADER_VALUES_KEY);
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
  if (ExtensionAPI.storage.local.setAccessLevel) {
    await ExtensionAPI.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  }
  if (ExtensionAPI.storage.session.setAccessLevel) {
    await ExtensionAPI.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  }
}

async function getRuntime(state) {
  const [dynamicRules, sessionRules, storageBytes, sessionStorageBytes] = await Promise.all([
    ExtensionAPI.declarativeNetRequest.getDynamicRules(),
    ExtensionAPI.declarativeNetRequest.getSessionRules(),
    ExtensionAPI.storage.local.getBytesInUse(null),
    ExtensionAPI.storage.session.getBytesInUse(null)
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
      ExtensionAPI.declarativeNetRequest.getDynamicRules(),
      ExtensionAPI.declarativeNetRequest.getSessionRules()
    ]);
    count = new Set([
      ...dynamicRules.map((rule) => rule.id),
      ...sessionRules.map((rule) => rule.id)
    ]).size;
  }
  const enabled = state.extensionEnabled;
  await Promise.all([
    ExtensionAPI.action.setBadgeText({ text: enabled ? (count > 0 ? String(Math.min(count, 999)) : "ON") : "OFF" }),
    ExtensionAPI.action.setBadgeBackgroundColor({ color: enabled ? "#4f46e5" : "#64748b" }),
    ExtensionAPI.action.setTitle({
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
