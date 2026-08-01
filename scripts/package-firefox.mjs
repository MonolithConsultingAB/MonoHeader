import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { createZip } from "./create-zip.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distributionRoot = join(projectRoot, "dist");
const unpackedRoot = join(distributionRoot, "monoheader-firefox");
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const zipPath = join(distributionRoot, `monoheader-firefox-${packageJson.version}.zip`);
const xpiPath = join(distributionRoot, `monoheader-firefox-${packageJson.version}-unsigned.xpi`);
const packageFiles = [
  "platform.js",
  "background.js",
  "core.js",
  "app.html",
  "app.css",
  "app.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "README.md",
  "PRIVACY.md",
  "icons"
];

await mkdir(distributionRoot, { recursive: true });
await rm(unpackedRoot, { recursive: true, force: true });
await rm(zipPath, { force: true });
await rm(xpiPath, { force: true });
await mkdir(unpackedRoot, { recursive: true });
await cp(join(projectRoot, "manifest.firefox.json"), join(unpackedRoot, "manifest.json"));
for (const relativePath of packageFiles) {
  await cp(join(projectRoot, relativePath), join(unpackedRoot, basename(relativePath)), { recursive: true });
}
const entries = await readdir(unpackedRoot);
await createZip(unpackedRoot, entries, zipPath);
await cp(zipPath, xpiPath);
console.log(`Created unpacked Firefox extension: ${unpackedRoot}`);
console.log(`Created AMO upload ZIP: ${zipPath}`);
console.log(`Created unsigned temporary-test XPI: ${xpiPath}`);
