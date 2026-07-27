"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const Core = require("../core.js");

const backgroundSource = readFileSync(join(__dirname, "..", "background.js"), "utf8");

function makeRule(dnrId, name) {
  return Core.createRule({
    dnrId,
    name: name || `Rule ${dnrId}`,
    match: {
      patternType: "urlFilter",
      pattern: "*",
      resourceTypes: ["main_frame", "xmlhttprequest"]
    },
    modifications: [{
      target: "request",
      operation: "set",
      header: "X-MonoHeader-Test",
      value: String(dnrId)
    }]
  });
}

function makeState(rules) {
  const profile = Core.createProfile("Test", { rules });
  return Core.normalizeState({
    extensionEnabled: true,
    activeProfileId: profile.id,
    profiles: [profile],
    nextDnrId: 100
  });
}

function makeSessionRule(dnrId, value, available) {
  return Core.createRule({
    id: `session-rule-${dnrId}`,
    dnrId,
    name: `Session rule ${dnrId}`,
    match: {
      patternType: "urlFilter",
      pattern: "*",
      resourceTypes: ["main_frame", "xmlhttprequest"]
    },
    modifications: [{
      id: `session-mod-${dnrId}`,
      target: "request",
      operation: "set",
      header: "Authorization",
      value: value == null ? "" : value,
      sessionOnly: true,
      sessionValueAvailable: available !== false
    }]
  });
}

function createHarness(seedState, initialRules, options) {
  const controls = {
    failDnrUpdates: 0,
    failSessionDnrUpdates: 0,
    failStorageSets: 0,
    failSessionStorageSets: 0,
    failScripting: 0,
    hangScripting: false,
    beforeAlarmClear: null,
    advanceClockDuringPingMs: 0,
    pingResult: {
      ok: true,
      status: 204,
      redirected: false,
      sameOrigin: true,
      error: ""
    }
  };
  const storage = {
    monoHeaderState: Core.clone(seedState),
    ...(options && options.sessionStore
      ? { monoHeaderSessionKeepAlive: Core.clone(options.sessionStore) }
      : {})
  };
  const sessionStorage = Core.clone(options && options.sessionStorage || {});
  let clockMs = options && Number.isFinite(options.nowMs) ? Number(options.nowMs) : null;
  const clockNow = () => clockMs == null ? Date.now() : clockMs;
  class HarnessDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clockNow()]));
    }

    static now() {
      return clockNow();
    }
  }
  let dynamicRules = Core.clone(initialRules || []);
  let sessionRules = Core.clone(options && options.sessionRules || []);
  const tabMap = new Map(
    (options && options.tabs || [{ id: 7, url: "https://app.example.com/dashboard?private=1" }])
      .map((tab) => [tab.id, Core.clone(tab)])
  );
  const alarms = new Map();
  const alarmCreateCalls = [];
  const scriptingCalls = [];
  const listeners = {};
  const chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onStartup: { addListener(listener) { listeners.startup = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } }
    },
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") {
            return {
              [key]: storage[key] === undefined ? undefined : Core.clone(storage[key])
            };
          }
          return Core.clone(storage);
        },
        async set(value) {
          if (controls.failStorageSets > 0) {
            controls.failStorageSets -= 1;
            throw new Error("simulated local quota failure");
          }
          Object.assign(storage, Core.clone(value));
        },
        async getBytesInUse() {
          return Buffer.byteLength(JSON.stringify(storage));
        },
        async setAccessLevel() {}
      },
      session: {
        async get(key) {
          if (typeof key === "string") {
            return {
              [key]: sessionStorage[key] === undefined
                ? undefined
                : Core.clone(sessionStorage[key])
            };
          }
          return Core.clone(sessionStorage);
        },
        async set(value) {
          if (controls.failSessionStorageSets > 0) {
            controls.failSessionStorageSets -= 1;
            throw new Error("simulated session quota failure");
          }
          Object.assign(sessionStorage, Core.clone(value));
        },
        async remove(key) {
          delete sessionStorage[key];
        },
        async getBytesInUse() {
          return Buffer.byteLength(JSON.stringify(sessionStorage));
        },
        async setAccessLevel() {}
      }
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        return Core.clone(dynamicRules);
      },
      async updateDynamicRules(update) {
        if (controls.failDnrUpdates > 0) {
          controls.failDnrUpdates -= 1;
          throw new Error("simulated DNR rejection");
        }
        const removed = new Set(update.removeRuleIds || []);
        dynamicRules = dynamicRules.filter((rule) => !removed.has(rule.id));
        dynamicRules.push(...Core.clone(update.addRules || []));
      },
      async getSessionRules() {
        return Core.clone(sessionRules);
      },
      async updateSessionRules(update) {
        if (controls.failSessionDnrUpdates > 0) {
          controls.failSessionDnrUpdates -= 1;
          throw new Error("simulated session DNR rejection");
        }
        const removed = new Set(update.removeRuleIds || []);
        sessionRules = sessionRules.filter((rule) => !removed.has(rule.id));
        sessionRules.push(...Core.clone(update.addRules || []));
      },
      async isRegexSupported() {
        return { isSupported: true };
      }
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setTitle() {}
    },
    alarms: {
      onAlarm: { addListener(listener) { listeners.alarm = listener; } },
      async create(name, alarmInfo) {
        alarmCreateCalls.push({ name, alarmInfo: Core.clone(alarmInfo) });
        alarms.set(name, {
          name,
          ...Core.clone(alarmInfo),
          scheduledTime: clockNow() + (alarmInfo.delayInMinutes || alarmInfo.periodInMinutes) * 60_000
        });
      },
      async get(name) {
        return alarms.has(name) ? Core.clone(alarms.get(name)) : undefined;
      },
      async clear(name) {
        if (typeof controls.beforeAlarmClear === "function") {
          await controls.beforeAlarmClear(name);
        }
        return alarms.delete(name);
      }
    },
    tabs: {
      onRemoved: { addListener(listener) { listeners.tabRemoved = listener; } },
      onUpdated: { addListener(listener) { listeners.tabUpdated = listener; } },
      async get(tabId) {
        if (!tabMap.has(tabId)) throw new Error("No tab with id");
        return Core.clone(tabMap.get(tabId));
      },
      async query() {
        return tabMap.size ? [Core.clone(tabMap.values().next().value)] : [];
      }
    },
    scripting: {
      async executeScript(injection) {
        scriptingCalls.push({
          target: Core.clone(injection.target),
          hasFunction: typeof injection.func === "function",
          args: Core.clone(injection.args || [])
        });
        if (controls.failScripting > 0) {
          controls.failScripting -= 1;
          throw new Error("simulated scripting failure");
        }
        if (controls.hangScripting) {
          return new Promise(() => {});
        }
        if (controls.advanceClockDuringPingMs > 0) {
          clockMs = clockNow() + controls.advanceClockDuringPingMs;
        }
        return [{ frameId: 0, result: Core.clone(controls.pingResult) }];
      }
    }
  };
  const context = vm.createContext({
    chrome,
    MonoHeaderCore: Core,
    importScripts() {},
    console,
    Buffer,
    URL,
    Date: HarnessDate,
    setTimeout(callback, delay, ...args) {
      const cappedDelay = options && Number.isFinite(options.timeoutCapMs)
        ? Math.min(delay, options.timeoutCapMs)
        : delay;
      return setTimeout(callback, cappedDelay, ...args);
    },
    clearTimeout
  });
  vm.runInContext(backgroundSource, context, { filename: "background.js" });
  return {
    context,
    controls,
    storage,
    sessionStorage,
    listeners,
    getDynamicRules: () => Core.clone(dynamicRules),
    getSessionRules: () => Core.clone(sessionRules),
    getAlarms: () => new Map([...alarms].map(([name, value]) => [name, Core.clone(value)])),
    getAlarmCreateCalls: () => Core.clone(alarmCreateCalls),
    getScriptingCalls: () => Core.clone(scriptingCalls),
    sendRuntimeMessage(message) {
      return new Promise((resolve) => {
        listeners.message(Core.clone(message), {}, resolve);
      });
    },
    setTab(tab) {
      if (tab) tabMap.set(tab.id, Core.clone(tab));
    },
    removeTab(tabId) {
      tabMap.delete(tabId);
    }
  };
}

test("background reports saved state and actual DNR runtime", async () => {
  const state = makeState([makeRule(1)]);
  const compiled = Core.compileState(state).rules;
  const harness = createHarness(state, compiled);
  const response = await harness.context.handleMessage({ action: "GET_STATE" });
  assert.equal(response.state.profiles[0].name, "Test");
  assert.equal(response.runtime.deployedRuleCount, 1);
  assert.equal(response.runtime.enabled, true);
});

test("successful background deployment updates DNR and retains a local audit record", async () => {
  const state = makeState([makeRule(1)]);
  const harness = createHarness(state, Core.compileState(state).rules);
  const candidate = Core.clone(state);
  candidate.profiles[0].rules.push(makeRule(2, "Second"));
  const response = await harness.context.handleMessage({
    action: "APPLY_STATE",
    state: candidate,
    reason: "Integration test"
  });
  assert.equal(harness.getDynamicRules().length, 2);
  assert.equal(response.state.deployments[0].reason, "Integration test");
  assert.match(response.state.diagnostics[0].message, /Applied 2 rules/i);
  assert.ok(response.state.rollbackSnapshot);
});

test("session-only header values use in-memory storage and DNR session rules only", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  const candidate = Core.clone(state);
  candidate.profiles[0].rules.push(makeSessionRule(7, "Bearer memory-only"));

  const response = await harness.context.handleMessage({
    action: "APPLY_STATE",
    state: candidate,
    reason: "Apply sensitive value"
  });

  assert.equal(harness.getDynamicRules().length, 0);
  assert.equal(harness.getSessionRules().length, 1);
  assert.match(JSON.stringify(harness.getSessionRules()), /Bearer memory-only/);
  assert.equal(response.runtime.deployedRuleCount, 1);
  assert.equal(response.runtime.deployedSessionRuleCount, 1);
  assert.equal(
    response.state.profiles[0].rules[0].modifications[0].value,
    "Bearer memory-only"
  );

  const localText = JSON.stringify(harness.storage.monoHeaderState);
  assert.doesNotMatch(localText, /Bearer memory-only/);
  assert.equal(
    harness.storage.monoHeaderState.profiles[0].rules[0].modifications[0].value,
    ""
  );
  assert.equal(
    harness.sessionStorage.monoHeaderSessionHeaderValues.values["session-mod-7"],
    "Bearer memory-only"
  );
});

test("a new browser session leaves sensitive modifications configured but inactive", async () => {
  const state = makeState([makeSessionRule(7, "Bearer memory-only")]);
  const localState = Core.sanitizeStateForLocalStorage(state);
  const harness = createHarness(localState, []);

  const response = await harness.context.handleMessage({ action: "GET_STATE" });
  const modification = response.state.profiles[0].rules[0].modifications[0];

  assert.equal(modification.sessionOnly, true);
  assert.equal(modification.sessionValueAvailable, false);
  assert.equal(modification.value, "");
  assert.equal(response.runtime.deployedRuleCount, 0);
  assert.equal(response.runtime.unavailableSessionValueCount, 1);
  assert.equal(harness.getSessionRules().length, 0);
});

test("service worker startup removes stale session rules when their in-memory values are gone", async () => {
  const state = makeState([makeSessionRule(7, "Bearer stale")]);
  const compiled = Core.compileState(state);
  const harness = createHarness(
    Core.sanitizeStateForLocalStorage(state),
    compiled.dynamicRules,
    { sessionRules: compiled.sessionRules }
  );

  const response = await harness.context.handleMessage({ action: "GET_STATE" });

  assert.equal(response.runtime.deployedRuleCount, 0);
  assert.equal(response.runtime.unavailableSessionValueCount, 1);
  assert.equal(harness.getSessionRules().length, 0);
  assert.doesNotMatch(JSON.stringify(harness.storage), /Bearer stale/);
});

test("a rejected session-rule deployment restores changed dynamic rules and saved state", async () => {
  const state = makeState([makeRule(1)]);
  const originalDynamic = Core.compileState(state).dynamicRules;
  const harness = createHarness(state, originalDynamic);
  const candidate = Core.clone(state);
  candidate.profiles[0].rules.push(
    makeRule(2, "Second persistent"),
    makeSessionRule(3, "Bearer rejected")
  );
  harness.controls.failSessionDnrUpdates = 1;

  await assert.rejects(
    harness.context.handleMessage({ action: "APPLY_STATE", state: candidate }),
    /Chrome rejected the rule deployment/i
  );

  assert.equal(
    Core.dnrSignature(harness.getDynamicRules()),
    Core.dnrSignature(originalDynamic)
  );
  assert.equal(harness.getSessionRules().length, 0);
  assert.equal(harness.storage.monoHeaderState.profiles[0].rules.length, 1);
  assert.deepEqual(harness.sessionStorage.monoHeaderSessionHeaderValues.values, {});
});

test("a local storage failure restores session rules and in-memory values", async () => {
  const state = makeState([makeRule(1)]);
  const originalDynamic = Core.compileState(state).dynamicRules;
  const harness = createHarness(state, originalDynamic);
  const candidate = Core.clone(state);
  candidate.profiles[0].rules.push(makeSessionRule(2, "Bearer rollback"));
  harness.controls.failStorageSets = 1;

  await assert.rejects(
    harness.context.handleMessage({ action: "APPLY_STATE", state: candidate }),
    /previous Chrome rules were restored/i
  );

  assert.equal(
    Core.dnrSignature(harness.getDynamicRules()),
    Core.dnrSignature(originalDynamic)
  );
  assert.equal(harness.getSessionRules().length, 0);
  assert.equal(harness.sessionStorage.monoHeaderSessionHeaderValues, undefined);
  assert.equal(harness.storage.monoHeaderState.profiles[0].rules.length, 1);
});

test("a Chrome DNR rejection leaves the previous configuration active", async () => {
  const state = makeState([makeRule(1)]);
  const originalRules = Core.compileState(state).rules;
  const harness = createHarness(state, originalRules);
  const candidate = Core.clone(state);
  candidate.profiles[0].name = "Rejected";
  candidate.profiles[0].rules.push(makeRule(2));
  harness.controls.failDnrUpdates = 1;
  await assert.rejects(
    harness.context.handleMessage({ action: "APPLY_STATE", state: candidate }),
    /Chrome rejected the rule deployment/i
  );
  assert.equal(harness.storage.monoHeaderState.profiles[0].name, "Test");
  assert.equal(harness.getDynamicRules().length, 1);
  assert.equal(harness.storage.monoHeaderState.diagnostics[0].level, "error");
});

test("a local storage failure rolls the DNR runtime back to its prior rules", async () => {
  const state = makeState([makeRule(1)]);
  const originalRules = Core.compileState(state).rules;
  const harness = createHarness(state, originalRules);
  const candidate = Core.clone(state);
  candidate.profiles[0].rules.push(makeRule(2));
  harness.controls.failStorageSets = 1;
  await assert.rejects(
    harness.context.handleMessage({ action: "APPLY_STATE", state: candidate }),
    /previous Chrome rules were restored/i
  );
  assert.equal(Core.dnrSignature(harness.getDynamicRules()), Core.dnrSignature(originalRules));
  assert.equal(harness.storage.monoHeaderState.profiles[0].rules.length, 1);
});

test("factory reset clears configuration, history, diagnostics, rollback, and DNR rules", async () => {
  const state = makeState([makeRule(1)]);
  state.deployments = [Core.createDeployment(state, Core.compileState(state), "Earlier", "success")];
  state.diagnostics = [Core.createDiagnostic("warning", "Test", "Earlier")];
  state.rollbackSnapshot = Core.configurationSnapshot(state);
  const harness = createHarness(state, Core.compileState(state).rules);
  const response = await harness.context.handleMessage({ action: "RESET" });
  assert.equal(response.state.profiles.length, 1);
  assert.equal(response.state.profiles[0].rules.length, 0);
  assert.equal(response.state.deployments.length, 0);
  assert.equal(response.state.diagnostics.length, 0);
  assert.equal(response.state.rollbackSnapshot, null);
  assert.equal(harness.getDynamicRules().length, 0);
});

test("factory reset clears session-only values and DNR session rules", async () => {
  const state = makeState([makeSessionRule(7, "Bearer erase-me")]);
  const compiled = Core.compileState(state);
  const harness = createHarness(
    Core.sanitizeStateForLocalStorage(state),
    compiled.dynamicRules,
    {
      sessionRules: compiled.sessionRules,
      sessionStorage: {
        monoHeaderSessionHeaderValues: {
          version: 1,
          values: { "session-mod-7": "Bearer erase-me" }
        }
      }
    }
  );

  await harness.context.handleMessage({ action: "RESET" });

  assert.equal(harness.getDynamicRules().length, 0);
  assert.equal(harness.getSessionRules().length, 0);
  assert.deepEqual(harness.sessionStorage.monoHeaderSessionHeaderValues.values, {});
  assert.doesNotMatch(JSON.stringify(harness.storage), /erase-me/);
});

test("quick add creates and atomically applies a low-priority global request-header rule", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  const response = await harness.context.handleMessage({
    action: "QUICK_ADD_HEADER",
    header: "X-Environment",
    value: "development"
  });
  const rule = response.state.profiles[0].rules[0];
  assert.equal(response.quickAdd.created, true);
  assert.equal(response.quickAdd.applied, true);
  assert.equal(rule.priority, 10);
  assert.equal(rule.match.patternType, "urlFilter");
  assert.equal(rule.match.pattern, "*");
  assert.equal(rule.match.requestDomains.length, 0);
  assert.equal(rule.match.initiatorDomains.length, 0);
  assert.deepEqual([...rule.match.resourceTypes].sort(), [...Core.DEFAULT_RESOURCE_TYPES].sort());
  assert.equal(rule.modifications.length, 1);
  assert.deepEqual(
    {
      target: rule.modifications[0].target,
      operation: rule.modifications[0].operation,
      header: rule.modifications[0].header,
      value: rule.modifications[0].value
    },
    {
      target: "request",
      operation: "set",
      header: "X-Environment",
      value: "development"
    }
  );
  assert.equal(harness.getDynamicRules().length, 1);
});

test("quick add can keep a global value in the browser session only", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  const response = await harness.context.handleMessage({
    action: "QUICK_ADD_HEADER",
    header: "Authorization",
    value: "Bearer quick-secret",
    sessionOnly: true
  });
  const modification = response.state.profiles[0].rules[0].modifications[0];

  assert.equal(response.quickAdd.sessionOnly, true);
  assert.equal(modification.sessionOnly, true);
  assert.equal(modification.sessionValueAvailable, true);
  assert.equal(modification.value, "Bearer quick-secret");
  assert.equal(harness.getDynamicRules().length, 0);
  assert.equal(harness.getSessionRules().length, 1);
  assert.doesNotMatch(JSON.stringify(harness.storage.monoHeaderState), /quick-secret/);
  assert.equal(
    harness.sessionStorage.monoHeaderSessionHeaderValues.values[modification.id],
    "Bearer quick-secret"
  );
});

test("quick adding the same global header updates its value without creating a conflict", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  const first = await harness.context.handleMessage({
    action: "QUICK_ADD_HEADER",
    header: "X-Environment",
    value: "development"
  });
  const firstDnrId = first.state.profiles[0].rules[0].dnrId;
  const second = await harness.context.handleMessage({
    action: "QUICK_ADD_HEADER",
    header: "x-environment",
    value: "staging"
  });
  assert.equal(second.quickAdd.created, false);
  assert.equal(second.state.profiles[0].rules.length, 1);
  assert.equal(second.state.profiles[0].rules[0].dnrId, firstDnrId);
  assert.equal(second.state.profiles[0].rules[0].modifications[0].value, "staging");
  assert.equal(harness.getDynamicRules().length, 1);
});

test("quick add saves while paused without silently enabling MonoHeader", async () => {
  const state = makeState([]);
  state.extensionEnabled = false;
  const harness = createHarness(state, []);
  const response = await harness.context.handleMessage({
    action: "QUICK_ADD_HEADER",
    header: "X-Paused",
    value: "saved"
  });
  assert.equal(response.state.extensionEnabled, false);
  assert.equal(response.state.profiles[0].rules.length, 1);
  assert.equal(response.quickAdd.applied, false);
  assert.equal(harness.getDynamicRules().length, 0);
});

test("quick add rejects malformed names and header-value injection", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  await assert.rejects(
    harness.context.handleMessage({
      action: "QUICK_ADD_HEADER",
      header: "Bad Header",
      value: "safe"
    }),
    /valid HTTP header name/i
  );
  await assert.rejects(
    harness.context.handleMessage({
      action: "QUICK_ADD_HEADER",
      header: "X-Test",
      value: "safe\r\nInjected: yes"
    }),
    /prohibited line break/i
  );
  assert.equal(harness.storage.monoHeaderState.profiles[0].rules.length, 0);
  assert.equal(harness.getDynamicRules().length, 0);
});

test("popup rule toggle atomically disables and re-enables a rule", async () => {
  const firstRule = makeRule(1, "First");
  const secondRule = makeRule(2, "Second");
  const state = makeState([firstRule, secondRule]);
  const harness = createHarness(state, Core.compileState(state).rules);

  const disabled = await harness.context.handleMessage({
    action: "SET_RULE_ENABLED",
    profileId: state.activeProfileId,
    ruleId: firstRule.id,
    enabled: false
  });
  assert.equal(disabled.state.profiles[0].rules[0].enabled, false);
  assert.equal(harness.storage.monoHeaderState.profiles[0].rules[0].enabled, false);
  assert.deepEqual(harness.getDynamicRules().map((rule) => rule.id), [2]);
  assert.match(disabled.state.deployments[0].reason, /Disabled rule First/);

  const enabled = await harness.context.handleMessage({
    action: "SET_RULE_ENABLED",
    profileId: state.activeProfileId,
    ruleId: firstRule.id,
    enabled: true
  });
  assert.equal(enabled.state.profiles[0].rules[0].enabled, true);
  assert.deepEqual(harness.getDynamicRules().map((rule) => rule.id).sort(), [1, 2]);
  assert.match(enabled.state.deployments[0].reason, /Enabled rule First/);
});

test("popup rule toggle rejects stale identities without changing the runtime", async () => {
  const rule = makeRule(1);
  const state = makeState([rule]);
  const compiled = Core.compileState(state).rules;
  const harness = createHarness(state, compiled);

  await assert.rejects(
    harness.context.handleMessage({
      action: "SET_RULE_ENABLED",
      profileId: "profile-stale",
      ruleId: rule.id,
      enabled: false
    }),
    /active profile changed/i
  );
  await assert.rejects(
    harness.context.handleMessage({
      action: "SET_RULE_ENABLED",
      profileId: state.activeProfileId,
      ruleId: "rule-stale",
      enabled: false
    }),
    /no longer available/i
  );
  assert.equal(harness.storage.monoHeaderState.profiles[0].rules[0].enabled, true);
  assert.equal(Core.dnrSignature(harness.getDynamicRules()), Core.dnrSignature(compiled));
});

test("a rejected popup rule toggle retains the prior saved and deployed state", async () => {
  const rule = makeRule(1);
  const state = makeState([rule]);
  const compiled = Core.compileState(state).rules;
  const harness = createHarness(state, compiled);
  harness.controls.failDnrUpdates = 1;

  await assert.rejects(
    harness.context.handleMessage({
      action: "SET_RULE_ENABLED",
      profileId: state.activeProfileId,
      ruleId: rule.id,
      enabled: false
    }),
    /Chrome rejected the rule deployment/i
  );
  assert.equal(harness.storage.monoHeaderState.profiles[0].rules[0].enabled, true);
  assert.equal(Core.dnrSignature(harness.getDynamicRules()), Core.dnrSignature(compiled));
});

test("session keep-alive defaults to activity pulse and schedules an immediate test", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  const response = await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 10
  });

  assert.equal(response.sessionKeepAlive.supported, true);
  assert.equal(response.sessionKeepAlive.enabled, true);
  assert.equal(response.sessionKeepAlive.hostname, "app.example.com");
  assert.equal(response.sessionKeepAlive.lastStatus, "success");
  assert.equal(response.sessionKeepAlive.mode, "activity");
  assert.ok(response.sessionKeepAlive.lastSuccessAt);
  assert.ok(response.sessionKeepAlive.nextCheckAt);
  assert.equal(harness.getAlarms().get("monoheader-session-7").periodInMinutes, 10);
  assert.deepEqual(harness.getScriptingCalls()[0], {
    target: { tabId: 7 },
    hasFunction: true,
    args: [{ mode: "activity", targetPath: "" }]
  });

  const entry = harness.storage.monoHeaderSessionKeepAlive.entries[0];
  assert.equal(entry.origin, "https://app.example.com");
  assert.equal(entry.intervalMinutes, 10);
  assert.equal("url" in entry, false, "The full page URL must not be retained.");
});

test("a per-site preset stores settings without starting keep-alive", async () => {
  const state = makeState([]);
  const harness = createHarness(state, [], {
    tabs: [
      { id: 7, url: "https://app.example.com/dashboard" },
      { id: 8, url: "https://other.example.net/account" }
    ]
  });

  const saved = await harness.context.handleMessage({
    action: "SAVE_SESSION_KEEP_ALIVE_PRESET",
    tabId: 7,
    intervalMinutes: 15,
    targetPath: "https://app.example.com/api/session/keepalive",
    mode: "request"
  });

  assert.equal(saved.sessionKeepAlive.enabled, false);
  assert.equal(saved.sessionKeepAlive.preset.intervalMinutes, 15);
  assert.equal(saved.sessionKeepAlive.preset.targetPath, "/api/session/keepalive");
  assert.equal(saved.sessionKeepAlive.preset.mode, "request");
  assert.ok(saved.sessionKeepAlive.preset.updatedAt);
  assert.equal(harness.storage.monoHeaderSessionKeepAlive.version, 5);
  assert.equal(harness.storage.monoHeaderSessionKeepAlive.entries.length, 0);
  assert.equal(harness.storage.monoHeaderSessionKeepAlive.presets.length, 1);
  assert.equal(
    harness.storage.monoHeaderSessionKeepAlive.presets[0].origin,
    "https://app.example.com"
  );
  assert.equal(harness.getScriptingCalls().length, 0);
  assert.equal(harness.getAlarms().size, 0);

  const sameSite = await harness.context.handleMessage({
    action: "GET_SESSION_KEEP_ALIVE",
    tabId: 7
  });
  assert.equal(sameSite.sessionKeepAlive.mode, "request");
  assert.equal(sameSite.sessionKeepAlive.intervalMinutes, 15);
  assert.equal(sameSite.sessionKeepAlive.targetPath, "/api/session/keepalive");

  const otherSite = await harness.context.handleMessage({
    action: "GET_SESSION_KEEP_ALIVE",
    tabId: 8
  });
  assert.equal(otherSite.sessionKeepAlive.preset, null);
  assert.equal(otherSite.sessionKeepAlive.mode, "activity");
  assert.equal(otherSite.sessionKeepAlive.intervalMinutes, 10);
});

test("saving again updates one exact-origin preset and Activity pulse drops a hidden path", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  await harness.context.handleMessage({
    action: "SAVE_SESSION_KEEP_ALIVE_PRESET",
    tabId: 7,
    intervalMinutes: 5,
    targetPath: "/old",
    mode: "request"
  });

  const updated = await harness.context.handleMessage({
    action: "SAVE_SESSION_KEEP_ALIVE_PRESET",
    tabId: 7,
    intervalMinutes: 30,
    targetPath: "/must-not-remain",
    mode: "activity"
  });

  assert.equal(harness.storage.monoHeaderSessionKeepAlive.presets.length, 1);
  assert.equal(updated.sessionKeepAlive.preset.intervalMinutes, 30);
  assert.equal(updated.sessionKeepAlive.preset.mode, "activity");
  assert.equal(updated.sessionKeepAlive.preset.targetPath, "");
});

test("per-site presets reject cross-origin paths and non-HTTPS tabs", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  await assert.rejects(
    harness.context.handleMessage({
      action: "SAVE_SESSION_KEEP_ALIVE_PRESET",
      tabId: 7,
      intervalMinutes: 10,
      targetPath: "https://other.example.net/keepalive",
      mode: "request"
    }),
    /must stay on the current HTTPS site/i
  );
  assert.equal(harness.storage.monoHeaderSessionKeepAlive, undefined);

  const httpHarness = createHarness(state, [], {
    tabs: [{ id: 7, url: "http://app.example.com/dashboard" }]
  });
  await assert.rejects(
    httpHarness.context.handleMessage({
      action: "SAVE_SESSION_KEEP_ALIVE_PRESET",
      tabId: 7,
      intervalMinutes: 10,
      mode: "activity"
    }),
    /HTTPS pages only/i
  );
  assert.equal(httpHarness.storage.monoHeaderSessionKeepAlive, undefined);
});

test("tab reset preserves its site preset and deleting the preset preserves an active tab", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  await harness.context.handleMessage({
    action: "SAVE_SESSION_KEEP_ALIVE_PRESET",
    tabId: 7,
    intervalMinutes: 15,
    targetPath: "",
    mode: "activity"
  });
  await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 15,
    targetPath: "",
    mode: "activity"
  });

  const deleted = await harness.context.handleMessage({
    action: "DELETE_SESSION_KEEP_ALIVE_PRESET",
    tabId: 7
  });
  assert.equal(deleted.sessionKeepAlive.enabled, true);
  assert.equal(deleted.sessionKeepAlive.preset, null);
  assert.equal(harness.storage.monoHeaderSessionKeepAlive.entries.length, 1);
  assert.equal(harness.storage.monoHeaderSessionKeepAlive.presets.length, 0);
  assert.equal(harness.getAlarms().has("monoheader-session-7"), true);

  await harness.context.handleMessage({
    action: "SAVE_SESSION_KEEP_ALIVE_PRESET",
    tabId: 7,
    intervalMinutes: 15,
    targetPath: "",
    mode: "activity"
  });
  const reset = await harness.context.handleMessage({
    action: "RESET_SESSION_KEEP_ALIVE",
    tabId: 7
  });
  assert.equal(reset.sessionKeepAlive.enabled, false);
  assert.ok(reset.sessionKeepAlive.preset);
  assert.equal(reset.sessionKeepAlive.intervalMinutes, 15);
  assert.equal(harness.storage.monoHeaderSessionKeepAlive.entries.length, 0);
  assert.equal(harness.storage.monoHeaderSessionKeepAlive.presets.length, 1);
  assert.equal(harness.getAlarms().has("monoheader-session-7"), false);
});

test("legacy keep-alive stores migrate with entries intact and no invented presets", () => {
  const normalized = harnessNormalizeSessionStore({
    version: 4,
    entries: [{
      tabId: 7,
      origin: "https://app.example.com",
      intervalMinutes: 10,
      targetPath: "",
      mode: "activity"
    }]
  });

  assert.equal(normalized.version, 5);
  assert.equal(normalized.entries.length, 1);
  assert.equal(normalized.presets.length, 0);

  function harnessNormalizeSessionStore(store) {
    const state = makeState([]);
    return createHarness(state, []).context.normalizeSessionStore(store);
  }
});

test("manual keep-alive test runs once without enabling or scheduling the tab", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  harness.controls.pingResult = {
    ok: true,
    status: null,
    redirected: false,
    sameOrigin: true,
    requestSent: false,
    activitySent: true,
    error: ""
  };

  const response = await harness.context.handleMessage({
    action: "TEST_SESSION_KEEP_ALIVE",
    tabId: 7,
    targetPath: "",
    mode: "activity"
  });

  assert.equal(response.sessionKeepAlive.enabled, false);
  assert.equal(response.sessionKeepAlive.origin, "https://app.example.com");
  assert.equal(response.sessionKeepAlive.alarmActive, false);
  assert.equal(response.sessionDiagnostic.mode, "activity");
  assert.equal(response.sessionDiagnostic.trigger, "manual");
  assert.equal(response.sessionDiagnostic.status, "success");
  assert.equal(response.sessionDiagnostic.activitySent, true);
  assert.ok(response.sessionDiagnostic.attemptedAt);
  assert.ok(response.sessionDiagnostic.completedAt);
  assert.equal(harness.storage.monoHeaderSessionKeepAlive, undefined);
  assert.equal(harness.getAlarms().size, 0);
  assert.deepEqual(harness.getScriptingCalls()[0].args, [{
    mode: "activity",
    targetPath: ""
  }]);
});

test("manual test updates diagnostics without moving an active alarm", async () => {
  const state = makeState([]);
  const startedAt = Date.UTC(2026, 6, 24, 12, 0, 0);
  const harness = createHarness(state, [], { nowMs: startedAt });
  harness.controls.pingResult = {
    ok: true,
    status: null,
    redirected: false,
    sameOrigin: true,
    requestSent: false,
    activitySent: true,
    error: ""
  };
  const enabled = await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 10,
    mode: "activity"
  });
  const originalNextCheck = enabled.sessionKeepAlive.nextCheckAt;

  const tested = await harness.context.handleMessage({
    action: "TEST_SESSION_KEEP_ALIVE",
    tabId: 7,
    targetPath: "",
    mode: "activity"
  });

  assert.equal(tested.sessionKeepAlive.enabled, true);
  assert.equal(tested.sessionKeepAlive.nextCheckAt, originalNextCheck);
  assert.equal(tested.sessionKeepAlive.alarmActive, true);
  assert.equal(tested.sessionKeepAlive.alarmPeriodMinutes, 10);
  assert.equal(tested.sessionKeepAlive.lastTrigger, "manual");
  assert.equal(tested.sessionKeepAlive.lastActivitySent, true);
  assert.ok(tested.sessionKeepAlive.lastCompletedAt);
  assert.equal(tested.sessionDiagnostic.trigger, "manual");
  assert.equal(harness.getAlarmCreateCalls().length, 1);
  assert.equal(harness.getScriptingCalls().length, 2);
});

test("keep-alive reset clears only the selected tab", async () => {
  const state = makeState([]);
  const harness = createHarness(state, [], {
    tabs: [
      { id: 7, url: "https://app.example.com/dashboard" },
      { id: 8, url: "https://other.example.net/account" }
    ]
  });
  await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 10
  });
  await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 8,
    enabled: true,
    intervalMinutes: 15
  });

  const response = await harness.context.handleMessage({
    action: "RESET_SESSION_KEEP_ALIVE",
    tabId: 7
  });

  assert.equal(response.sessionKeepAlive.enabled, false);
  assert.equal(response.sessionKeepAlive.mode, "activity");
  assert.equal(response.sessionKeepAlive.intervalMinutes, 10);
  assert.deepEqual(
    harness.storage.monoHeaderSessionKeepAlive.entries.map((entry) => entry.tabId),
    [8]
  );
  assert.equal(harness.getAlarms().has("monoheader-session-7"), false);
  assert.equal(harness.getAlarms().has("monoheader-session-8"), true);
});

test("a stalled page pulse cannot block popup state messages indefinitely", async () => {
  const state = makeState([]);
  const harness = createHarness(state, [], { timeoutCapMs: 15 });
  harness.controls.hangScripting = true;

  const pendingSessionUpdate = harness.sendRuntimeMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 5,
    mode: "activity"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.getScriptingCalls().length, 1);

  const stateResponse = await Promise.race([
    harness.sendRuntimeMessage({ action: "GET_STATE" }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("GET_STATE was blocked behind the stalled session pulse.")),
      100
    ))
  ]);
  assert.equal(stateResponse.ok, true);
  assert.equal(stateResponse.state.profiles[0].name, "Test");

  const sessionResponse = await pendingSessionUpdate;
  assert.equal(sessionResponse.ok, true);
  assert.equal(sessionResponse.sessionKeepAlive.lastStatus, "error");
  assert.match(sessionResponse.sessionKeepAlive.lastError, /within five seconds/i);
});

test("session keep-alive can target a normalized same-origin request path", async () => {
  const state = makeState([]);
  const harness = createHarness(state, [], {
    tabs: [{ id: 7, url: "https://management.service.imperva.com/dashboard" }]
  });
  const response = await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 5,
    targetPath: "https://management.service.imperva.com/api/session/keepalive-apigw",
    mode: "request"
  });

  assert.equal(response.sessionKeepAlive.targetPath, "/api/session/keepalive-apigw");
  assert.equal(
    harness.storage.monoHeaderSessionKeepAlive.entries[0].targetPath,
    "/api/session/keepalive-apigw"
  );
  assert.deepEqual(harness.getScriptingCalls()[0].args, [{
    mode: "request",
    targetPath: "/api/session/keepalive-apigw"
  }]);
});

test("session keep-alive stores and injects activity-only mode without a request path", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  harness.controls.pingResult = {
    ok: true,
    status: null,
    redirected: false,
    sameOrigin: true,
    requestSent: false,
    activitySent: true,
    error: ""
  };
  const response = await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 5,
    targetPath: "",
    mode: "activity"
  });

  assert.equal(response.sessionKeepAlive.mode, "activity");
  assert.equal(response.sessionKeepAlive.lastStatus, "success");
  assert.equal(harness.storage.monoHeaderSessionKeepAlive.entries[0].mode, "activity");
  assert.deepEqual(harness.getScriptingCalls()[0].args, [{
    mode: "activity",
    targetPath: ""
  }]);
});

test("session keep-alive rejects cross-origin targets and embedded credentials", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  await assert.rejects(
    harness.context.handleMessage({
      action: "SET_SESSION_KEEP_ALIVE",
      tabId: 7,
      enabled: true,
      intervalMinutes: 5,
      targetPath: "https://my.imperva.com/app/keepalive"
    }),
    /must stay on the current HTTPS site/i
  );
  await assert.rejects(
    harness.context.handleMessage({
      action: "SET_SESSION_KEEP_ALIVE",
      tabId: 7,
      enabled: true,
      intervalMinutes: 5,
      targetPath: "https://user:secret@app.example.com/keepalive"
    }),
    /cannot contain credentials/i
  );
  assert.equal(harness.storage.monoHeaderSessionKeepAlive, undefined);
  assert.equal(harness.getScriptingCalls().length, 0);
});

test("last successful records request completion rather than request start", async () => {
  const state = makeState([]);
  const startedAt = Date.UTC(2026, 6, 24, 12, 0, 0);
  const harness = createHarness(state, [], { nowMs: startedAt });
  harness.controls.advanceClockDuringPingMs = 12_345;

  const response = await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 10
  });

  assert.equal(response.sessionKeepAlive.lastAttemptAt, new Date(startedAt).toISOString());
  assert.equal(response.sessionKeepAlive.lastSuccessAt, new Date(startedAt + 12_345).toISOString());
  assert.equal(
    harness.storage.monoHeaderSessionKeepAlive.entries[0].updatedAt,
    new Date(startedAt + 12_345).toISOString()
  );
});

test("reading session status preserves the existing alarm schedule", async () => {
  const state = makeState([]);
  const startedAt = Date.UTC(2026, 6, 24, 12, 0, 0);
  const harness = createHarness(state, [], { nowMs: startedAt });
  const enabled = await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 10
  });
  const originalNextCheck = enabled.sessionKeepAlive.nextCheckAt;

  const firstRead = await harness.context.handleMessage({
    action: "GET_SESSION_KEEP_ALIVE",
    tabId: 7
  });
  const secondRead = await harness.context.handleMessage({
    action: "GET_SESSION_KEEP_ALIVE",
    tabId: 7
  });

  assert.equal(harness.getAlarmCreateCalls().length, 1);
  assert.equal(firstRead.sessionKeepAlive.nextCheckAt, originalNextCheck);
  assert.equal(secondRead.sessionKeepAlive.nextCheckAt, originalNextCheck);
});

test("changing the keep-alive interval replaces the alarm exactly once", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 10
  });
  await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 15
  });

  assert.equal(harness.getAlarmCreateCalls().length, 2);
  assert.equal(harness.getAlarms().get("monoheader-session-7").periodInMinutes, 15);
});

test("session keep-alive rejects non-HTTPS tabs and unsupported intervals", async () => {
  const state = makeState([]);
  const httpHarness = createHarness(state, [], {
    tabs: [{ id: 7, url: "http://app.example.com/dashboard" }]
  });
  await assert.rejects(
    httpHarness.context.handleMessage({
      action: "SET_SESSION_KEEP_ALIVE",
      tabId: 7,
      enabled: true,
      intervalMinutes: 10
    }),
    /HTTPS pages only/i
  );

  const intervalHarness = createHarness(state, []);
  await assert.rejects(
    intervalHarness.context.handleMessage({
      action: "SET_SESSION_KEEP_ALIVE",
      tabId: 7,
      enabled: true,
      intervalMinutes: 1
    }),
    /5, 10, 15, or 30 minutes/i
  );
});

test("session keep-alive reports redirects without claiming success", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  harness.controls.pingResult = {
    ok: true,
    status: 200,
    redirected: true,
    sameOrigin: true,
    error: ""
  };
  const response = await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 5
  });
  assert.equal(response.sessionKeepAlive.lastStatus, "warning");
  assert.equal(response.sessionKeepAlive.lastSuccessAt, null);
  assert.match(response.sessionKeepAlive.lastError, /may already have expired/i);
});

test("session keep-alive alarms perform later checks and retain failures locally", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  const initial = await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 5
  });
  harness.controls.pingResult = {
    ok: false,
    status: 401,
    redirected: false,
    sameOrigin: true,
    error: ""
  };
  await harness.context.handleSessionAlarm({ name: "monoheader-session-7" });
  const status = await harness.context.handleMessage({
    action: "GET_SESSION_KEEP_ALIVE",
    tabId: 7
  });
  assert.equal(status.sessionKeepAlive.enabled, true);
  assert.equal(status.sessionKeepAlive.lastStatus, "error");
  assert.equal(status.sessionKeepAlive.lastHttpStatus, 401);
  assert.equal(status.sessionKeepAlive.lastSuccessAt, initial.sessionKeepAlive.lastSuccessAt);
  assert.equal(status.sessionKeepAlive.lastTrigger, "scheduled");
  assert.ok(status.sessionKeepAlive.lastCompletedAt);
  assert.match(status.sessionKeepAlive.lastError, /HTTP 401/);
  assert.equal(harness.getScriptingCalls().length, 2);
});

test("session keep-alive stops when its tab leaves the configured origin", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 15
  });
  const navigated = { id: 7, url: "https://other.example.net/" };
  harness.setTab(navigated);
  await harness.context.handleSessionTabUpdated(7, navigated);
  assert.equal(harness.storage.monoHeaderSessionKeepAlive.entries.length, 0);
  assert.equal(harness.getAlarms().has("monoheader-session-7"), false);
});

test("factory reset also stops every session keep-alive", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  await harness.context.handleMessage({
    action: "SAVE_SESSION_KEEP_ALIVE_PRESET",
    tabId: 7,
    intervalMinutes: 30,
    mode: "activity"
  });
  await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 30
  });
  await harness.context.handleMessage({ action: "RESET" });
  assert.equal(harness.storage.monoHeaderSessionKeepAlive.entries.length, 0);
  assert.equal(harness.storage.monoHeaderSessionKeepAlive.presets.length, 0);
  assert.equal(harness.getAlarms().size, 0);
});

test("session status waits for factory reset and cannot recreate a cleared alarm", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  await harness.context.handleMessage({
    action: "SET_SESSION_KEEP_ALIVE",
    tabId: 7,
    enabled: true,
    intervalMinutes: 30
  });

  let releaseAlarmClear;
  const alarmClearGate = new Promise((resolve) => {
    releaseAlarmClear = resolve;
  });
  let signalAlarmClear;
  const alarmClearStarted = new Promise((resolve) => {
    signalAlarmClear = resolve;
  });
  harness.controls.beforeAlarmClear = async (name) => {
    if (name !== "monoheader-session-7") return;
    signalAlarmClear();
    await alarmClearGate;
  };

  const resetPromise = harness.sendRuntimeMessage({ action: "RESET" });
  await alarmClearStarted;
  let statusSettled = false;
  const statusPromise = harness.sendRuntimeMessage({
    action: "GET_SESSION_KEEP_ALIVE",
    tabId: 7
  }).finally(() => {
    statusSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statusSettled, false);

  releaseAlarmClear();
  const [reset, status] = await Promise.all([resetPromise, statusPromise]);
  assert.equal(reset.ok, true);
  assert.equal(status.ok, true);
  assert.equal(status.sessionKeepAlive.enabled, false);
  assert.equal(harness.storage.monoHeaderSessionKeepAlive.entries.length, 0);
  assert.equal(harness.getAlarms().has("monoheader-session-7"), false);
});

test("an orphan keep-alive alarm clears itself when no tab entry remains", async () => {
  const state = makeState([]);
  const harness = createHarness(state, []);
  await harness.context.chrome.alarms.create("monoheader-session-7", {
    periodInMinutes: 10
  });
  assert.equal(harness.getAlarms().has("monoheader-session-7"), true);

  await harness.context.handleSessionAlarm({ name: "monoheader-session-7" });
  assert.equal(harness.getAlarms().has("monoheader-session-7"), false);
  assert.equal(harness.getScriptingCalls().length, 0);
});
