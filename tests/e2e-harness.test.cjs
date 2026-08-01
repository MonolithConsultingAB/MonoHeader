"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const config = readFileSync(join(root, "playwright.config.mjs"), "utf8");
const fixtures = readFileSync(join(root, "tests/e2e/fixtures.mjs"), "utf8");
const scenarios = readFileSync(join(root, "tests/e2e/monoheader.spec.mjs"), "utf8");
const server = readFileSync(join(root, "tests/e2e/test-server.mjs"), "utf8");
const workflow = readFileSync(join(root, ".github/workflows/release-check.yml"), "utf8");
const sourcePackager = readFileSync(join(root, "scripts/package-source.mjs"), "utf8");

test("release gate includes real Chromium extension tests", () => {
  assert.match(packageJson.scripts["test:e2e"], /playwright test/);
  assert.match(packageJson.scripts["release:check"], /npm run test:e2e/);
  assert.equal(packageJson.devDependencies["@playwright/test"], "1.62.0");
  assert.match(config, /trace:\s*"retain-on-failure"/);
  assert.match(config, /screenshot:\s*"only-on-failure"/);
  assert.match(fixtures, /chromium\.launchPersistentContext/);
  assert.match(fixtures, /--load-extension=/);
  assert.match(fixtures, /waitForExtensionWorker/);
});

test("browser suite uses only a temporary local HTTPS fixture", () => {
  assert.match(server, /https\.createServer/);
  assert.match(server, /server\.listen\(0, "127\.0\.0\.1"/);
  assert.match(server, /selfsigned\.generate/);
  assert.doesNotMatch(server, /https?:\/\/(?!localhost|127\.0\.0\.1)/);
});

test("browser scenarios cover popup, DNR, conflict inspection, keep-alive lifecycle, and restart", () => {
  assert.match(scenarios, /popup initializes in Chromium/);
  assert.match(scenarios, /tested, diagnosed, and reset without enabling a schedule/);
  assert.match(scenarios, /#session-test-button/);
  assert.match(scenarios, /#session-diagnostics-button/);
  assert.match(scenarios, /#session-reset-button/);
  assert.match(scenarios, /per-site keep-alive presets load only for their exact HTTPS origin/);
  assert.match(scenarios, /#session-preset-save/);
  assert.match(scenarios, /#session-preset-delete/);
  assert.match(scenarios, /keepAliveRequests\)\.toBe\(0\)/);
  assert.match(scenarios, /automatic keep-alive site rules start, explain, and pause per tab/);
  assert.match(scenarios, /#keepalive-auto-start/);
  assert.match(scenarios, /#keepalive-test-result/);
  assert.match(scenarios, /Paused for this tab/);
  assert.match(scenarios, /quick add deploys a real DNR header/);
  assert.match(scenarios, /rule inspector explains resolved and ambiguous conflicts/);
  assert.match(scenarios, /#rule-inspector-button/);
  assert.match(scenarios, /#inspector-show-values/);
  assert.match(scenarios, /session-only header values stay out of persistent storage/);
  assert.match(scenarios, /chrome\.storage\.session\.get/);
  assert.match(scenarios, /chrome\.declarativeNetRequest\.getSessionRules/);
  assert.match(scenarios, /real Chrome alarm wake-up/);
  assert.match(scenarios, /chrome\.alarms\.create/);
  assert.match(scenarios, /targetPage\.goto\(`\$\{testSite\.alternateOrigin\}/);
  assert.match(fixtures, /restartExtensionContext/);
  assert.match(fixtures, /extensionSession\.restart\(\)/);
  assert.match(fixtures, /launchExtensionContext\(userDataDir\)/);
  assert.match(fixtures, /chrome\.runtime\.sendMessage\(\{ action: "GET_RUNTIME" \}\)/);
  assert.doesNotMatch(fixtures, /chrome\.runtime\.reload/);
  assert.match(workflow, /mcr\.microsoft\.com\/playwright:v1\.62\.0-noble/);
  assert.match(workflow, /npm run release:check/);
});

test("browser setup messages originate from extension pages rather than the service worker itself", () => {
  const inspectorStart = scenarios.indexOf(
    'test("rule inspector explains resolved and ambiguous conflicts without exposing values by default"'
  );
  const sessionStart = scenarios.indexOf(
    'test("session-only header values stay out of persistent storage and expire on browser restart"'
  );
  const inspectorScenario = scenarios.slice(inspectorStart, sessionStart);

  assert.match(inspectorScenario, /workspace\.evaluate\(async \(\) =>/);
  assert.match(inspectorScenario, /await workspace\.reload\(\)/);
  assert.doesNotMatch(inspectorScenario, /serviceWorker\.evaluate/);
  assert.doesNotMatch(scenarios, /waitForEvent\("serviceworker"[\s\S]*worker !== serviceWorker/);
});

test("source packaging removes an existing archive before rebuilding it", () => {
  const removeIndex = sourcePackager.indexOf("await rm(zipPath, { force: true })");
  const zipIndex = sourcePackager.indexOf("await createZip(");

  assert.notEqual(removeIndex, -1);
  assert.notEqual(zipIndex, -1);
  assert.ok(removeIndex < zipIndex);
});

test("packaging is implemented in Node without an operating-system ZIP command", () => {
  const installPackager = readFileSync(join(root, "scripts/package.mjs"), "utf8");
  const zipHelper = readFileSync(join(root, "scripts/create-zip.mjs"), "utf8");

  assert.doesNotMatch(installPackager, /spawnSync|exec(?:File)?Sync/);
  assert.doesNotMatch(sourcePackager, /spawnSync|exec(?:File)?Sync/);
  assert.match(installPackager, /await createZip\(/);
  assert.match(sourcePackager, /await createZip\(/);
  assert.match(zipHelper, /zipSync/);
});
