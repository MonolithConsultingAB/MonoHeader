"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("Chrome, Firefox, and source archives build without an external ZIP executable", async () => {
  const env = { ...process.env, PATH: "" };
  execFileSync(process.execPath, ["scripts/package.mjs"], {
    cwd: root,
    env,
    stdio: "pipe"
  });
  execFileSync(process.execPath, ["scripts/package-source.mjs"], {
    cwd: root,
    env,
    stdio: "pipe"
  });
  execFileSync(process.execPath, ["scripts/package-firefox.mjs"], {
    cwd: root,
    env,
    stdio: "pipe"
  });

  const { unzipSync, strFromU8 } = await import("fflate");
  const installablePath = join(root, "dist", `monoheader-${packageJson.version}.zip`);
  const sourcePath = join(root, "dist", `monoheader-${packageJson.version}-source.zip`);
  const firefoxPath = join(root, "dist", `monoheader-firefox-${packageJson.version}.zip`);
  const firefoxXpiPath = join(root, "dist", `monoheader-firefox-${packageJson.version}-unsigned.xpi`);
  const firstInstallable = readFileSync(installablePath);
  const firstSource = readFileSync(sourcePath);
  const firstFirefox = readFileSync(firefoxPath);
  const installable = unzipSync(new Uint8Array(firstInstallable));
  const source = unzipSync(new Uint8Array(firstSource));
  const firefox = unzipSync(new Uint8Array(firstFirefox));

  assert.equal(
    JSON.parse(strFromU8(installable["manifest.json"])).version,
    packageJson.version
  );
  const firefoxManifest = JSON.parse(strFromU8(firefox["manifest.json"]));
  assert.equal(firefoxManifest.version, packageJson.version);
  assert.deepEqual(firefoxManifest.background.scripts, ["platform.js", "core.js", "background.js"]);
  assert.equal(firefoxManifest.background.service_worker, undefined);
  assert.equal(firefoxManifest.browser_specific_settings.gecko.strict_min_version, "140.0");
  assert.equal(firefoxManifest.browser_specific_settings.gecko_android.strict_min_version, "142.0");
  assert.deepEqual(firefoxManifest.browser_specific_settings.gecko.data_collection_permissions.required, [
    "authenticationInfo",
    "websiteContent"
  ]);
  assert.ok(firefox["platform.js"]);
  assert.deepEqual(readFileSync(firefoxXpiPath), firstFirefox);
  assert.ok(source[".github/workflows/release-check.yml"]);
  assert.ok(source[".gitattributes"]);
  assert.ok(source[".gitignore"]);
  assert.ok(source["GITHUB_UPLOAD.md"]);
  assert.ok(source["PRIVACY.md"]);
  assert.ok(source["FIREFOX_SUBMISSION.md"]);
  assert.ok(source["manifest.firefox.json"]);
  assert.ok(source["platform.js"]);
  assert.ok(source["privacy-policy/monoheader-privacy-policy.html"]);
  assert.ok(source["privacy-policy/monoheader-privacy-policy.md"]);
  assert.ok(source["store-assets/monoheader-store-icon-128.png"]);
  assert.ok(source["store-assets/monoheader-screenshot-rules-1280x800.png"]);
  assert.ok(source["store-assets/monoheader-promo-small-440x280.png"]);
  assert.ok(source["store-assets/monoheader-promo-marquee-1400x560.png"]);
  assert.ok(source["scripts/create-zip.mjs"]);
  assert.ok(source["tests/packaging.test.cjs"]);
  assert.equal(
    strFromU8(source["PRIVACY.md"]),
    strFromU8(source["privacy-policy/monoheader-privacy-policy.md"])
  );
  for (const forbiddenPrefix of [
    "dist/",
    "node_modules/",
    "playwright-report/",
    "test-results/"
  ]) {
    assert.equal(
      Object.keys(source).some((entry) => entry.startsWith(forbiddenPrefix)),
      false,
      `source archive must exclude ${forbiddenPrefix}`
    );
  }

  execFileSync(process.execPath, ["scripts/package.mjs"], {
    cwd: root,
    env,
    stdio: "pipe"
  });
  execFileSync(process.execPath, ["scripts/package-source.mjs"], {
    cwd: root,
    env,
    stdio: "pipe"
  });
  execFileSync(process.execPath, ["scripts/package-firefox.mjs"], {
    cwd: root,
    env,
    stdio: "pipe"
  });
  assert.deepEqual(readFileSync(installablePath), firstInstallable);
  assert.deepEqual(readFileSync(sourcePath), firstSource);
  assert.deepEqual(readFileSync(firefoxPath), firstFirefox);
  assert.deepEqual(readFileSync(firefoxXpiPath), firstFirefox);
});
