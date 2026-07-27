"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");

function validRule(overrides) {
  return Core.createRule({
    dnrId: 1,
    name: "API authentication",
    match: {
      patternType: "urlFilter",
      pattern: "||api.example.com/",
      resourceTypes: ["xmlhttprequest"],
      requestMethods: ["get", "post"]
    },
    modifications: [{
      target: "request",
      operation: "set",
      header: "Authorization",
      value: "Bearer local-token"
    }],
    ...(overrides || {})
  });
}

function stateWithRules(rules, overrides) {
  const profile = Core.createProfile("Development", { rules });
  return Core.normalizeState({
    extensionEnabled: true,
    activeProfileId: profile.id,
    profiles: [profile],
    nextDnrId: 10,
    ...(overrides || {})
  });
}

test("default state is valid and contains one empty active profile", () => {
  const state = Core.createDefaultState();
  const validation = Core.validateState(state);
  assert.equal(validation.valid, true);
  assert.equal(state.profiles.length, 1);
  assert.equal(Core.getActiveProfile(state).name, "Default");
  assert.deepEqual(Core.compileState(state).rules, []);
});

test("normalization allocates unique positive DNR identifiers", () => {
  const profileA = Core.createProfile("A", {
    rules: [validRule({ dnrId: 4 }), validRule({ id: "second", dnrId: 4 })]
  });
  const profileB = Core.createProfile("B", {
    rules: [validRule({ id: "third", dnrId: null })]
  });
  const state = Core.normalizeState({
    activeProfileId: profileA.id,
    profiles: [profileA, profileB],
    nextDnrId: 1
  });
  const ids = state.profiles.flatMap((profile) => profile.rules.map((rule) => rule.dnrId));
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every((id) => Number.isSafeInteger(id) && id > 0));
  assert.ok(state.nextDnrId > Math.max(...ids));
});

test("normalization repairs duplicate profile, rule, and modification identifiers", () => {
  const state = Core.normalizeState({
    activeProfileId: "duplicate-profile",
    profiles: [
      {
        id: "duplicate-profile",
        name: "First",
        rules: [{
          id: "duplicate-rule",
          dnrId: 1,
          name: "First rule",
          match: {
            patternType: "urlFilter",
            pattern: "*",
            resourceTypes: ["xmlhttprequest"]
          },
          modifications: [{
            id: "duplicate-modification",
            target: "request",
            operation: "set",
            header: "X-First",
            value: "first"
          }]
        }]
      },
      {
        id: "duplicate-profile",
        name: "Second",
        rules: [{
          id: "duplicate-rule",
          dnrId: 2,
          name: "Second rule",
          match: {
            patternType: "urlFilter",
            pattern: "*",
            resourceTypes: ["xmlhttprequest"]
          },
          modifications: [{
            id: "duplicate-modification",
            target: "request",
            operation: "set",
            header: "X-Second",
            value: "second"
          }]
        }]
      }
    ],
    nextDnrId: 3
  });

  const profileIds = state.profiles.map((profile) => profile.id);
  const ruleIds = state.profiles.flatMap((profile) => profile.rules.map((rule) => rule.id));
  const modificationIds = state.profiles.flatMap((profile) => (
    profile.rules.flatMap((rule) => rule.modifications.map((modification) => modification.id))
  ));
  assert.equal(new Set(profileIds).size, profileIds.length);
  assert.equal(new Set(ruleIds).size, ruleIds.length);
  assert.equal(new Set(modificationIds).size, modificationIds.length);
  assert.equal(state.activeProfileId, profileIds[0]);
});

test("imported duplicate modification identifiers cannot couple session-only values", () => {
  const state = Core.createDefaultState();
  state.profiles[0].rules = [
    validRule({
      id: "duplicate-rule",
      dnrId: 1,
      name: "First session header",
      modifications: [{
        id: "duplicate-modification",
        target: "request",
        operation: "set",
        header: "X-First",
        value: "first-secret",
        sessionOnly: true,
        sessionValueAvailable: true
      }]
    }),
    validRule({
      id: "duplicate-rule",
      dnrId: 2,
      name: "Second session header",
      modifications: [{
        id: "duplicate-modification",
        target: "request",
        operation: "set",
        header: "X-Second",
        value: "second-secret",
        sessionOnly: true,
        sessionValueAvailable: true
      }]
    })
  ];
  state.nextDnrId = 3;

  const imported = Core.parseImport({
    format: Core.EXPORT_FORMAT,
    version: Core.SCHEMA_VERSION,
    configuration: state
  });
  assert.deepEqual(imported.errors, []);

  const rules = imported.state.profiles[0].rules;
  assert.notEqual(rules[0].id, rules[1].id);
  assert.notEqual(rules[0].modifications[0].id, rules[1].modifications[0].id);

  const values = Core.extractSessionHeaderValues(imported.state);
  const localState = Core.sanitizeStateForLocalStorage(imported.state);
  const hydrated = Core.hydrateSessionHeaderValues(localState, values);
  assert.deepEqual(
    hydrated.profiles[0].rules.map((rule) => rule.modifications[0].value),
    ["first-secret", "second-secret"]
  );
});

test("compiler produces a DNR modifyHeaders rule with explicit conditions", () => {
  const state = stateWithRules([validRule()]);
  const compiled = Core.compileState(state);
  assert.equal(compiled.rules.length, 1);
  assert.deepEqual(compiled.rules[0], {
    id: 1,
    priority: 100,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{
        header: "Authorization",
        operation: "set",
        value: "Bearer local-token"
      }]
    },
    condition: {
      resourceTypes: ["xmlhttprequest"],
      urlFilter: "||api.example.com/",
      requestMethods: ["get", "post"]
    }
  });
});

test("compiler supports request and response modifications in one rule", () => {
  const rule = validRule({
    modifications: [
      { target: "request", operation: "remove", header: "Cookie", value: "ignored" },
      { target: "response", operation: "set", header: "X-Environment", value: "development" }
    ]
  });
  const compiled = Core.compileState(stateWithRules([rule])).rules[0];
  assert.deepEqual(compiled.action.requestHeaders, [
    { header: "Cookie", operation: "remove" }
  ]);
  assert.deepEqual(compiled.action.responseHeaders, [
    { header: "X-Environment", operation: "set", value: "development" }
  ]);
});

test("compiler separates persistent and session-only values into different DNR rulesets", () => {
  const rule = validRule({
    dnrId: 12,
    modifications: [
      {
        id: "persistent-mod",
        target: "request",
        operation: "set",
        header: "X-Environment",
        value: "development"
      },
      {
        id: "session-mod",
        target: "request",
        operation: "set",
        header: "Authorization",
        value: "Bearer session-secret",
        sessionOnly: true,
        sessionValueAvailable: true
      }
    ]
  });
  const compiled = Core.compileState(stateWithRules([rule]));

  assert.equal(compiled.dynamicRules.length, 1);
  assert.equal(compiled.sessionRules.length, 1);
  assert.equal(compiled.logicalRuleCount, 1);
  assert.equal(compiled.dynamicRules[0].id, 12);
  assert.equal(compiled.sessionRules[0].id, 12);
  assert.deepEqual(compiled.dynamicRules[0].condition, compiled.sessionRules[0].condition);
  assert.deepEqual(compiled.dynamicRules[0].action.requestHeaders, [{
    header: "X-Environment",
    operation: "set",
    value: "development"
  }]);
  assert.deepEqual(compiled.sessionRules[0].action.requestHeaders, [{
    header: "Authorization",
    operation: "set",
    value: "Bearer session-secret"
  }]);
  assert.doesNotMatch(JSON.stringify(compiled.dynamicRules), /session-secret/);
});

test("missing session-only values stay configured but are not deployed", () => {
  const state = stateWithRules([validRule({
    modifications: [{
      id: "missing-session-mod",
      target: "request",
      operation: "set",
      header: "Authorization",
      value: "",
      sessionOnly: true,
      sessionValueAvailable: false
    }]
  })]);
  const compiled = Core.compileState(state);

  assert.deepEqual(compiled.dynamicRules, []);
  assert.deepEqual(compiled.sessionRules, []);
  assert.equal(compiled.logicalRuleCount, 0);
  assert.match(compiled.warnings.join(" "), /session-only value.*unavailable/i);
});

test("session-only values round trip through memory and are scrubbed from local state and exports", () => {
  const modificationId = "session-secret-mod";
  const secret = "Bearer do-not-persist";
  const state = stateWithRules([validRule({
    modifications: [{
      id: modificationId,
      target: "request",
      operation: "set",
      header: "Authorization",
      value: secret,
      sessionOnly: true,
      sessionValueAvailable: true
    }]
  })]);
  const values = Core.extractSessionHeaderValues(state);
  assert.deepEqual(values, { [modificationId]: secret });

  const localState = Core.sanitizeStateForLocalStorage(state);
  const localModification = localState.profiles[0].rules[0].modifications[0];
  assert.equal(localModification.value, "");
  assert.equal(localModification.sessionOnly, true);
  assert.equal(localModification.sessionValueAvailable, false);
  assert.doesNotMatch(JSON.stringify(localState), /do-not-persist/);

  const hydrated = Core.hydrateSessionHeaderValues(localState, values);
  const hydratedModification = hydrated.profiles[0].rules[0].modifications[0];
  assert.equal(hydratedModification.value, secret);
  assert.equal(hydratedModification.sessionValueAvailable, true);

  const exported = Core.createExport(state);
  assert.equal(exported.version, 2);
  assert.doesNotMatch(JSON.stringify(exported), /do-not-persist/);
  assert.equal(
    exported.configuration.profiles[0].rules[0].modifications[0].sessionOnly,
    true
  );
});

test("local sanitization also scrubs a prior persistent value from rollback by modification identity", () => {
  const modificationId = "transitioned-secret";
  const persistent = stateWithRules([validRule({
    modifications: [{
      id: modificationId,
      target: "request",
      operation: "set",
      header: "Authorization",
      value: "previously-persistent"
    }]
  })]);
  const sessionOnly = stateWithRules([validRule({
    modifications: [{
      id: modificationId,
      target: "request",
      operation: "set",
      header: "Authorization",
      value: "now-in-memory",
      sessionOnly: true,
      sessionValueAvailable: true
    }]
  })]);
  sessionOnly.rollbackSnapshot = Core.configurationSnapshot(persistent);

  const localState = Core.sanitizeStateForLocalStorage(sessionOnly);
  const rollbackModification =
    localState.rollbackSnapshot.profiles[0].rules[0].modifications[0];
  assert.equal(rollbackModification.value, "");
  assert.equal(rollbackModification.sessionOnly, true);
  assert.equal(rollbackModification.sessionValueAvailable, false);
  assert.doesNotMatch(JSON.stringify(localState), /previously-persistent|now-in-memory/);
});

test("one logical rule cannot ambiguously mix value lifetimes for the same header", () => {
  const rule = validRule({
    modifications: [
      {
        target: "request",
        operation: "set",
        header: "Authorization",
        value: "persistent"
      },
      {
        target: "request",
        operation: "set",
        header: "authorization",
        value: "session",
        sessionOnly: true,
        sessionValueAvailable: true
      }
    ]
  });
  const validation = Core.validateRule(rule);

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /cannot mix Persistent and This session/i);
  assert.match(validation.errors.join(" "), /different priorities/i);
});

test("disabled rules and a paused extension deploy no dynamic rules", () => {
  const disabled = validRule({ enabled: false });
  assert.deepEqual(Core.compileState(stateWithRules([disabled])).rules, []);
  const paused = stateWithRules([validRule()]);
  paused.extensionEnabled = false;
  assert.deepEqual(Core.compileState(paused).rules, []);
});

test("header names and values reject malformed or injected input", () => {
  const malformedName = validRule({
    modifications: [{ target: "request", operation: "set", header: "Bad Header", value: "x" }]
  });
  const injected = validRule({
    modifications: [{ target: "request", operation: "set", header: "X-Test", value: "safe\r\nInjected: yes" }]
  });
  assert.match(Core.validateRule(malformedName).errors.join(" "), /valid HTTP header name/i);
  assert.match(Core.validateRule(injected).errors.join(" "), /prohibited line break/i);
});

test("request append follows Chrome's case-insensitive allowlist", () => {
  const allowed = validRule({
    modifications: [{ target: "request", operation: "append", header: "Accept-Language", value: "sv-SE" }]
  });
  const denied = validRule({
    modifications: [{ target: "request", operation: "append", header: "X-Custom", value: "value" }]
  });
  assert.equal(Core.validateRule(allowed).valid, true);
  assert.equal(Core.validateRule(denied).valid, false);
  assert.match(Core.validateRule(denied).errors.join(" "), /cannot append/i);
  const compiled = Core.compileState(stateWithRules([allowed])).rules[0];
  assert.equal(compiled.action.requestHeaders[0].header, "accept-language");
});

test("URL filters reject non-ASCII and prohibited domain wildcard syntax", () => {
  const unicode = validRule({ match: { patternType: "urlFilter", pattern: "https://例え.jp/*" } });
  const wildcard = validRule({ match: { patternType: "urlFilter", pattern: "||*.example.com/" } });
  assert.match(Core.validateRule(unicode).errors.join(" "), /ASCII/i);
  assert.match(Core.validateRule(wildcard).errors.join(" "), /cannot begin/i);
});

test("explicitly empty URL patterns and resource selections are not widened to all requests", () => {
  const rule = validRule({
    match: {
      patternType: "urlFilter",
      pattern: "",
      resourceTypes: []
    }
  });
  const state = stateWithRules([rule]);
  const normalizedRule = state.profiles[0].rules[0];
  assert.equal(normalizedRule.match.pattern, "");
  assert.deepEqual(normalizedRule.match.resourceTypes, []);
  const validation = Core.validateRule(normalizedRule);
  assert.match(validation.errors.join(" "), /URL pattern is required/i);
  assert.match(validation.errors.join(" "), /resource type/i);
});

test("invalid regular expressions are rejected before deployment", () => {
  const rule = validRule({ match: { patternType: "regexFilter", pattern: "(unclosed" } });
  const validation = Core.validateRule(rule);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /regular expression is invalid/i);
});

test("domain values are normalized to hostnames and punycode", () => {
  assert.equal(Core.normalizeDomain("HTTPS://API.Example.com:443/path"), "api.example.com");
  assert.equal(Core.normalizeDomain("räksmörgås.se"), "xn--rksmrgs-5wao1o.se");
});

test("export and import round trip preserves configuration, not audit history", () => {
  let state = stateWithRules([validRule()]);
  state.deployments = [{
    id: "deployment",
    timestamp: new Date().toISOString(),
    profileId: state.activeProfileId,
    profileName: "Development",
    ruleCount: 1,
    modificationCount: 1,
    reason: "test",
    status: "success"
  }];
  state.diagnostics = [Core.createDiagnostic("info", "Test", "Event")];
  const exported = Core.createExport(state);
  const imported = Core.parseImport(JSON.stringify(exported));
  assert.equal(imported.source, "MonoHeader");
  assert.equal(imported.errors.length, 0);
  assert.equal(imported.state.profiles[0].rules[0].name, "API authentication");
  assert.deepEqual(imported.state.deployments, []);
  assert.deepEqual(imported.state.diagnostics, []);
});

test("future export versions are rejected", () => {
  assert.throws(() => Core.parseImport({
    format: "monoheader",
    version: Core.SCHEMA_VERSION + 1,
    configuration: Core.configurationSnapshot(stateWithRules([]))
  }), /newer than this extension supports/i);
});

test("compatible ModHeader profiles convert to local MonoHeader rules", () => {
  const imported = Core.parseImport({
    profiles: [{
      title: "Legacy development",
      headers: [{ enabled: true, name: "X-Request", value: "local" }],
      respHeaders: [{ enabled: true, name: "X-Response", value: "ok" }],
      filters: [{ enabled: true, urlPattern: "||example.com/" }]
    }]
  });
  assert.equal(imported.source, "ModHeader");
  assert.equal(imported.state.profiles.length, 1);
  assert.equal(imported.state.profiles[0].rules.length, 2);
  assert.equal(imported.state.profiles[0].rules[1].modifications[0].target, "response");
  assert.equal(imported.errors.length, 0);
});

test("local URL test recognizes common DNR URL filter forms", () => {
  const domainRule = validRule();
  assert.equal(Core.matchRuleLocally(domainRule, "https://api.example.com/v1", {}), true);
  assert.equal(Core.matchRuleLocally(domainRule, "https://example.net/v1", {}), false);
  const exact = validRule({
    match: { patternType: "urlFilter", pattern: "|https://www.example.com/|" }
  });
  assert.equal(Core.matchRuleLocally(exact, "https://www.example.com/", {}), true);
  assert.equal(Core.matchRuleLocally(exact, "https://www.example.com/path", {}), false);
});

test("local URL test preserves paths in domain-anchored DNR filters", () => {
  const rule = validRule({
    match: {
      patternType: "urlFilter",
      pattern: "||example.com/api/*",
      resourceTypes: ["xmlhttprequest"]
    }
  });

  assert.equal(Core.matchRuleLocally(rule, "https://example.com/api/session", {}), true);
  assert.equal(Core.matchRuleLocally(rule, "https://sub.example.com/api/session", {}), true);
  assert.equal(Core.matchRuleLocally(rule, "https://example.com/unrelated", {}), false);
  assert.equal(Core.matchRuleLocally(rule, "https://notexample.com/api/session", {}), false);
});

test("local URL test honors domain separators and right anchors", () => {
  const domainBoundary = validRule({
    match: {
      patternType: "urlFilter",
      pattern: "||example.com^",
      resourceTypes: ["xmlhttprequest"]
    }
  });
  const exactPath = validRule({
    dnrId: 2,
    match: {
      patternType: "urlFilter",
      pattern: "||example.com/api|",
      resourceTypes: ["xmlhttprequest"]
    }
  });

  assert.equal(Core.matchRuleLocally(domainBoundary, "https://example.com/api", {}), true);
  assert.equal(Core.matchRuleLocally(domainBoundary, "https://example.company/api", {}), false);
  assert.equal(Core.matchRuleLocally(exactPath, "https://example.com/api", {}), true);
  assert.equal(Core.matchRuleLocally(exactPath, "https://example.com/api/extra", {}), false);
});

test("request-domain includes and excludes are honored by local URL test", () => {
  const rule = validRule({
    match: {
      patternType: "urlFilter",
      pattern: "*",
      requestDomains: ["example.com"],
      excludedRequestDomains: ["private.example.com"]
    }
  });
  assert.equal(Core.matchRuleLocally(rule, "https://api.example.com/data", {}), true);
  assert.equal(Core.matchRuleLocally(rule, "https://private.example.com/data", {}), false);
  assert.equal(Core.matchRuleLocally(rule, "https://example.net/data", {}), false);
});

test("effective inspector applies Set, permits lower Append, and shadows lower Set", () => {
  const state = stateWithRules([
    validRule({
      id: "high-set",
      dnrId: 1,
      name: "High set",
      priority: 300,
      modifications: [{
        target: "request",
        operation: "set",
        header: "Accept-Language",
        value: "sv-SE"
      }]
    }),
    validRule({
      id: "middle-append",
      dnrId: 2,
      name: "Middle append",
      priority: 200,
      modifications: [{
        target: "request",
        operation: "append",
        header: "accept-language",
        value: "en-US"
      }]
    }),
    validRule({
      id: "low-set",
      dnrId: 3,
      name: "Low set",
      priority: 100,
      modifications: [{
        target: "request",
        operation: "set",
        header: "ACCEPT-LANGUAGE",
        value: "fr-FR"
      }]
    })
  ]);

  const inspection = Core.inspectEffectiveHeaders(
    state,
    "https://api.example.com/v1",
    {
      method: "get",
      resourceType: "xmlhttprequest",
      initiatorDomain: "app.example.com",
      domainType: "firstParty"
    }
  );
  assert.equal(inspection.matchingRules.length, 3);
  assert.equal(inspection.headers.length, 1);
  assert.equal(inspection.conflictCount, 1);
  assert.equal(inspection.ambiguousCount, 0);
  assert.equal(inspection.resolvedConflictCount, 1);
  assert.equal(inspection.headers[0].effective.kind, "set");
  assert.equal(inspection.headers[0].effective.lead.ruleName, "High set");
  assert.deepEqual(
    inspection.headers[0].effective.appends.map((operation) => operation.ruleName),
    ["Middle append"]
  );
  assert.equal(
    inspection.headers[0].operations.find((operation) => operation.ruleName === "Low set").status,
    "shadowed"
  );
});

test("effective inspector treats higher Remove as final", () => {
  const state = stateWithRules([
    validRule({
      id: "remove",
      dnrId: 1,
      name: "Remove cookies",
      priority: 200,
      modifications: [{ target: "request", operation: "remove", header: "Cookie" }]
    }),
    validRule({
      id: "set",
      dnrId: 2,
      name: "Set cookies",
      priority: 100,
      modifications: [{ target: "request", operation: "set", header: "cookie", value: "a=1" }]
    })
  ]);
  const header = Core.inspectEffectiveHeaders(
    state,
    "https://api.example.com/v1",
    { method: "get", resourceType: "xmlhttprequest" }
  ).headers[0];

  assert.equal(header.effective.kind, "remove");
  assert.equal(header.effective.lead.ruleName, "Remove cookies");
  assert.equal(header.operations[1].status, "shadowed");
  assert.match(header.operations[1].reason, /higher-priority Remove/i);
});

test("effective inspector reports incompatible equal-priority operations as ambiguous", () => {
  const state = stateWithRules([
    validRule({
      id: "blue",
      dnrId: 1,
      name: "Blue",
      priority: 200,
      modifications: [{ target: "response", operation: "set", header: "X-Color", value: "blue" }]
    }),
    validRule({
      id: "green",
      dnrId: 2,
      name: "Green",
      priority: 200,
      modifications: [{ target: "response", operation: "set", header: "x-color", value: "green" }]
    }),
    validRule({
      id: "lower",
      dnrId: 3,
      name: "Lower",
      priority: 100,
      modifications: [{ target: "response", operation: "remove", header: "X-Color" }]
    })
  ]);
  const inspection = Core.inspectEffectiveHeaders(
    state,
    "https://api.example.com/v1",
    { method: "get", resourceType: "xmlhttprequest" }
  );
  const header = inspection.headers[0];

  assert.equal(inspection.ambiguousCount, 1);
  assert.equal(header.effective.kind, "ambiguous");
  assert.deepEqual(header.operations.map((operation) => operation.status), [
    "ambiguous",
    "ambiguous",
    "uncertain"
  ]);
});

test("effective inspector recognizes equivalent Sets and compatible Append chains", () => {
  const identicalSets = stateWithRules([
    validRule({
      id: "set-one",
      dnrId: 1,
      name: "Set one",
      priority: 200,
      modifications: [{ target: "response", operation: "set", header: "X-Mode", value: "safe" }]
    }),
    validRule({
      id: "set-two",
      dnrId: 2,
      name: "Set two",
      priority: 200,
      modifications: [{ target: "response", operation: "set", header: "x-mode", value: "safe" }]
    })
  ]);
  const setHeader = Core.inspectEffectiveHeaders(
    identicalSets,
    "https://api.example.com/v1",
    { method: "get", resourceType: "xmlhttprequest" }
  ).headers[0];
  assert.equal(setHeader.ambiguous, false);
  assert.deepEqual(setHeader.operations.map((operation) => operation.status), ["applied", "redundant"]);

  const appendChain = stateWithRules([
    validRule({
      id: "append-one",
      dnrId: 3,
      name: "Append one",
      priority: 200,
      modifications: [{ target: "request", operation: "append", header: "Accept", value: "text/html" }]
    }),
    validRule({
      id: "append-two",
      dnrId: 4,
      name: "Append two",
      priority: 200,
      modifications: [{ target: "request", operation: "append", header: "accept", value: "application/json" }]
    })
  ]);
  const appendHeader = Core.inspectEffectiveHeaders(
    appendChain,
    "https://api.example.com/v1",
    { method: "get", resourceType: "xmlhttprequest" }
  ).headers[0];
  assert.equal(appendHeader.effective.kind, "append");
  assert.equal(appendHeader.effective.appends.length, 2);
  assert.equal(appendHeader.orderUncertain, true);
  assert.equal(appendHeader.ambiguous, false);
});

test("effective inspector applies method, resource, initiator, and relationship context", () => {
  const constrained = validRule({
    id: "contextual",
    dnrId: 1,
    match: {
      patternType: "urlFilter",
      pattern: "*",
      requestDomains: ["api.example.com"],
      initiatorDomains: ["portal.example.com"],
      excludedInitiatorDomains: ["admin.portal.example.com"],
      resourceTypes: ["xmlhttprequest"],
      requestMethods: ["post"],
      domainType: "thirdParty"
    }
  });
  const state = stateWithRules([constrained], { extensionEnabled: false });
  const matching = Core.inspectEffectiveHeaders(state, "https://api.example.com/v1", {
    method: "post",
    resourceType: "xmlhttprequest",
    initiatorDomain: "portal.example.com",
    domainType: "thirdParty"
  });
  assert.equal(matching.active, false);
  assert.equal(matching.matchingRules.length, 1);

  for (const context of [
    {
      method: "get",
      resourceType: "xmlhttprequest",
      initiatorDomain: "portal.example.com",
      domainType: "thirdParty"
    },
    {
      method: "post",
      resourceType: "script",
      initiatorDomain: "portal.example.com",
      domainType: "thirdParty"
    },
    {
      method: "post",
      resourceType: "xmlhttprequest",
      initiatorDomain: "admin.portal.example.com",
      domainType: "thirdParty"
    },
    {
      method: "post",
      resourceType: "xmlhttprequest",
      initiatorDomain: "portal.example.com",
      domainType: "firstParty"
    }
  ]) {
    assert.equal(
      Core.inspectEffectiveHeaders(state, "https://api.example.com/v1", context).matchingRules.length,
      0
    );
  }
});

test("effective inspector distinguishes available and missing session-only values", () => {
  const state = stateWithRules([
    validRule({
      id: "available-session-rule",
      dnrId: 1,
      name: "Available session rule",
      modifications: [{
        id: "available-session-mod",
        target: "request",
        operation: "set",
        header: "Authorization",
        value: "Bearer available",
        sessionOnly: true,
        sessionValueAvailable: true
      }]
    }),
    validRule({
      id: "missing-session-rule",
      dnrId: 2,
      name: "Missing session rule",
      modifications: [{
        id: "missing-session-mod",
        target: "request",
        operation: "set",
        header: "X-Session-Key",
        value: "",
        sessionOnly: true,
        sessionValueAvailable: false
      }]
    })
  ]);
  const inspection = Core.inspectEffectiveHeaders(
    state,
    "https://api.example.com/v1",
    { method: "get", resourceType: "xmlhttprequest" }
  );

  assert.equal(inspection.matchingRules.length, 2);
  assert.equal(inspection.headers.length, 1);
  assert.equal(inspection.headers[0].operations[0].sessionOnly, true);
  assert.equal(inspection.unavailableSessionValueCount, 1);
  assert.deepEqual(inspection.unavailableSessionModifications[0], {
    ruleId: "missing-session-rule",
    ruleName: "Missing session rule",
    modificationId: "missing-session-mod",
    target: "request",
    operation: "set",
    header: "X-Session-Key"
  });
});

test("rollback snapshot restores prior configuration and keeps a reverse snapshot", () => {
  const original = stateWithRules([validRule()]);
  const changed = Core.normalizeState(original);
  changed.profiles[0].name = "Changed";
  changed.rollbackSnapshot = Core.configurationSnapshot(original);
  const restored = Core.restoreSnapshot(changed, changed.rollbackSnapshot);
  assert.equal(restored.profiles[0].name, "Development");
  assert.equal(restored.rollbackSnapshot.profiles[0].name, "Changed");
});

test("DNR signatures ignore input ordering but retain semantic differences", () => {
  const first = Core.compileState(stateWithRules([
    validRule({ id: "one", dnrId: 1 }),
    validRule({ id: "two", dnrId: 2, name: "Second" })
  ])).rules;
  const reversed = [...first].reverse();
  assert.equal(Core.dnrSignature(first), Core.dnrSignature(reversed));
  const changed = Core.clone(first);
  changed[0].priority += 1;
  assert.notEqual(Core.dnrSignature(first), Core.dnrSignature(changed));
});
