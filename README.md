# MonoHeader

MonoHeader is a local-only Manifest V3 extension for Chrome and Firefox that sets, appends, and removes HTTP request and response headers. It uses the browser's Declarative Net Request (DNR) engine and does not run a remote service.

MonoHeader is created and developed by **Monolith Consulting AB**.

"Local-only" means the extension's configuration, processing, audit data, and interface remain on the device. Request-header values that the user enables are necessarily included by the browser in matching network requests and are visible to those destination websites. Values marked session-only remain in extension memory instead of persistent configuration. Optional session keep-alive requests are sent only to the HTTPS site selected by the user. MonoHeader does not upload the configuration or send anything to a separate MonoHeader service.

## Install in Chrome

1. Extract `monoheader-1.11.1.zip` to a permanent folder.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** in the upper-right corner.
4. Select **Load unpacked**.
5. Select the extracted folder that directly contains `manifest.json`.
6. Pin MonoHeader from Chrome's Extensions menu if you want quick access.

Chrome does not install an ordinary unsigned ZIP by opening it. The ZIP is a transport package: extract it first for **Load unpacked**, or upload the ZIP through the Chrome Web Store developer dashboard.

## Install in Firefox

For temporary local testing:

1. Run `npm run package:firefox` or extract `monoheader-firefox-1.11.1.zip`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on**.
4. Select `dist/monoheader-firefox/manifest.json` or
   `monoheader-firefox-1.11.1-unsigned.xpi`.

Temporary add-ons are removed when Firefox closes. Normal installation requires
an XPI signed by Mozilla; upload `monoheader-firefox-1.11.1.zip` to AMO. The
Firefox build supports Firefox 140+ on desktop and Firefox 142+ on Android so
Mozilla's built-in data-consent prompt is available. See
`FIREFOX_SUBMISSION.md` for the submission checklist and disclosure text.

## First use

1. Select the MonoHeader toolbar icon and open the rule workspace.
2. Create a rule.
3. Enter a URL pattern such as `||api.example.com/`.
4. Add one or more request or response header modifications.
5. Select **Save rule**, then **Apply changes**.
6. Reload the target page. Network requests already completed before deployment are not retroactively changed.

Use the popup to pause all deployed rules, switch the active profile, or toggle an individual rule without opening the workspace. Disabled rules remain visible in the popup so they can be switched back on. Only one profile is active at a time.

### Quick-add a global request header

Open the toolbar popup and expand **Quick add request header**. Enter a header name and value, then select **Add & apply**. MonoHeader creates an enabled `Set` rule in the active profile that matches every site and every supported resource type.

Quick-added rules use priority 10 so ordinary workspace rules, which default to priority 100, can override the global value for more specific destinations. Adding the same globally scoped header again updates its existing value instead of creating a conflicting duplicate.

Request-header values are sent to every matching destination website. Do not globally configure credentials or other secrets unless that exposure is deliberate. Browser-protected pages and requests outside the DNR engine remain unaffected.

Select **This browser session only** in quick add when the value should not be written to persistent configuration or included in a backup. The same choice is available as **Value lifetime → This session** for every Set or Append modification in the workspace.

### Session-only sensitive header values

A session-only value is stored in the browser's in-memory extension session storage and deployed through an in-memory DNR session rule. The rule name, header name, match conditions, and session-only marker remain in the local configuration, but the value itself does not. Session-only values are excluded from JSON exports and rollback snapshots.

The browser clears the in-memory value when its session ends. MonoHeader also treats extension disable, reload, or update as a sensitive-value boundary and reconciles DNR session rules whenever its background runtime starts. A stale rule is removed when its value is no longer available. The configured modification is then labeled **needs session value** and stays inactive until you edit it, enter the value again, save, and apply.

A rule can mix persistent and session-only modifications. MonoHeader deploys the persistent part through the browser's dynamic ruleset and the sensitive part through its session ruleset while preserving the same match conditions and priority. To avoid non-portable equal-priority ordering, the same target/header pair cannot use both lifetimes inside one rule; use separate rules with different priorities instead.

Session-only storage prevents the value from being retained in MonoHeader's persistent data or portable backups; it is not encryption. While active, the value necessarily exists in extension/browser memory, and request-header values are sent to every matching destination.

### Session keep-alive

Open an HTTPS website, select the MonoHeader toolbar icon, and enable **Keep this tab signed in**. Choose a 5, 10, 15, or 30-minute interval and one of three methods:

- **Activity pulse** is the default. It dispatches synthetic `mousemove` and `click` events to the document itself. It does not locate or activate a button, link, or form control. The request-path field stays hidden in this mode.
- **Request path** sends a credentialed same-origin `GET`. Enter a path such as `/api/session/keepalive`, or leave it blank to request the current page.
- **Request + pulse** performs both actions.

The feature is opt-in. A schedule can be started manually for one tab or automatically through a saved site rule. The configured path is normalized and cannot leave the matching tab's HTTPS origin. Activity events are synthetic (`isTrusted` is false), so a site can ignore them. Keep-alive stops when disabled, when the tab closes, or when the tab no longer matches its automatic rule. The page is not reloaded. MonoHeader does not inspect DOM content, read cookies, or retain response content; it stores only the selected site pattern or origin, optional exclusions, method and path, interval, scheduler state, timestamps, HTTP status, redirect state, and a short failure description.

Use **Save preset** in the popup to remember the selected method, interval, and optional request path for the current exact HTTPS origin. New popup presets do not auto-start unless automatic activation is later enabled in the Keep-alive workspace.

Open **Keep-alive** in the workspace to manage automatic site rules. A rule can target:

- one exact HTTPS origin, including its port;
- a domain and all of its subdomains;
- subdomains only, using wildcard semantics such as `*.example.com`;
- every HTTPS site.

Rules can exclude exact hosts or wildcard subdomains. MonoHeader chooses one effective rule per tab: an exact origin wins first, then the most-specific matching domain or subdomain rule, then the global HTTPS rule. An exact rule with automatic start off can therefore opt a site out of a broader automatic rule. The pattern tester explains which saved or draft rule wins for a supplied HTTPS URL. Enabling the global rule requires an explicit confirmation.

Turning an automatically managed tab off in the popup pauses only that tab. The pause remains while it stays on the same origin and is cleared when the tab leaves the site or closes. The popup also shows the effective automatic rule and can disable its auto-start setting or open the Keep-alive workspace.

Presets stay in local extension storage and are not included in header-configuration exports, deployment history, diagnostics, or rollback snapshots. Factory reset removes every preset.

The popup shows when the most recent successful request completed and a live countdown to the browser's next scheduled check. Later failures do not erase the previous successful timestamp. Opening the popup reads the existing alarm without postponing it.

Use **Test now** to run the selected method once without enabling keep-alive or creating an alarm. If keep-alive is already enabled, the test updates its result metadata without moving the existing next-check time. **Reset tab** stops and clears keep-alive only for the current tab while preserving its site preset. **Diagnostics** shows the scheduler state, current HTTPS origin, trigger, attempt/completion times, result, HTTP status, and which selected actions were completed. Its copyable report deliberately excludes cookies, page content, response bodies, and the configured request path.

This can prevent ordinary inactivity timeouts when the site renews a session after authenticated traffic. It cannot override absolute session limits, expired SSO tokens, or sites that require genuine user interaction. A redirect is shown as a warning because it may indicate that the session has already expired.

## Matching

- `*` matches every URL that the browser permits extensions to affect.
- `||example.com/` matches `example.com` and its subdomains.
- `|https://example.com/path|` matches that exact URL.
- Regular expressions use the browser's DNR regex engine. MonoHeader asks the running browser to validate them before deployment.
- Request domains match the destination host. Initiator domains match the page or context that initiated the request.
- Empty HTTP-method selection means all methods.

Use **Inspect effective result** in the rule workspace to preview an HTTP or HTTPS request against the enabled rules in the active profile. Supply the request URL, method, resource type, initiator domain, and first- or third-party relationship. The inspector groups request and response modifications by header, shows which rules match, and explains which operations apply, are shadowed, or remain ambiguous.

The inspector follows the portable DNR priority behavior for `Set`, `Append`, and `Remove`. It never invents a winner for incompatible operations with the same priority; assign different priorities to make the result deterministic. Configured header values are hidden unless **Show configured values** is selected. Draft and paused-state previews are labeled, and any rule change invalidates the previous result.

Inspection is performed locally and does not send the entered URL or configuration anywhere. It is a preview: the running browser's DNR engine remains authoritative for the final match, equal-priority ordering is not portable, and other extensions can also modify the same headers.

## Browser limitations

- MonoHeader enforces a portable cap of 5,000 dynamic header-modification rules and 1,000 regular-expression rules even where a browser exposes a higher limit.
- Session-only header values use the browser's separate in-memory DNR session ruleset.
- Appending request headers is limited to MonoHeader's conservative cross-browser allowlist. `Set` and `Remove` have different browser rules.
- Browser-internal and other restricted pages such as `chrome://settings` and `about:config` cannot be modified by extensions.
- Responses produced entirely by a website service worker or Cache Storage might not reach DNR. Network requests made by the service worker do.
- Competing extensions can affect the same header. Within MonoHeader, higher priority rules are evaluated first.
- Host access to all URLs is necessary for a general-purpose header tool. Keep-alive additionally uses transient programmatic injection only for tabs the user enables manually or through an automatic site rule; there are no persistent content scripts.

## Local backup and rollback

- **Export JSON** creates a local file containing profiles, rules, and settings. It omits diagnostics, deployment history, and every session-only value.
- **Import** accepts MonoHeader JSON and a conservative subset of common ModHeader profile exports. Review imported filters before applying.
- **Rollback last change** restores the configuration that preceded the most recent successful deployment.
- Removing the extension clears its local extension storage. Export a backup before removal if the rules matter.

## Development checks

The extension has no runtime dependencies. Development uses Node.js, Playwright, and a local self-signed HTTPS fixture. Install Playwright's Chromium once before running the real-browser suite:

```text
npm ci
npm run e2e:install
npm test
npm run check
npm run lint:firefox
npm run test:e2e
npm run release:check
npm run package
npm run package:firefox
npm run package:all
npm run package:source
```

`npm run test:e2e` loads the packaged extension into a persistent Chromium context and exercises popup initialization, options-page opening, DNR header deployment and toggling, the rule conflict inspector, keep-alive site rules, Activity pulse, a real alarm wake-up, origin cleanup, and a persistent-profile browser restart. It communicates only with a temporary local HTTPS server. Screenshots, video, and traces are retained only when a browser test fails. Set `MONOHEADER_CHROMIUM_EXECUTABLE` to an explicit Chromium binary when the bundled Playwright browser is not used.

`npm run lint:firefox` builds the Firefox target and runs Mozilla's `web-ext lint` with warnings treated as release failures. Firefox compatibility also has manifest, adapter, runtime, and deterministic packaging tests in the shared Node suite.

`npm run release:check` is the release gate. It runs unit/integration tests, Chrome and Firefox package validation, Mozilla's add-on linter, packaging, and the Chromium E2E suite. The included GitHub Actions workflow runs the same gate in Playwright's pinned Chromium container.

The final unpacked Chrome extension is written to `dist/monoheader` and its Web Store/transport archive is `dist/monoheader-1.11.1.zip`. The unpacked Firefox extension is written to `dist/monoheader-firefox`; its AMO upload is `dist/monoheader-firefox-1.11.1.zip`, and the matching unsigned temporary-test package is `dist/monoheader-firefox-1.11.1-unsigned.xpi`. The reproducible cross-browser source with tests is `dist/monoheader-1.11.1-source.zip`.

The source archive is also the GitHub repository package. It includes the
workflow, tests, browser manifests, icons, Chrome Web Store artwork, Firefox
submission guide, and public privacy-policy
files while excluding generated dependencies and reports. See
`GITHUB_UPLOAD.md` for PowerShell and browser-upload instructions.

## Security design

- Manifest V3 Chrome service worker and Firefox background event page
- DNR instead of request interception
- no persistent content scripts or DOM-content inspection
- no remote scripts or runtime dependencies
- one narrowly validated same-origin `fetch` and optional document-level synthetic activity pulse for user-enabled session keep-alive
- no `XMLHttpRequest`, WebSocket client, telemetry, or accounts
- `connect-src 'none'` for extension pages
- storage access restricted to trusted extension contexts
- optional sensitive values stored only in the browser's in-memory extension session storage and deployed only through DNR session rules
- keep-alive site rules store settings locally, support deterministic exact/domain/wildcard precedence, and auto-start only when explicitly enabled
- persistent configuration, exports, and rollback snapshots scrub session-only values
- header-name and value validation, including CR/LF injection rejection
- running-browser regular-expression validation
- transactional DNR replacement through `updateDynamicRules` and `updateSessionRules`

See `PRIVACY.md` for the complete privacy disclosure.
