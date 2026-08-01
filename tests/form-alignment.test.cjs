"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const projectRoot = join(__dirname, "..");
const appHtml = readFileSync(join(projectRoot, "app.html"), "utf8");
const appCss = readFileSync(join(projectRoot, "app.css"), "utf8");
const popupHtml = readFileSync(join(projectRoot, "popup.html"), "utf8");

test("every workspace field uses one label row before its control", () => {
  const fields = [...appHtml.matchAll(/<label class="field[^"]*">([\s\S]*?)<\/label>/g)];
  assert.ok(fields.length >= 14, "Expected every rule, profile, and modification field.");

  for (const [, body] of fields) {
    const markup = body.trim();
    assert.match(markup, /^<span class="field-label">/);
    const controlIndex = markup.search(/<(?:input|select|textarea)\b/);
    assert.ok(controlIndex > 0, "Each field must contain a form control after its label row.");
  }

  assert.doesNotMatch(
    appHtml,
    /<label class="field[^"]*">[^<]+<span class="optional"/,
    "Optional markers must remain inside the shared label row."
  );
});

test("workspace controls share fixed aligned heights", () => {
  assert.match(appCss, /\.form-grid\s*\{[^}]*align-items:\s*start;/s);
  assert.match(
    appCss,
    /\.field > input,\s*\.field > select\s*\{[^}]*height:\s*38px;[^}]*min-height:\s*38px;/s
  );
  assert.match(
    appCss,
    /\.field\.compact input,\s*\.field\.compact select\s*\{[^}]*height:\s*34px;[^}]*min-height:\s*34px;/s
  );
  assert.match(appCss, /\.field-label\s*\{[^}]*min-height:\s*16px;/s);
});

test("workspace hidden fields cannot be made visible by layout styles", () => {
  assert.match(appCss, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/s);
  assert.match(appHtml, /id="keepalive-target-path-field"[^>]*hidden/);
});

test("quick-add inputs inherit one shared popup layout", () => {
  assert.match(popupHtml, /id="quick-header-name"/);
  assert.match(popupHtml, /id="quick-header-value"/);
  assert.doesNotMatch(popupHtml, /id="quick-header-(?:name|value)"[^>]+style=/);
});
