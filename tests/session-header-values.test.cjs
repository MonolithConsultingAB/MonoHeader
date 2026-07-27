"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const core = readFileSync(join(root, "core.js"), "utf8");
const background = readFileSync(join(root, "background.js"), "utf8");
const appHtml = readFileSync(join(root, "app.html"), "utf8");
const appCss = readFileSync(join(root, "app.css"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const popupHtml = readFileSync(join(root, "popup.html"), "utf8");
const popupJs = readFileSync(join(root, "popup.js"), "utf8");
const privacy = readFileSync(join(root, "PRIVACY.md"), "utf8");

test("workspace offers an explained per-modification value lifetime", () => {
  assert.match(appHtml, /data-mod-field="lifetime"/);
  assert.match(appHtml, /<option value="persistent">Persistent<\/option>/);
  assert.match(appHtml, /<option value="session">This session<\/option>/);
  assert.match(appHtml, /Value lifetime help:/);
  assert.match(appHtml, /must be re-entered after Chrome restarts/);
  assert.match(appJs, /value\.type = sessionOnly \? "password" : "text"/);
  assert.match(appJs, /Value required for this session/);
  assert.match(appJs, /sessionValueAvailable:/);
  assert.match(appCss, /\.lifetime-field\.needs-value small/);
});

test("quick add can opt into session-only storage without exposing values in rule summaries", () => {
  assert.match(popupHtml, /id="quick-header-session-only"/);
  assert.match(popupHtml, /This browser session only/);
  assert.match(popupJs, /popupMessage\("QUICK_ADD_HEADER", \{ header, value, sessionOnly \}\)/);
  assert.match(popupJs, /valueInput\.type = sessionOnly \? "password" : "text"/);

  const chipFunction = popupJs.match(
    /function createModificationChips\(modifications\) \{([\s\S]*?)\n\}\n\nfunction createActiveRulesEmpty/
  );
  assert.ok(chipFunction);
  assert.match(chipFunction[1], /needs session value/);
  assert.doesNotMatch(chipFunction[1], /modification\.value/);
});

test("sensitive values are paired with in-memory storage and DNR session rules", () => {
  assert.match(background, /chrome\.storage\.session\.get\(SESSION_HEADER_VALUES_KEY\)/);
  assert.match(background, /chrome\.storage\.session\.set\(/);
  assert.match(background, /chrome\.storage\.session\.setAccessLevel\(\{ accessLevel: "TRUSTED_CONTEXTS" \}\)/);
  assert.match(background, /chrome\.declarativeNetRequest\.getSessionRules\(\)/);
  assert.match(background, /chrome\.declarativeNetRequest\.updateSessionRules\(/);
  assert.match(background, /initializeAndReconcile\("Service worker started"\)/);
  assert.match(background, /Core\.sanitizeStateForLocalStorage\(normalized\)/);
  assert.match(core, /function sanitizeStateForLocalStorage\(/);
  assert.match(core, /function extractSessionHeaderValues\(/);
  assert.match(core, /function hydrateSessionHeaderValues\(/);
});

test("exports, rollback and privacy copy explicitly exclude session-only values", () => {
  assert.match(core, /function configurationSnapshot\(state\) \{\s*const normalized = sanitizeStateForLocalStorage\(state\)/);
  assert.match(appHtml, /without history, diagnostics, or session-only values/);
  assert.match(appJs, /session-only value.*excluded/);
  assert.match(privacy, /not written to MonoHeader's persistent configuration, rollback snapshot, diagnostics, deployment history, or exported JSON/);
  assert.match(privacy, /removes any stale session rule/);
});

