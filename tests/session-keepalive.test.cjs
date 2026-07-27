"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const projectRoot = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(projectRoot, "manifest.json"), "utf8"));
const background = readFileSync(join(projectRoot, "background.js"), "utf8");
const injectedStart = background.indexOf("async function runMonoHeaderSessionCheck(input) {");
const injectedEnd = background.indexOf("\nasync function getSessionKeepAliveForTab", injectedStart);
const injectedCheck = background.slice(injectedStart, injectedEnd);
const backgroundRuntime = `${background.slice(0, injectedStart)}${background.slice(injectedEnd)}`;
const popupHtml = readFileSync(join(projectRoot, "popup.html"), "utf8");
const popupJs = readFileSync(join(projectRoot, "popup.js"), "utf8");
const reportStart = popupJs.indexOf("function createSessionDiagnosticReport(session) {");
const reportEnd = popupJs.indexOf("\nfunction formatSessionMode", reportStart);
const diagnosticReportSource = popupJs.slice(reportStart, reportEnd);
const privacy = readFileSync(join(projectRoot, "PRIVACY.md"), "utf8");

test("keep-alive uses transient scripting and alarms without persistent content scripts", () => {
  assert.ok(manifest.permissions.includes("alarms"));
  assert.ok(manifest.permissions.includes("scripting"));
  assert.equal(manifest.content_scripts, undefined);
  assert.match(background, /importScripts\("core\.js"\)/);
  assert.match(background, /func:\s*runMonoHeaderSessionCheck/);
  assert.match(background, /store\.entries\[entryIndex\]\.mode/);
  assert.match(background, /store\.entries\[entryIndex\]\.targetPath/);
  assert.doesNotMatch(backgroundRuntime, /\bfetch\s*\(/);
  assert.match(background, /function queueSessionOperation\(operation\)/);
  assert.match(background, /SESSION_SERIAL_ACTIONS\.has\(action\)/);
  assert.match(background, /"GET_SESSION_KEEP_ALIVE",\s*\.\.\.SESSION_WRITE_ACTIONS/s);
  assert.match(
    background,
    /action === "RESET"\s*\?\s*queueOperation\(\(\) => queueSessionOperation\(\(\) => handleMessage\(message\)\)\)/
  );
  assert.match(background, /function isReadOnlyAction\(action\)/);
  assert.match(background, /SESSION_EXECUTION_TIMEOUT_MS = 5000/);
  assert.match(background, /withTimeout\(\s*chrome\.scripting\.executeScript\(/s);
});

test("keep-alive ping is HTTPS, credentialed, same-origin, and metadata-only", () => {
  assert.equal([...injectedCheck.matchAll(/\bfetch\s*\(/g)].length, 1);
  assert.match(injectedCheck, /pageTarget\.protocol !== "https:"/);
  assert.match(injectedCheck, /new URL\(normalizedPath, pageTarget\.origin\)/);
  assert.match(injectedCheck, /target\.origin !== pageTarget\.origin/);
  assert.match(injectedCheck, /credentials:\s*"include"/);
  assert.match(injectedCheck, /mode:\s*"same-origin"/);
  assert.match(injectedCheck, /finalUrl\.origin === pageTarget\.origin/);
  assert.match(injectedCheck, /response\.body\.cancel\(\)/);
  assert.doesNotMatch(injectedCheck, /\.cookie\b|\b(?:localStorage|sessionStorage)\b/);
  assert.doesNotMatch(injectedCheck, /response\.(?:text|json|blob|arrayBuffer|formData)\s*\(/);
});

test("popup makes the network behavior and supported intervals explicit", () => {
  assert.match(popupHtml, /id="session-toggle"/);
  assert.match(popupHtml, /id="session-status"[^>]+aria-live="polite"/);
  for (const interval of [5, 10, 15, 30]) {
    assert.match(popupHtml, new RegExp(`<option value="${interval}"`));
  }
  assert.match(popupHtml, /id="session-target-path"/);
  assert.match(popupHtml, /id="session-target-path-label"[^>]+hidden/);
  assert.match(popupHtml, /id="session-target-path"[^>]+hidden/);
  assert.match(popupHtml, /id="session-mode"/);
  for (const mode of ["request", "activity", "both"]) {
    assert.match(popupHtml, new RegExp(`<option value="${mode}"`));
  }
  assert.match(popupHtml, /Dispatches synthetic mousemove and click events to the document itself/);
  assert.match(popupJs, /Sends one authenticated GET to this HTTPS site/);
  assert.match(popupJs, /Leave the path blank to request the current page/);
  assert.match(popupJs, /SET_SESSION_KEEP_ALIVE/);
  assert.match(popupJs, /GET_SESSION_KEEP_ALIVE/);
  assert.match(popupJs, /targetPath: popupState\.sessionTargetPath/);
  assert.match(popupJs, /mode: popupState\.sessionMode/);
  assert.match(popupJs, /sessionMode:\s*"activity"/);
  assert.match(popupJs, /targetPathLabel\.hidden = !requestPathVisible/);
  assert.match(popupJs, /targetPath\.hidden = !requestPathVisible/);
  assert.match(background, /mode: selectedSettings \? selectedSettings\.mode : "activity"/);
  assert.match(background, /return SESSION_MODES\.has\(value\) \? value : "activity"/);
  assert.match(privacy, /credentialed `GET`/);
  assert.match(privacy, /does not read or retain page content or the response body/);
});

test("popup provides one-shot test, tab-only reset, and metadata-only diagnostics", () => {
  assert.match(popupHtml, /id="session-test-button"[^>]*>Test now</);
  assert.match(popupHtml, /id="session-reset-button"[^>]*>Reset tab</);
  assert.match(popupHtml, /id="session-test-button"[^>]+aria-describedby="session-action-help"/);
  assert.match(popupHtml, /id="session-reset-button"[^>]+aria-describedby="session-action-help"/);
  assert.match(popupHtml, /id="session-diagnostics-button"[^>]+aria-expanded="false"/);
  assert.match(popupHtml, /id="session-diagnostics"[^>]+hidden/);
  assert.match(popupHtml, /id="session-copy-diagnostics"/);
  assert.match(popupHtml, /Test runs once without starting the schedule/);
  assert.match(popupHtml, /Reset affects only this tab/);
  assert.match(popupHtml, /Cookies, page content, and response bodies are never included/);
  assert.match(popupJs, /TEST_SESSION_KEEP_ALIVE/);
  assert.match(popupJs, /RESET_SESSION_KEEP_ALIVE/);
  assert.match(popupJs, /createSessionDiagnosticReport/);
  assert.match(popupJs, /configured request paths are excluded/);
  assert.doesNotMatch(diagnosticReportSource, /\.targetPath\b|document\.cookie|localStorage|sessionStorage/);
  assert.match(background, /async function testSessionKeepAliveForTab/);
  assert.match(background, /sessionDiagnostic: createSessionDiagnostic\(check, mode\)/);
  assert.match(background, /lastTrigger: check\.trigger/);
  assert.match(background, /lastCompletedAt: check\.completedAt/);
});

test("popup shows completion-based success and a live next-check countdown", () => {
  assert.match(popupHtml, /id="session-last-success"/);
  assert.match(popupHtml, /id="session-next-check"/);
  assert.match(background, /const completedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(background, /updated\.lastSuccessAt = check\.completedAt/);
  assert.match(background, /nextCheckAt: entry \? normalizeAlarmTimestamp\(alarm && alarm\.scheduledTime\) : null/);
  assert.match(popupJs, /chrome\.storage\.onChanged\.addListener\(handleSessionStorageChange\)/);
  assert.match(popupJs, /window\.setInterval\(updateSessionCountdown, 1000\)/);
  assert.match(popupJs, /String\(minutes\)\.padStart\(2, "0"\)/);
  assert.match(popupJs, /Latest request succeeded/);
  assert.match(popupHtml, /Last pulse dispatched/);
});

test("activity mode dispatches events only to the document and warns they may be ignored", () => {
  assert.match(injectedCheck, /globalThis\.document\.dispatchEvent\(new MouseEvent\("mousemove"/);
  assert.match(injectedCheck, /globalThis\.document\.dispatchEvent\(new MouseEvent\("click"/);
  assert.doesNotMatch(injectedCheck, /querySelector|getElementById|HTMLElement\.prototype\.click|\.click\(\)/);
  assert.match(popupJs, /It never selects or activates a page element/);
  assert.match(popupJs, /sites may ignore untrusted events/);
});

test("session request paths are normalized and constrained to the tab origin", () => {
  assert.match(background, /function normalizeSessionTargetPath\(value, origin\)/);
  assert.match(background, /parsed\.origin !== origin/);
  assert.match(background, /parsed\.username \|\| parsed\.password \|\| parsed\.hash/);
  assert.match(background, /targetPath: selectedSettings \? selectedSettings\.targetPath : ""/);
});

test("per-site presets remember exact-origin settings without auto-starting", () => {
  assert.match(popupHtml, /id="session-preset-save"[^>]*>Save preset</);
  assert.match(popupHtml, /id="session-preset-delete"/);
  assert.match(popupHtml, /Stores these settings for this exact HTTPS site/);
  assert.match(popupHtml, /Presets never start keep-alive automatically/);
  assert.match(popupHtml, /Reset affects only this tab and keeps its site preset/);
  assert.match(popupJs, /SAVE_SESSION_KEEP_ALIVE_PRESET/);
  assert.match(popupJs, /DELETE_SESSION_KEEP_ALIVE_PRESET/);
  assert.match(popupJs, /sessionPresetMatchesControls/);
  assert.match(background, /const SESSION_STORE_VERSION = 5/);
  assert.match(background, /const MAX_SESSION_PRESETS = 100/);
  assert.match(background, /async function saveSessionPresetForTab/);
  assert.match(background, /async function deleteSessionPresetForTab/);
  assert.match(background, /preset\.origin === tabInfo\.origin/);
  assert.match(background, /return \{ version: SESSION_STORE_VERSION, entries, presets \}/);
  const saveStart = background.indexOf("async function saveSessionPresetForTab");
  const saveEnd = background.indexOf("\nasync function deleteSessionPresetForTab", saveStart);
  const savePresetSource = background.slice(saveStart, saveEnd);
  assert.doesNotMatch(savePresetSource, /ensureSessionAlarm|executeSessionKeepAliveCheck|chrome\.scripting/);
});

test("status reads ensure a missing alarm without replacing a matching one", () => {
  assert.match(background, /const existing = await chrome\.alarms\.get\(name\)/);
  assert.match(background, /if \(replace \|\| intervalChanged\)/);
  assert.doesNotMatch(background, /if \(entry\) await scheduleSessionAlarm\(entry\)/);
});

test("keep-alive is the final functional section in the popup", () => {
  const dashboardIndex = popupHtml.indexOf('id="open-dashboard"');
  const sessionIndex = popupHtml.indexOf('class="session-card"');
  const privacyIndex = popupHtml.indexOf('class="privacy-copy"');

  assert.ok(dashboardIndex >= 0);
  assert.ok(sessionIndex > dashboardIndex);
  assert.ok(privacyIndex > sessionIndex);
});
