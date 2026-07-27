import { Resvg } from "@resvg/resvg-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const iconDirectory = join(projectRoot, "icons");
const iconSourcePath = join(iconDirectory, "monoheader-icon.svg");
const iconSource = await readFile(iconSourcePath, "utf8");

await mkdir(iconDirectory, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const renderer = new Resvg(iconSource, {
    fitTo: {
      mode: "width",
      value: size
    }
  });
  const rendered = renderer.render();
  if (rendered.width !== size || rendered.height !== size) {
    throw new Error(`Generated ${size}px icon has unexpected dimensions ${rendered.width}x${rendered.height}.`);
  }
  await writeFile(join(iconDirectory, `icon-${size}.png`), rendered.asPng());
}

console.log("Generated Chrome PNG icons from icons/monoheader-icon.svg.");
