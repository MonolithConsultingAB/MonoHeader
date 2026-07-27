"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const popupCss = readFileSync(join(__dirname, "..", "popup.css"), "utf8");
const popupHtml = readFileSync(join(__dirname, "..", "popup.html"), "utf8");
const popupJs = readFileSync(join(__dirname, "..", "popup.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(__dirname, "..", "manifest.json"), "utf8"));

test("popup loading state cannot override the hidden attribute after initialization", () => {
  assert.match(popupHtml, /id="loading-state"/);
  assert.match(popupJs, /getElementById\("loading-state"\)\.hidden\s*=\s*true/);
  assert.match(
    popupCss,
    /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important\s*;?[^}]*\}/s,
    "An author-level [hidden] rule is required because .loading-state declares display:flex."
  );
});

test("popup content renders before session status retrieval and loading has a bounded failure state", () => {
  const renderIndex = popupJs.indexOf("renderPopup();");
  const sessionLoadIndex = popupJs.indexOf("await loadSessionContext();");
  assert.ok(renderIndex >= 0 && sessionLoadIndex > renderIndex);
  assert.match(popupJs, /const POPUP_MESSAGE_TIMEOUT_MS = 6000/);
  assert.match(popupJs, /Promise\.race\(\[Promise\.resolve\(promise\), timeout\]\)/);
  assert.match(popupJs, /function showPopupLoadFailure\(message\)/);
  assert.match(popupJs, /retry\.addEventListener\("click", \(\) => window\.location\.reload\(\)\)/);
  assert.match(popupCss, /\.loading-state\.is-error\s*\{/);
  assert.match(popupCss, /\.loading-retry\s*\{/);
});

test("popup exposes the running extension version for installation diagnostics", () => {
  const escapedVersion = manifest.version.replace(/\./g, "\\.");
  assert.match(popupHtml, new RegExp(`id="popup-version">${escapedVersion}<`));
  assert.match(popupJs, /getElementById\("popup-version"\)\.textContent = PopupCore\.APP_VERSION/);
});

test("popup lists every rule so disabled rules can be switched back on", () => {
  assert.match(popupHtml, /id="active-rule-list"[^>]+role="list"/);
  assert.match(popupHtml, /id="active-rules-badge"/);
  assert.match(
    popupJs,
    /renderActiveRules\(profile \? profile\.rules : \[\], profile, state\.extensionEnabled\)/
  );
  assert.match(popupJs, /list\.replaceChildren\(\.\.\.rules\.map\(createActiveRuleItem\)\)/);
  assert.doesNotMatch(popupJs, /if \(!extensionEnabled\) \{[\s\S]*?list\.replaceChildren/);
  assert.match(
    popupCss,
    /\.active-rule-list\s*\{[^}]*max-height:\s*220px;[^}]*overflow-y:\s*auto;/s,
    "The full rule list should scroll inside the compact popup."
  );
});

test("every popup rule row has an accessible compact on/off switch", () => {
  assert.match(popupJs, /input\.setAttribute\("role", "switch"\)/);
  assert.match(popupJs, /input\.setAttribute\("aria-label", `Enable rule \$\{rule\.name\}`\)/);
  assert.match(popupJs, /popupMessage\("SET_RULE_ENABLED"/);
  assert.match(popupJs, /popupState\.pendingRule = \{ ruleId, enabled \}/);
  assert.match(popupCss, /\.rule-switch \.switch-track\s*\{[^}]*height:\s*18px;[^}]*width:\s*32px;/s);
  assert.match(popupCss, /\.active-rule-item\.is-disabled\s*\{/);
});

test("popup switch inputs cover their complete visual hit targets", () => {
  const inputRule = popupCss.match(/\.switch input\s*\{([^}]*)\}/s);
  assert.ok(inputRule, "Expected the shared switch input rule.");
  assert.match(inputRule[1], /inset:\s*0/);
  assert.match(inputRule[1], /height:\s*100%/);
  assert.match(inputRule[1], /width:\s*100%/);
  assert.match(inputRule[1], /z-index:\s*1/);
  assert.doesNotMatch(inputRule[1], /(?:height|width):\s*1px/);
  assert.match(popupCss, /\.rule-switch\s*\{[^}]*padding-block:\s*3px/s);
});

test("active-rule summaries show actions without exposing header values", () => {
  const chipFunction = popupJs.match(
    /function createModificationChips\(modifications\) \{([\s\S]*?)\n\}\n\nfunction createActiveRulesEmpty/
  );
  assert.ok(chipFunction, "Expected the active-rule modification renderer.");
  assert.match(chipFunction[1], /modification\.header/);
  assert.doesNotMatch(chipFunction[1], /modification\.value/);
  assert.doesNotMatch(chipFunction[1], /innerHTML/);
});
