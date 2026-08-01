# MonoHeader Privacy Policy

**Effective date:** 27 July 2026  
**Last updated:** 31 July 2026

MonoHeader is created and developed by **Monolith Consulting AB**, Sweden.

## 1. Scope

This Privacy Policy describes how the MonoHeader browser extension for Chrome and Firefox handles information when users create and apply HTTP request and response header rules or use the optional manual or site-based session keep-alive feature.

Browser-store policies use terms such as “collect,” “handle,” and “transmit” broadly. MonoHeader handles certain information locally and transmits user-configured values only to user-selected websites as described below. Monolith Consulting AB does not operate a MonoHeader server and does not receive the user’s extension configuration, header values, browsing activity, diagnostics, or exported files.

## 2. MonoHeader’s purpose

MonoHeader’s single purpose is to give users local control over HTTP sessions in their browser for development, testing, and administration. Users can create and apply rules that set, append, or remove HTTP request and response headers. As part of the same session-control purpose, users may optionally enable manual or site-based session keep-alive functionality for websites they select.

## 3. Information handled by MonoHeader

### 3.1 Configuration information

MonoHeader stores configuration entered by the user, including:

- profile and rule names;
- request and response header names, operations, and values;
- URL filters, regular expressions, domains, resource types, and request methods;
- rule priorities and enabled or disabled states;
- interface settings;
- deployment history, rollback information, and diagnostic messages.

This information is used only to provide the extension’s user-facing functionality.

### 3.2 Authentication information

MonoHeader is a general-purpose header tool. A user may choose to enter authentication-related information, such as an authorization token, API key, session identifier, or other credential, as a header value.

MonoHeader does not obtain such information from page content, forms, password fields, or cookies. It handles authentication information only when the user explicitly enters it as an extension configuration value.

Values saved normally remain in the browser’s local extension storage until the user changes or deletes them, resets the extension, or removes the extension. Values marked **This session** are stored only in the browser’s in-memory extension session storage and are excluded from persistent configuration, deployment history, diagnostics, rollback snapshots, and exported files.

Such a value is not written to MonoHeader's persistent configuration, rollback snapshot, diagnostics, deployment history, or exported JSON. If its in-memory value is missing, MonoHeader removes any stale session rule and leaves the modification inactive until the value is re-entered.

### 3.3 Web browsing activity

MonoHeader does not collect or maintain the user’s general browsing history.

When the user explicitly configures or enables keep-alive for a tab, MonoHeader may locally handle:

- the selected tab identifier;
- the exact HTTPS origin selected by the user;
- an optional same-origin request path;
- the selected keep-alive method and interval;
- scheduler state, timestamps, HTTP status, redirect state, completion flags, and a short error description;
- optional keep-alive site rules containing an exact HTTPS origin, domain, subdomain wildcard, or global HTTPS scope;
- optional host exclusions and whether automatic activation is enabled;
- a temporary per-tab pause marker when the user pauses an automatically managed tab.

Header rules may also contain domains or URL patterns entered by the user. This information is used only to determine where the user’s rules should apply.

### 3.4 Information MonoHeader does not collect

MonoHeader does not intentionally collect:

- names, postal addresses, email addresses, government identifiers, or other identity information;
- health information;
- financial or payment information;
- personal communications;
- physical location, GPS coordinates, or IP-address-based location;
- the user’s actual clicks, mouse position, scrolling, or keystrokes;
- page text, images, audio, video, hyperlinks, form values, request bodies, or response bodies.

Activity pulse creates synthetic, untrusted document-level events. It does not record the user’s actual activity and does not select or activate page elements.

## 4. How information is used

MonoHeader uses locally handled information only to:

- save and display the user’s profiles and rules;
- compile and apply enabled header modifications through the browser’s Declarative Net Request engine;
- show local runtime status, deployment history, diagnostics, and rollback information;
- import and export user-requested local configuration files;
- perform and report keep-alive checks that the user starts for a tab or explicitly enables for matching HTTPS sites;
- match open HTTPS tabs against locally saved exact-origin, domain, subdomain-wildcard, and global rules;
- restore exact-origin keep-alive presets when the user opens the popup on the same origin.

MonoHeader does not use information for advertising, profiling, analytics, creditworthiness, lending, marketing, or any purpose unrelated to the extension’s disclosed functionality.

## 5. Local storage and retention

### Persistent local storage

Profiles, ordinary header values, rules, settings, local history, diagnostics, rollback information, active keep-alive configuration, and keep-alive presets are stored in the browser’s local extension storage on the user’s device.

They remain there until the user deletes or changes them, clears diagnostics, restores factory defaults, or removes the extension.

### Session-only storage

Header values marked **This session** are stored in the browser’s in-memory extension session storage. The browser clears this storage when the browser session ends. MonoHeader also treats extension disable, reload, or update as a sensitive-value boundary and removes stale in-memory Declarative Net Request session rules when their corresponding session value is no longer available.

### Local exports

MonoHeader creates an export only when the user selects **Export JSON**. The file is downloaded to the user’s device. Session-only values, diagnostics, deployment history, and rollback snapshots are excluded. Imports occur only after the user selects a local file.

## 6. Network transmissions

MonoHeader does not send configuration, diagnostics, browsing activity, or header values to Monolith Consulting AB.

When a request-header rule is enabled, the browser sends the configured header name and value to destinations matching the rule. This user-directed transmission is the essential purpose of a request-header modification tool. A global rule may apply to every destination supported by the browser while the rule is enabled. Users should limit sensitive values to trusted HTTPS destinations and avoid sending sensitive information to insecure HTTP origins.

Response-header modifications are applied inside the browser.

When the user explicitly enables keep-alive for a tab or site rule, or selects **Test now**, MonoHeader may perform a credentialed `GET` request to the matching tab’s current HTTPS page or an optional same-origin HTTPS path. The destination cannot leave that tab’s origin. Automatically activated rules run only for HTTPS tabs matching the user’s saved pattern and exclusions. The response body is discarded. Activity-only mode sends no keep-alive network request.

MonoHeader does not read or retain page content or the response body.

## 7. Sharing, sale, and transfer

Monolith Consulting AB does not sell user data.

Monolith Consulting AB does not receive or transfer the information stored by MonoHeader. User-supplied request-header values are transmitted by the browser only to destinations selected through the user’s enabled rules. Keep-alive requests are sent only to the current HTTPS origin of tabs selected manually or matched by site rules the user explicitly enabled.

MonoHeader does not use or transfer user data for personalized advertising, retargeting, unrelated profiling, creditworthiness, or lending.

## 8. Browser-store disclosures and limited use

MonoHeader’s use of information received from browser APIs is limited to its disclosed single purpose. For Chrome, this includes the Chrome Web Store User Data Policy and its Limited Use requirements:

- information is used only to provide or improve MonoHeader’s disclosed single purpose and user-facing features;
- information is not transferred except where necessary to provide the user-directed functionality, comply with applicable law, protect security, or as part of a permitted merger, acquisition, or sale of assets;
- information is not used for personalized advertising;
- Monolith Consulting AB personnel cannot access locally stored extension data because MonoHeader has no server or remote data-collection service.

For Firefox, the manifest declares the Mozilla data-transmission categories **Authentication information** and **Website content**. These declarations cover authentication-bearing values that a user may deliberately enter, configured request headers, and same-origin keep-alive requests sent to websites the user selects. They do not indicate that Monolith Consulting AB receives this information. MonoHeader does not transmit telemetry, analytics, diagnostics, configuration, or browsing history to Monolith Consulting AB or to a MonoHeader service.

## 9. Security

MonoHeader uses Manifest V3 and the browser’s Declarative Net Request API instead of intercepting request or response bodies. It contains no analytics, advertising SDK, remote code, external account system, cloud synchronization, or automatic update checker.

Extension pages prohibit remote connections through their Content Security Policy. Keep-alive is restricted to HTTPS and to the selected tab’s origin. Header names and values are validated, including rejection of CR/LF header injection. Sensitive session-only values use the browser’s in-memory extension session storage and Declarative Net Request session rules.

No software can guarantee absolute security. Users remain responsible for selecting trusted destinations and configuring rules that do not expose sensitive values unnecessarily.

## 10. Permissions

MonoHeader uses the following Chrome and Firefox permissions:

- **storage:** stores local configuration, settings, history, diagnostics, rollback data, session-only values, and keep-alive settings;
- **alarms:** schedules keep-alive checks explicitly enabled by the user;
- **scripting:** temporarily runs the packaged keep-alive function in the selected HTTPS tab;
- **declarativeNetRequestWithHostAccess:** applies the user’s enabled request and response header rules;
- **host access to all URLs:** allows a general-purpose header rule to operate on destinations selected by the user.

MonoHeader has no persistent content scripts.

## 11. User choices and deletion

Users can:

- disable or delete individual rules;
- pause MonoHeader;
- stop or reset keep-alive for a tab, including pausing an automatic rule for that tab until it leaves the site;
- enable, disable, edit, test, or delete exact-origin, domain, subdomain-wildcard, and global keep-alive site rules;
- clear diagnostics;
- export configuration before deletion;
- restore factory defaults to remove local configuration and in-memory values;
- remove the extension, which causes the browser to remove the extension’s local storage.

Because Monolith Consulting AB does not receive the locally stored information, the company cannot view, export, correct, or delete it on the user’s behalf.

## 12. Children’s privacy

MonoHeader is a technical tool for development, testing, and administration. It is not directed to children and does not knowingly collect personal information from children.

## 13. Changes to this policy

If MonoHeader’s data-handling behavior changes, this policy and the applicable Chrome Web Store and Mozilla Add-ons disclosures will be updated before the changed version is distributed. The effective date and last-updated date at the top of this policy will also be revised.

## 14. Contact

MonoHeader is created and developed by:

**Monolith Consulting AB**  
Sweden

For privacy inquiries, use the verified developer contact address displayed on MonoHeader’s Chrome Web Store or Mozilla Add-ons listing.
