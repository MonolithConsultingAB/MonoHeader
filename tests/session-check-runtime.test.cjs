"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const background = readFileSync(join(__dirname, "..", "background.js"), "utf8");
const sourceStart = background.indexOf("async function runMonoHeaderSessionCheck(input) {");
const sourceEnd = background.indexOf("\nasync function getSessionKeepAliveForTab", sourceStart);
const source = background.slice(sourceStart, sourceEnd);

function createPingHarness(pageUrl) {
  const fetchCalls = [];
  const activityEvents = [];
  class TestMouseEvent {
    constructor(type, options) {
      this.type = type;
      this.options = options;
    }
  }
  const context = vm.createContext({
    URL,
    location: { href: pageUrl },
    MouseEvent: TestMouseEvent,
    document: {
      dispatchEvent(event) {
        activityEvents.push(event.type);
        return true;
      }
    },
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 204,
        redirected: false,
        url,
        body: { async cancel() {} }
      };
    }
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: "session-check.js" });
  return {
    ping: context.runMonoHeaderSessionCheck,
    fetchCalls,
    activityEvents
  };
}

test("injected ping requests the configured same-origin path", async () => {
  const harness = createPingHarness("https://management.service.imperva.com/dashboard");
  const result = await harness.ping({
    mode: "request",
    targetPath: "/api/session/keepalive-apigw"
  });

  assert.equal(result.ok, true);
  assert.equal(result.sameOrigin, true);
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(
    harness.fetchCalls[0].url,
    "https://management.service.imperva.com/api/session/keepalive-apigw"
  );
  assert.equal(harness.fetchCalls[0].options.method, "GET");
  assert.equal(harness.fetchCalls[0].options.credentials, "include");
});

test("blank request path retains current-page behavior", async () => {
  const harness = createPingHarness("https://app.example.com/dashboard?view=one");
  await harness.ping({ mode: "request", targetPath: "" });
  assert.equal(harness.fetchCalls[0].url, "https://app.example.com/dashboard?view=one");
});

test("injected ping rejects a cross-origin path before fetch", async () => {
  const harness = createPingHarness("https://management.service.imperva.com/dashboard");
  const result = await harness.ping({
    mode: "request",
    targetPath: "https://my.imperva.com/app/keepalive"
  });

  assert.equal(result.ok, false);
  assert.equal(result.sameOrigin, false);
  assert.equal(harness.fetchCalls.length, 0);
});

test("activity mode dispatches only non-activating document-level events", async () => {
  const harness = createPingHarness("https://app.example.com/dashboard");
  const result = await harness.ping({ mode: "activity", targetPath: "" });

  assert.equal(result.ok, true);
  assert.equal(result.requestSent, false);
  assert.equal(result.activitySent, true);
  assert.equal(harness.fetchCalls.length, 0);
  assert.deepEqual(harness.activityEvents, ["mousemove", "click"]);
});

test("combined mode performs both constrained actions", async () => {
  const harness = createPingHarness("https://app.example.com/dashboard");
  const result = await harness.ping({
    mode: "both",
    targetPath: "/api/session/keepalive"
  });

  assert.equal(result.ok, true);
  assert.equal(result.requestSent, true);
  assert.equal(result.activitySent, true);
  assert.equal(harness.fetchCalls.length, 1);
  assert.deepEqual(harness.activityEvents, ["mousemove", "click"]);
});
