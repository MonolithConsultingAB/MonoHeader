# Firefox / AMO submission guide

MonoHeader 1.11.1 uses one shared implementation for Chrome and Firefox. The
Firefox release has a separate manifest because Firefox Manifest V3 uses a
background event page rather than Chrome's background service worker.

## Release files

- `dist/monoheader-firefox-1.11.1.zip` — upload this file to Mozilla Add-ons
  (AMO).
- `dist/monoheader-firefox-1.11.1-unsigned.xpi` — identical unsigned package
  for temporary local testing only. A normal Firefox installation requires a
  package signed by Mozilla.
- `dist/monoheader-1.11.1-source.zip` — complete reviewable source, tests, and
  reproducible packaging scripts.

The Firefox package targets Firefox 140 or later on desktop and Firefox 142 or
later on Android so the browser can present Mozilla's built-in data collection
and transmission consent during install.

## Test locally

1. Run `npm ci`.
2. Run `npm run release:check` for the complete release gate, or run
   `npm run lint:firefox` for the Firefox package and AMO linter only.
3. Open `about:debugging#/runtime/this-firefox` in Firefox.
4. Select **Load Temporary Add-on**.
5. Select `dist/monoheader-firefox/manifest.json` or the unsigned XPI.
6. Create a rule for a local test endpoint, apply it, and verify the modified
   header in Firefox Developer Tools. Also test popup rule toggles, a
   session-only value, and keep-alive on an HTTPS page you control.

Temporary add-ons are removed when Firefox closes. Upload the ZIP to AMO for a
signed distributable XPI.

## AMO listing disclosure

Suggested single purpose:

> MonoHeader gives users local control over HTTP request and response headers,
> with optional user-configured session keep-alive for selected HTTPS sites.

The manifest declares `authenticationInfo` and `websiteContent` because users
can deliberately configure authentication-bearing header values and send
request headers or keep-alive activity to websites they select. These are
essential, user-controlled transmissions. MonoHeader has no telemetry,
analytics, advertising, cloud sync, account system, or developer-operated
runtime server, and Monolith Consulting AB does not receive the data.

Permission justifications:

- `storage`: local profiles, rules, diagnostics, rollback data, keep-alive site
  rules, and in-memory session-only values.
- `alarms`: user-enabled keep-alive schedules.
- `scripting`: transient packaged keep-alive execution in matching HTTPS tabs.
- `declarativeNetRequestWithHostAccess`: request and response header changes.
- `<all_urls>`: a general-purpose header tool must be able to apply rules to
  destinations explicitly selected by the user.

MonoHeader contains no persistent content scripts and no remotely hosted code.
The public privacy policy is `PRIVACY.md` and the website-ready copy is
`privacy-policy/monoheader-privacy-policy.html`.

## Build commands

```text
npm ci
npm test
npm run check
npm run lint:firefox
npm run package:all
```

`npm run package:all` recreates the Chrome ZIP, Firefox ZIP, unsigned Firefox
XPI, and complete source archive without relying on an operating-system ZIP
command.
