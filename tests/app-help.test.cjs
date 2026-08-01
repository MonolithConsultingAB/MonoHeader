"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const projectRoot = join(__dirname, "..");
const appHtml = readFileSync(join(projectRoot, "app.html"), "utf8");
const appCss = readFileSync(join(projectRoot, "app.css"), "utf8");
const appJs = readFileSync(join(projectRoot, "app.js"), "utf8");

test("rule editor explains when a saved draft is actually applied", () => {
  assert.match(appHtml, /class="rule-application-note"/);
  assert.match(appHtml, /Nothing is deployed until you choose <strong>Apply changes<\/strong>/);
});

test("technical rule fields expose keyboard-accessible help", () => {
  const helpTips = [...appHtml.matchAll(/<span class="help-tip"([^>]*)>\?<\/span>/g)];
  assert.ok(helpTips.length >= 6, "Expected contextual help on the technical rule fields.");

  for (const [, attributes] of helpTips) {
    assert.match(attributes, /tabindex="0"/);
    assert.match(attributes, /role="note"/);
    assert.match(attributes, /aria-label="[^"]+"/);
    assert.match(attributes, /data-tooltip="[^"]+"/);
  }

  assert.match(appCss, /\.help-tip:hover::after/);
  assert.match(appCss, /\.help-tip:focus::after/);
  assert.match(appCss, /\.help-tip:focus-visible/);
});

test("pattern guidance follows the selected filter syntax", () => {
  assert.match(appHtml, /id="url-pattern"[^>]+aria-describedby="url-pattern-help"/);
  assert.match(appHtml, /id="url-pattern-help"/);
  assert.match(appJs, /#pattern-type"\)\.addEventListener\("change", updatePatternGuidance\)/);
  assert.match(appJs, /function updatePatternGuidance\(\)/);
  assert.match(appJs, /regexFilter/);
  assert.match(appJs, /RE2 syntax/);
  assert.match(appJs, /DNR URL-filter syntax/);
});
