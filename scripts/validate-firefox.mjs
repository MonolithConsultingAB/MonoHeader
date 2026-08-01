import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const errors = [];
const requiredFiles = [
  "manifest.firefox.json",
  "platform.js",
  "background.js",
  "core.js",
  "app.html",
  "app.css",
  "app.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png"
];

for (const relativePath of requiredFiles) {
  try {
    const metadata = await stat(join(projectRoot, relativePath));
    if (!metadata.isFile() || metadata.size === 0) errors.push(`${relativePath} is empty or is not a file.`);
  } catch {
    errors.push(`${relativePath} is missing.`);
  }
}

const manifest = JSON.parse(await readFile(join(projectRoot, "manifest.firefox.json"), "utf8"));
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const platformSource = await readFile(join(projectRoot, "platform.js"), "utf8");
const backgroundSource = await readFile(join(projectRoot, "background.js"), "utf8");
const appSource = await readFile(join(projectRoot, "app.js"), "utf8");
const popupSource = await readFile(join(projectRoot, "popup.js"), "utf8");
const appHtml = await readFile(join(projectRoot, "app.html"), "utf8");
const popupHtml = await readFile(join(projectRoot, "popup.html"), "utf8");
const gecko = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
const geckoAndroid = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko_android;

if (manifest.manifest_version !== 3) errors.push("The Firefox manifest must use Manifest V3.");
if (manifest.version !== packageJson.version) errors.push("The Firefox manifest and package.json versions must match.");
if (manifest.author !== "Monolith Consulting AB") errors.push("The Firefox manifest must identify Monolith Consulting AB as author.");
if (manifest.minimum_chrome_version) errors.push("The Firefox manifest must not contain minimum_chrome_version.");
if (!manifest.background || !Array.isArray(manifest.background.scripts)) {
  errors.push("Firefox must use a background scripts event page.");
} else if (manifest.background.scripts.join(",") !== "platform.js,core.js,background.js") {
  errors.push("Firefox background scripts must load the API adapter, core, and runtime in that order.");
}
if (manifest.background && manifest.background.service_worker) {
  errors.push("Firefox does not support background.service_worker.");
}
if (!gecko || gecko.id !== "monoheader@monolithconsulting.se") {
  errors.push("The Firefox package must have the stable Monolith Consulting AB add-on ID.");
}
if (!gecko || gecko.strict_min_version !== "140.0") {
  errors.push("Firefox 140 is required for the built-in data-consent declaration.");
}
if (!geckoAndroid || geckoAndroid.strict_min_version !== "142.0") {
  errors.push("Firefox for Android 142 is required for the built-in data-consent declaration.");
}
const dataTypes = gecko && gecko.data_collection_permissions && gecko.data_collection_permissions.required;
if (!Array.isArray(dataTypes) || dataTypes.join(",") !== "authenticationInfo,websiteContent") {
  errors.push("AMO data transmission must disclose authentication information and website content.");
}
for (const permission of ["storage", "alarms", "scripting", "declarativeNetRequestWithHostAccess"]) {
  if (!manifest.permissions.includes(permission)) errors.push(`The Firefox manifest is missing ${permission}.`);
}
if (!manifest.host_permissions.includes("<all_urls>")) errors.push("The Firefox header tool requires all-URL host access.");
for (const forbidden of ["tabs", "webRequest", "webRequestBlocking", "cookies", "history", "unlimitedStorage"]) {
  if (manifest.permissions.includes(forbidden)) errors.push(`Unexpected broad Firefox permission: ${forbidden}.`);
}
if (manifest.content_scripts) errors.push("Persistent Firefox content scripts are intentionally prohibited.");
if (!manifest.content_security_policy.extension_pages.includes("connect-src 'none'")) {
  errors.push("Firefox extension pages must prohibit outbound connections.");
}
if (JSON.stringify(manifest).includes("http://") || JSON.stringify(manifest).includes("https://")) {
  errors.push("The Firefox manifest contains a remote URL.");
}
if (!/globalThis\.browser \|\| globalThis\.chrome/.test(platformSource)) {
  errors.push("platform.js must prefer Firefox's Promise-based browser namespace.");
}
for (const [name, source] of [["background.js", backgroundSource], ["app.js", appSource], ["popup.js", popupSource]]) {
  if (/\bchrome\./.test(source)) errors.push(`${name} bypasses the shared WebExtensions adapter.`);
  if (!/ExtensionAPI/.test(source)) errors.push(`${name} does not use the shared WebExtensions adapter.`);
}
for (const [name, source] of [["app.html", appHtml], ["popup.html", popupHtml]]) {
  if (!/<script src="platform\.js"><\/script>\s*<script src="core\.js"><\/script>/.test(source)) {
    errors.push(`${name} must load platform.js before core.js and its UI controller.`);
  }
}

if (errors.length) {
  console.error(`Firefox validation failed with ${errors.length} issue${errors.length === 1 ? "" : "s"}:`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`Firefox validation passed (${requiredFiles.length} required files, Firefox 140+, explicit AMO disclosure, shared runtime adapter).`);
}
