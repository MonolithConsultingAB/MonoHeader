"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.firefox.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const platformSource = readFileSync(join(root, "platform.js"), "utf8");
const backgroundSource = readFileSync(join(root, "background.js"), "utf8");
const appSource = readFileSync(join(root, "app.js"), "utf8");
const popupSource = readFileSync(join(root, "popup.js"), "utf8");
const appHtml = readFileSync(join(root, "app.html"), "utf8");
const popupHtml = readFileSync(join(root, "popup.html"), "utf8");

test("Firefox manifest uses an event page, stable ID, and built-in consent metadata", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.author, "Monolith Consulting AB");
  assert.deepEqual(manifest.background.scripts, ["platform.js", "core.js", "background.js"]);
  assert.equal(manifest.background.service_worker, undefined);
  assert.equal(manifest.browser_specific_settings.gecko.id, "monoheader@monolithconsulting.se");
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "140.0");
  assert.equal(manifest.browser_specific_settings.gecko_android.strict_min_version, "142.0");
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, [
    "authenticationInfo",
    "websiteContent"
  ]);
});

test("platform adapter prefers Firefox's Promise-based browser namespace", () => {
  const browser = { runtime: {}, storage: {} };
  const chrome = { runtime: { wrong: true } };
  const context = vm.createContext({ browser, chrome, Object });
  vm.runInContext(platformSource, context, { filename: "platform.js" });
  assert.equal(context.MonoHeaderAPI, browser);
  assert.equal(context.MonoHeaderPlatform.api, browser);
  assert.equal(context.MonoHeaderPlatform.browserName, "Firefox");
  assert.equal(context.MonoHeaderPlatform.isFirefox, true);
});

test("shared runtime and UIs avoid direct chrome namespace calls", () => {
  for (const [name, source] of [
    ["background.js", backgroundSource],
    ["app.js", appSource],
    ["popup.js", popupSource]
  ]) {
    assert.doesNotMatch(source, /\bchrome\./, `${name} must use ExtensionAPI`);
    assert.match(source, /ExtensionAPI/);
  }
  assert.match(backgroundSource, /globalThis\.MonoHeaderAPI \|\| globalThis\.browser \|\| globalThis\.chrome/);
});

test("extension pages load the adapter before shared controllers", () => {
  assert.match(appHtml, /<script src="platform\.js"><\/script>\s*<script src="core\.js"><\/script>\s*<script src="app\.js"><\/script>/);
  assert.match(popupHtml, /<script src="platform\.js"><\/script>\s*<script src="core\.js"><\/script>\s*<script src="popup\.js"><\/script>/);
});
