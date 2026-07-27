"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const projectRoot = join(__dirname, "..");
const appHtml = readFileSync(join(projectRoot, "app.html"), "utf8");
const popupHtml = readFileSync(join(projectRoot, "popup.html"), "utf8");
const appCss = readFileSync(join(projectRoot, "app.css"), "utf8");
const popupCss = readFileSync(join(projectRoot, "popup.css"), "utf8");
const manifest = JSON.parse(readFileSync(join(projectRoot, "manifest.json"), "utf8"));
const iconGenerator = readFileSync(join(projectRoot, "scripts", "generate-icons.mjs"), "utf8");
const wordmark = readFileSync(join(projectRoot, "icons", "monoheader-wordmark.svg"), "utf8");
const compactIcon = readFileSync(join(projectRoot, "icons", "monoheader-icon.svg"), "utf8");

const expectedIcons = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png"
};

test("every Chrome and in-app logo surface uses the responsive canonical assets", () => {
  assert.deepEqual(manifest.icons, expectedIcons);
  assert.deepEqual(manifest.action.default_icon, expectedIcons);

  for (const html of [appHtml, popupHtml]) {
    assert.match(html, /<link rel="icon"[^>]+href="icons\/icon-32\.png">/);
    assert.match(html, /<img class="brand-wordmark" src="icons\/monoheader-wordmark\.svg"[^>]+alt="MonoHeader">/);
    assert.doesNotMatch(html, /class="brand-mark"|src="icons\/icon-48\.png"/);
  }
  assert.match(appHtml, /<img class="brand-icon" src="icons\/monoheader-icon\.svg"[^>]+aria-hidden="true">/);
});

test("legacy logo artwork cannot replace the supplied vector identity", () => {
  for (const css of [appCss, popupCss]) {
    assert.doesNotMatch(css, /#5149e9|#716bf3/i);
    assert.doesNotMatch(css, /\.brand-mark::(?:before|after)/);
  }
  assert.match(iconGenerator, /monoheader-icon\.svg/);
  assert.match(iconGenerator, /new Resvg/);
  assert.doesNotMatch(iconGenerator, /drawMonogram|drawHeaderRequestMotif/);
});

test("canonical SVG assets are self-contained and preserve the supplied palette", () => {
  for (const source of [wordmark, compactIcon]) {
    assert.doesNotMatch(source, /<(?:script|foreignObject|image)\b/i);
    assert.doesNotMatch(source, /\b(?:href|src)\s*=|\bon[a-z]+\s*=|\burl\s*\(\s*(?!#)/i);
    assert.match(source, /#4338CA/);
  }
  assert.match(wordmark, /viewBox="38 810 1970 430"/);
  assert.match(compactIcon, /viewBox="28 815 380 380"/);
  for (const color of ["#0BA54D", "#B86900", "#D23442"]) {
    assert.match(wordmark, new RegExp(color, "i"));
    assert.match(compactIcon, new RegExp(color, "i"));
  }
});

test("canonical PNG assets have the exact Chrome icon dimensions", () => {
  for (const size of [16, 32, 48, 128]) {
    const image = readFileSync(join(projectRoot, "icons", `icon-${size}.png`));
    assert.deepEqual(
      [...image.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
      `icon-${size}.png must be a PNG file.`
    );
    assert.equal(image.readUInt32BE(16), size);
    assert.equal(image.readUInt32BE(20), size);
  }
});
