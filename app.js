"use strict";

const Core = globalThis.MonoHeaderCore;
const $ = (selector, root) => (root || document).querySelector(selector);
const $$ = (selector, root) => [...(root || document).querySelectorAll(selector)];

let persistedState = null;
let draftState = null;
let runtime = null;
let activeView = "rules";
let dirty = false;
let applying = false;
let pendingImport = null;
let editingRuleId = null;
let editingProfileId = null;
let lastInspection = null;

const viewMeta = {
  rules: ["Workspace", "Header rules"],
  profiles: ["Workspace", "Profiles"],
  activity: ["Observability", "Activity"],
  settings: ["Configuration", "Settings"]
};

const resourceLabels = {
  main_frame: "Page",
  sub_frame: "Frame",
  stylesheet: "Stylesheet",
  script: "Script",
  image: "Image",
  font: "Font",
  object: "Object",
  xmlhttprequest: "XHR / fetch",
  ping: "Ping",
  csp_report: "CSP report",
  media: "Media",
  websocket: "WebSocket",
  webtransport: "WebTransport",
  webbundle: "WebBundle",
  other: "Other"
};

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  buildFormOptions();
  bindEvents();
  try {
    const response = await sendMessage("GET_STATE");
    persistedState = Core.normalizeState(response.state);
    draftState = Core.clone(persistedState);
    runtime = response.runtime;
    applyTheme(draftState.settings.theme);
    render();
  } catch (error) {
    showToast("Could not start MonoHeader", error.message, "error");
    renderFatal(error);
  }
}

function buildFormOptions() {
  const resourceContainer = $("#resource-type-options");
  Core.DEFAULT_RESOURCE_TYPES.forEach((resourceType) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = resourceType;
    input.name = "resourceType";
    label.append(input, document.createTextNode(resourceLabels[resourceType] || resourceType));
    resourceContainer.append(label);
  });

  const methodContainer = $("#method-options");
  Core.REQUEST_METHODS.forEach((method) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = method;
    input.name = "requestMethod";
    label.append(input, document.createTextNode(method));
    methodContainer.append(label);
  });

  const inspectorMethod = $("#inspector-method");
  Core.REQUEST_METHODS.forEach((method) => {
    const option = document.createElement("option");
    option.value = method;
    option.textContent = method.toUpperCase();
    inspectorMethod.append(option);
  });
  inspectorMethod.value = "get";

  const inspectorResourceType = $("#inspector-resource-type");
  Core.DEFAULT_RESOURCE_TYPES.forEach((resourceType) => {
    const option = document.createElement("option");
    option.value = resourceType;
    option.textContent = resourceLabels[resourceType] || resourceType;
    inspectorResourceType.append(option);
  });
  inspectorResourceType.value = "xmlhttprequest";

  const colorContainer = $("#profile-color-options");
  ["indigo", "teal", "amber", "rose", "slate"].forEach((color) => {
    const wrapper = document.createElement("span");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "profileColor";
    input.value = color;
    input.id = `profile-color-${color}`;
    const label = document.createElement("label");
    label.className = `color-option ${color}`;
    label.htmlFor = input.id;
    label.title = color[0].toUpperCase() + color.slice(1);
    label.setAttribute("aria-label", label.title);
    wrapper.append(input, label);
    colorContainer.append(wrapper);
  });
}

function bindEvents() {
  $$(".nav-item").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  $("#apply-button").addEventListener("click", applyDraft);
  $("#new-rule-button").addEventListener("click", () => openRuleDialog());
  $("#rule-search").addEventListener("input", renderRules);
  $("#rule-filter").addEventListener("change", renderRules);
  $("#rule-inspector-button").addEventListener("click", openRuleInspector);
  $("#rule-inspector-form").addEventListener("submit", runRuleInspector);
  $("#inspector-show-values").addEventListener("change", () => {
    if (lastInspection) renderRuleInspection(lastInspection);
  });
  $("#new-profile-button").addEventListener("click", () => openProfileDialog());
  $("#rule-form").addEventListener("submit", saveRuleFromForm);
  $("#profile-form").addEventListener("submit", saveProfileFromForm);
  $("#add-modification-button").addEventListener("click", () => addModificationRow(Core.createModification()));
  $("#pattern-type").addEventListener("change", updatePatternGuidance);
  $("#toggle-resource-types").addEventListener("click", toggleAllResourceTypes);
  $("#rollback-button").addEventListener("click", rollback);
  $("#clear-diagnostics-button").addEventListener("click", clearDiagnostics);
  $("#export-button").addEventListener("click", exportConfiguration);
  $("#import-button").addEventListener("click", openImportDialog);
  $("#import-file").addEventListener("change", readImportFile);
  $("#import-form").addEventListener("submit", applyImport);
  $("#reset-button").addEventListener("click", resetExtension);
  $("#theme-select").addEventListener("change", (event) => {
    draftState.settings.theme = event.target.value;
    applyTheme(event.target.value);
    markDirty();
  });
  $("#history-limit").addEventListener("change", (event) => {
    draftState.settings.deploymentHistoryLimit = clamp(event.target.value, 5, 100);
    markDirty();
  });
  $("#diagnostic-limit").addEventListener("change", (event) => {
    draftState.settings.diagnosticsLimit = clamp(event.target.value, 20, 500);
    markDirty();
  });
  $$("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      const dialog = document.getElementById(button.dataset.closeDialog);
      if (dialog) dialog.close();
    });
  });
  $$(".dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (draftState && draftState.settings.theme === "system") applyTheme("system");
  });
}

function setView(view) {
  if (!viewMeta[view]) return;
  activeView = view;
  $$(".nav-item").forEach((button) => {
    const selected = button.dataset.view === view;
    button.classList.toggle("is-active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $$("[data-view-panel]").forEach((panel) => {
    const selected = panel.dataset.viewPanel === view;
    panel.hidden = !selected;
    panel.classList.toggle("is-active", selected);
  });
  $("#view-eyebrow").textContent = viewMeta[view][0];
  $("#view-title").textContent = viewMeta[view][1];
  render();
}

function render() {
  if (!draftState) return;
  renderStatus();
  renderMetrics();
  renderRules();
  renderProfiles();
  renderActivity();
  renderSettings();
}

function renderStatus() {
  const status = $("#runtime-status");
  const statusText = $("span:last-child", status);
  status.classList.remove("is-paused", "is-error");
  if (!draftState.extensionEnabled) {
    status.classList.add("is-paused");
    statusText.textContent = dirty ? "Will be paused" : "Paused";
  } else if (runtime && runtime.lastStatus === "error" && !dirty) {
    status.classList.add("is-error");
    statusText.textContent = "Needs attention";
  } else if (dirty) {
    statusText.textContent = "Changes pending";
  } else {
    statusText.textContent = `${runtime ? runtime.deployedRuleCount : 0} active`;
  }
  $("#dirty-indicator").hidden = !dirty;
  $("#apply-button").disabled = !dirty || applying;
  $("#apply-button").lastChild.textContent = applying ? " Applying…" : " Apply changes";
}

function renderMetrics() {
  const profile = Core.getActiveProfile(draftState);
  const rules = profile ? profile.rules : [];
  const enabledRules = rules.filter((rule) => rule.enabled);
  const modifications = enabledRules.reduce((count, rule) => count + rule.modifications.length, 0);
  const requestMods = enabledRules.reduce(
    (count, rule) => count + rule.modifications.filter((modification) => modification.target === "request").length,
    0
  );
  const responseMods = modifications - requestMods;
  const unavailableSessionValues = enabledRules.reduce(
    (count, rule) => count + rule.modifications.filter((modification) => (
      modification.sessionOnly && !modification.sessionValueAvailable
    )).length,
    0
  );
  const metrics = [
    { label: "Saved rules", value: rules.length, detail: `${enabledRules.length} enabled` },
    { label: "Header changes", value: modifications, detail: `${requestMods} request · ${responseMods} response` },
    {
      label: "Chrome runtime",
      value: runtime ? runtime.deployedRuleCount : "—",
      detail: unavailableSessionValues
        ? `${unavailableSessionValues} session value${unavailableSessionValues === 1 ? "" : "s"} needed`
        : `of ${Core.MAX_DYNAMIC_HEADER_RULES.toLocaleString()} available`
    },
    {
      label: "MonoHeader",
      value: draftState.extensionEnabled ? "Enabled" : "Paused",
      detail: dirty ? "Apply to update runtime" : "Runtime matches saved state",
      action: draftState.extensionEnabled ? "Pause" : "Enable"
    }
  ];
  const container = $("#rules-metrics");
  container.replaceChildren(...metrics.map(createMetricCard));

  const errors = draftState.diagnostics.filter((item) => item.level === "error").length;
  const warnings = draftState.diagnostics.filter((item) => item.level === "warning").length;
  const lastApplied = draftState.deployments[0] ? formatRelativeTime(draftState.deployments[0].timestamp) : "Never";
  const activityMetrics = [
    { label: "Successful deployments", value: draftState.deployments.length, detail: "Retained locally" },
    { label: "Last applied", value: lastApplied, detail: profile ? profile.name : "No profile" },
    { label: "Warnings", value: warnings, detail: "In retained diagnostics" },
    { label: "Errors", value: errors, detail: errors ? "Review diagnostics" : "No retained errors" }
  ];
  $("#activity-metrics").replaceChildren(...activityMetrics.map(createMetricCard));
}

function createMetricCard(metric) {
  const card = document.createElement("article");
  card.className = "metric-card";
  const label = document.createElement("span");
  label.className = "metric-label";
  label.textContent = metric.label;
  const value = document.createElement("span");
  value.className = "metric-value";
  value.textContent = String(metric.value);
  const detail = document.createElement("span");
  detail.className = "metric-detail";
  detail.textContent = metric.detail;
  card.append(label, value, detail);
  if (metric.action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = metric.action;
    button.addEventListener("click", () => {
      draftState.extensionEnabled = !draftState.extensionEnabled;
      markDirty();
    });
    card.append(button);
  }
  return card;
}

function renderRules() {
  if (!draftState) return;
  const profile = Core.getActiveProfile(draftState);
  $("#active-profile-heading").textContent = profile ? profile.name : "No profile";
  const container = $("#rules-list");
  if (!profile) {
    container.replaceChildren(createEmptyState("No active profile", "Create a profile before adding rules."));
    return;
  }
  const search = $("#rule-search").value.trim().toLowerCase();
  const filter = $("#rule-filter").value;
  const visibleRules = profile.rules.filter((rule) => {
    const haystack = [
      rule.name,
      rule.description,
      rule.match.pattern,
      ...rule.modifications.flatMap((modification) => [modification.header, modification.value])
    ].join(" ").toLowerCase();
    if (search && !haystack.includes(search)) return false;
    if (filter === "enabled" && !rule.enabled) return false;
    if (filter === "disabled" && rule.enabled) return false;
    if (filter === "request" && !rule.modifications.some((modification) => modification.target === "request")) return false;
    if (filter === "response" && !rule.modifications.some((modification) => modification.target === "response")) return false;
    return true;
  });
  if (profile.rules.length === 0) {
    const empty = createEmptyState(
      "Create your first header rule",
      "Set, append, or remove request and response headers using precise URL and domain conditions.",
      "New rule",
      () => openRuleDialog()
    );
    container.replaceChildren(empty);
    return;
  }
  if (visibleRules.length === 0) {
    container.replaceChildren(createEmptyState("No matching rules", "Try another search or filter."));
    return;
  }
  container.replaceChildren(...visibleRules.map(createRuleCard));
}

function createRuleCard(rule) {
  const card = document.createElement("article");
  card.className = `rule-card${rule.enabled ? "" : " is-disabled"}`;
  card.dataset.ruleId = rule.id;

  const toggle = createSwitch(rule.enabled, `Enable ${rule.name}`);
  toggle.input.addEventListener("change", () => {
    const draftRule = findRule(rule.id);
    if (draftRule) {
      draftRule.enabled = toggle.input.checked;
      touchActiveProfile();
      markDirty();
    }
  });

  const main = document.createElement("div");
  main.className = "rule-main";
  const name = document.createElement("h3");
  name.textContent = rule.name;
  const description = document.createElement("p");
  description.textContent = rule.description || `Priority ${rule.priority}`;
  main.append(name, description);

  const condition = document.createElement("div");
  condition.className = "rule-condition";
  const conditionLabel = document.createElement("small");
  conditionLabel.textContent = rule.match.patternType === "regexFilter" ? "Regular expression" : "URL pattern";
  const pattern = document.createElement("code");
  pattern.textContent = rule.match.pattern;
  pattern.title = rule.match.pattern;
  condition.append(conditionLabel, pattern);

  const summary = document.createElement("div");
  summary.className = "modification-summary";
  const summaryLabel = document.createElement("small");
  const unavailableSessionValues = rule.modifications.filter((modification) => (
    modification.sessionOnly && !modification.sessionValueAvailable
  )).length;
  summaryLabel.textContent = `${rule.modifications.length} modification${rule.modifications.length === 1 ? "" : "s"}${unavailableSessionValues ? ` · ${unavailableSessionValues} needs value` : ""}`;
  const chips = document.createElement("div");
  chips.className = "modification-chips";
  rule.modifications.slice(0, 3).forEach((modification) => {
    const chip = document.createElement("span");
    const needsValue = modification.sessionOnly && !modification.sessionValueAvailable;
    chip.className = `header-chip${modification.sessionOnly ? " is-session" : ""}${needsValue ? " needs-value" : ""}`;
    chip.textContent = `${modification.operation} ${modification.header || "unnamed"}${modification.sessionOnly ? (needsValue ? " · needs session value" : " · session") : ""}`;
    chip.title = `${modification.target} · ${modification.operation} · ${modification.header}${modification.sessionOnly ? " · session only" : ""}`;
    chips.append(chip);
  });
  if (rule.modifications.length > 3) {
    const more = document.createElement("span");
    more.className = "header-chip";
    more.textContent = `+${rule.modifications.length - 3}`;
    chips.append(more);
  }
  summary.append(summaryLabel, chips);

  const meta = document.createElement("div");
  meta.className = "rule-meta";
  const targets = new Set(rule.modifications.map((modification) => modification.target));
  targets.forEach((target) => {
    const badge = document.createElement("span");
    badge.className = `badge badge-${target}`;
    badge.textContent = target;
    meta.append(badge);
  });
  if (rule.modifications.some((modification) => modification.sessionOnly)) {
    const badge = document.createElement("span");
    badge.className = unavailableSessionValues ? "badge badge-needs-value" : "badge badge-session";
    badge.textContent = unavailableSessionValues ? "needs value" : "session value";
    meta.append(badge);
  }

  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.append(
    createIconButton("✎", `Edit ${rule.name}`, () => openRuleDialog(rule.id)),
    createIconButton("⧉", `Duplicate ${rule.name}`, () => duplicateRule(rule.id)),
    createIconButton("×", `Delete ${rule.name}`, () => deleteRule(rule.id))
  );
  card.append(toggle.wrapper, main, condition, summary, meta, actions);
  return card;
}

function renderProfiles() {
  if (!draftState) return;
  const container = $("#profiles-grid");
  container.replaceChildren(...draftState.profiles.map((profile) => {
    const card = document.createElement("article");
    const active = profile.id === draftState.activeProfileId;
    card.className = `profile-card${active ? " is-active" : ""}`;
    const header = document.createElement("div");
    header.className = "profile-card-header";
    const symbol = document.createElement("span");
    symbol.className = `profile-symbol ${profile.color}`;
    symbol.textContent = profile.name.slice(0, 1).toUpperCase();
    const badge = document.createElement("span");
    badge.className = active ? "badge badge-success" : "badge";
    badge.textContent = active ? (dirty ? "Selected" : "Active") : "Inactive";
    header.append(symbol, badge);
    const title = document.createElement("h3");
    title.textContent = profile.name;
    const description = document.createElement("p");
    description.textContent = profile.description || "No description";
    const footer = document.createElement("div");
    footer.className = "profile-card-footer";
    const stats = document.createElement("span");
    stats.className = "profile-stats";
    stats.textContent = `${profile.rules.length} rule${profile.rules.length === 1 ? "" : "s"} · ${profile.rules.filter((rule) => rule.enabled).length} enabled`;
    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (!active) {
      const activate = document.createElement("button");
      activate.type = "button";
      activate.className = "button button-secondary";
      activate.textContent = "Activate";
      activate.addEventListener("click", () => {
        draftState.activeProfileId = profile.id;
        markDirty();
      });
      actions.append(activate);
    }
    actions.append(
      createIconButton("✎", `Edit ${profile.name}`, () => openProfileDialog(profile.id)),
      createIconButton("⧉", `Duplicate ${profile.name}`, () => duplicateProfile(profile.id)),
      createIconButton("×", `Delete ${profile.name}`, () => deleteProfile(profile.id))
    );
    footer.append(stats, actions);
    card.append(header, title, description, footer);
    return card;
  }));
}

function renderActivity() {
  if (!draftState) return;
  $("#rollback-button").disabled = !draftState.rollbackSnapshot || applying;
  const deployments = $("#deployment-list");
  if (draftState.deployments.length === 0) {
    deployments.replaceChildren(createMiniEmpty("No deployments yet."));
  } else {
    deployments.replaceChildren(...draftState.deployments.map((deployment) => {
      const item = document.createElement("div");
      item.className = "timeline-item";
      const marker = document.createElement("span");
      marker.className = "timeline-marker";
      marker.textContent = "✓";
      const body = document.createElement("div");
      body.className = "timeline-body";
      const title = document.createElement("strong");
      title.textContent = deployment.reason;
      const detail = document.createElement("span");
      detail.textContent = `${deployment.profileName} · ${deployment.ruleCount} rules · ${deployment.modificationCount} modifications`;
      body.append(title, detail);
      const time = document.createElement("time");
      time.className = "timeline-time";
      time.dateTime = deployment.timestamp;
      time.textContent = formatDateTime(deployment.timestamp);
      item.append(marker, body, time);
      return item;
    }));
  }

  const diagnostics = $("#diagnostic-list");
  if (draftState.diagnostics.length === 0) {
    diagnostics.replaceChildren(createMiniEmpty("No diagnostics retained."));
  } else {
    diagnostics.replaceChildren(...draftState.diagnostics.map((diagnostic) => {
      const item = document.createElement("div");
      item.className = "diagnostic-item";
      const level = document.createElement("span");
      level.className = `diagnostic-level ${diagnostic.level}`;
      level.title = diagnostic.level;
      const body = document.createElement("div");
      body.className = "diagnostic-body";
      const title = document.createElement("strong");
      title.textContent = `${diagnostic.source} — ${diagnostic.message}`;
      const details = document.createElement("p");
      details.textContent = diagnostic.details || formatDateTime(diagnostic.timestamp);
      const time = document.createElement("time");
      time.className = "diagnostic-time";
      time.dateTime = diagnostic.timestamp;
      time.textContent = formatDateTime(diagnostic.timestamp);
      body.append(title, details, time);
      item.append(level, body);
      return item;
    }));
  }
}

function renderSettings() {
  if (!draftState) return;
  $("#theme-select").value = draftState.settings.theme;
  $("#history-limit").value = draftState.settings.deploymentHistoryLimit;
  $("#diagnostic-limit").value = draftState.settings.diagnosticsLimit;
}

function createEmptyState(titleText, descriptionText, actionText, action) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const icon = document.createElement("div");
  icon.className = "empty-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "H+";
  const title = document.createElement("h3");
  title.textContent = titleText;
  const description = document.createElement("p");
  description.textContent = descriptionText;
  empty.append(icon, title, description);
  if (actionText && action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-primary";
    button.textContent = actionText;
    button.addEventListener("click", action);
    empty.append(button);
  }
  return empty;
}

function createMiniEmpty(text) {
  const element = document.createElement("p");
  element.className = "helper-text";
  element.textContent = text;
  element.style.padding = "24px 19px";
  return element;
}

function createSwitch(checked, label) {
  const wrapper = document.createElement("label");
  wrapper.className = "switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.setAttribute("aria-label", label);
  const track = document.createElement("span");
  track.className = "switch-track";
  wrapper.append(input, track);
  return { wrapper, input };
}

function createIconButton(symbol, label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.textContent = symbol;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", action);
  return button;
}

function openRuleDialog(ruleId) {
  const rule = ruleId ? findRule(ruleId) : null;
  editingRuleId = rule ? rule.id : null;
  const source = rule || Core.createRule({
    name: "",
    dnrId: null,
    modifications: [Core.createModification({ header: "" })]
  });
  $("#rule-dialog-title").textContent = rule ? "Edit rule" : "New rule";
  $("#rule-id").value = source.id || "";
  $("#rule-name").value = rule ? source.name : "";
  $("#rule-description").value = source.description || "";
  $("#rule-priority").value = source.priority;
  $("#pattern-type").value = source.match.patternType;
  $("#url-pattern").value = source.match.pattern;
  updatePatternGuidance();
  $("#case-sensitive").checked = source.match.caseSensitive;
  $("#domain-type").value = source.match.domainType;
  $("#request-domains").value = source.match.requestDomains.join(", ");
  $("#excluded-request-domains").value = source.match.excludedRequestDomains.join(", ");
  $("#initiator-domains").value = source.match.initiatorDomains.join(", ");
  $("#excluded-initiator-domains").value = source.match.excludedInitiatorDomains.join(", ");
  $("#rule-enabled").checked = source.enabled;
  $$('input[name="resourceType"]').forEach((input) => {
    input.checked = source.match.resourceTypes.includes(input.value);
  });
  $$('input[name="requestMethod"]').forEach((input) => {
    input.checked = source.match.requestMethods.includes(input.value);
  });
  $("#modification-list").replaceChildren();
  source.modifications.forEach(addModificationRow);
  hideRuleErrors();
  $("#rule-dialog").showModal();
  requestAnimationFrame(() => $("#rule-name").focus());
}

function addModificationRow(modification) {
  const fragment = $("#modification-template").content.cloneNode(true);
  const row = $(".modification-row", fragment);
  row.dataset.modificationId = modification.id || Core.createId("mod");
  const target = $('[data-mod-field="target"]', row);
  const operation = $('[data-mod-field="operation"]', row);
  const header = $('[data-mod-field="header"]', row);
  const value = $('[data-mod-field="value"]', row);
  const lifetime = $('[data-mod-field="lifetime"]', row);
  target.value = modification.target || "request";
  operation.value = modification.operation || "set";
  header.value = modification.header || "";
  value.value = modification.value || "";
  lifetime.value = modification.sessionOnly ? "session" : "persistent";
  row.dataset.sessionValueAvailable = modification.sessionOnly &&
    modification.sessionValueAvailable
    ? "true"
    : "false";
  updateModificationValueState(row);
  target.addEventListener("change", () => updateModificationHelp(row));
  operation.addEventListener("change", () => updateModificationValueState(row));
  lifetime.addEventListener("change", () => {
    if (lifetime.value === "session" && value.value !== "") {
      row.dataset.sessionValueAvailable = "true";
    }
    if (lifetime.value === "persistent") {
      row.dataset.sessionValueAvailable = "false";
    }
    updateModificationLifetimeState(row);
  });
  value.addEventListener("input", () => {
    if (lifetime.value === "session") {
      row.dataset.sessionValueAvailable = "true";
      updateModificationLifetimeState(row);
    }
  });
  $(".remove-modification", row).addEventListener("click", () => {
    row.remove();
    if ($$(".modification-row", $("#modification-list")).length === 0) {
      addModificationRow(Core.createModification());
    }
  });
  $("#modification-list").append(fragment);
}

function updateModificationValueState(row) {
  const operation = $('[data-mod-field="operation"]', row).value;
  const value = $('[data-mod-field="value"]', row);
  const lifetime = $('[data-mod-field="lifetime"]', row);
  const valueField = value.closest(".value-field");
  const removed = operation === "remove";
  value.disabled = removed;
  value.required = !removed;
  lifetime.disabled = removed;
  valueField.style.opacity = removed ? "0.5" : "";
  if (removed) {
    value.value = "";
    lifetime.value = "persistent";
    row.dataset.sessionValueAvailable = "false";
  }
  updateModificationLifetimeState(row);
  updateModificationHelp(row);
}

function updateModificationLifetimeState(row) {
  const value = $('[data-mod-field="value"]', row);
  const lifetime = $('[data-mod-field="lifetime"]', row);
  const field = lifetime.closest(".lifetime-field");
  const status = $(".session-value-status", row);
  const sessionOnly = !lifetime.disabled && lifetime.value === "session";
  const available = sessionOnly && row.dataset.sessionValueAvailable === "true";
  value.type = sessionOnly ? "password" : "text";
  value.placeholder = sessionOnly
    ? (available ? "Stored for this browser session" : "Enter for this browser session")
    : "Bearer …";
  field.classList.toggle("is-session", sessionOnly);
  field.classList.toggle("needs-value", sessionOnly && !available);
  status.textContent = sessionOnly
    ? (available ? "In memory for this session" : "Value required for this session")
    : "Saved in local configuration";
}

function updateModificationHelp(row) {
  const target = $('[data-mod-field="target"]', row).value;
  const operation = $('[data-mod-field="operation"]', row).value;
  const header = $('[data-mod-field="header"]', row);
  if (target === "request" && operation === "append") {
    header.title = `Chrome permits request-header append for: ${[...Core.REQUEST_APPEND_ALLOWLIST].join(", ")}`;
  } else {
    header.removeAttribute("title");
  }
}

function updatePatternGuidance() {
  const regex = $("#pattern-type").value === "regexFilter";
  const pattern = $("#url-pattern");
  const help = $("#url-pattern-help");
  pattern.placeholder = regex ? "^https://api\\.example\\.com/" : "||api.example.com/";
  help.replaceChildren();
  if (regex) {
    help.append("RE2 syntax. Anchor with ", createInlineCode("^"), " or ", createInlineCode("$"), " when the start or end must match exactly.");
  } else {
    help.append("Chrome URL-filter syntax. Use ", createInlineCode("*"), " for every URL or ", createInlineCode("||example.com/"), " for a domain and its subdomains.");
  }
}

function createInlineCode(text) {
  const code = document.createElement("code");
  code.textContent = text;
  return code;
}

function saveRuleFromForm(event) {
  event.preventDefault();
  const profile = Core.getActiveProfile(draftState);
  if (!profile) return;
  const existing = editingRuleId ? findRule(editingRuleId) : null;
  const dnrId = existing ? existing.dnrId : allocateDnrId();
  const rule = Core.createRule({
    id: existing ? existing.id : Core.createId("rule"),
    dnrId,
    name: $("#rule-name").value,
    description: $("#rule-description").value,
    enabled: $("#rule-enabled").checked,
    priority: Number($("#rule-priority").value),
    match: {
      patternType: $("#pattern-type").value,
      pattern: $("#url-pattern").value.trim(),
      caseSensitive: $("#case-sensitive").checked,
      requestDomains: splitDomains($("#request-domains").value),
      excludedRequestDomains: splitDomains($("#excluded-request-domains").value),
      initiatorDomains: splitDomains($("#initiator-domains").value),
      excludedInitiatorDomains: splitDomains($("#excluded-initiator-domains").value),
      resourceTypes: $$('input[name="resourceType"]:checked').map((input) => input.value),
      requestMethods: $$('input[name="requestMethod"]:checked').map((input) => input.value),
      domainType: $("#domain-type").value
    },
    modifications: $$(".modification-row", $("#modification-list")).map((row) => {
      const operation = $('[data-mod-field="operation"]', row).value;
      const sessionOnly = operation !== "remove" &&
        $('[data-mod-field="lifetime"]', row).value === "session";
      return Core.createModification({
        id: row.dataset.modificationId,
        target: $('[data-mod-field="target"]', row).value,
        operation,
        header: $('[data-mod-field="header"]', row).value.trim(),
        value: operation === "remove" ? "" : $('[data-mod-field="value"]', row).value,
        sessionOnly,
        sessionValueAvailable: sessionOnly &&
          row.dataset.sessionValueAvailable === "true"
      });
    })
  });
  const rawValidation = Core.validateRule(rule);
  if (!rawValidation.valid) {
    showRuleErrors(rawValidation.errors);
    return;
  }
  const normalizedRule = normalizeSingleRule(rule);
  const validation = Core.validateRule(normalizedRule);
  if (existing) {
    const index = profile.rules.findIndex((item) => item.id === existing.id);
    profile.rules[index] = normalizedRule;
  } else {
    profile.rules.unshift(normalizedRule);
  }
  touchActiveProfile();
  $("#rule-dialog").close();
  markDirty();
  if (validation.warnings.length) showToast("Rule saved with a warning", validation.warnings.join("\n"), "warning");
  else showToast("Rule saved", `${normalizedRule.name} is ready to apply.`);
}

function normalizeSingleRule(rule) {
  const temporaryProfile = Core.createProfile("Temporary", { rules: [rule] });
  const temporary = Core.normalizeState({
    extensionEnabled: true,
    activeProfileId: temporaryProfile.id,
    profiles: [temporaryProfile],
    nextDnrId: draftState.nextDnrId,
    settings: draftState.settings
  });
  return temporary.profiles[0].rules[0];
}

function showRuleErrors(errors) {
  const alert = $("#rule-form-errors");
  alert.textContent = errors.join("\n");
  alert.hidden = false;
  alert.scrollIntoView({ block: "nearest" });
}

function hideRuleErrors() {
  const alert = $("#rule-form-errors");
  alert.textContent = "";
  alert.hidden = true;
}

function duplicateRule(ruleId) {
  const profile = Core.getActiveProfile(draftState);
  const source = findRule(ruleId);
  if (!profile || !source) return;
  const copy = Core.clone(source);
  copy.id = Core.createId("rule");
  copy.dnrId = allocateDnrId();
  copy.name = `${source.name} copy`.slice(0, 120);
  copy.modifications = copy.modifications.map((modification) => ({
    ...modification,
    id: Core.createId("mod")
  }));
  const index = profile.rules.findIndex((rule) => rule.id === source.id);
  profile.rules.splice(index + 1, 0, copy);
  touchActiveProfile();
  markDirty();
  showToast("Rule duplicated", copy.name);
}

function deleteRule(ruleId) {
  const profile = Core.getActiveProfile(draftState);
  const rule = findRule(ruleId);
  if (!profile || !rule) return;
  if (!confirm(`Delete "${rule.name}"?\n\nThis takes effect only after you apply the change.`)) return;
  profile.rules = profile.rules.filter((item) => item.id !== ruleId);
  touchActiveProfile();
  markDirty();
  showToast("Rule removed", rule.name);
}

function openProfileDialog(profileId) {
  const profile = profileId ? draftState.profiles.find((item) => item.id === profileId) : null;
  editingProfileId = profile ? profile.id : null;
  $("#profile-dialog-title").textContent = profile ? "Edit profile" : "New profile";
  $("#profile-id").value = profile ? profile.id : "";
  $("#profile-name").value = profile ? profile.name : "";
  $("#profile-description").value = profile ? profile.description : "";
  const color = profile ? profile.color : "indigo";
  $$('input[name="profileColor"]').forEach((input) => {
    input.checked = input.value === color;
  });
  $("#profile-dialog").showModal();
  requestAnimationFrame(() => $("#profile-name").focus());
}

function saveProfileFromForm(event) {
  event.preventDefault();
  const name = $("#profile-name").value.trim();
  if (!name) {
    $("#profile-name").focus();
    return;
  }
  const colorInput = $('input[name="profileColor"]:checked');
  if (editingProfileId) {
    const profile = draftState.profiles.find((item) => item.id === editingProfileId);
    if (!profile) return;
    profile.name = name.slice(0, 80);
    profile.description = $("#profile-description").value.trim().slice(0, 500);
    profile.color = colorInput ? colorInput.value : "indigo";
    profile.updatedAt = new Date().toISOString();
  } else {
    const profile = Core.createProfile(name, {
      description: $("#profile-description").value.trim(),
      color: colorInput ? colorInput.value : "indigo"
    });
    draftState.profiles.push(profile);
    draftState.activeProfileId = profile.id;
  }
  $("#profile-dialog").close();
  markDirty();
}

function duplicateProfile(profileId) {
  const source = draftState.profiles.find((profile) => profile.id === profileId);
  if (!source) return;
  const copy = Core.clone(source);
  copy.id = Core.createId("profile");
  copy.name = `${source.name} copy`.slice(0, 80);
  copy.createdAt = new Date().toISOString();
  copy.updatedAt = copy.createdAt;
  copy.rules = copy.rules.map((rule) => ({
    ...rule,
    id: Core.createId("rule"),
    dnrId: allocateDnrId(),
    modifications: rule.modifications.map((modification) => ({
      ...modification,
      id: Core.createId("mod")
    }))
  }));
  draftState.profiles.push(copy);
  markDirty();
  showToast("Profile duplicated", copy.name);
}

function deleteProfile(profileId) {
  const profile = draftState.profiles.find((item) => item.id === profileId);
  if (!profile) return;
  if (draftState.profiles.length === 1) {
    showToast("Cannot delete the only profile", "Create another profile first.", "error");
    return;
  }
  if (!confirm(`Delete "${profile.name}" and its ${profile.rules.length} rule${profile.rules.length === 1 ? "" : "s"}?`)) return;
  draftState.profiles = draftState.profiles.filter((item) => item.id !== profileId);
  if (draftState.activeProfileId === profileId) draftState.activeProfileId = draftState.profiles[0].id;
  markDirty();
}

async function applyDraft() {
  if (!dirty || applying) return;
  const validation = Core.validateState(draftState);
  if (!validation.valid) {
    setView("rules");
    showToast("Changes were not applied", validation.errors.slice(0, 5).join("\n"), "error");
    return;
  }
  applying = true;
  renderStatus();
  try {
    const response = await sendMessage("APPLY_STATE", {
      state: draftState,
      reason: "Applied workspace changes"
    });
    persistedState = Core.normalizeState(response.state);
    draftState = Core.clone(persistedState);
    runtime = response.runtime;
    dirty = false;
    invalidateRuleInspection("The applied configuration changed. Inspect again for a current result.");
    applyTheme(draftState.settings.theme);
    render();
    if (response.warnings && response.warnings.length) {
      showToast("Changes applied with warnings", response.warnings.join("\n"), "warning");
    } else {
      showToast("Changes applied", `${runtime.deployedRuleCount} rule${runtime.deployedRuleCount === 1 ? "" : "s"} active in Chrome.`);
    }
  } catch (error) {
    showToast("Could not apply changes", error.message, "error");
  } finally {
    applying = false;
    renderStatus();
  }
}

async function rollback() {
  if (dirty) {
    showToast("Apply or discard pending edits first", "Rollback operates on the last applied configuration.", "error");
    return;
  }
  if (!confirm("Restore the configuration that was active before the latest successful deployment?")) return;
  applying = true;
  renderStatus();
  try {
    const response = await sendMessage("ROLLBACK");
    persistedState = Core.normalizeState(response.state);
    draftState = Core.clone(persistedState);
    runtime = response.runtime;
    dirty = false;
    invalidateRuleInspection("Rollback changed the active configuration. Inspect again for a current result.");
    applyTheme(draftState.settings.theme);
    render();
    showToast("Rollback complete", "The previous configuration is active.");
  } catch (error) {
    showToast("Rollback failed", error.message, "error");
  } finally {
    applying = false;
    renderStatus();
  }
}

async function clearDiagnostics() {
  try {
    const response = await sendMessage("CLEAR_DIAGNOSTICS");
    persistedState = Core.normalizeState(response.state);
    if (!dirty) draftState = Core.clone(persistedState);
    else draftState.diagnostics = [];
    runtime = response.runtime;
    render();
    showToast("Diagnostics cleared", "Local diagnostic history was removed.");
  } catch (error) {
    showToast("Could not clear diagnostics", error.message, "error");
  }
}

function exportConfiguration() {
  try {
    const sessionValueCount = draftState.profiles.reduce(
      (profileCount, profile) => profileCount + profile.rules.reduce(
        (ruleCount, rule) => ruleCount + rule.modifications.filter((modification) => modification.sessionOnly).length,
        0
      ),
      0
    );
    const data = Core.createExport(draftState);
    const text = `${JSON.stringify(data, null, 2)}\n`;
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `monoheader-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(
      "Backup exported",
      `${draftState.profiles.length} profile${draftState.profiles.length === 1 ? "" : "s"} saved to JSON.${sessionValueCount ? ` ${sessionValueCount} session-only value${sessionValueCount === 1 ? " was" : "s were"} excluded.` : ""}`
    );
  } catch (error) {
    showToast("Export failed", error.message, "error");
  }
}

function openImportDialog() {
  pendingImport = null;
  $("#import-file").value = "";
  $("#import-enable").checked = false;
  $("#import-preview").hidden = true;
  $("#import-preview").classList.remove("is-error");
  $("#confirm-import-button").disabled = true;
  $("#import-dialog").showModal();
}

async function readImportFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const preview = $("#import-preview");
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("The import file is larger than 10 MB.");
    const parsed = Core.parseImport(await file.text());
    pendingImport = parsed;
    const ruleCount = parsed.state.profiles.reduce((count, profile) => count + profile.rules.length, 0);
    const lines = [
      `${parsed.source} configuration recognized.`,
      `${parsed.state.profiles.length} profile${parsed.state.profiles.length === 1 ? "" : "s"} and ${ruleCount} rule${ruleCount === 1 ? "" : "s"} found.`
    ];
    if (parsed.errors.length) lines.push("", `Cannot apply:\n${parsed.errors.join("\n")}`);
    if (parsed.warnings.length) lines.push("", `Review:\n${parsed.warnings.join("\n")}`);
    preview.textContent = lines.join("\n");
    preview.classList.toggle("is-error", parsed.errors.length > 0);
    preview.hidden = false;
    $("#confirm-import-button").disabled = parsed.errors.length > 0;
  } catch (error) {
    pendingImport = null;
    preview.textContent = error.message;
    preview.classList.add("is-error");
    preview.hidden = false;
    $("#confirm-import-button").disabled = true;
  }
}

async function applyImport(event) {
  event.preventDefault();
  if (!pendingImport || pendingImport.errors.length) return;
  const candidate = Core.normalizeState(pendingImport.state);
  candidate.extensionEnabled = $("#import-enable").checked;
  applying = true;
  $("#confirm-import-button").disabled = true;
  try {
    const response = await sendMessage("APPLY_STATE", {
      state: candidate,
      reason: `Imported ${pendingImport.source} configuration`
    });
    persistedState = Core.normalizeState(response.state);
    draftState = Core.clone(persistedState);
    runtime = response.runtime;
    dirty = false;
    invalidateRuleInspection("The imported configuration changed the active rules. Inspect again for a current result.");
    $("#import-dialog").close();
    applyTheme(draftState.settings.theme);
    render();
    showToast("Import complete", `${draftState.profiles.length} profile${draftState.profiles.length === 1 ? "" : "s"} imported.`);
  } catch (error) {
    showToast("Import failed", error.message, "error");
    $("#confirm-import-button").disabled = false;
  } finally {
    applying = false;
    renderStatus();
  }
}

async function resetExtension() {
  const promptText = "Reset MonoHeader?\n\nAll profiles, rules, session-only values, keep-alive tabs, site presets, history, and diagnostics will be removed from this browser. This cannot be undone unless you exported a backup; session-only values and keep-alive presets are never included in backups.";
  if (!confirm(promptText)) return;
  applying = true;
  try {
    const response = await sendMessage("RESET");
    persistedState = Core.normalizeState(response.state);
    draftState = Core.clone(persistedState);
    runtime = response.runtime;
    dirty = false;
    invalidateRuleInspection("MonoHeader was reset. Inspect again for a current result.");
    applyTheme(draftState.settings.theme);
    setView("rules");
    render();
    showToast("MonoHeader reset", "Factory defaults are active.");
  } catch (error) {
    showToast("Reset failed", error.message, "error");
  } finally {
    applying = false;
    renderStatus();
  }
}

function openRuleInspector() {
  const profile = Core.getActiveProfile(draftState);
  if (lastInspection && (!profile || lastInspection.profileId !== profile.id)) {
    lastInspection = null;
    resetRuleInspectorResult("The active profile changed. Inspect again for a current result.");
  }
  $("#rule-inspector-error").hidden = true;
  $("#rule-inspector-dialog").showModal();
  requestAnimationFrame(() => $("#inspector-url").focus());
}

function runRuleInspector(event) {
  event.preventDefault();
  const error = $("#rule-inspector-error");
  error.hidden = true;
  try {
    lastInspection = Core.inspectEffectiveHeaders(
      draftState,
      $("#inspector-url").value,
      {
        method: $("#inspector-method").value,
        resourceType: $("#inspector-resource-type").value,
        initiatorDomain: $("#inspector-initiator").value,
        domainType: $("#inspector-domain-type").value
      }
    );
    renderRuleInspection(lastInspection);
  } catch (inspectionError) {
    lastInspection = null;
    error.textContent = inspectionError.message;
    error.hidden = false;
    resetRuleInspectorResult("Correct the request context and inspect again.");
  }
}

function resetRuleInspectorResult(message) {
  const result = $("#rule-inspector-result");
  if (!result) return;
  const empty = document.createElement("div");
  empty.className = "inspector-empty";
  const title = document.createElement("strong");
  title.textContent = "No current inspection";
  const detail = document.createElement("p");
  detail.textContent = message || "Enter a request context and choose Inspect rules.";
  empty.append(title, detail);
  result.replaceChildren(empty);
}

function renderRuleInspection(inspection) {
  const result = $("#rule-inspector-result");
  const summary = document.createElement("div");
  summary.className = "inspector-summary";
  summary.append(
    createInspectorMetric("Matched rules", inspection.matchingRules.length),
    createInspectorMetric("Affected headers", inspection.headers.length),
    createInspectorMetric("Competing headers", inspection.conflictCount),
    createInspectorMetric("Ambiguous", inspection.ambiguousCount)
  );
  const content = [summary];

  if (!inspection.active) {
    content.push(createInspectorNotice(
      "MonoHeader is paused. This is a preview of what the enabled rules would do after MonoHeader is enabled and applied.",
      "warning"
    ));
  }
  if (dirty) {
    content.push(createInspectorNotice(
      "This preview includes unapplied draft changes. Chrome may still be running the last applied configuration.",
      "info"
    ));
  }
  if (inspection.unavailableSessionValueCount > 0) {
    const headers = inspection.unavailableSessionModifications
      .map((modification) => `${modification.ruleName}: ${modification.header}`)
      .join(", ");
    content.push(createInspectorNotice(
      `${inspection.unavailableSessionValueCount} matching session-only modification${inspection.unavailableSessionValueCount === 1 ? " is" : "s are"} inactive until a value is re-entered: ${headers}.`,
      "warning"
    ));
  }
  if (inspection.ambiguousCount > 0) {
    content.push(createInspectorNotice(
      `${inspection.ambiguousCount} header result${inspection.ambiguousCount === 1 ? " is" : "s are"} ambiguous because incompatible rules share a priority. Give the intended winner a higher priority.`,
      "danger"
    ));
  } else if (inspection.resolvedConflictCount > 0) {
    content.push(createInspectorNotice(
      `${inspection.resolvedConflictCount} competing header result${inspection.resolvedConflictCount === 1 ? " is" : "s are"} resolved by explicit priority.`,
      "success"
    ));
  }

  if (inspection.matchingRules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "inspector-empty";
    const title = document.createElement("strong");
    title.textContent = "No enabled rules match";
    const detail = document.createElement("p");
    detail.textContent = "Review the URL, request method, resource type, initiator, and domain relationship.";
    empty.append(title, detail);
    content.push(empty, createInspectorCaveat());
    result.replaceChildren(...content);
    return;
  }

  ["request", "response"].forEach((target) => {
    const headers = inspection.headers.filter((header) => header.target === target);
    if (!headers.length) return;
    const section = document.createElement("section");
    section.className = "inspector-header-section";
    const heading = document.createElement("h3");
    heading.textContent = `${target === "request" ? "Request" : "Response"} headers`;
    const list = document.createElement("div");
    list.className = "inspector-header-list";
    list.append(...headers.map(createInspectorHeaderCard));
    section.append(heading, list);
    content.push(section);
  });

  content.push(createInspectorMatchList(inspection.matchingRules), createInspectorCaveat());
  result.replaceChildren(...content);
}

function createInspectorMetric(labelText, valueText) {
  const metric = document.createElement("div");
  metric.className = "inspector-metric";
  const value = document.createElement("strong");
  value.textContent = String(valueText);
  const label = document.createElement("span");
  label.textContent = labelText;
  metric.append(value, label);
  return metric;
}

function createInspectorNotice(message, type) {
  const notice = document.createElement("p");
  notice.className = `inspector-notice is-${type}`;
  notice.textContent = message;
  return notice;
}

function createInspectorHeaderCard(header) {
  const card = document.createElement("article");
  card.className = `inspector-header-card${header.ambiguous ? " is-ambiguous" : ""}`;
  const heading = document.createElement("div");
  heading.className = "inspector-header-heading";
  const title = document.createElement("div");
  const name = document.createElement("h4");
  name.textContent = header.header;
  const target = document.createElement("span");
  target.textContent = header.target === "request" ? "Outgoing request" : "Incoming response";
  title.append(name, target);
  const badges = document.createElement("div");
  badges.className = "inspector-badges";
  if (header.ambiguous) {
    badges.append(createInspectorBadge("Ambiguous", "danger"));
  } else if (header.shadowedCount > 0) {
    badges.append(createInspectorBadge("Resolved by priority", "warning"));
  } else if (header.orderUncertain) {
    badges.append(createInspectorBadge("Append order varies", "warning"));
  } else if (header.hasConflict) {
    badges.append(createInspectorBadge("Compatible overlap", "success"));
  } else {
    badges.append(createInspectorBadge("Single rule", "neutral"));
  }
  heading.append(title, badges);

  const effective = document.createElement("p");
  effective.className = "inspector-effective";
  effective.textContent = describeEffectiveHeader(header);

  const chain = document.createElement("ol");
  chain.className = "inspector-operation-list";
  chain.append(...header.operations.map(createInspectorOperation));
  card.append(heading, effective, chain);
  return card;
}

function createInspectorBadge(label, type) {
  const badge = document.createElement("span");
  badge.className = `inspector-badge is-${type}`;
  badge.textContent = label;
  return badge;
}

function describeEffectiveHeader(header) {
  const effective = header.effective;
  if (effective.kind === "ambiguous") {
    return "Effective result is indeterminate until the competing rules have different priorities.";
  }
  if (effective.kind === "remove") {
    return `Effective result: Remove, selected by “${effective.lead.ruleName}” at priority ${effective.lead.priority}.`;
  }
  if (effective.kind === "set") {
    const appendCount = effective.appends.length;
    return `Effective result: Set by “${effective.lead.ruleName}” at priority ${effective.lead.priority}${appendCount ? `, then ${appendCount} lower-priority Append${appendCount === 1 ? "" : "s"}` : ""}.`;
  }
  if (effective.kind === "append") {
    const appendCount = effective.appends.length;
    return `Effective result: ${appendCount} Append${appendCount === 1 ? "" : "s"}; the original header value is retained.`;
  }
  return "No effective header operation.";
}

function createInspectorOperation(operation) {
  const item = document.createElement("li");
  item.className = `inspector-operation is-${operation.status}`;
  const marker = document.createElement("span");
  marker.className = "inspector-operation-marker";
  marker.setAttribute("aria-hidden", "true");
  marker.textContent = {
    applied: "✓",
    shadowed: "×",
    redundant: "=",
    ambiguous: "?",
    uncertain: "?"
  }[operation.status] || "·";
  const body = document.createElement("div");
  const line = document.createElement("div");
  line.className = "inspector-operation-line";
  const identity = document.createElement("strong");
  identity.textContent = `${capitalize(operation.operation)} · ${operation.ruleName}${operation.sessionOnly ? " · Session only" : ""}`;
  const priority = document.createElement("span");
  priority.textContent = `Priority ${operation.priority} · ${formatInspectorStatus(operation.status)}`;
  line.append(identity, priority);

  const value = document.createElement(operation.operation === "remove" ? "span" : "code");
  value.className = "inspector-operation-value";
  if (operation.operation === "remove") {
    value.textContent = "No configured value";
  } else if ($("#inspector-show-values").checked) {
    value.textContent = operation.value === "" ? "(empty value)" : operation.value;
  } else {
    value.textContent = "Value hidden";
    value.classList.add("is-hidden");
  }
  const reason = document.createElement("small");
  reason.textContent = operation.reason;
  body.append(line, value, reason);
  item.append(marker, body);
  return item;
}

function formatInspectorStatus(status) {
  return {
    applied: "applied",
    shadowed: "shadowed",
    redundant: "equivalent",
    ambiguous: "ambiguous",
    uncertain: "depends on conflict"
  }[status] || status;
}

function createInspectorMatchList(rules) {
  const details = document.createElement("details");
  details.className = "inspector-matches";
  const summary = document.createElement("summary");
  summary.textContent = `Matched rules (${rules.length})`;
  const list = document.createElement("div");
  list.className = "inspector-match-list";
  rules.forEach((rule) => {
    const item = document.createElement("div");
    const identity = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = rule.name;
    const count = document.createElement("span");
    count.textContent = `${rule.modificationCount} change${rule.modificationCount === 1 ? "" : "s"}`;
    identity.append(name, count);
    const meta = document.createElement("div");
    const priority = document.createElement("span");
    priority.textContent = `Priority ${rule.priority}`;
    const pattern = document.createElement("code");
    pattern.textContent = rule.pattern;
    pattern.title = rule.pattern;
    meta.append(priority, pattern);
    item.append(identity, meta);
    list.append(item);
  });
  details.append(summary, list);
  return details;
}

function createInspectorCaveat() {
  const note = document.createElement("p");
  note.className = "inspector-caveat";
  note.textContent = "Local preview only. Chrome’s DNR engine makes the final match decision, equal-priority order is not guaranteed, and other extensions may also modify these headers.";
  return note;
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function toggleAllResourceTypes() {
  const inputs = $$('input[name="resourceType"]');
  const allChecked = inputs.every((input) => input.checked);
  inputs.forEach((input) => {
    input.checked = !allChecked;
  });
  $("#toggle-resource-types").textContent = allChecked ? "Select all" : "Clear all";
}

function findRule(ruleId) {
  const profile = Core.getActiveProfile(draftState);
  return profile ? profile.rules.find((rule) => rule.id === ruleId) : null;
}

function touchActiveProfile() {
  const profile = Core.getActiveProfile(draftState);
  if (profile) profile.updatedAt = new Date().toISOString();
}

function allocateDnrId() {
  const used = new Set(draftState.profiles.flatMap((profile) => profile.rules.map((rule) => rule.dnrId)));
  let candidate = Math.max(1, Number(draftState.nextDnrId) || 1);
  while (used.has(candidate)) candidate += 1;
  draftState.nextDnrId = candidate + 1;
  return candidate;
}

function markDirty() {
  dirty = true;
  invalidateRuleInspection("Rules changed. Inspect again for a current result.");
  render();
}

function invalidateRuleInspection(message) {
  if (!lastInspection) return;
  lastInspection = null;
  resetRuleInspectorResult(message);
  const error = $("#rule-inspector-error");
  if (error) error.hidden = true;
}

function splitDomains(value) {
  return [...new Set(
    String(value || "")
      .split(/[\s,;]+/)
      .map((item) => Core.normalizeDomain(item))
      .filter(Boolean)
  )];
}

function applyTheme(theme) {
  const resolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;
  document.documentElement.dataset.theme = resolved;
}

function formatDateTime(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  } catch (_error) {
    return value;
  }
}

function formatRelativeTime(value) {
  const date = new Date(value);
  const delta = Date.now() - date.getTime();
  if (!Number.isFinite(delta)) return "Unknown";
  if (delta < 60_000) return "Just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return formatDateTime(value);
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

async function sendMessage(action, payload) {
  const response = await chrome.runtime.sendMessage({ action, ...(payload || {}) });
  if (!response || !response.ok) {
    const error = response && response.error;
    const message = error && error.message || "The MonoHeader service worker did not respond.";
    const thrown = new Error(message);
    thrown.name = error && error.name || "Error";
    thrown.validation = error && error.validation;
    throw thrown;
  }
  return response;
}

function showToast(title, message, type) {
  const toast = document.createElement("div");
  toast.className = `toast${type === "error" ? " is-error" : ""}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  const symbol = document.createElement("span");
  symbol.textContent = type === "error" ? "!" : (type === "warning" ? "△" : "✓");
  const body = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const detail = document.createElement("span");
  detail.textContent = String(message || "");
  body.append(heading, detail);
  toast.append(symbol, body);
  $("#toast-region").append(toast);
  setTimeout(() => toast.remove(), type === "error" ? 9000 : 4500);
}

function renderFatal(error) {
  const main = $("#main-content");
  const empty = createEmptyState(
    "MonoHeader could not start",
    `Reload the extension from chrome://extensions. Details: ${error.message}`
  );
  main.replaceChildren(empty);
}
