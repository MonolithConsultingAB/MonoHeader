"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const creator = "Monolith Consulting AB";
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

test("Monolith Consulting AB is the canonical MonoHeader creator", () => {
  assert.equal(packageJson.author, creator);
  assert.match(manifest.description, new RegExp(`Created by ${creator.replaceAll(" ", "\\s+")}\\.`));
  assert.ok(manifest.description.length <= 132);

  for (const relativePath of ["README.md", "PRIVACY.md", "app.html", "popup.html"]) {
    assert.match(
      read(relativePath),
      new RegExp(creator),
      `${relativePath} must carry the canonical creator attribution.`
    );
  }
});

test("unsupported Chrome author metadata is not used as a substitute for visible attribution", () => {
  assert.equal(Object.hasOwn(manifest, "author"), false);
});
