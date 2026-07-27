import { mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createZip } from "./create-zip.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distributionRoot = join(projectRoot, "dist");
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const zipPath = join(distributionRoot, `monoheader-${packageJson.version}-source.zip`);
const sourceEntries = [
  ".github",
  ".gitattributes",
  ".gitignore",
  "GITHUB_UPLOAD.md",
  "PRIVACY.md",
  "README.md",
  "app.css",
  "app.html",
  "app.js",
  "background.js",
  "core.js",
  "icons",
  "manifest.json",
  "package-lock.json",
  "package.json",
  "playwright.config.mjs",
  "popup.css",
  "popup.html",
  "popup.js",
  "privacy-policy",
  "scripts",
  "store-assets",
  "tests"
];

await mkdir(distributionRoot, { recursive: true });
await rm(zipPath, { force: true });
await createZip(projectRoot, sourceEntries, zipPath);
console.log(`Created source archive: ${zipPath}`);
