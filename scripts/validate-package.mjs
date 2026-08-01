import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requiredFiles = [
  "manifest.json",
  "platform.js",
  "background.js",
  "core.js",
  "app.html",
  "app.css",
  "app.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "icons/monoheader-wordmark.svg",
  "icons/monoheader-icon.svg",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png"
];
const errors = [];

for (const relativePath of requiredFiles) {
  try {
    const metadata = await stat(join(projectRoot, relativePath));
    if (!metadata.isFile() || metadata.size === 0) errors.push(`${relativePath} is empty or is not a file.`);
  } catch {
    errors.push(`${relativePath} is missing.`);
  }
}

const manifest = JSON.parse(await readFile(join(projectRoot, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const creatorName = "Monolith Consulting AB";
if (manifest.manifest_version !== 3) errors.push("manifest.json must use Manifest V3.");
if (manifest.minimum_chrome_version !== "120") errors.push("The tested minimum Chrome version must remain explicit.");
if (!manifest.permissions.includes("storage")) errors.push("The storage permission is required.");
if (!manifest.permissions.includes("declarativeNetRequestWithHostAccess")) errors.push("The DNR permission is required.");
if (!manifest.permissions.includes("alarms")) errors.push("The alarms permission is required for session keep-alive.");
if (!manifest.permissions.includes("scripting")) errors.push("The scripting permission is required for transient session keep-alive.");
for (const forbidden of ["tabs", "webRequest", "webRequestBlocking", "cookies", "history", "unlimitedStorage"]) {
  if (manifest.permissions.includes(forbidden)) errors.push(`Unexpected broad permission: ${forbidden}.`);
}
if (manifest.content_scripts) errors.push("Content scripts are intentionally prohibited.");
if (!manifest.content_security_policy.extension_pages.includes("connect-src 'none'")) {
  errors.push("Extension pages must prohibit outbound connections with connect-src 'none'.");
}
if (JSON.stringify(manifest).includes("http://") || JSON.stringify(manifest).includes("https://")) {
  errors.push("The manifest contains a remote URL.");
}
if (packageJson.version !== manifest.version) {
  errors.push("package.json and manifest.json versions must match.");
}
if (packageJson.author !== creatorName) {
  errors.push(`package.json must identify ${creatorName} as the author.`);
}
if (!manifest.description.includes(`Created by ${creatorName}.`)) {
  errors.push(`The Chrome-visible manifest description must identify ${creatorName} as creator.`);
}
if (manifest.description.length > 132) {
  errors.push("The manifest description exceeds Chrome Web Store's 132-character limit.");
}

for (const relativePath of ["icons/monoheader-wordmark.svg", "icons/monoheader-icon.svg"]) {
  const source = await readFile(join(projectRoot, relativePath), "utf8");
  for (const [pattern, description] of [
    [/<script\b/i, "script content"],
    [/<foreignObject\b/i, "foreign-object content"],
    [/<image\b/i, "embedded or linked images"],
    [/\b(?:href|src)\s*=/i, "linked resources"],
    [/\bon[a-z]+\s*=/i, "inline event handlers"],
    [/\burl\s*\(\s*(?!#)/i, "external CSS URL references"]
  ]) {
    if (pattern.test(source)) errors.push(`${relativePath} contains prohibited ${description}.`);
  }
}

const backgroundSource = await readFile(join(projectRoot, "background.js"), "utf8");
const platformSource = await readFile(join(projectRoot, "platform.js"), "utf8");
const coreSource = await readFile(join(projectRoot, "core.js"), "utf8");
const appHtmlSource = await readFile(join(projectRoot, "app.html"), "utf8");
const popupHtmlSource = await readFile(join(projectRoot, "popup.html"), "utf8");
for (const [name, source, pattern] of [
  ["core.js", coreSource, new RegExp(`APP_VERSION = "${escapeRegExp(manifest.version)}"`)],
  ["app.html", appHtmlSource, new RegExp(`Version ${escapeRegExp(manifest.version)}`)],
  ["popup.html", popupHtmlSource, new RegExp(`id="popup-version">${escapeRegExp(manifest.version)}<`)]
]) {
  if (!pattern.test(source)) errors.push(`${name} does not display manifest version ${manifest.version}.`);
}
for (const [source, pattern, description] of [
  [backgroundSource, /ExtensionAPI\.storage\.session\.get\(SESSION_HEADER_VALUES_KEY\)/, "load sensitive values from in-memory session storage"],
  [backgroundSource, /ExtensionAPI\.storage\.session\.set\(/, "write sensitive values to in-memory session storage"],
  [backgroundSource, /ExtensionAPI\.storage\.session\.setAccessLevel\(\{ accessLevel: "TRUSTED_CONTEXTS" \}\)/, "restrict session storage to trusted extension contexts"],
  [backgroundSource, /ExtensionAPI\.declarativeNetRequest\.getSessionRules\(\)/, "inspect DNR session rules"],
  [backgroundSource, /ExtensionAPI\.declarativeNetRequest\.updateSessionRules\(/, "deploy sensitive values through DNR session rules"],
  [backgroundSource, /initializeAndReconcile\("Background runtime started"\)/, "reconcile stale session rules whenever the background runtime starts"],
  [backgroundSource, /async function saveSessionPresetForTab/, "save exact-origin keep-alive presets"],
  [backgroundSource, /return \{ version: SESSION_STORE_VERSION, entries, presets, pauses \}/, "retain versioned keep-alive presets and per-tab pauses"],
  [backgroundSource, /function findEffectiveSessionPreset/, "resolve one effective keep-alive rule per tab"],
  [backgroundSource, /function compareSessionPresetSpecificity/, "apply deterministic exact and wildcard precedence"],
  [backgroundSource, /async function reconcileSessionKeepAliveForTab/, "reconcile automatic keep-alive when tabs load or navigate"],
  [backgroundSource, /Core\.sanitizeStateForLocalStorage\(normalized\)/, "scrub session-only values before local persistence"],
  [coreSource, /function sanitizeStateForLocalStorage\(/, "provide local-state redaction"],
  [coreSource, /const normalized = sanitizeStateForLocalStorage\(state\)/, "redact configuration snapshots and exports"]
]) {
  if (!pattern.test(source)) errors.push(`The session-only value implementation must ${description}.`);
}
const injectedStart = backgroundSource.indexOf("async function runMonoHeaderSessionCheck(input) {");
const injectedEnd = backgroundSource.indexOf("\nasync function getSessionKeepAliveForTab", injectedStart);
const injectedSessionCheck = injectedStart >= 0 && injectedEnd > injectedStart
  ? backgroundSource.slice(injectedStart, injectedEnd)
  : "";
const backgroundRuntime = injectedSessionCheck
  ? `${backgroundSource.slice(0, injectedStart)}${backgroundSource.slice(injectedEnd)}`
  : backgroundSource;
if (!injectedSessionCheck) errors.push("background.js is missing the packaged injected session-check function.");
const presetSaveStart = backgroundSource.indexOf("async function saveSessionPresetForTab");
const presetSaveEnd = backgroundSource.indexOf("\nasync function deleteSessionPresetForTab", presetSaveStart);
const presetSaveSource = presetSaveStart >= 0 && presetSaveEnd > presetSaveStart
  ? backgroundSource.slice(presetSaveStart, presetSaveEnd)
  : "";
if (!presetSaveSource) {
  errors.push("background.js is missing exact-origin keep-alive preset persistence.");
} else if (/executeSessionKeepAliveCheck|ExtensionAPI\.scripting|setSessionKeepAliveForTab/.test(presetSaveSource)) {
  errors.push("Saving a popup preset must not directly inject a page action or manually enable a tab.");
}

const runtimeSources = [
  ["background.js", backgroundRuntime],
  ["platform.js", platformSource],
  ["core.js", coreSource],
  ["app.js", await readFile(join(projectRoot, "app.js"), "utf8")],
  ["popup.js", await readFile(join(projectRoot, "popup.js"), "utf8")]
];
const prohibitedPatterns = [
  [/\bfetch\s*\(/, "fetch()"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bnavigator\.sendBeacon\b/, "sendBeacon"],
  [/\bnew\s+WebSocket\s*\(/, "WebSocket constructor"],
  [/\bEventSource\s*\(/, "EventSource"],
  [/\beval\s*\(/, "eval()"],
  [/\bnew\s+Function\s*\(/, "Function constructor"],
  [/\bimport\s*\(/, "dynamic import"]
];
for (const [relativePath, source] of runtimeSources) {
  for (const [pattern, description] of prohibitedPatterns) {
    if (pattern.test(source)) errors.push(`${relativePath} contains prohibited networking or dynamic-code behavior: ${description}.`);
  }
}

const sessionFetches = [...injectedSessionCheck.matchAll(/\bfetch\s*\(/g)];
if (sessionFetches.length !== 1) {
  errors.push("The injected session check must contain exactly one narrowly scoped fetch().");
}
for (const [pattern, description] of [
  [/fetch\(target\.href,\s*\{/, "fetch the configured same-origin target only"],
  [/new URL\(normalizedPath,\s*pageTarget\.origin\)/, "resolve configured paths against the tab origin"],
  [/target\.origin\s*!==\s*pageTarget\.origin/, "reject cross-origin configured paths"],
  [/method:\s*"GET"/, "use GET"],
  [/credentials:\s*"include"/, "use the existing authenticated session"],
  [/cache:\s*"no-store"/, "bypass cached responses"],
  [/mode:\s*"same-origin"/, "enforce same-origin requests"],
  [/finalUrl\.origin\s*===\s*pageTarget\.origin/, "verify the final origin"],
  [/response\.body\.cancel\(\)/, "discard the response body"]
]) {
  if (!pattern.test(injectedSessionCheck)) errors.push(`The injected session check must ${description}.`);
}
for (const [pattern, description] of [
  [/\b(?:querySelector|querySelectorAll|getElementById|getElementsBy\w+)\s*\(/, "query DOM elements"],
  [/\b(?:innerHTML|outerHTML|textContent|innerText)\b/, "read or write DOM content"],
  [/\b(?:localStorage|sessionStorage)\b/, "access page storage"],
  [/\.cookie\b/, "access cookies directly"],
  [/\bresponse\.(?:text|json|blob|arrayBuffer|formData)\s*\(/, "read response content"],
  [/\bXMLHttpRequest\b/, "use XMLHttpRequest"],
  [/\b(?:WebSocket|EventSource)\b/, "open a streaming connection"]
]) {
  if (pattern.test(injectedSessionCheck)) errors.push(`The injected session check must not ${description}.`);
}
for (const [pattern, description] of [
  [/globalThis\.document\.dispatchEvent\(new MouseEvent\("mousemove"/, "dispatch a document-level mousemove pulse"],
  [/globalThis\.document\.dispatchEvent\(new MouseEvent\("click"/, "dispatch a document-level click pulse"],
  [/func:\s*runMonoHeaderSessionCheck/, "pass the packaged function to the scripting API"]
]) {
  const source = description.includes("scripting API") ? backgroundRuntime : injectedSessionCheck;
  if (!pattern.test(source)) errors.push(`The session implementation must ${description}.`);
}

for (const relativePath of ["app.html", "popup.html"]) {
  const source = await readFile(join(projectRoot, relativePath), "utf8");
  const ids = [...source.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length) errors.push(`${relativePath} contains duplicate IDs: ${[...new Set(duplicateIds)].join(", ")}.`);
  const scriptTags = [...source.matchAll(/<script\b([^>]*)>/gi)];
  for (const match of scriptTags) {
    if (!/\bsrc\s*=\s*["'][^"']+["']/i.test(match[1])) errors.push(`${relativePath} contains an inline script.`);
    if (/src\s*=\s*["'](?:https?:)?\/\//i.test(match[1])) errors.push(`${relativePath} loads a remote script.`);
  }
  if (/\son\w+\s*=/i.test(source)) errors.push(`${relativePath} contains an inline event handler.`);
}

const appHtml = appHtmlSource;
const appJs = await readFile(join(projectRoot, "app.js"), "utf8");
const popupHtml = popupHtmlSource;
const popupJs = await readFile(join(projectRoot, "popup.js"), "utf8");
checkReferencedIds(appJs, appHtml, "app.js", "app.html", [
  ...appJs.matchAll(/\$\(\s*["']#([A-Za-z][\w:-]*)["']\s*\)/g)
].map((match) => match[1]));
checkReferencedIds(popupJs, popupHtml, "popup.js", "popup.html", [
  ...popupJs.matchAll(/getElementById\(\s*["']([A-Za-z][\w:-]*)["']\s*\)/g)
].map((match) => match[1]));

if (errors.length) {
  console.error(`Package validation failed with ${errors.length} issue${errors.length === 1 ? "" : "s"}:`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`Package validation passed (${requiredFiles.length} required files, constrained request/activity session modes, no dynamic code).`);
}

function checkReferencedIds(script, html, scriptName, htmlName, ids) {
  void script;
  for (const id of new Set(ids)) {
    if (!new RegExp(`\\bid\\s*=\\s*["']${escapeRegExp(id)}["']`).test(html)) {
      errors.push(`${scriptName} references #${id}, which is missing from ${htmlName}.`);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
