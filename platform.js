"use strict";

(() => {
  const api = globalThis.browser || globalThis.chrome;
  if (!api) throw new Error("MonoHeader could not find a WebExtensions API namespace.");

  const isFirefox = typeof globalThis.browser !== "undefined" && api === globalThis.browser;
  globalThis.MonoHeaderAPI = api;
  globalThis.MonoHeaderPlatform = Object.freeze({
    api,
    browserName: isFirefox ? "Firefox" : "Chrome",
    isFirefox,
    isChrome: !isFirefox
  });
})();
