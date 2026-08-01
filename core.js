(function initializeMonoHeaderCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.MonoHeaderCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCore() {
  "use strict";

  const APP_NAME = "MonoHeader";
  const APP_VERSION = "1.11.1";
  const SCHEMA_VERSION = 2;
  const EXPORT_FORMAT = "monoheader";
  const MAX_DYNAMIC_HEADER_RULES = 5000;
  const MAX_REGEX_RULES = 1000;
  const MAX_RULE_NAME_LENGTH = 120;
  const MAX_PROFILE_NAME_LENGTH = 80;
  const MAX_HEADER_VALUE_LENGTH = 8192;
  const DEFAULT_RESOURCE_TYPES = Object.freeze([
    "main_frame",
    "sub_frame",
    "stylesheet",
    "script",
    "image",
    "font",
    "object",
    "xmlhttprequest",
    "ping",
    "csp_report",
    "media",
    "websocket",
    "webtransport",
    "webbundle",
    "other"
  ]);
  const REQUEST_METHODS = Object.freeze([
    "get",
    "head",
    "post",
    "put",
    "delete",
    "connect",
    "options",
    "patch",
    "other"
  ]);
  const REQUEST_APPEND_ALLOWLIST = new Set([
    "accept",
    "accept-encoding",
    "accept-language",
    "access-control-request-headers",
    "cache-control",
    "connection",
    "content-language",
    "cookie",
    "forwarded",
    "if-match",
    "if-none-match",
    "keep-alive",
    "range",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "user-agent",
    "via",
    "want-digest",
    "x-forwarded-for"
  ]);
  const HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const DOMAIN_LABEL_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function createId(prefix) {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }

  function isoNow() {
    return new Date().toISOString();
  }

  function createModification(overrides) {
    const input = overrides || {};
    const modification = Object.assign({
      id: createId("mod"),
      target: "request",
      operation: "set",
      header: "",
      value: "",
      sessionOnly: false,
      sessionValueAvailable: false
    }, input);
    if (
      modification.sessionOnly &&
      modification.operation !== "remove" &&
      !Object.prototype.hasOwnProperty.call(input, "sessionValueAvailable")
    ) {
      modification.sessionValueAvailable = modification.value !== "";
    }
    return modification;
  }

  function createRule(overrides) {
    const rule = {
      id: createId("rule"),
      dnrId: null,
      name: "New rule",
      description: "",
      enabled: true,
      priority: 100,
      match: {
        patternType: "urlFilter",
        pattern: "*",
        caseSensitive: false,
        requestDomains: [],
        excludedRequestDomains: [],
        initiatorDomains: [],
        excludedInitiatorDomains: [],
        resourceTypes: [...DEFAULT_RESOURCE_TYPES],
        requestMethods: [],
        domainType: "all"
      },
      modifications: [createModification()]
    };
    return mergeRule(rule, overrides || {});
  }

  function mergeRule(base, overrides) {
    const result = Object.assign({}, base, overrides);
    result.match = Object.assign({}, base.match, overrides.match || {});
    result.modifications = Array.isArray(overrides.modifications)
      ? overrides.modifications.map((item) => createModification(item))
      : base.modifications.map((item) => createModification(item));
    return result;
  }

  function createProfile(name, overrides) {
    return Object.assign({
      id: createId("profile"),
      name: cleanText(name || "Default", MAX_PROFILE_NAME_LENGTH),
      description: "",
      color: "indigo",
      rules: [],
      createdAt: isoNow(),
      updatedAt: isoNow()
    }, overrides || {});
  }

  function createDefaultState() {
    const defaultProfile = createProfile("Default");
    return {
      schemaVersion: SCHEMA_VERSION,
      extensionEnabled: true,
      activeProfileId: defaultProfile.id,
      profiles: [defaultProfile],
      nextDnrId: 1,
      deployments: [],
      diagnostics: [],
      rollbackSnapshot: null,
      settings: {
        theme: "system",
        deploymentHistoryLimit: 30,
        diagnosticsLimit: 100
      }
    };
  }

  function cleanText(value, maxLength) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .trim()
      .slice(0, maxLength);
  }

  function claimUniqueId(value, prefix, usedIds) {
    let id = cleanText(value, 160);
    if (!id || usedIds.has(id)) {
      do {
        id = createId(prefix);
      } while (usedIds.has(id));
    }
    usedIds.add(id);
    return id;
  }

  function uniqueStrings(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  }

  function normalizeDomain(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const hostname = withoutScheme.split("/")[0].split(":")[0].replace(/^\.+|\.+$/g, "");
    if (!hostname) return "";
    try {
      return new URL(`http://${hostname}`).hostname.toLowerCase();
    } catch (_error) {
      return hostname;
    }
  }

  function normalizeDomains(values) {
    return uniqueStrings(values).map(normalizeDomain).filter(Boolean);
  }

  function normalizeState(input) {
    const fallback = createDefaultState();
    if (!input || typeof input !== "object") return fallback;

    const rawProfiles = Array.isArray(input.profiles) ? input.profiles : [];
    let nextDnrId = Math.max(1, Number.isSafeInteger(input.nextDnrId) ? input.nextDnrId : 1);
    const usedDnrIds = new Set();
    const usedProfileIds = new Set();
    const usedRuleIds = new Set();
    const usedModificationIds = new Set();

    const profiles = rawProfiles.map((rawProfile, profileIndex) => {
      const profile = createProfile(
        cleanText(rawProfile && rawProfile.name, MAX_PROFILE_NAME_LENGTH) || `Profile ${profileIndex + 1}`,
        rawProfile || {}
      );
      profile.id = claimUniqueId(rawProfile && rawProfile.id, "profile", usedProfileIds);
      profile.description = cleanText(rawProfile && rawProfile.description, 500);
      profile.color = ["indigo", "teal", "amber", "rose", "slate"].includes(rawProfile && rawProfile.color)
        ? rawProfile.color
        : "indigo";
      profile.createdAt = validIso(rawProfile && rawProfile.createdAt) || isoNow();
      profile.updatedAt = validIso(rawProfile && rawProfile.updatedAt) || isoNow();
      profile.rules = (Array.isArray(rawProfile && rawProfile.rules) ? rawProfile.rules : []).map((rawRule) => {
        const rule = createRule(rawRule || {});
        rule.id = claimUniqueId(rawRule && rawRule.id, "rule", usedRuleIds);
        let dnrId = Number(rawRule && rawRule.dnrId);
        if (!Number.isSafeInteger(dnrId) || dnrId < 1 || dnrId > 2147483647 || usedDnrIds.has(dnrId)) {
          while (usedDnrIds.has(nextDnrId)) nextDnrId += 1;
          dnrId = nextDnrId;
          nextDnrId += 1;
        }
        usedDnrIds.add(dnrId);
        rule.dnrId = dnrId;
        rule.name = cleanText(rawRule && rawRule.name, MAX_RULE_NAME_LENGTH) || "Untitled rule";
        rule.description = cleanText(rawRule && rawRule.description, 500);
        rule.enabled = rawRule && typeof rawRule.enabled === "boolean" ? rawRule.enabled : true;
        rule.priority = clampInteger(rawRule && rawRule.priority, 1, 100000, 100);
        rule.match = normalizeMatch(rawRule && rawRule.match);
        rule.modifications = (Array.isArray(rawRule && rawRule.modifications)
          ? rawRule.modifications
          : []
        ).map((rawModification) => {
          const modification = createModification(rawModification || {});
          modification.id = claimUniqueId(
            rawModification && rawModification.id,
            "mod",
            usedModificationIds
          );
          modification.target = rawModification && rawModification.target === "response" ? "response" : "request";
          modification.operation = ["set", "append", "remove"].includes(rawModification && rawModification.operation)
            ? rawModification.operation
            : "set";
          modification.header = String(rawModification && rawModification.header || "").trim();
          modification.value = modification.operation === "remove"
            ? ""
            : String(rawModification && rawModification.value || "").slice(0, MAX_HEADER_VALUE_LENGTH);
          modification.sessionOnly = modification.operation !== "remove" &&
            rawModification && rawModification.sessionOnly === true;
          modification.sessionValueAvailable = modification.sessionOnly && (
            rawModification && typeof rawModification.sessionValueAvailable === "boolean"
              ? rawModification.sessionValueAvailable
              : modification.value !== ""
          );
          return modification;
        });
        if (rule.modifications.length === 0) {
          rule.modifications = [createModification({
            id: claimUniqueId("", "mod", usedModificationIds)
          })];
        }
        return rule;
      });
      return profile;
    });

    if (profiles.length === 0) profiles.push(fallback.profiles[0]);
    const activeProfileId = profiles.some((profile) => profile.id === input.activeProfileId)
      ? input.activeProfileId
      : profiles[0].id;
    const settings = Object.assign({}, fallback.settings, input.settings || {});
    settings.theme = ["system", "light", "dark"].includes(settings.theme) ? settings.theme : "system";
    settings.deploymentHistoryLimit = clampInteger(settings.deploymentHistoryLimit, 5, 100, 30);
    settings.diagnosticsLimit = clampInteger(settings.diagnosticsLimit, 20, 500, 100);

    const maxDnrId = usedDnrIds.size ? Math.max(...usedDnrIds) : 0;
    nextDnrId = Math.max(nextDnrId, maxDnrId + 1);

    return {
      schemaVersion: SCHEMA_VERSION,
      extensionEnabled: input.extensionEnabled !== false,
      activeProfileId,
      profiles,
      nextDnrId,
      deployments: normalizeDeployments(input.deployments, settings.deploymentHistoryLimit),
      diagnostics: normalizeDiagnostics(input.diagnostics, settings.diagnosticsLimit),
      rollbackSnapshot: normalizeSnapshot(input.rollbackSnapshot),
      settings
    };
  }

  function extractSessionHeaderValues(inputState) {
    const state = normalizeState(inputState);
    const values = {};
    state.profiles.forEach((profile) => {
      profile.rules.forEach((rule) => {
        rule.modifications.forEach((modification) => {
          if (
            modification.sessionOnly &&
            modification.operation !== "remove" &&
            modification.sessionValueAvailable
          ) {
            values[modification.id] = modification.value;
          }
        });
      });
    });
    return values;
  }

  function hydrateSessionHeaderValues(inputState, inputValues) {
    const state = normalizeState(inputState);
    const values = inputValues && typeof inputValues === "object" ? inputValues : {};
    state.profiles.forEach((profile) => {
      profile.rules.forEach((rule) => {
        rule.modifications.forEach((modification) => {
          if (!modification.sessionOnly || modification.operation === "remove") return;
          if (Object.prototype.hasOwnProperty.call(values, modification.id)) {
            modification.value = String(values[modification.id] == null ? "" : values[modification.id])
              .slice(0, MAX_HEADER_VALUE_LENGTH);
            modification.sessionValueAvailable = true;
          } else {
            modification.value = "";
            modification.sessionValueAvailable = false;
          }
        });
      });
    });
    return state;
  }

  function sanitizeStateForLocalStorage(inputState) {
    const state = normalizeState(inputState);
    const sensitiveIds = new Set();
    state.profiles.forEach((profile) => {
      profile.rules.forEach((rule) => {
        rule.modifications.forEach((modification) => {
          if (!modification.sessionOnly) return;
          sensitiveIds.add(modification.id);
          modification.value = "";
          modification.sessionValueAvailable = false;
        });
      });
    });
    if (state.rollbackSnapshot) {
      redactSnapshotSessionValues(state.rollbackSnapshot, sensitiveIds);
    }
    return state;
  }

  function redactSnapshotSessionValues(snapshot, sensitiveIds) {
    (snapshot.profiles || []).forEach((profile) => {
      (profile.rules || []).forEach((rule) => {
        (rule.modifications || []).forEach((modification) => {
          if (modification.sessionOnly !== true && !sensitiveIds.has(modification.id)) return;
          modification.sessionOnly = true;
          modification.sessionValueAvailable = false;
          modification.value = "";
        });
      });
    });
  }

  function normalizeMatch(rawMatch) {
    const raw = rawMatch && typeof rawMatch === "object" ? rawMatch : {};
    const resourceTypesProvided = Array.isArray(raw.resourceTypes);
    const resourceTypes = uniqueStrings(raw.resourceTypes)
      .filter((item) => DEFAULT_RESOURCE_TYPES.includes(item));
    const requestMethods = uniqueStrings(raw.requestMethods)
      .map((item) => item.toLowerCase())
      .filter((item) => REQUEST_METHODS.includes(item));
    return {
      patternType: raw.patternType === "regexFilter" ? "regexFilter" : "urlFilter",
      pattern: raw.pattern == null ? "*" : String(raw.pattern).trim(),
      caseSensitive: raw.caseSensitive === true,
      requestDomains: normalizeDomains(raw.requestDomains),
      excludedRequestDomains: normalizeDomains(raw.excludedRequestDomains),
      initiatorDomains: normalizeDomains(raw.initiatorDomains),
      excludedInitiatorDomains: normalizeDomains(raw.excludedInitiatorDomains),
      resourceTypes: resourceTypesProvided ? resourceTypes : [...DEFAULT_RESOURCE_TYPES],
      requestMethods,
      domainType: ["firstParty", "thirdParty"].includes(raw.domainType) ? raw.domainType : "all"
    };
  }

  function normalizeDeployments(items, limit) {
    if (!Array.isArray(items)) return [];
    return items
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: cleanText(item.id, 160) || createId("deployment"),
        timestamp: validIso(item.timestamp) || isoNow(),
        profileId: cleanText(item.profileId, 160),
        profileName: cleanText(item.profileName, MAX_PROFILE_NAME_LENGTH) || "Unknown profile",
        ruleCount: clampInteger(item.ruleCount, 0, MAX_DYNAMIC_HEADER_RULES, 0),
        modificationCount: clampInteger(item.modificationCount, 0, 50000, 0),
        reason: cleanText(item.reason, 160) || "Applied changes",
        status: item.status === "reconciled" ? "reconciled" : "success"
      }))
      .slice(0, limit);
  }

  function normalizeDiagnostics(items, limit) {
    if (!Array.isArray(items)) return [];
    return items
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: cleanText(item.id, 160) || createId("diagnostic"),
        timestamp: validIso(item.timestamp) || isoNow(),
        level: ["info", "warning", "error"].includes(item.level) ? item.level : "info",
        source: cleanText(item.source, 80) || "Runtime",
        message: cleanText(item.message, 500) || "No message",
        details: cleanText(item.details, 2000)
      }))
      .slice(0, limit);
  }

  function normalizeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.profiles)) return null;
    return {
      schemaVersion: SCHEMA_VERSION,
      extensionEnabled: snapshot.extensionEnabled !== false,
      activeProfileId: String(snapshot.activeProfileId || ""),
      profiles: clone(snapshot.profiles),
      nextDnrId: clampInteger(snapshot.nextDnrId, 1, 2147483647, 1),
      settings: Object.assign({}, snapshot.settings || {})
    };
  }

  function validIso(value) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return "";
    return new Date(value).toISOString();
  }

  function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function getActiveProfile(state) {
    return state.profiles.find((profile) => profile.id === state.activeProfileId) || state.profiles[0] || null;
  }

  function validateDomainList(values, label, errors) {
    values.forEach((domain) => {
      if (!DOMAIN_LABEL_PATTERN.test(domain) && domain !== "localhost") {
        errors.push(`${label} contains an invalid domain: ${domain}`);
      }
      if (!isAscii(domain)) {
        errors.push(`${label} must use ASCII or punycode domains: ${domain}`);
      }
    });
  }

  function validateModification(modification, index) {
    const errors = [];
    const label = `Modification ${index + 1}`;
    if (!["request", "response"].includes(modification.target)) {
      errors.push(`${label} has an invalid target.`);
    }
    if (!["set", "append", "remove"].includes(modification.operation)) {
      errors.push(`${label} has an invalid operation.`);
    }
    if (!modification.header || !HEADER_TOKEN_PATTERN.test(modification.header)) {
      errors.push(`${label} needs a valid HTTP header name.`);
    }
    const value = String(modification.value || "");
    if (/[\r\n\u0000]/.test(value)) {
      errors.push(`${label} contains a prohibited line break or null character.`);
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH) {
      errors.push(`${label} exceeds the ${MAX_HEADER_VALUE_LENGTH}-character value limit.`);
    }
    if (modification.target === "request" && modification.operation === "append") {
      if (!REQUEST_APPEND_ALLOWLIST.has(String(modification.header).toLowerCase())) {
        errors.push(`${label} cannot append to this request header in MonoHeader's portable browser rules. Use Set, or choose a supported append header.`);
      }
    }
    return errors;
  }

  function validateRule(rule) {
    const errors = [];
    const warnings = [];
    if (!rule.name || !cleanText(rule.name, MAX_RULE_NAME_LENGTH)) {
      errors.push("Rule name is required.");
    }
    if (!Number.isSafeInteger(rule.dnrId) || rule.dnrId < 1) {
      errors.push("Rule has no valid internal DNR identifier.");
    }
    if (!Number.isInteger(rule.priority) || rule.priority < 1 || rule.priority > 100000) {
      errors.push("Priority must be an integer from 1 to 100,000.");
    }
    if (!rule.match || !["urlFilter", "regexFilter"].includes(rule.match.patternType)) {
      errors.push("Select a valid match type.");
    } else {
      const pattern = String(rule.match.pattern || "");
      if (!pattern) errors.push("A URL pattern is required.");
      if (!isAscii(pattern)) errors.push("DNR URL patterns must contain ASCII characters only.");
      if (rule.match.patternType === "urlFilter" && pattern.startsWith("||*")) {
        errors.push('A URL filter cannot begin with "||*". Use "*" to match all URLs.');
      }
      if (rule.match.patternType === "regexFilter") {
        try {
          new RegExp(pattern);
        } catch (error) {
          errors.push(`Regular expression is invalid: ${error.message}`);
        }
      }
    }
    validateDomainList(rule.match.requestDomains || [], "Included request domains", errors);
    validateDomainList(rule.match.excludedRequestDomains || [], "Excluded request domains", errors);
    validateDomainList(rule.match.initiatorDomains || [], "Included initiator domains", errors);
    validateDomainList(rule.match.excludedInitiatorDomains || [], "Excluded initiator domains", errors);
    if (!Array.isArray(rule.match.resourceTypes) || rule.match.resourceTypes.length === 0) {
      errors.push("Select at least one resource type.");
    }
    if (!Array.isArray(rule.modifications) || rule.modifications.length === 0) {
      errors.push("Add at least one header modification.");
    } else {
      rule.modifications.forEach((modification, index) => {
        errors.push(...validateModification(modification, index));
        if (
          modification.sessionOnly &&
          modification.operation !== "remove" &&
          !modification.sessionValueAvailable
        ) {
          warnings.push(
            `The session-only value for "${modification.header || `modification ${index + 1}`}" is unavailable and will remain inactive until it is re-entered.`
          );
        }
      });
    }

    const targetHeaderOperations = new Map();
    (rule.modifications || []).forEach((modification) => {
      const key = `${modification.target}:${String(modification.header).toLowerCase()}`;
      const previousModification = targetHeaderOperations.get(key);
      if (previousModification) {
        warnings.push(`The header "${modification.header}" is modified more than once in this rule.`);
        if (
          modification.header &&
          previousModification.sessionOnly !== modification.sessionOnly
        ) {
          errors.push(
            `The header "${modification.header}" cannot mix Persistent and This session values in one rule because browsers do not guarantee portable equal-priority ordering across rulesets. Use one lifetime or separate rules with different priorities.`
          );
        }
      }
      targetHeaderOperations.set(key, modification);
    });
    return { valid: errors.length === 0, errors, warnings };
  }

  function validateState(state) {
    const normalized = normalizeState(state);
    const errors = [];
    const warnings = [];
    const activeProfile = getActiveProfile(normalized);
    if (!activeProfile) {
      errors.push("No active profile is available.");
      return { valid: false, errors, warnings, normalized };
    }
    const enabledRules = normalized.extensionEnabled
      ? activeProfile.rules.filter((rule) => rule.enabled)
      : [];
    if (enabledRules.length > MAX_DYNAMIC_HEADER_RULES) {
      errors.push(`The active profile has ${enabledRules.length} enabled header rules; MonoHeader's portable limit is ${MAX_DYNAMIC_HEADER_RULES}.`);
    }
    const regexCount = enabledRules.filter((rule) => rule.match.patternType === "regexFilter").length;
    if (regexCount > MAX_REGEX_RULES) {
      errors.push(`The active profile has ${regexCount} regular-expression rules; MonoHeader's portable limit is ${MAX_REGEX_RULES}.`);
    }
    const ids = new Set();
    normalized.profiles.forEach((profile) => {
      profile.rules.forEach((rule) => {
        if (ids.has(rule.dnrId)) errors.push(`Internal DNR rule identifier ${rule.dnrId} is duplicated.`);
        ids.add(rule.dnrId);
        const result = validateRule(rule);
        if (profile.id === activeProfile.id && rule.enabled && normalized.extensionEnabled) {
          result.errors.forEach((message) => errors.push(`${rule.name}: ${message}`));
          result.warnings.forEach((message) => warnings.push(`${rule.name}: ${message}`));
        }
      });
    });
    return { valid: errors.length === 0, errors, warnings, normalized };
  }

  function compileState(input) {
    const result = validateState(input);
    if (!result.valid) {
      const error = new Error(result.errors.join("\n"));
      error.name = "ValidationError";
      error.validation = {
        valid: false,
        errors: [...result.errors],
        warnings: [...result.warnings]
      };
      throw error;
    }
    const state = result.normalized;
    const activeProfile = getActiveProfile(state);
    if (!state.extensionEnabled) {
      return {
        state,
        profile: activeProfile,
        rules: [],
        dynamicRules: [],
        sessionRules: [],
        logicalRuleCount: 0,
        warnings: result.warnings
      };
    }
    const dynamicRules = [];
    const sessionRules = [];
    const enabledRules = activeProfile.rules.filter((rule) => rule.enabled);
    enabledRules.forEach((rule) => {
      const persistentModifications = rule.modifications.filter((modification) => (
        !modification.sessionOnly
      ));
      const availableSessionModifications = rule.modifications.filter((modification) => (
        modification.sessionOnly && modification.sessionValueAvailable
      ));
      if (persistentModifications.length) {
        dynamicRules.push(compileRule(rule, persistentModifications));
      }
      if (availableSessionModifications.length) {
        sessionRules.push(compileRule(rule, availableSessionModifications));
      }
    });
    dynamicRules.sort((left, right) => left.id - right.id);
    sessionRules.sort((left, right) => left.id - right.id);
    return {
      state,
      profile: activeProfile,
      rules: dynamicRules,
      dynamicRules,
      sessionRules,
      logicalRuleCount: new Set([
        ...dynamicRules.map((rule) => rule.id),
        ...sessionRules.map((rule) => rule.id)
      ]).size,
      warnings: result.warnings
    };
  }

  function compileRule(rule, selectedModifications) {
    const requestHeaders = [];
    const responseHeaders = [];
    const modifications = Array.isArray(selectedModifications)
      ? selectedModifications
      : rule.modifications;
    modifications.forEach((modification) => {
      const compiled = {
        header: modification.target === "request" && modification.operation === "append"
          ? modification.header.toLowerCase()
          : modification.header,
        operation: modification.operation
      };
      if (modification.operation !== "remove") compiled.value = modification.value;
      if (modification.target === "response") responseHeaders.push(compiled);
      else requestHeaders.push(compiled);
    });

    const action = { type: "modifyHeaders" };
    if (requestHeaders.length) action.requestHeaders = requestHeaders;
    if (responseHeaders.length) action.responseHeaders = responseHeaders;
    const condition = {
      resourceTypes: [...rule.match.resourceTypes]
    };
    condition[rule.match.patternType] = rule.match.pattern;
    if (rule.match.caseSensitive) condition.isUrlFilterCaseSensitive = true;
    copyArrayCondition(condition, "requestDomains", rule.match.requestDomains);
    copyArrayCondition(condition, "excludedRequestDomains", rule.match.excludedRequestDomains);
    copyArrayCondition(condition, "initiatorDomains", rule.match.initiatorDomains);
    copyArrayCondition(condition, "excludedInitiatorDomains", rule.match.excludedInitiatorDomains);
    copyArrayCondition(condition, "requestMethods", rule.match.requestMethods);
    if (rule.match.domainType !== "all") condition.domainType = rule.match.domainType;

    return {
      id: rule.dnrId,
      priority: rule.priority,
      action,
      condition
    };
  }

  function copyArrayCondition(target, key, value) {
    if (Array.isArray(value) && value.length) target[key] = [...value];
  }

  function configurationSnapshot(state) {
    const normalized = sanitizeStateForLocalStorage(state);
    return {
      schemaVersion: SCHEMA_VERSION,
      extensionEnabled: normalized.extensionEnabled,
      activeProfileId: normalized.activeProfileId,
      profiles: clone(normalized.profiles),
      nextDnrId: normalized.nextDnrId,
      settings: clone(normalized.settings)
    };
  }

  function restoreSnapshot(currentState, snapshot) {
    const normalizedCurrent = normalizeState(currentState);
    const normalizedSnapshot = normalizeSnapshot(snapshot);
    if (!normalizedSnapshot) throw new Error("No valid rollback snapshot is available.");
    return normalizeState(Object.assign({}, normalizedCurrent, normalizedSnapshot, {
      deployments: normalizedCurrent.deployments,
      diagnostics: normalizedCurrent.diagnostics,
      rollbackSnapshot: configurationSnapshot(normalizedCurrent)
    }));
  }

  function createDeployment(state, compiled, reason, status) {
    const modificationCount = compiled.profile
      ? compiled.profile.rules
        .filter((rule) => state.extensionEnabled && rule.enabled)
        .reduce((count, rule) => count + rule.modifications.length, 0)
      : 0;
    return {
      id: createId("deployment"),
      timestamp: isoNow(),
      profileId: compiled.profile ? compiled.profile.id : "",
      profileName: compiled.profile ? compiled.profile.name : "No profile",
      ruleCount: Number.isInteger(compiled.logicalRuleCount)
        ? compiled.logicalRuleCount
        : compiled.rules.length,
      modificationCount,
      reason: cleanText(reason, 160) || "Applied changes",
      status: status === "reconciled" ? "reconciled" : "success"
    };
  }

  function createDiagnostic(level, source, message, details) {
    return {
      id: createId("diagnostic"),
      timestamp: isoNow(),
      level: ["info", "warning", "error"].includes(level) ? level : "info",
      source: cleanText(source, 80) || "Runtime",
      message: cleanText(message, 500) || "No message",
      details: cleanText(details, 2000)
    };
  }

  function addDiagnostic(state, diagnostic) {
    const normalized = normalizeState(state);
    normalized.diagnostics = [diagnostic, ...normalized.diagnostics]
      .slice(0, normalized.settings.diagnosticsLimit);
    return normalized;
  }

  function addDeployment(state, deployment) {
    const normalized = normalizeState(state);
    normalized.deployments = [deployment, ...normalized.deployments]
      .slice(0, normalized.settings.deploymentHistoryLimit);
    return normalized;
  }

  function createExport(state) {
    return {
      format: EXPORT_FORMAT,
      version: SCHEMA_VERSION,
      exportedAt: isoNow(),
      source: {
        name: APP_NAME,
        version: APP_VERSION
      },
      configuration: configurationSnapshot(state)
    };
  }

  function parseImport(input) {
    let data = input;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (error) {
        throw new Error(`The selected file is not valid JSON: ${error.message}`);
      }
    }
    if (!data || typeof data !== "object") {
      throw new Error("The import file must contain a JSON object.");
    }
    if (data.format === EXPORT_FORMAT) {
      if (Number(data.version) > SCHEMA_VERSION) {
        throw new Error(`This file uses MonoHeader format version ${data.version}, which is newer than this extension supports.`);
      }
      if (!data.configuration || !Array.isArray(data.configuration.profiles)) {
        throw new Error("The MonoHeader export does not contain a valid configuration.");
      }
      const state = normalizeState(data.configuration);
      const validation = validateState(state);
      return {
        state: validation.normalized,
        source: "MonoHeader",
        warnings: validation.warnings,
        errors: validation.errors
      };
    }
    const legacy = parseLegacyModHeader(data);
    if (legacy) return legacy;
    throw new Error("Unsupported import format. Select a MonoHeader export or a compatible ModHeader profile export.");
  }

  function parseLegacyModHeader(data) {
    let rawProfiles = data.profiles;
    if (!rawProfiles && Array.isArray(data)) rawProfiles = data;
    if (rawProfiles && !Array.isArray(rawProfiles) && typeof rawProfiles === "object") {
      rawProfiles = Object.values(rawProfiles);
    }
    if (!Array.isArray(rawProfiles) || rawProfiles.length === 0) return null;
    const looksCompatible = rawProfiles.some((profile) =>
      profile && (Array.isArray(profile.headers) || Array.isArray(profile.respHeaders) || Array.isArray(profile.responseHeaders))
    );
    if (!looksCompatible) return null;

    const state = createDefaultState();
    state.profiles = rawProfiles.map((rawProfile, profileIndex) => {
      const profile = createProfile(rawProfile.title || rawProfile.name || `Imported ${profileIndex + 1}`);
      const requestHeaders = Array.isArray(rawProfile.headers) ? rawProfile.headers : [];
      const responseHeaders = Array.isArray(rawProfile.respHeaders)
        ? rawProfile.respHeaders
        : (Array.isArray(rawProfile.responseHeaders) ? rawProfile.responseHeaders : []);
      const filters = Array.isArray(rawProfile.filters) ? rawProfile.filters : [];
      const pattern = legacyFilterPattern(filters);
      const createLegacyRule = (header, target, index) => {
        const operation = normalizeLegacyOperation(header);
        return createRule({
          name: cleanText(header.comment || header.name, MAX_RULE_NAME_LENGTH) || `${target === "request" ? "Request" : "Response"} header ${index + 1}`,
          enabled: header.enabled !== false,
          match: {
            patternType: "urlFilter",
            pattern,
            resourceTypes: [...DEFAULT_RESOURCE_TYPES]
          },
          modifications: [{
            target,
            operation,
            header: String(header.name || "").trim(),
            value: operation === "remove" ? "" : String(header.value || "")
          }]
        });
      };
      profile.rules = [
        ...requestHeaders.map((header, index) => createLegacyRule(header || {}, "request", index)),
        ...responseHeaders.map((header, index) => createLegacyRule(header || {}, "response", index))
      ];
      return profile;
    });
    state.activeProfileId = state.profiles[0].id;
    state.nextDnrId = 1;
    const normalized = normalizeState(state);
    const validation = validateState(normalized);
    return {
      state: validation.normalized,
      source: "ModHeader",
      warnings: [
        "Imported ModHeader entries were converted to individual MonoHeader rules.",
        "Review URL filters and any advanced ModHeader conditions before applying.",
        ...validation.warnings
      ],
      errors: validation.errors
    };
  }

  function legacyFilterPattern(filters) {
    const enabled = filters.filter((filter) => filter && filter.enabled !== false);
    if (enabled.length !== 1) return "*";
    const value = String(enabled[0].urlPattern || enabled[0].pattern || enabled[0].value || "").trim();
    return value && isAscii(value) ? value : "*";
  }

  function normalizeLegacyOperation(header) {
    const raw = String(header.operation || header.type || "").toLowerCase();
    if (raw.includes("remove")) return "remove";
    if (raw.includes("append")) return "append";
    return "set";
  }

  function matchRuleLocally(rule, url, context) {
    if (!rule || !rule.enabled) return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      return false;
    }
    const match = rule.match || {};
    const candidate = match.caseSensitive ? parsed.href : parsed.href.toLowerCase();
    const rawPattern = String(match.pattern || "*");
    const pattern = match.caseSensitive ? rawPattern : rawPattern.toLowerCase();
    let patternMatches = false;
    if (match.patternType === "regexFilter") {
      try {
        patternMatches = new RegExp(rawPattern, match.caseSensitive ? "" : "i").test(parsed.href);
      } catch (_error) {
        return false;
      }
    } else {
      patternMatches = testUrlFilter(pattern, candidate, parsed.hostname.toLowerCase());
    }
    if (!patternMatches) return false;
    if (!domainListMatches(parsed.hostname, match.requestDomains, true)) return false;
    if (domainListMatches(parsed.hostname, match.excludedRequestDomains, false)) return false;
    const requestMethod = String(context && context.method || "").toLowerCase();
    if (match.requestMethods && match.requestMethods.length && requestMethod && !match.requestMethods.includes(requestMethod)) {
      return false;
    }
    const resourceType = String(context && context.resourceType || "");
    if (match.resourceTypes && match.resourceTypes.length && resourceType && !match.resourceTypes.includes(resourceType)) {
      return false;
    }
    const initiatorDomain = normalizeDomain(context && (
      context.initiatorDomain || context.initiatorUrl
    ));
    if (
      match.initiatorDomains &&
      match.initiatorDomains.length &&
      initiatorDomain &&
      !domainListMatches(initiatorDomain, match.initiatorDomains, false)
    ) {
      return false;
    }
    if (
      match.excludedInitiatorDomains &&
      match.excludedInitiatorDomains.length &&
      initiatorDomain &&
      domainListMatches(initiatorDomain, match.excludedInitiatorDomains, false)
    ) {
      return false;
    }
    const domainType = context && context.domainType;
    if (
      match.domainType &&
      match.domainType !== "all" &&
      ["firstParty", "thirdParty"].includes(domainType) &&
      match.domainType !== domainType
    ) {
      return false;
    }
    return true;
  }

  function inspectEffectiveHeaders(inputState, inputUrl, inputContext) {
    const state = normalizeState(inputState);
    const profile = getActiveProfile(state);
    let parsed;
    try {
      parsed = new URL(String(inputUrl || "").trim());
    } catch (_error) {
      throw new Error("Enter a complete URL, including http:// or https://.");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("The rule inspector supports HTTP and HTTPS request URLs.");
    }
    const context = normalizeInspectionContext(parsed, inputContext);
    const matchingRules = profile
      ? profile.rules
        .filter((rule) => rule.enabled && matchRuleLocally(rule, parsed.href, context))
        .sort(compareInspectorRules)
      : [];
    const operationGroups = new Map();
    const unavailableSessionModifications = [];
    matchingRules.forEach((rule) => {
      rule.modifications.forEach((modification, modificationIndex) => {
        const headerKey = String(modification.header || "").toLowerCase();
        if (!headerKey) return;
        if (modification.sessionOnly && !modification.sessionValueAvailable) {
          unavailableSessionModifications.push({
            ruleId: rule.id,
            ruleName: rule.name,
            modificationId: modification.id,
            target: modification.target,
            operation: modification.operation,
            header: modification.header
          });
          return;
        }
        const key = `${modification.target}:${headerKey}`;
        if (!operationGroups.has(key)) operationGroups.set(key, []);
        operationGroups.get(key).push({
          ruleId: rule.id,
          dnrId: rule.dnrId,
          ruleName: rule.name,
          priority: rule.priority,
          modificationId: modification.id,
          modificationIndex,
          target: modification.target,
          operation: modification.operation,
          header: modification.header,
          value: modification.operation === "remove" ? "" : modification.value,
          sessionOnly: modification.sessionOnly,
          status: "pending",
          reason: ""
        });
      });
    });

    const headers = [...operationGroups.values()]
      .map(resolveHeaderOperations)
      .sort((left, right) => (
        left.target.localeCompare(right.target) ||
        left.header.toLowerCase().localeCompare(right.header.toLowerCase())
      ));
    return {
      active: state.extensionEnabled,
      profileId: profile ? profile.id : "",
      profileName: profile ? profile.name : "No profile",
      url: parsed.href,
      context,
      matchingRules: matchingRules.map((rule) => ({
        id: rule.id,
        dnrId: rule.dnrId,
        name: rule.name,
        priority: rule.priority,
        patternType: rule.match.patternType,
        pattern: rule.match.pattern,
        modificationCount: rule.modifications.length
      })),
      unavailableSessionModifications,
      unavailableSessionValueCount: unavailableSessionModifications.length,
      headers,
      conflictCount: headers.filter((header) => header.hasConflict).length,
      ambiguousCount: headers.filter((header) => header.ambiguous).length,
      resolvedConflictCount: headers.filter((header) => (
        header.hasConflict && !header.ambiguous && header.shadowedCount > 0
      )).length,
      compatibleConflictCount: headers.filter((header) => (
        header.hasConflict && !header.ambiguous && header.shadowedCount === 0
      )).length,
      shadowedOperationCount: headers.reduce((count, header) => count + header.shadowedCount, 0)
    };
  }

  function normalizeInspectionContext(parsedUrl, input) {
    const raw = input && typeof input === "object" ? input : {};
    const method = String(raw.method || "get").toLowerCase();
    const resourceType = String(raw.resourceType || "xmlhttprequest");
    const initiatorDomain = normalizeDomain(raw.initiatorDomain || raw.initiatorUrl) ||
      parsedUrl.hostname.toLowerCase();
    return {
      method: REQUEST_METHODS.includes(method) ? method : "get",
      resourceType: DEFAULT_RESOURCE_TYPES.includes(resourceType)
        ? resourceType
        : "xmlhttprequest",
      initiatorDomain,
      domainType: raw.domainType === "thirdParty" ? "thirdParty" : "firstParty"
    };
  }

  function compareInspectorRules(left, right) {
    return right.priority - left.priority || left.dnrId - right.dnrId;
  }

  function compareInspectorOperations(left, right) {
    return right.priority - left.priority ||
      left.dnrId - right.dnrId ||
      left.modificationIndex - right.modificationIndex;
  }

  function resolveHeaderOperations(inputOperations) {
    const operations = inputOperations.map((operation) => ({ ...operation }))
      .sort(compareInspectorOperations);
    const priorityGroups = [];
    operations.forEach((operation) => {
      const current = priorityGroups[priorityGroups.length - 1];
      if (!current || current.priority !== operation.priority) {
        priorityGroups.push({ priority: operation.priority, operations: [operation] });
      } else {
        current.operations.push(operation);
      }
    });

    let policy = "all";
    let orderUncertain = false;
    priorityGroups.forEach((group) => {
      if (policy === "uncertain") {
        group.operations.forEach((operation) => {
          operation.status = "uncertain";
          operation.reason = "The result depends on unresolved equal-priority operations above.";
        });
        return;
      }
      if (policy === "none") {
        group.operations.forEach((operation) => {
          operation.status = "shadowed";
          operation.reason = "A higher-priority Remove prevents lower-priority changes.";
        });
        return;
      }
      if (policy === "append-only") {
        const appends = group.operations.filter((operation) => operation.operation === "append");
        const blocked = group.operations.filter((operation) => operation.operation !== "append");
        appends.forEach((operation) => {
          operation.status = "applied";
          operation.reason = "Append remains compatible with the higher-priority result.";
        });
        blocked.forEach((operation) => {
          operation.status = "shadowed";
          operation.reason = "A higher-priority Set or Append permits only lower-priority Append operations.";
        });
        if (appends.length > 1) orderUncertain = true;
        return;
      }

      const operationKinds = new Set(group.operations.map((operation) => operation.operation));
      const setValues = new Set(
        group.operations
          .filter((operation) => operation.operation === "set")
          .map((operation) => operation.value)
      );
      const incompatible = operationKinds.size > 1 ||
        (operationKinds.has("set") && setValues.size > 1);
      if (incompatible) {
        group.operations.forEach((operation) => {
          operation.status = "ambiguous";
          operation.reason = "Equal-priority operations have no guaranteed portable evaluation order across browsers.";
        });
        policy = "uncertain";
        return;
      }

      const operationKind = group.operations[0].operation;
      if (operationKind === "append") {
        group.operations.forEach((operation) => {
          operation.status = "applied";
          operation.reason = group.operations.length > 1
            ? "All Appends apply, but their equal-priority order is not guaranteed."
            : "Highest-priority operation.";
        });
        orderUncertain = group.operations.length > 1;
        policy = "append-only";
        return;
      }

      group.operations.forEach((operation, index) => {
        operation.status = index === 0 ? "applied" : "redundant";
        operation.reason = index === 0
          ? "Highest-priority operation."
          : `Equivalent equal-priority ${operationKind === "set" ? "Set value" : "Remove"}; the result is unchanged.`;
      });
      policy = operationKind === "remove" ? "none" : "append-only";
    });

    const ambiguous = operations.some((operation) => (
      operation.status === "ambiguous" || operation.status === "uncertain"
    ));
    const applied = operations.filter((operation) => operation.status === "applied");
    const lead = applied.find((operation) => operation.operation !== "append") || applied[0] || null;
    const effective = ambiguous
      ? { kind: "ambiguous", lead: null, appends: [] }
      : lead && lead.operation === "remove"
        ? { kind: "remove", lead, appends: [] }
        : lead && lead.operation === "set"
          ? {
            kind: "set",
            lead,
            appends: applied.filter((operation) => operation.operation === "append")
          }
          : {
            kind: applied.length ? "append" : "none",
            lead,
            appends: applied.filter((operation) => operation.operation === "append")
          };
    const shadowedCount = operations.filter((operation) => operation.status === "shadowed").length;
    return {
      target: operations[0].target,
      header: operations[0].header,
      hasConflict: operations.length > 1,
      ambiguous,
      orderUncertain,
      shadowedCount,
      operations,
      effective
    };
  }

  function domainListMatches(hostname, domains, emptyResult) {
    if (!Array.isArray(domains) || domains.length === 0) return emptyResult;
    const host = String(hostname || "").toLowerCase();
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  }

  function testUrlFilter(filter, url) {
    if (filter === "*") return true;
    const domainAnchored = filter.startsWith("||");
    const leftAnchored = !domainAnchored && filter.startsWith("|");
    const rightAnchored = filter.endsWith("|") && filter.length > 1;
    const bodyStart = domainAnchored ? 2 : leftAnchored ? 1 : 0;
    const bodyEnd = rightAnchored ? -1 : undefined;
    const body = filter.slice(bodyStart, bodyEnd);
    if (!body) return false;
    const escaped = body
      .replace(/[.+?${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\^/g, "(?:[^A-Za-z0-9_.%-]|$)");
    try {
      const prefix = domainAnchored
        ? "^[A-Za-z][A-Za-z0-9+.-]*://(?:[^./?#]+\\.)*"
        : leftAnchored
          ? "^"
          : "";
      const regex = new RegExp(`${prefix}${escaped}${rightAnchored ? "$" : ""}`);
      return regex.test(url);
    } catch (_error) {
      return false;
    }
  }

  function dnrSignature(rules) {
    return JSON.stringify(
      [...(rules || [])]
        .sort((left, right) => left.id - right.id)
        .map((rule) => ({
          id: rule.id,
          priority: rule.priority,
          action: rule.action,
          condition: rule.condition
        }))
    );
  }

  function isAscii(value) {
    return /^[\x00-\x7F]*$/.test(String(value));
  }

  return Object.freeze({
    APP_NAME,
    APP_VERSION,
    SCHEMA_VERSION,
    EXPORT_FORMAT,
    MAX_DYNAMIC_HEADER_RULES,
    MAX_REGEX_RULES,
    MAX_HEADER_VALUE_LENGTH,
    DEFAULT_RESOURCE_TYPES,
    REQUEST_METHODS,
    REQUEST_APPEND_ALLOWLIST,
    createId,
    createModification,
    createRule,
    createProfile,
    createDefaultState,
    normalizeState,
    normalizeDomain,
    extractSessionHeaderValues,
    hydrateSessionHeaderValues,
    sanitizeStateForLocalStorage,
    validateModification,
    validateRule,
    validateState,
    compileRule,
    compileState,
    getActiveProfile,
    configurationSnapshot,
    restoreSnapshot,
    createDeployment,
    createDiagnostic,
    addDiagnostic,
    addDeployment,
    createExport,
    parseImport,
    matchRuleLocally,
    inspectEffectiveHeaders,
    dnrSignature,
    clone
  });
});
