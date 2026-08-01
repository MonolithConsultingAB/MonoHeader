"use strict";

const ExtensionAPI = globalThis.MonoHeaderAPI || globalThis.browser || globalThis.chrome;
const BrowserName = globalThis.MonoHeaderPlatform && globalThis.MonoHeaderPlatform.browserName || "Browser";

const PopupCore = globalThis.MonoHeaderCore;
const SESSION_STORAGE_KEY = "monoHeaderSessionKeepAlive";
const POPUP_MESSAGE_TIMEOUT_MS = 6000;
let sessionCountdownTimer = null;
let sessionRefreshQueue = Promise.resolve();
let diagnosticCopyTimer = null;
const popupState = {
  state: null,
  runtime: null,
  busy: false,
  sessionBusy: false,
  currentTab: null,
  sessionKeepAlive: null,
  sessionInterval: 10,
  sessionTargetPath: "",
  sessionMode: "activity",
  sessionPresetNotice: "",
  sessionPending: null,
  sessionAction: "",
  sessionDiagnostic: null,
  sessionDiagnosticsOpen: false,
  pendingRule: null
};

document.addEventListener("DOMContentLoaded", initializePopup);

async function initializePopup() {
  document.getElementById("popup-version").textContent = PopupCore.APP_VERSION;
  document.getElementById("power-toggle").addEventListener("change", togglePower);
  document.getElementById("profile-select").addEventListener("change", switchProfile);
  document.getElementById("quick-header-form").addEventListener("submit", quickAddHeader);
  document.getElementById("quick-header-session-only").addEventListener("change", updateQuickValueLifetime);
  document.getElementById("session-toggle").addEventListener("change", toggleSessionKeepAlive);
  document.getElementById("session-mode").addEventListener("change", changeSessionMode);
  document.getElementById("session-interval").addEventListener("change", changeSessionInterval);
  document.getElementById("session-target-path").addEventListener("change", changeSessionTargetPath);
  document.getElementById("session-preset-save").addEventListener("click", saveSessionPreset);
  document.getElementById("session-preset-delete").addEventListener("click", deleteSessionPreset);
  document.getElementById("session-auto-rule-disable").addEventListener("click", disableSessionAutoRule);
  document.getElementById("session-auto-rule-manage").addEventListener("click", openKeepAliveWorkspace);
  document.getElementById("session-test-button").addEventListener("click", testSessionKeepAlive);
  document.getElementById("session-reset-button").addEventListener("click", resetSessionKeepAlive);
  document.getElementById("session-diagnostics-button").addEventListener("click", toggleSessionDiagnostics);
  document.getElementById("session-copy-diagnostics").addEventListener("click", copySessionDiagnostics);
  document.getElementById("open-dashboard").addEventListener("click", () => ExtensionAPI.runtime.openOptionsPage());
  ExtensionAPI.storage.onChanged.addListener(handleSessionStorageChange);
  window.addEventListener("pagehide", stopSessionCountdown);
  try {
    const response = await popupMessage("GET_STATE");
    popupState.state = PopupCore.normalizeState(response.state);
    popupState.runtime = response.runtime;
    popupState.sessionKeepAlive = unsupportedSessionState("Checking session keep-alive status…");
    renderPopup();
    startSessionCountdown();
    await loadSessionContext();
    renderSessionKeepAlive();
  } catch (error) {
    showPopupLoadFailure(error.message);
  }
}

function renderPopup() {
  const state = popupState.state;
  const profile = PopupCore.getActiveProfile(state);
  const enabledRules = profile ? profile.rules.filter((rule) => rule.enabled) : [];
  const modifications = enabledRules.reduce((count, rule) => count + rule.modifications.length, 0);
  document.getElementById("loading-state").hidden = true;
  document.getElementById("popup-content").hidden = false;
  document.getElementById("power-toggle").checked = state.extensionEnabled;
  document.getElementById("power-toggle").disabled = popupState.busy;
  document.getElementById("power-title").textContent = state.extensionEnabled ? "MonoHeader enabled" : "MonoHeader paused";
  document.getElementById("power-description").textContent = state.extensionEnabled
    ? `${popupState.runtime.deployedRuleCount} rule${popupState.runtime.deployedRuleCount === 1 ? "" : "s"} active in ${BrowserName}.`
    : "No header rules are currently applied.";
  document.getElementById("active-rule-count").textContent = state.extensionEnabled ? enabledRules.length : 0;
  document.getElementById("header-change-count").textContent = state.extensionEnabled ? modifications : 0;
  renderActiveRules(profile ? profile.rules : [], profile, state.extensionEnabled);

  const select = document.getElementById("profile-select");
  select.replaceChildren(...state.profiles.map((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.name} (${item.rules.filter((rule) => rule.enabled).length})`;
    option.selected = item.id === state.activeProfileId;
    return option;
  }));
  select.disabled = popupState.busy;
  document.getElementById("quick-header-name").disabled = popupState.busy;
  document.getElementById("quick-header-value").disabled = popupState.busy;
  document.getElementById("quick-header-session-only").disabled = popupState.busy;
  const quickButton = document.getElementById("quick-add-button");
  quickButton.disabled = popupState.busy;
  quickButton.textContent = popupState.busy
    ? "Applying…"
    : (state.extensionEnabled ? "Add & apply" : "Save header");
  document.getElementById("quick-scope-copy").textContent = state.extensionEnabled
    ? "Creates a global Set rule and applies it immediately."
    : "MonoHeader is paused; this will be saved and applied when enabled.";
  renderSessionKeepAlive();
}

async function loadSessionContext() {
  try {
    const tabs = await ExtensionAPI.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    popupState.currentTab = tab && Number.isInteger(tab.id)
      ? { id: tab.id, url: String(tab.url || "") }
      : null;
    if (!popupState.currentTab) {
      popupState.sessionKeepAlive = unsupportedSessionState("No active website tab is available.");
      return;
    }
    const response = await popupMessage("GET_SESSION_KEEP_ALIVE", {
      tabId: popupState.currentTab.id
    });
    popupState.sessionKeepAlive = response.sessionKeepAlive;
    popupState.sessionInterval = response.sessionKeepAlive.intervalMinutes || 10;
    popupState.sessionTargetPath = response.sessionKeepAlive.targetPath || "";
    popupState.sessionMode = response.sessionKeepAlive.mode || "activity";
  } catch (error) {
    popupState.sessionKeepAlive = unsupportedSessionState(error.message);
  }
}

function renderSessionKeepAlive() {
  const session = popupState.sessionKeepAlive || unsupportedSessionState("Session status is unavailable.");
  const pendingEnabled = popupState.sessionPending;
  const displayedEnabled = pendingEnabled == null ? session.enabled : pendingEnabled;
  const toggle = document.getElementById("session-toggle");
  const mode = document.getElementById("session-mode");
  const interval = document.getElementById("session-interval");
  const targetPathLabel = document.getElementById("session-target-path-label");
  const targetPath = document.getElementById("session-target-path");
  const site = document.getElementById("session-site");
  const status = document.getElementById("session-status");
  const disclosure = document.getElementById("session-disclosure");
  const lastLabel = document.getElementById("session-last-label");
  const testButton = document.getElementById("session-test-button");
  const resetButton = document.getElementById("session-reset-button");
  const diagnosticsButton = document.getElementById("session-diagnostics-button");
  const copyDiagnosticsButton = document.getElementById("session-copy-diagnostics");
  const presetStatus = document.getElementById("session-preset-status");
  const presetSave = document.getElementById("session-preset-save");
  const presetDelete = document.getElementById("session-preset-delete");
  const autoRule = document.getElementById("session-auto-rule");
  const autoRuleStatus = document.getElementById("session-auto-rule-status");
  const autoRuleDisable = document.getElementById("session-auto-rule-disable");
  const autoRuleManage = document.getElementById("session-auto-rule-manage");
  const presetMatches = sessionPresetMatchesControls(session.preset);

  toggle.checked = displayedEnabled;
  toggle.disabled = popupState.sessionBusy || !session.supported;
  mode.value = popupState.sessionMode;
  mode.disabled = popupState.sessionBusy || !session.supported;
  interval.value = String(popupState.sessionInterval);
  interval.disabled = popupState.sessionBusy || !session.supported;
  if (document.activeElement !== targetPath) {
    targetPath.value = popupState.sessionTargetPath;
  }
  const requestPathVisible = popupState.sessionMode !== "activity";
  targetPathLabel.hidden = !requestPathVisible;
  targetPath.hidden = !requestPathVisible;
  targetPath.disabled = popupState.sessionBusy || !session.supported || !requestPathVisible;
  testButton.disabled = popupState.sessionBusy || !session.supported;
  resetButton.disabled = popupState.sessionBusy || !session.supported;
  diagnosticsButton.disabled = popupState.sessionBusy;
  copyDiagnosticsButton.disabled = popupState.sessionBusy;
  presetSave.disabled = popupState.sessionBusy || !session.supported || presetMatches;
  presetDelete.disabled = popupState.sessionBusy || !session.supported || !session.preset;
  presetSave.textContent = session.preset ? "Update preset" : "Save preset";
  const showAutoRule = Boolean(session.matchedPreset && session.automaticManaged);
  autoRule.hidden = !showAutoRule;
  autoRuleDisable.disabled = popupState.sessionBusy || !showAutoRule;
  autoRuleManage.disabled = popupState.sessionBusy;
  if (showAutoRule) {
    const matched = session.matchedPreset;
    autoRuleStatus.textContent = session.autoPaused
      ? `Paused for this tab · ${matched.name} · ${matched.displayPattern}`
      : `${matched.name} · ${matched.displayPattern}`;
  }
  presetStatus.className = "";
  if (popupState.sessionAction === "saving-preset") {
    presetStatus.textContent = "Saving this site preset…";
  } else if (popupState.sessionAction === "deleting-preset") {
    presetStatus.textContent = "Deleting this site preset…";
  } else if (popupState.sessionPresetNotice) {
    presetStatus.textContent = popupState.sessionPresetNotice;
    presetStatus.classList.add("is-saved");
  } else if (!session.supported) {
    presetStatus.textContent = "Available on HTTPS website tabs only.";
  } else if (!session.preset) {
    presetStatus.textContent = "No preset saved for this site.";
  } else if (presetMatches) {
    presetStatus.textContent = "Saved settings loaded for this site.";
    presetStatus.classList.add("is-saved");
  } else {
    presetStatus.textContent = "Current settings differ from the saved preset.";
    presetStatus.classList.add("is-dirty");
  }
  diagnosticsButton.setAttribute("aria-expanded", String(popupState.sessionDiagnosticsOpen));
  site.textContent = session.supported
    ? session.hostname
    : "Available on HTTPS website tabs only.";
  if (popupState.sessionMode === "activity") {
    disclosure.textContent = "Dispatches synthetic mousemove and click events to the document itself. It never selects or activates a page element, but sites may ignore untrusted events.";
    lastLabel.textContent = "Last pulse dispatched";
  } else if (popupState.sessionMode === "both") {
    disclosure.textContent = "Sends the configured same-origin GET and dispatches a synthetic document-level activity pulse. No page content or response body is read.";
    lastLabel.textContent = "Last combined check";
  } else {
    disclosure.textContent = "Sends one authenticated GET to this HTTPS site. Leave the path blank to request the current page. No page content or response body is read.";
    lastLabel.textContent = "Last request succeeded";
  }
  renderSessionTiming(session, displayedEnabled, pendingEnabled);
  renderSessionDiagnostics(session);

  status.className = "session-status";
  if (popupState.sessionAction === "testing") {
    status.textContent = popupState.sessionMode === "activity"
      ? "Testing one activity pulse without changing the schedule…"
      : popupState.sessionMode === "both"
        ? "Testing one request and activity pulse without changing the schedule…"
        : "Testing one request without changing the schedule…";
    status.classList.add("is-pending");
  } else if (popupState.sessionAction === "resetting") {
    status.textContent = "Stopping and resetting keep-alive for this tab…";
    status.classList.add("is-pending");
  } else if (pendingEnabled === true) {
    if (popupState.sessionMode === "activity") {
      status.textContent = "Dispatching a test activity pulse and scheduling keep-alive…";
    } else if (popupState.sessionMode === "both") {
      status.textContent = "Running a test request and activity pulse, then scheduling keep-alive…";
    } else {
      status.textContent = "Sending a test request and scheduling keep-alive…";
    }
    status.classList.add("is-pending");
  } else if (pendingEnabled === false) {
    status.textContent = "Stopping session keep-alive…";
    status.classList.add("is-pending");
  } else if (!session.supported) {
    status.textContent = session.lastError || "Open an HTTPS website to use this feature.";
  } else if (popupState.sessionDiagnostic) {
    status.textContent = describeSessionResult(
      popupState.sessionDiagnostic,
      popupState.sessionMode,
      "Manual test"
    );
    status.classList.add(sessionResultClass(popupState.sessionDiagnostic.status));
  } else if (!session.enabled) {
    status.textContent = session.autoPaused
      ? "Paused for this tab. Automatic keep-alive can resume after the tab leaves this site."
      : "Off. No keep-alive checks are running.";
  } else if (session.lastStatus === "success") {
    const http = session.lastHttpStatus ? ` · HTTP ${session.lastHttpStatus}` : "";
    if (session.mode === "activity") {
      status.textContent = "Latest synthetic activity pulse was dispatched.";
    } else if (session.mode === "both") {
      status.textContent = `Latest request and activity pulse completed${http}.`;
    } else {
      status.textContent = `Latest request succeeded${http}.`;
    }
    status.classList.add("is-success");
  } else if (session.lastStatus === "warning") {
    status.textContent = session.lastError || "The last request was redirected.";
    status.classList.add("is-warning");
  } else if (session.lastStatus === "error") {
    status.textContent = session.lastError || "The last keep-alive check failed.";
    status.classList.add("is-error");
  } else {
    status.textContent = "Keep-alive is scheduled.";
    status.classList.add("is-pending");
  }
}

function renderSessionDiagnostics(session) {
  const panel = document.getElementById("session-diagnostics");
  panel.hidden = !popupState.sessionDiagnosticsOpen;
  if (panel.hidden) return;

  const diagnostic = getCurrentSessionDiagnostic(session);
  setSessionDiagnosticText("session-diagnostic-state", session.enabled ? "On" : "Off");
  setSessionDiagnosticText(
    "session-diagnostic-scheduler",
    session.enabled
      ? session.alarmActive
        ? `Active · ${session.alarmPeriodMinutes || session.intervalMinutes} min`
        : "Missing alarm"
      : "Inactive"
  );
  setSessionDiagnosticText("session-diagnostic-origin", session.origin || "—");
  setSessionDiagnosticText("session-diagnostic-trigger", formatSessionTrigger(diagnostic.trigger));
  setSessionDiagnosticText("session-diagnostic-attempt", formatDiagnosticTime(diagnostic.attemptedAt));
  setSessionDiagnosticText("session-diagnostic-completed", formatDiagnosticTime(diagnostic.completedAt));
  setSessionDiagnosticText("session-diagnostic-result", formatDiagnosticResult(diagnostic));
  setSessionDiagnosticText("session-diagnostic-actions", formatDiagnosticActions(diagnostic));

  const error = document.getElementById("session-diagnostic-error");
  error.hidden = !diagnostic.error;
  error.textContent = diagnostic.error || "";
}

function getCurrentSessionDiagnostic(session) {
  return popupState.sessionDiagnostic || {
    mode: session.mode,
    trigger: session.lastTrigger,
    attemptedAt: session.lastAttemptAt,
    completedAt: session.lastCompletedAt,
    status: session.lastStatus,
    httpStatus: session.lastHttpStatus,
    requestSent: session.lastRequestSent,
    activitySent: session.lastActivitySent,
    redirected: session.lastRedirected,
    sameOrigin: session.lastSameOrigin,
    error: session.lastError
  };
}

function setSessionDiagnosticText(id, value) {
  document.getElementById(id).textContent = value;
}

function formatSessionTrigger(value) {
  return {
    enabled: "Enabled",
    settings: "Settings changed",
    scheduled: "Scheduled alarm",
    manual: "Manual test",
    automatic: "Automatic site rule"
  }[value] || "None";
}

function formatDiagnosticTime(value) {
  return value ? formatSessionTime(value) : "Not yet";
}

function formatDiagnosticResult(diagnostic) {
  if (!diagnostic || !["success", "warning", "error"].includes(diagnostic.status)) {
    return "No result";
  }
  const label = diagnostic.status[0].toUpperCase() + diagnostic.status.slice(1);
  const http = diagnostic.httpStatus ? ` · HTTP ${diagnostic.httpStatus}` : "";
  const redirect = diagnostic.redirected ? " · redirected" : "";
  return `${label}${http}${redirect}`;
}

function formatDiagnosticActions(diagnostic) {
  if (!diagnostic || !diagnostic.attemptedAt) return "None";
  const mode = diagnostic.mode || popupState.sessionMode;
  const actions = [];
  if (mode === "request" || mode === "both") {
    actions.push(diagnostic.requestSent ? "Request sent" : "Request not sent");
  }
  if (mode === "activity" || mode === "both") {
    actions.push(diagnostic.activitySent ? "Pulse dispatched" : "Pulse not dispatched");
  }
  return actions.join(" · ") || "None";
}

function describeSessionResult(diagnostic, mode, prefix) {
  if (diagnostic.status === "warning" || diagnostic.status === "error") {
    return `${prefix}: ${diagnostic.error || "the keep-alive check did not succeed."}`;
  }
  const http = diagnostic.httpStatus ? ` · HTTP ${diagnostic.httpStatus}` : "";
  if (mode === "activity") return `${prefix}: synthetic activity pulse dispatched.`;
  if (mode === "both") return `${prefix}: request and activity pulse completed${http}.`;
  return `${prefix}: request succeeded${http}.`;
}

function sessionResultClass(status) {
  if (status === "success") return "is-success";
  if (status === "warning") return "is-warning";
  if (status === "error") return "is-error";
  return "is-pending";
}

function renderSessionTiming(session, displayedEnabled, pendingEnabled) {
  const lastSuccess = document.getElementById("session-last-success");
  if (session.lastSuccessAt) {
    lastSuccess.textContent = formatSessionTime(session.lastSuccessAt);
    lastSuccess.dateTime = session.lastSuccessAt;
    lastSuccess.title = new Date(session.lastSuccessAt).toLocaleString();
  } else {
    lastSuccess.textContent = "Not yet";
    lastSuccess.removeAttribute("datetime");
    lastSuccess.removeAttribute("title");
  }

  const nextCheck = document.getElementById("session-next-check");
  if (session.nextCheckAt) {
    nextCheck.dateTime = session.nextCheckAt;
    nextCheck.title = `Scheduled for ${new Date(session.nextCheckAt).toLocaleString()}`;
  } else {
    nextCheck.removeAttribute("datetime");
    nextCheck.removeAttribute("title");
  }
  if (pendingEnabled === true) {
    nextCheck.textContent = "Scheduling…";
  } else if (pendingEnabled === false) {
    nextCheck.textContent = "Stopping…";
  } else if (!session.supported || !displayedEnabled) {
    nextCheck.textContent = "Off";
  } else {
    updateSessionCountdown();
  }
}

function startSessionCountdown() {
  if (sessionCountdownTimer) return;
  updateSessionCountdown();
  sessionCountdownTimer = window.setInterval(updateSessionCountdown, 1000);
}

function stopSessionCountdown() {
  if (!sessionCountdownTimer) return;
  window.clearInterval(sessionCountdownTimer);
  sessionCountdownTimer = null;
}

function updateSessionCountdown() {
  const element = document.getElementById("session-next-check");
  const session = popupState.sessionKeepAlive;
  if (!element || !session || !session.supported || !session.enabled || popupState.sessionPending === false) {
    if (element) element.textContent = "Off";
    return;
  }
  if (popupState.sessionPending === true || !session.nextCheckAt) {
    element.textContent = "Scheduling…";
    return;
  }
  const remainingMs = Date.parse(session.nextCheckAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    element.textContent = "Checking now…";
    return;
  }
  element.textContent = formatCountdown(remainingMs);
}

function formatCountdown(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function handleSessionStorageChange(changes, areaName) {
  if (areaName !== "local" || !changes || !changes[SESSION_STORAGE_KEY]) return;
  sessionRefreshQueue = sessionRefreshQueue
    .then(refreshSessionStatus)
    .catch((error) => showPopupError(error.message));
}

async function refreshSessionStatus() {
  if (popupState.sessionBusy || !popupState.currentTab) return;
  const response = await popupMessage("GET_SESSION_KEEP_ALIVE", {
    tabId: popupState.currentTab.id
  });
  if (popupState.sessionBusy) return;
  popupState.sessionKeepAlive = response.sessionKeepAlive;
  popupState.sessionInterval = response.sessionKeepAlive.intervalMinutes || popupState.sessionInterval;
  popupState.sessionTargetPath = response.sessionKeepAlive.targetPath || "";
  popupState.sessionMode = response.sessionKeepAlive.mode || "activity";
  popupState.sessionDiagnostic = null;
  renderSessionKeepAlive();
}

async function toggleSessionKeepAlive(event) {
  await updateSessionKeepAlive(event.target.checked);
}

async function changeSessionMode(event) {
  popupState.sessionMode = event.target.value;
  if (popupState.sessionMode === "activity") popupState.sessionTargetPath = "";
  popupState.sessionDiagnostic = null;
  popupState.sessionPresetNotice = "";
  if (popupState.sessionKeepAlive && popupState.sessionKeepAlive.enabled) {
    await updateSessionKeepAlive(true);
  } else {
    renderSessionKeepAlive();
  }
}

async function changeSessionInterval(event) {
  popupState.sessionInterval = Number(event.target.value);
  popupState.sessionDiagnostic = null;
  popupState.sessionPresetNotice = "";
  if (popupState.sessionKeepAlive && popupState.sessionKeepAlive.enabled) {
    await updateSessionKeepAlive(true);
  } else {
    renderSessionKeepAlive();
  }
}

async function changeSessionTargetPath(event) {
  popupState.sessionTargetPath = event.target.value.trim();
  popupState.sessionDiagnostic = null;
  popupState.sessionPresetNotice = "";
  if (popupState.sessionKeepAlive && popupState.sessionKeepAlive.enabled) {
    await updateSessionKeepAlive(true);
  } else {
    renderSessionKeepAlive();
  }
}

function sessionPresetMatchesControls(preset) {
  return Boolean(
    preset &&
    preset.mode === popupState.sessionMode &&
    preset.intervalMinutes === popupState.sessionInterval &&
    preset.targetPath === popupState.sessionTargetPath
  );
}

async function saveSessionPreset() {
  if (popupState.sessionBusy || !popupState.currentTab) return;
  const targetPath = document.getElementById("session-target-path").value.trim();
  popupState.sessionTargetPath = targetPath;
  popupState.sessionBusy = true;
  popupState.sessionAction = "saving-preset";
  popupState.sessionPresetNotice = "";
  clearPopupError();
  renderPopup();
  try {
    const response = await popupMessage("SAVE_SESSION_KEEP_ALIVE_PRESET", {
      tabId: popupState.currentTab.id,
      intervalMinutes: popupState.sessionInterval,
      targetPath,
      mode: popupState.sessionMode
    });
    popupState.sessionKeepAlive = response.sessionKeepAlive;
    popupState.sessionInterval = response.sessionKeepAlive.preset.intervalMinutes;
    popupState.sessionTargetPath = response.sessionKeepAlive.preset.targetPath;
    popupState.sessionMode = response.sessionKeepAlive.preset.mode;
    popupState.sessionPresetNotice = "Preset saved for this site.";
  } catch (error) {
    showPopupError(error.message);
  } finally {
    popupState.sessionBusy = false;
    popupState.sessionAction = "";
    renderPopup();
  }
}

async function deleteSessionPreset() {
  if (popupState.sessionBusy || !popupState.currentTab) return;
  popupState.sessionBusy = true;
  popupState.sessionAction = "deleting-preset";
  popupState.sessionPresetNotice = "";
  clearPopupError();
  renderPopup();
  try {
    const response = await popupMessage("DELETE_SESSION_KEEP_ALIVE_PRESET", {
      tabId: popupState.currentTab.id
    });
    popupState.sessionKeepAlive = response.sessionKeepAlive;
    popupState.sessionPresetNotice = "Preset deleted. Current tab settings were kept.";
  } catch (error) {
    showPopupError(error.message);
  } finally {
    popupState.sessionBusy = false;
    popupState.sessionAction = "";
    renderPopup();
  }
}

async function disableSessionAutoRule() {
  const session = popupState.sessionKeepAlive;
  if (
    popupState.sessionBusy ||
    !popupState.currentTab ||
    !session ||
    !session.matchedPreset
  ) return;
  popupState.sessionBusy = true;
  popupState.sessionAction = "disabling";
  clearPopupError();
  renderPopup();
  try {
    const response = await popupMessage("SET_SESSION_KEEP_ALIVE_PRESET_AUTO_START", {
      presetKey: session.matchedPreset.key,
      enabled: false,
      tabId: popupState.currentTab.id
    });
    popupState.sessionKeepAlive = response.sessionKeepAlive;
    popupState.sessionPresetNotice = "Automatic start disabled. The site rule remains saved.";
  } catch (error) {
    showPopupError(error.message);
  } finally {
    popupState.sessionBusy = false;
    popupState.sessionAction = "";
    renderPopup();
  }
}

function openKeepAliveWorkspace() {
  ExtensionAPI.tabs.create({ url: ExtensionAPI.runtime.getURL("app.html#keepalive") });
}

async function updateSessionKeepAlive(enabled) {
  if (popupState.sessionBusy || !popupState.currentTab) return;
  popupState.sessionBusy = true;
  popupState.sessionPending = enabled;
  popupState.sessionAction = enabled ? "enabling" : "disabling";
  popupState.sessionDiagnostic = null;
  clearPopupError();
  renderPopup();
  try {
    const response = await popupMessage("SET_SESSION_KEEP_ALIVE", {
      tabId: popupState.currentTab.id,
      enabled,
      intervalMinutes: popupState.sessionInterval,
      targetPath: popupState.sessionTargetPath,
      mode: popupState.sessionMode
    });
    popupState.sessionKeepAlive = response.sessionKeepAlive;
    popupState.sessionInterval = response.sessionKeepAlive.intervalMinutes || popupState.sessionInterval;
    popupState.sessionTargetPath = response.sessionKeepAlive.targetPath || "";
    popupState.sessionMode = response.sessionKeepAlive.mode || "activity";
  } catch (error) {
    showPopupError(error.message);
  } finally {
    popupState.sessionBusy = false;
    popupState.sessionPending = null;
    popupState.sessionAction = "";
    renderPopup();
  }
}

async function testSessionKeepAlive() {
  if (popupState.sessionBusy || !popupState.currentTab) return;
  const targetPath = document.getElementById("session-target-path").value.trim();
  popupState.sessionTargetPath = targetPath;
  popupState.sessionBusy = true;
  popupState.sessionAction = "testing";
  popupState.sessionDiagnostic = null;
  clearPopupError();
  renderPopup();
  try {
    const response = await popupMessage("TEST_SESSION_KEEP_ALIVE", {
      tabId: popupState.currentTab.id,
      targetPath,
      mode: popupState.sessionMode
    });
    popupState.sessionKeepAlive = response.sessionKeepAlive;
    popupState.sessionDiagnostic = response.sessionDiagnostic;
  } catch (error) {
    showPopupError(error.message);
  } finally {
    popupState.sessionBusy = false;
    popupState.sessionAction = "";
    renderPopup();
  }
}

async function resetSessionKeepAlive() {
  if (popupState.sessionBusy || !popupState.currentTab) return;
  popupState.sessionBusy = true;
  popupState.sessionAction = "resetting";
  clearPopupError();
  renderPopup();
  try {
    const response = await popupMessage("RESET_SESSION_KEEP_ALIVE", {
      tabId: popupState.currentTab.id
    });
    popupState.sessionKeepAlive = response.sessionKeepAlive;
    popupState.sessionInterval = response.sessionKeepAlive.intervalMinutes || 10;
    popupState.sessionTargetPath = response.sessionKeepAlive.targetPath || "";
    popupState.sessionMode = response.sessionKeepAlive.mode || "activity";
    popupState.sessionDiagnostic = null;
  } catch (error) {
    showPopupError(error.message);
  } finally {
    popupState.sessionBusy = false;
    popupState.sessionAction = "";
    renderPopup();
  }
}

function toggleSessionDiagnostics() {
  popupState.sessionDiagnosticsOpen = !popupState.sessionDiagnosticsOpen;
  renderSessionKeepAlive();
}

async function copySessionDiagnostics() {
  const button = document.getElementById("session-copy-diagnostics");
  try {
    const report = createSessionDiagnosticReport(
      popupState.sessionKeepAlive || unsupportedSessionState("Session status is unavailable.")
    );
    await navigator.clipboard.writeText(report);
    button.textContent = "Copied";
    if (diagnosticCopyTimer) window.clearTimeout(diagnosticCopyTimer);
    diagnosticCopyTimer = window.setTimeout(() => {
      button.textContent = "Copy report";
      diagnosticCopyTimer = null;
    }, 1600);
  } catch (_error) {
    showPopupError("The diagnostic report could not be copied.");
  }
}

function createSessionDiagnosticReport(session) {
  const diagnostic = getCurrentSessionDiagnostic(session);
  return [
    `MonoHeader ${PopupCore.APP_VERSION} keep-alive diagnostics`,
    `Generated: ${new Date().toISOString()}`,
    `State: ${session.enabled ? "On" : "Off"}`,
    `Scheduler: ${session.enabled
      ? session.alarmActive
        ? `Active (${session.alarmPeriodMinutes || session.intervalMinutes} minutes)`
        : "Missing alarm"
      : "Inactive"}`,
    `Origin: ${session.origin || "Unavailable"}`,
    `Method: ${formatSessionMode(diagnostic.mode || session.mode)}`,
    `Last trigger: ${formatSessionTrigger(diagnostic.trigger)}`,
    `Attempted: ${diagnostic.attemptedAt || "Not yet"}`,
    `Completed: ${diagnostic.completedAt || "Not yet"}`,
    `Result: ${formatDiagnosticResult(diagnostic)}`,
    `Actions: ${formatDiagnosticActions(diagnostic)}`,
    `Same origin: ${diagnostic.sameOrigin == null ? "Unknown" : diagnostic.sameOrigin ? "Yes" : "No"}`,
    `Error: ${diagnostic.error || "None"}`,
    "Privacy: metadata only; cookies, page content, response bodies, and configured request paths are excluded."
  ].join("\n");
}

function formatSessionMode(mode) {
  return {
    activity: "Activity pulse",
    request: "Request path",
    both: "Request + pulse"
  }[mode] || "Unknown";
}

function unsupportedSessionState(message) {
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
    lastError: message || "",
    alarmActive: false,
    alarmPeriodMinutes: null,
    nextCheckAt: null
  };
}

function formatSessionTime(value) {
  if (!value) return "not yet";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "short",
      timeStyle: "short"
    }).format(new Date(value));
  } catch (_error) {
    return value;
  }
}

function renderActiveRules(rules, profile, extensionEnabled) {
  const list = document.getElementById("active-rule-list");
  const context = document.getElementById("active-rules-context");
  const badge = document.getElementById("active-rules-badge");
  const enabledCount = rules.filter((rule) => rule.enabled).length;
  badge.textContent = `${enabledCount}/${rules.length}`;
  context.textContent = extensionEnabled
    ? `${enabledCount} active in ${profile ? profile.name : "this profile"}`
    : `${enabledCount} enabled · MonoHeader paused`;

  if (rules.length === 0) {
    list.replaceChildren(createActiveRulesEmpty("This profile has no rules."));
    return;
  }
  list.replaceChildren(...rules.map(createActiveRuleItem));
}

function createActiveRuleItem(rule) {
  const pending = popupState.pendingRule && popupState.pendingRule.ruleId === rule.id
    ? popupState.pendingRule.enabled
    : null;
  const displayedEnabled = pending == null ? rule.enabled : pending;
  const item = document.createElement("article");
  item.className = `active-rule-item${displayedEnabled ? "" : " is-disabled"}${pending == null ? "" : " is-pending"}`;
  item.setAttribute("role", "listitem");

  const heading = document.createElement("div");
  heading.className = "active-rule-item-heading";
  const name = document.createElement("strong");
  name.textContent = rule.name;
  name.title = rule.name;
  const actions = document.createElement("div");
  actions.className = "active-rule-item-actions";
  const priority = document.createElement("span");
  priority.className = "active-rule-priority";
  priority.textContent = `Priority ${rule.priority}`;
  const status = document.createElement("span");
  status.className = `active-rule-state${displayedEnabled ? " is-on" : ""}`;
  status.textContent = displayedEnabled ? "On" : "Off";
  const toggle = document.createElement("label");
  toggle.className = "switch rule-switch";
  toggle.title = `${displayedEnabled ? "Disable" : "Enable"} ${rule.name}`;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = displayedEnabled;
  input.disabled = popupState.busy;
  input.setAttribute("role", "switch");
  input.setAttribute("aria-label", `Enable rule ${rule.name}`);
  input.addEventListener("change", (event) => toggleRule(rule.id, event.target.checked));
  const track = document.createElement("span");
  track.className = "switch-track";
  track.setAttribute("aria-hidden", "true");
  toggle.append(input, track);
  actions.append(priority, status, toggle);
  heading.append(name, actions);

  const scope = document.createElement("div");
  scope.className = "active-rule-scope";
  const scopeType = document.createElement("span");
  scopeType.textContent = rule.match.patternType === "regexFilter" ? "Regex" : "URL";
  const pattern = document.createElement("code");
  pattern.textContent = rule.match.pattern === "*" ? "All URLs" : rule.match.pattern;
  pattern.title = rule.match.pattern;
  scope.append(scopeType, pattern);

  const constraints = summarizeRuleConstraints(rule);
  if (constraints) {
    const detail = document.createElement("p");
    detail.className = "active-rule-constraints";
    detail.textContent = constraints;
    detail.title = constraints;
    item.append(heading, scope, detail, createModificationChips(rule.modifications));
  } else {
    item.append(heading, scope, createModificationChips(rule.modifications));
  }
  return item;
}

async function toggleRule(ruleId, enabled) {
  if (popupState.busy) return;
  const profile = PopupCore.getActiveProfile(popupState.state);
  if (!profile) {
    showPopupError("No active profile is available.");
    return;
  }

  popupState.busy = true;
  popupState.pendingRule = { ruleId, enabled };
  clearPopupError();
  renderPopup();
  try {
    const response = await popupMessage("SET_RULE_ENABLED", {
      profileId: profile.id,
      ruleId,
      enabled
    });
    popupState.state = PopupCore.normalizeState(response.state);
    popupState.runtime = response.runtime;
  } catch (error) {
    showPopupError(error.message);
  } finally {
    popupState.busy = false;
    popupState.pendingRule = null;
    renderPopup();
  }
}

function summarizeRuleConstraints(rule) {
  const match = rule.match;
  const parts = [];
  if (match.requestDomains.length) {
    parts.push(`${match.requestDomains.length} destination domain${match.requestDomains.length === 1 ? "" : "s"}`);
  }
  if (match.initiatorDomains.length) {
    parts.push(`${match.initiatorDomains.length} initiator domain${match.initiatorDomains.length === 1 ? "" : "s"}`);
  }
  if (match.requestMethods.length) {
    parts.push(match.requestMethods.map((method) => method.toUpperCase()).join(", "));
  }
  if (match.domainType === "firstParty") parts.push("first party");
  if (match.domainType === "thirdParty") parts.push("third party");
  return parts.join(" · ");
}

function createModificationChips(modifications) {
  const container = document.createElement("div");
  container.className = "active-rule-modifications";
  modifications.forEach((modification) => {
    const chip = document.createElement("span");
    const needsValue = modification.sessionOnly && !modification.sessionValueAvailable;
    chip.className = `active-rule-chip is-${modification.target}${modification.sessionOnly ? " is-session" : ""}${needsValue ? " needs-value" : ""}`;
    const target = modification.target === "response" ? "Response" : "Request";
    const operation = modification.operation[0].toUpperCase() + modification.operation.slice(1);
    chip.textContent = `${target} · ${operation} ${modification.header}${modification.sessionOnly ? (needsValue ? " · needs session value" : " · session") : ""}`;
    chip.title = `${operation} the ${modification.header} ${modification.target} header${modification.sessionOnly ? " for this browser session only" : ""}`;
    container.append(chip);
  });
  return container;
}

function createActiveRulesEmpty(message) {
  const empty = document.createElement("p");
  empty.className = "active-rules-empty";
  empty.textContent = message;
  return empty;
}

async function quickAddHeader(event) {
  event.preventDefault();
  if (popupState.busy) return;
  const nameInput = document.getElementById("quick-header-name");
  const valueInput = document.getElementById("quick-header-value");
  const sessionInput = document.getElementById("quick-header-session-only");
  const header = nameInput.value.trim();
  const value = valueInput.value;
  const sessionOnly = sessionInput.checked;
  if (!header) {
    setQuickStatus("Enter a header name.", true);
    nameInput.focus();
    return;
  }
  popupState.busy = true;
  clearPopupError();
  setQuickStatus("", false);
  renderPopup();
  try {
    const response = await popupMessage("QUICK_ADD_HEADER", { header, value, sessionOnly });
    popupState.state = PopupCore.normalizeState(response.state);
    popupState.runtime = response.runtime;
    nameInput.value = "";
    valueInput.value = "";
    sessionInput.checked = false;
    updateQuickValueLifetime();
    const verb = response.quickAdd && response.quickAdd.created ? "Added" : "Updated";
    const suffix = response.quickAdd && response.quickAdd.applied
      ? "for every supported request."
      : "in the active profile; MonoHeader remains paused.";
    setQuickStatus(`${verb} ${header}${sessionOnly ? " for this browser session" : ""} ${suffix}`, false);
  } catch (error) {
    setQuickStatus(error.message, true);
  } finally {
    popupState.busy = false;
    renderPopup();
  }
}

function updateQuickValueLifetime() {
  const sessionOnly = document.getElementById("quick-header-session-only").checked;
  const valueInput = document.getElementById("quick-header-value");
  valueInput.type = sessionOnly ? "password" : "text";
  valueInput.placeholder = sessionOnly ? "Enter sensitive value" : "development";
}

async function togglePower(event) {
  if (popupState.busy) return;
  const requestedEnabled = event.target.checked;
  popupState.busy = true;
  clearPopupError();
  renderPopup();
  try {
    const response = await popupMessage("SET_ENABLED", { enabled: requestedEnabled });
    popupState.state = PopupCore.normalizeState(response.state);
    popupState.runtime = response.runtime;
  } catch (error) {
    event.target.checked = !event.target.checked;
    showPopupError(error.message);
  } finally {
    popupState.busy = false;
    renderPopup();
  }
}

async function switchProfile(event) {
  if (popupState.busy) return;
  const requestedProfileId = event.target.value;
  const previous = popupState.state.activeProfileId;
  popupState.busy = true;
  clearPopupError();
  renderPopup();
  try {
    const response = await popupMessage("SWITCH_PROFILE", { profileId: requestedProfileId });
    popupState.state = PopupCore.normalizeState(response.state);
    popupState.runtime = response.runtime;
  } catch (error) {
    popupState.state.activeProfileId = previous;
    showPopupError(error.message);
  } finally {
    popupState.busy = false;
    renderPopup();
  }
}

async function popupMessage(action, payload) {
  const response = await withPopupTimeout(
    ExtensionAPI.runtime.sendMessage({ action, ...(payload || {}) }),
    POPUP_MESSAGE_TIMEOUT_MS
  );
  if (!response || !response.ok) {
    throw new Error(response && response.error && response.error.message || "The MonoHeader background runtime did not respond.");
  }
  return response;
}

function withPopupTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(
      () => reject(new Error("MonoHeader did not receive a response from its background service in time.")),
      timeoutMs
    );
  });
  return Promise.race([Promise.resolve(promise), timeout])
    .finally(() => window.clearTimeout(timer));
}

function showPopupLoadFailure(message) {
  const loading = document.getElementById("loading-state");
  const explanation = document.createElement("span");
  explanation.textContent = message || "MonoHeader could not load.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "loading-retry";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => window.location.reload());
  loading.classList.add("is-error");
  loading.replaceChildren(explanation, retry);
}

function showPopupError(message) {
  const element = document.getElementById("popup-error");
  element.textContent = message;
  element.hidden = false;
}

function clearPopupError() {
  const element = document.getElementById("popup-error");
  element.textContent = "";
  element.hidden = true;
}

function setQuickStatus(message, isError) {
  const element = document.getElementById("quick-add-status");
  element.textContent = message;
  element.classList.toggle("is-error", isError);
  element.hidden = !message;
}
