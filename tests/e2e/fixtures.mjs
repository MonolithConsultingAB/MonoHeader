import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test as base } from "@playwright/test";
import { startTestServer } from "./test-server.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extensionPath = join(projectRoot, "dist", "monoheader");

export const test = base.extend({
  testSite: [async ({}, use) => {
    const site = await startTestServer();
    try {
      await use(site);
    } finally {
      await site.close();
    }
  }, { scope: "worker" }],

  extensionSession: async ({}, use) => {
    const userDataDir = await mkdtemp(join(tmpdir(), "monoheader-e2e-profile-"));
    let context = await launchExtensionContext(userDataDir);
    const session = {
      get context() {
        return context;
      },
      async restart() {
        await context.close();
        context = await launchExtensionContext(userDataDir);
        return context;
      }
    };
    try {
      await use(session);
    } finally {
      await context.close().catch(() => undefined);
      await rm(userDataDir, { recursive: true, force: true });
    }
  },

  extensionContext: async ({ extensionSession }, use) => {
    await use(extensionSession.context);
  },

  restartExtensionContext: async ({ extensionSession }, use) => {
    await use(async () => {
      const context = await extensionSession.restart();
      const worker = await waitForExtensionWorker(context);
      const extensionId = new URL(worker.url()).hostname;
      const readyPage = await openReadyExtensionPage(context, extensionId);
      return { context, extensionId, readyPage, worker };
    });
  },

  serviceWorker: async ({ extensionContext }, use) => {
    await use(await waitForExtensionWorker(extensionContext));
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).hostname);
  },

  targetPage: async ({ extensionContext, testSite }, use) => {
    const pages = extensionContext.pages();
    const page = pages[0] || await extensionContext.newPage();
    await page.goto(`${testSite.origin}/activity`);
    await use(page);
  },

  openPopup: async ({ extensionContext, extensionId, targetPage }, use) => {
    const openedPages = [];
    const open = async () => {
      const worker = await waitForExtensionWorker(extensionContext);
      await targetPage.bringToFront();
      const targetTabId = await worker.evaluate(async (targetUrl) => {
        const tabs = await chrome.tabs.query({});
        const target = tabs.find((tab) => tab.url === targetUrl);
        if (!target || !Number.isInteger(target.id)) {
          throw new Error(`Could not resolve the E2E target tab for ${targetUrl}.`);
        }
        return target.id;
      }, targetPage.url());

      const popup = await extensionContext.newPage();
      openedPages.push(popup);
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), targetTabId);
      await popup.reload();
      await expect(popup.locator("#popup-content")).toBeVisible();
      await expect(popup.locator("#loading-state")).toBeHidden();
      await expect(popup.locator(".loading-retry")).toHaveCount(0);
      return popup;
    };
    try {
      await use(open);
    } finally {
      await Promise.all(openedPages.map((page) => page.isClosed() ? undefined : page.close()));
    }
  }
});

export { expect };

export async function waitForExtensionWorker(context) {
  const existing = context.serviceWorkers().find((worker) => worker.url().startsWith("chrome-extension://"));
  if (existing) return existing;
  return context.waitForEvent("serviceworker", {
    predicate: (worker) => worker.url().startsWith("chrome-extension://"),
    timeout: 15_000
  });
}

async function launchExtensionContext(userDataDir) {
  const executablePath = process.env.MONOHEADER_CHROMIUM_EXECUTABLE || undefined;
  return chromium.launchPersistentContext(userDataDir, {
    channel: executablePath ? undefined : "chromium",
    executablePath,
    headless: process.env.MONOHEADER_E2E_HEADED !== "1",
    ignoreHTTPSErrors: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--ignore-certificate-errors",
      "--no-first-run"
    ]
  });
}

async function openReadyExtensionPage(context, extensionId) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const readyPage = await context.newPage();
    try {
      await readyPage.goto(`chrome-extension://${extensionId}/popup.html`, {
        waitUntil: "domcontentloaded",
        timeout: 5_000
      });
      await expect.poll(async () => readyPage.evaluate(async () => {
        try {
          const response = await chrome.runtime.sendMessage({ action: "GET_RUNTIME" });
          return response && response.ok === true;
        } catch {
          return false;
        }
      }), { timeout: 5_000 }).toBe(true);
      return readyPage;
    } catch (error) {
      lastError = error;
      await readyPage.close().catch(() => undefined);
    }
  }
  throw new Error(`Extension did not become ready after browser restart: ${lastError && lastError.message || "unknown error"}`);
}
