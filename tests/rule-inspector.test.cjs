"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const appHtml = readFileSync(join(root, "app.html"), "utf8");
const appCss = readFileSync(join(root, "app.css"), "utf8");
const appJs = readFileSync(join(root, "app.js"), "utf8");

test("workspace exposes a contextual effective-result inspector", () => {
  assert.match(appHtml, /id="rule-inspector-button"/);
  assert.match(appHtml, /id="rule-inspector-dialog"[^>]+aria-labelledby="rule-inspector-title"/);
  assert.match(appHtml, /id="rule-inspector-form"/);
  assert.match(appHtml, /id="inspector-url"[^>]+type="url"[^>]+required/);
  assert.match(appHtml, /id="inspector-initiator"/);
  assert.match(appHtml, /id="inspector-method"/);
  assert.match(appHtml, /id="inspector-resource-type"/);
  assert.match(appHtml, /id="inspector-domain-type"/);
  assert.match(appHtml, /id="rule-inspector-result"[^>]+aria-live="polite"/);
  assert.match(appHtml, /id="rule-inspector-error"[^>]+role="alert"/);
  assert.doesNotMatch(appHtml, /id="test-url"/);
});

test("inspector delegates matching and precedence to the core model", () => {
  assert.match(appJs, /Core\.inspectEffectiveHeaders\(\s*draftState/);
  assert.match(appJs, /method:\s*\$\("#inspector-method"\)\.value/);
  assert.match(appJs, /resourceType:\s*\$\("#inspector-resource-type"\)\.value/);
  assert.match(appJs, /initiatorDomain:\s*\$\("#inspector-initiator"\)\.value/);
  assert.match(appJs, /domainType:\s*\$\("#inspector-domain-type"\)\.value/);
  assert.match(appJs, /function invalidateRuleInspection\(/);
  assert.match(appJs, /Rules changed\. Inspect again for a current result\./);
});

test("configured header values are hidden unless the user opts in", () => {
  const toggle = appHtml.match(/<input id="inspector-show-values"[^>]*>/);
  assert.ok(toggle, "Expected a configured-value visibility control.");
  assert.doesNotMatch(toggle[0], /\bchecked\b/);
  assert.match(appHtml, /Values stay hidden by default\./);

  const rendererStart = appJs.indexOf("function createInspectorOperation(operation)");
  const rendererEnd = appJs.indexOf("\nfunction formatInspectorStatus", rendererStart);
  const renderer = appJs.slice(rendererStart, rendererEnd);
  assert.match(renderer, /\$\("#inspector-show-values"\)\.checked/);
  assert.match(renderer, /value\.textContent = operation\.value/);
  assert.match(renderer, /value\.textContent = "Value hidden"/);
});

test("inspector clearly labels uncertainty and remains responsive", () => {
  assert.match(appHtml, /Equal-priority conflicts are never guessed\./);
  assert.match(appJs, /equal-priority order is not guaranteed/);
  assert.match(appJs, /other extensions may also modify these headers/);
  assert.match(appCss, /\.inspector-header-card\.is-ambiguous/);
  assert.match(appCss, /\.inspector-operation\.is-shadowed/);
  assert.match(appCss, /\.inspector-context-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(4/);
  assert.match(appCss, /@media \(max-width: 760px\)[\s\S]*\.inspector-context-grid\s*\{\s*grid-template-columns:\s*1fr/);
});
