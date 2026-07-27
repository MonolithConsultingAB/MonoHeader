import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { createZip } from "./create-zip.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distributionRoot = join(projectRoot, "dist");
const unpackedRoot = join(distributionRoot, "monoheader");
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const zipPath = join(distributionRoot, `monoheader-${packageJson.version}.zip`);
const packageFiles = [
  "manifest.json",
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

await rm(distributionRoot, { recursive: true, force: true });
await mkdir(unpackedRoot, { recursive: true });
for (const relativePath of packageFiles) {
  await cp(join(projectRoot, relativePath), join(unpackedRoot, basename(relativePath)), { recursive: true });
}
const entries = await readdir(unpackedRoot);
await createZip(unpackedRoot, entries, zipPath);
console.log(`Created unpacked extension: ${unpackedRoot}`);
console.log(`Created Chrome/Web Store ZIP: ${zipPath}`);
