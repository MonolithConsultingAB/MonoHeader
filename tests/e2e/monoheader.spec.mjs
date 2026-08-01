import {
  expect,
  test,
  waitForExtensionWorker
} from "./fixtures.mjs";

test("popup initializes in Chromium and exposes every primary control", async ({
  extensionContext,
  extensionId,
  openPopup,
  serviceWorker
}) => {
  const popup = await openPopup();
  const runningVersion = await serviceWorker.evaluate(() => chrome.runtime.getManifest().version);

  await expect(popup.locator("#popup-version")).toHaveText(runningVersion);
  await expect(popup.locator("#power-toggle")).toBeEnabled();
  await expect(popup.locator("#profile-select")).toBeEnabled();
  await expect(popup.locator("#session-toggle")).toBeEnabled();
  await expect(popup.locator("#session-mode")).toHaveValue("activity");
  await expect(popup.locator("#session-target-path")).toBeHidden();

  await popup.locator("#session-mode").selectOption("request");
  await expect(popup.locator("#session-target-path")).toBeVisible();
  await popup.locator("#session-mode").selectOption("activity");
  await expect(popup.locator("#session-target-path")).toBeHidden();

  const optionsPagePromise = extensionContext.waitForEvent("page");
  await popup.locator("#open-dashboard").click();
  const optionsPage = await optionsPagePromise;
  await optionsPage.waitForLoadState("domcontentloaded");
  await expect(optionsPage).toHaveURL(`chrome-extension://${extensionId}/app.html#rules`);
  await expect(optionsPage.getByRole("heading", { name: "Header rules" })).toBeVisible();
  await optionsPage.close();
});

test("keep-alive can be tested, diagnosed, and reset without enabling a schedule", async ({
  openPopup,
  targetPage,
  testSite
}) => {
  const popup = await openPopup();
  await expect(popup.locator("#session-toggle")).not.toBeChecked();
  await popup.locator("#session-test-button").click();

  await expect(popup.locator("#session-status")).toContainText(
    "Manual test: synthetic activity pulse dispatched."
  );
  await expect(targetPage.locator("#mousemove-count")).toHaveText("1");
  await expect(targetPage.locator("#click-count")).toHaveText("1");
  await expect(popup.locator("#session-toggle")).not.toBeChecked();
  await expect(popup.locator("#session-next-check")).toHaveText("Off");

  await popup.locator("#session-diagnostics-button").click();
  await expect(popup.locator("#session-diagnostics")).toBeVisible();
  await expect(popup.locator("#session-diagnostic-state")).toHaveText("Off");
  await expect(popup.locator("#session-diagnostic-scheduler")).toHaveText("Inactive");
  await expect(popup.locator("#session-diagnostic-origin")).toHaveText(testSite.origin);
  await expect(popup.locator("#session-diagnostic-trigger")).toHaveText("Manual test");
  await expect(popup.locator("#session-diagnostic-result")).toHaveText("Success");
  await expect(popup.locator("#session-diagnostic-actions")).toHaveText("Pulse dispatched");

  await popup.locator("#session-reset-button").click();
  await expect(popup.locator("#session-status")).toHaveText(
    "Off. No keep-alive checks are running."
  );
  await expect(popup.locator("#session-mode")).toHaveValue("activity");
  await expect(popup.locator("#session-diagnostic-trigger")).toHaveText("None");
  await expect(popup.locator("#session-diagnostic-result")).toHaveText("No result");
});

test("per-site keep-alive presets load only for their exact HTTPS origin", async ({
  openPopup,
  targetPage,
  testSite
}) => {
  testSite.reset();
  const popup = await openPopup();
  await popup.locator("#session-mode").selectOption("request");
  await popup.locator("#session-interval").selectOption("15");
  await popup.locator("#session-target-path").fill("/api/session/keepalive");
  await popup.locator("#session-preset-save").click();
  await expect(popup.locator("#session-preset-status")).toHaveText(
    "Preset saved for this site."
  );
  await expect(popup.locator("#session-toggle")).not.toBeChecked();
  expect(testSite.state.keepAliveRequests).toBe(0);
  await popup.close();

  await targetPage.goto(`${testSite.alternateOrigin}/activity`);
  const otherOriginPopup = await openPopup();
  await expect(otherOriginPopup.locator("#session-preset-status")).toHaveText(
    "No preset saved for this site."
  );
  await expect(otherOriginPopup.locator("#session-mode")).toHaveValue("activity");
  await expect(otherOriginPopup.locator("#session-interval")).toHaveValue("10");
  await expect(otherOriginPopup.locator("#session-toggle")).not.toBeChecked();
  await otherOriginPopup.close();

  await targetPage.goto(`${testSite.origin}/activity`);
  const restoredPopup = await openPopup();
  await expect(restoredPopup.locator("#session-preset-status")).toHaveText(
    "Saved settings loaded for this site."
  );
  await expect(restoredPopup.locator("#session-mode")).toHaveValue("request");
  await expect(restoredPopup.locator("#session-interval")).toHaveValue("15");
  await expect(restoredPopup.locator("#session-target-path")).toHaveValue(
    "/api/session/keepalive"
  );
  await expect(restoredPopup.locator("#session-toggle")).not.toBeChecked();
  expect(testSite.state.keepAliveRequests).toBe(0);

  await restoredPopup.locator("#session-preset-delete").click();
  await expect(restoredPopup.locator("#session-preset-status")).toHaveText(
    "Preset deleted. Current tab settings were kept."
  );
  await expect(restoredPopup.locator("#session-preset-delete")).toBeDisabled();
  await restoredPopup.close();

  const reopened = await openPopup();
  await expect(reopened.locator("#session-preset-status")).toHaveText(
    "No preset saved for this site."
  );
  await expect(reopened.locator("#session-mode")).toHaveValue("activity");
  await expect(reopened.locator("#session-interval")).toHaveValue("10");
});

test("automatic keep-alive site rules start, explain, and pause per tab", async ({
  extensionContext,
  extensionId,
  openPopup,
  targetPage,
  testSite
}) => {
  const workspace = await extensionContext.newPage();
  await workspace.goto(`chrome-extension://${extensionId}/app.html#keepalive`);
  await expect(workspace.getByRole("heading", { name: "Keep-alive", exact: true })).toBeVisible();
  await expect(workspace.locator("#keepalive-mode")).toHaveValue("activity");
  await expect(workspace.locator("#keepalive-target-path-field")).toBeHidden();

  await workspace.locator("#keepalive-name").fill("Local test site");
  await workspace.locator("#keepalive-scope").selectOption("exact");
  await workspace.locator("#keepalive-pattern").fill(testSite.origin);
  await workspace.locator("#keepalive-auto-start").check();
  await workspace.locator("#keepalive-test-url").fill(`${testSite.origin}/activity`);
  await workspace.locator("#keepalive-test-button").click();
  await expect(workspace.locator("#keepalive-test-result")).toContainText(
    "Local test site"
  );
  await workspace.locator("#save-keepalive-preset-button").click();
  await expect(workspace.locator(".keepalive-preset-card")).toContainText(
    "Local test site"
  );
  await expect(targetPage.locator("#mousemove-count")).toHaveText("1");
  await expect(targetPage.locator("#click-count")).toHaveText("1");

  const popup = await openPopup();
  await expect(popup.locator("#session-toggle")).toBeChecked();
  await expect(popup.locator("#session-auto-rule")).toBeVisible();
  await expect(popup.locator("#session-auto-rule-status")).toContainText(
    "Local test site"
  );
  await popup.locator("#session-toggle").uncheck();
  await expect(popup.locator("#session-status")).toContainText("Paused for this tab");
  await expect(popup.locator("#session-auto-rule-status")).toContainText(
    "Paused for this tab"
  );
  await popup.close();

  await targetPage.goto(`${testSite.origin}/activity?still-same-origin=1`);
  await expect(targetPage.locator("#mousemove-count")).toHaveText("0");
  await targetPage.goto(`${testSite.alternateOrigin}/activity`);
  await targetPage.goto(`${testSite.origin}/activity?returned=1`);
  await expect(targetPage.locator("#mousemove-count")).toHaveText("1");
  await expect(targetPage.locator("#click-count")).toHaveText("1");
  await workspace.close();
});

test("quick add deploys a real DNR header and the popup switch removes it", async ({
  openPopup,
  targetPage,
  testSite
}) => {
  const popup = await openPopup();
  await popup.locator("#quick-add-panel").evaluate((details) => {
    details.open = true;
  });
  await popup.locator("#quick-header-name").fill("X-MonoHeader-E2E");
  await popup.locator("#quick-header-value").fill("browser-pass");
  await popup.locator("#quick-add-button").click();
  await expect(popup.locator("#quick-add-status")).toContainText(
    "Added X-MonoHeader-E2E for every supported request."
  );

  await targetPage.goto(`${testSite.origin}/headers?enabled=1`);
  await expect(targetPage.locator("#received-header")).toHaveText("browser-pass");

  const rule = popup.locator(".active-rule-item", {
    hasText: "Everywhere: X-MonoHeader-E2E"
  });
  await expect(rule).toBeVisible();
  await rule.getByRole("switch", {
    name: "Enable rule Everywhere: X-MonoHeader-E2E"
  }).uncheck();
  await expect(rule.locator(".active-rule-state")).toHaveText("Off");

  await targetPage.goto(`${testSite.origin}/headers?enabled=0`);
  await expect(targetPage.locator("#received-header")).toBeEmpty();
});

test("rule inspector explains resolved and ambiguous conflicts without exposing values by default", async ({
  extensionContext,
  extensionId,
  testSite
}) => {
  const workspace = await extensionContext.newPage();
  await workspace.goto(`chrome-extension://${extensionId}/app.html`);
  await expect(workspace.getByRole("heading", { name: "Header rules" })).toBeVisible();
  const applied = await workspace.evaluate(async () => {
    const current = await chrome.runtime.sendMessage({ action: "GET_STATE" });
    const state = current.state;
    const profile = state.profiles.find((item) => item.id === state.activeProfileId);
    const Core = globalThis.MonoHeaderCore;
    const createRule = (overrides) => Core.createRule({
      enabled: true,
      match: {
        patternType: "urlFilter",
        pattern: "*",
        resourceTypes: ["xmlhttprequest"],
        requestMethods: ["get"]
      },
      ...overrides
    });
    profile.rules = [
      createRule({
        id: "high-language",
        dnrId: 1,
        name: "Preferred language",
        priority: 300,
        modifications: [{
          target: "request",
          operation: "set",
          header: "Accept-Language",
          value: "sv-SE"
        }]
      }),
      createRule({
        id: "low-language",
        dnrId: 2,
        name: "Fallback language",
        priority: 100,
        modifications: [{
          target: "request",
          operation: "set",
          header: "accept-language",
          value: "fr-FR"
        }]
      }),
      createRule({
        id: "blue-response",
        dnrId: 3,
        name: "Blue response",
        priority: 200,
        modifications: [{
          target: "response",
          operation: "set",
          header: "X-Color",
          value: "blue"
        }]
      }),
      createRule({
        id: "green-response",
        dnrId: 4,
        name: "Green response",
        priority: 200,
        modifications: [{
          target: "response",
          operation: "set",
          header: "x-color",
          value: "green"
        }]
      })
    ];
    state.nextDnrId = 5;
    return chrome.runtime.sendMessage({
      action: "APPLY_STATE",
      state,
      reason: "Prepared conflict inspector browser test"
    });
  });
  expect(applied.ok).toBe(true);
  await workspace.reload();
  await expect(workspace.getByRole("heading", { name: "Header rules" })).toBeVisible();

  await workspace.locator("#rule-inspector-button").click();
  await workspace.locator("#inspector-url").fill(`${testSite.origin}/headers`);
  await workspace.locator("#inspector-method").selectOption("get");
  await workspace.locator("#inspector-resource-type").selectOption("xmlhttprequest");
  await workspace.locator("#inspector-initiator").fill("portal.example.com");
  await workspace.locator("#inspector-domain-type").selectOption("thirdParty");
  await workspace.locator("#run-rule-inspector").click();

  const result = workspace.locator("#rule-inspector-result");
  await expect(result).toContainText("Matched rules");
  await expect(result).toContainText("4");
  await expect(result).toContainText("Accept-Language");
  await expect(result).toContainText("Resolved by priority");
  await expect(result).toContainText("Set by “Preferred language” at priority 300");
  await expect(result).toContainText("X-Color");
  await expect(result).toContainText("Ambiguous");
  await expect(result).toContainText("Value hidden");
  await expect(result).not.toContainText("sv-SE");
  await expect(result).not.toContainText("fr-FR");
  await expect(result).not.toContainText("blue");
  await expect(result).not.toContainText("green");

  await workspace.locator("#inspector-show-values").check();
  await expect(result).toContainText("sv-SE");
  await expect(result).toContainText("fr-FR");
  await expect(result).toContainText("blue");
  await expect(result).toContainText("green");
  await workspace.close();
});

test("session-only header values stay out of persistent storage and expire on browser restart", async ({
  extensionContext,
  extensionId,
  restartExtensionContext
}) => {
  const secret = "Bearer e2e-memory-only";
  const workspace = await extensionContext.newPage();
  await workspace.goto(`chrome-extension://${extensionId}/app.html`);
  await workspace.locator("#new-rule-button").click();
  await workspace.locator("#rule-name").fill("Session-only authorization");
  const modification = workspace.locator(".modification-row").first();
  await modification.locator('[data-mod-field="header"]').fill("Authorization");
  await modification.locator('[data-mod-field="value"]').fill(secret);
  await modification.locator('[data-mod-field="lifetime"]').selectOption("session");
  await expect(modification.locator('[data-mod-field="value"]')).toHaveAttribute("type", "password");
  await workspace.locator("#save-rule-button").click();
  await workspace.locator("#apply-button").click();
  await expect(workspace.locator("#dirty-indicator")).toBeHidden();

  const deployed = await workspace.evaluate(async () => {
    const [local, session, dynamicRules, sessionRules] = await Promise.all([
      chrome.storage.local.get("monoHeaderState"),
      chrome.storage.session.get("monoHeaderSessionHeaderValues"),
      chrome.declarativeNetRequest.getDynamicRules(),
      chrome.declarativeNetRequest.getSessionRules()
    ]);
    return {
      local: JSON.stringify(local),
      session: JSON.stringify(session),
      dynamicRules: JSON.stringify(dynamicRules),
      sessionRules: JSON.stringify(sessionRules)
    };
  });
  expect(deployed.local).not.toContain(secret);
  expect(deployed.dynamicRules).not.toContain(secret);
  expect(deployed.session).toContain(secret);
  expect(deployed.sessionRules).toContain(secret);

  const restarted = await restartExtensionContext();
  expect(restarted.extensionId).toBe(extensionId);
  const expired = await restarted.readyPage.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: "GET_STATE" });
    const modification =
      response.state.profiles[0].rules[0].modifications[0];
    const session = await chrome.storage.session.get("monoHeaderSessionHeaderValues");
    const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
    return {
      ok: response.ok,
      deployedRuleCount: response.runtime.deployedRuleCount,
      unavailableSessionValueCount: response.runtime.unavailableSessionValueCount,
      value: modification.value,
      sessionValueAvailable: modification.sessionValueAvailable,
      session: JSON.stringify(session),
      sessionRules: JSON.stringify(sessionRules)
    };
  });
  expect(expired.ok).toBe(true);
  expect(expired.deployedRuleCount).toBe(0);
  expect(expired.unavailableSessionValueCount).toBe(1);
  expect(expired.value).toBe("");
  expect(expired.sessionValueAvailable).toBe(false);
  expect(expired.session).not.toContain(secret);
  expect(expired.sessionRules).not.toContain(secret);
  await restarted.readyPage.close();
});

test("Activity pulse survives popup closure and a real Chrome alarm wake-up", async ({
  extensionContext,
  openPopup,
  serviceWorker,
  targetPage
}) => {
  const popup = await openPopup();
  await popup.locator("#session-toggle").check();
  await expect(popup.locator("#session-status")).toContainText(
    "Latest synthetic activity pulse was dispatched."
  );
  await expect(targetPage.locator("#mousemove-count")).toHaveText("1");
  await expect(targetPage.locator("#click-count")).toHaveText("1");
  await expect(popup.locator("#session-last-success")).not.toHaveText("Not yet");
  await expect(popup.locator("#session-next-check")).toHaveText(/^\d{2}:\d{2}$/);
  await popup.close();

  await serviceWorker.evaluate(async () => {
    const stored = await chrome.storage.local.get("monoHeaderSessionKeepAlive");
    const entry = stored.monoHeaderSessionKeepAlive.entries[0];
    const alarmName = `monoheader-session-${entry.tabId}`;
    await chrome.alarms.clear(alarmName);
    await chrome.alarms.create(alarmName, { delayInMinutes: 0.5 });
  });

  await expect(targetPage.locator("#mousemove-count")).toHaveText("2", { timeout: 45_000 });
  await expect(targetPage.locator("#click-count")).toHaveText("2");

  const reopened = await openPopup();
  await expect(reopened.locator("#session-toggle")).toBeChecked();
  await expect(reopened.locator("#session-status")).toContainText(
    "Latest synthetic activity pulse was dispatched."
  );
  await reopened.locator("#session-toggle").uncheck();
  await expect(reopened.locator("#session-status")).toContainText(
    "Off. No keep-alive checks are running."
  );

  const currentWorker = await waitForExtensionWorker(extensionContext);
  const entries = await currentWorker.evaluate(async () => {
    const stored = await chrome.storage.local.get("monoHeaderSessionKeepAlive");
    return stored.monoHeaderSessionKeepAlive.entries;
  });
  expect(entries).toHaveLength(0);
});

test("origin navigation stops keep-alive and a browser restart preserves rules", async ({
  extensionId,
  openPopup,
  restartExtensionContext,
  serviceWorker,
  targetPage,
  testSite
}) => {
  const popup = await openPopup();
  await popup.locator("#quick-add-panel").evaluate((details) => {
    details.open = true;
  });
  await popup.locator("#quick-header-name").fill("X-MonoHeader-E2E");
  await popup.locator("#quick-header-value").fill("reload-pass");
  await popup.locator("#quick-add-button").click();
  await expect(popup.locator("#quick-add-status")).toContainText("Added X-MonoHeader-E2E");
  await popup.locator("#session-toggle").check();
  await expect(popup.locator("#session-status")).toContainText("activity pulse was dispatched");
  await popup.close();

  await targetPage.goto(`${testSite.alternateOrigin}/activity`);
  await expect.poll(async () => serviceWorker.evaluate(async () => {
    const stored = await chrome.storage.local.get("monoHeaderSessionKeepAlive");
    return stored.monoHeaderSessionKeepAlive.entries.length;
  })).toBe(0);

  const versionBeforeRestart = await serviceWorker.evaluate(
    () => chrome.runtime.getManifest().version
  );
  const restarted = await restartExtensionContext();
  expect(restarted.extensionId).toBe(extensionId);
  const afterRestart = await restarted.readyPage.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: "GET_STATE" });
    const profile = response.state.profiles.find(
      (item) => item.id === response.state.activeProfileId
    );
    const keepAlive = await chrome.storage.local.get("monoHeaderSessionKeepAlive");
    return {
      ok: response.ok,
      version: chrome.runtime.getManifest().version,
      enabledRuleCount: profile.rules.filter((rule) => rule.enabled).length,
      keepAliveEntryCount: keepAlive.monoHeaderSessionKeepAlive.entries.length
    };
  });
  expect(afterRestart).toEqual({
    ok: true,
    version: versionBeforeRestart,
    enabledRuleCount: 1,
    keepAliveEntryCount: 0
  });
  await restarted.readyPage.close();

  const restartedTarget = await restarted.context.newPage();
  await restartedTarget.goto(`${testSite.alternateOrigin}/headers?restarted=1`);
  await expect(restartedTarget.locator("#received-header")).toHaveText("reload-pass");
  await restartedTarget.close();
});
