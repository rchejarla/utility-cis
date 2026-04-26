# 03 — Progressive Web App (PWA)

**RFP commitment owner:** SaaSLogic Utilities (web frontend in `packages/web`)
**Status:** Drafted — implementation pending. No PWA infrastructure exists today (no manifest, no service worker, no installable shell, no offline cache).
**Effort estimate:** L (~2-3 weeks engineering, mostly overlapping with the field-tech offline work in [02-mobile-and-responsive-ui.md](./02-mobile-and-responsive-ui.md) §3.4 Tier 3).

This document is a deeper expansion of FR-MOB-CC-002 (PWA manifest) and FR-MOB-T3-004 (offline operation) from the mobile doc. The mobile doc owns the *user-facing* mobile commitments; this doc owns the *engineering* of how the PWA is structured — service worker architecture, cache strategies, update lifecycle, iOS Safari constraints, and per-surface configuration.

---

## 1. Context: why a PWA, not native

The Bozeman RFP commits to mobile accessibility for CSR workflows and a mobile-first field-technician experience. That commitment can be satisfied three ways:

| Path | Pros | Cons |
|---|---|---|
| **PWA** (this doc) | Single codebase, web deploy cycle, installable from browser, no app-store review, works across iOS + Android + desktop. | iOS Safari has strict limits (50 MB cache, 7-day idle eviction, no Background Sync, late Web Push support). |
| **Native iOS + Android** | Full platform capability (push, deep background, deep file access), App Store visibility. | Two extra codebases, App Store review cycle on every release, significantly more engineering, separate auth + deep-link plumbing. |
| **Responsive web only** | Cheapest. | No installable surface, no offline, no home-screen presence — fails the "field-technician workflows specifically designed for mobile use" claim. |

We're committing to PWA. The mobile doc explicitly puts native iOS/Android apps out of scope (§6), so this doc operationalizes the PWA path.

The PWA covers three surfaces, each with different requirements:

| Surface | Route | Audience | Primary use |
|---|---|---|---|
| **Admin** | `/` (everything outside `/portal` and `/field`) | CSRs, supervisors, admins | Office desktop or iPad on calls. Online required. |
| **Portal** | `/portal/*` | Customers (utility account holders) | Phone or desktop. Mostly online; basic offline browse OK. |
| **Field** | `/field/*` (new — see mobile doc §3.4) | Field technicians | Phone in the field. Must work offline for entire shift. |

These three surfaces share the same Next.js app and the same backend, but their PWA configuration differs. The Field surface is the most demanding; Admin is the least.

---

## 2. RFP commitments (implicit + explicit)

### Explicit (from earlier proposal text)

> Field-technician workflows are specifically designed for mobile use.

> Core customer service, account lookup, service request intake, attachment upload and review, payment lookup, and audit-log review are fully accessible on mobile.

### Implicit (to satisfy "fully accessible on mobile" credibly)

- The mobile experience is **installable** to the device home screen with an app-like icon and splash screen.
- It runs in a standalone window without browser chrome.
- Field-tech workflows continue working when the device temporarily loses network.
- A version drift between client and server is detected and surfaced to the user with a "Reload" prompt rather than silently breaking.

---

## 3. Current-state gap

| What's claimed/implied | Today |
|---|---|
| Installable from browser | No `manifest.json`. No `<link rel="manifest">`. The "Add to Home Screen" prompt never fires. |
| Standalone display window | No `display: standalone` config. iOS pinned shortcut would open in Safari with full chrome. |
| Offline operation (field tech) | No service worker registered. No fetch interception. No precache. No IndexedDB usage. |
| Update prompts when client is stale | None. A user with a tab open during a deploy continues running old JS until they hard-refresh. |
| Splash screen on launch | None. Cold launch shows a white screen for ~1-3s while the JS bundle loads. |
| Background sync of queued submissions | None. |
| Push notifications | None (and per [02-mobile-and-responsive-ui.md §6](./02-mobile-and-responsive-ui.md), explicitly NOT promised). |
| iOS Add-to-Home-Screen icon + splash | No `apple-touch-icon`, no `apple-touch-startup-image`, no `apple-mobile-web-app-*` meta tags. |
| Theme color in browser UI | No `<meta name="theme-color">`. Browser address bar matches default chrome. |

Concrete: `grep -r "manifest\|serviceWorker\|service-worker" packages/web/app packages/web/public` returns zero matches. Starting from zero.

---

## 4. Functional requirements

### 4.1 Manifest + installability

- **FR-PWA-001** — A web app manifest MUST be served at `/manifest.json` from the web app, content-type `application/manifest+json`, with the following minimum fields:
  - `name`: "SaaSLogic Utilities"
  - `short_name`: "SaaSLogic" (≤12 chars; iOS truncates beyond this)
  - `description`: short utility-CIS description
  - `start_url`: tenant-aware — see FR-PWA-009
  - `scope`: `/`
  - `display`: `standalone`
  - `display_override`: `["window-controls-overlay", "standalone", "minimal-ui"]` (lets desktop installs use the title-bar API)
  - `orientation`: `any` (don't lock — the field tech might use landscape)
  - `theme_color`: matches the active theme's `--accent-primary`
  - `background_color`: matches `--bg-deep` (used by the splash screen)
  - `categories`: `["business", "productivity", "utilities"]`
  - `lang`: `"en-US"` (extend when i18n lands)
  - **Acceptance:** Chrome DevTools "Application → Manifest" shows zero errors. Lighthouse PWA audit "Web app manifest meets the installability requirements" passes.

- **FR-PWA-002** — Icon set MUST include at minimum:
  - `192×192` PNG (Android home screen)
  - `512×512` PNG (Android splash screen + app drawer; required for installability)
  - `180×180` PNG as `apple-touch-icon` (iOS home screen)
  - Maskable variants of 192 + 512 (Android adaptive icons need a 40% safe zone)
  - **Acceptance:** Install on Android, verify the icon renders correctly without padding artifacts. Install on iOS, verify the icon renders correctly without the iOS gloss overlay being applied to a logo with empty corners.

- **FR-PWA-003** — Tenant-aware install: if the URL contains a tenant subdomain (e.g., `bozeman.saaslogic-utilities.com`), the manifest MUST be customized so installs are tenant-scoped:
  - `name`: "SaaSLogic Utilities — Bozeman"
  - `start_url`: tenant-specific dashboard
  - `theme_color`: the tenant's branded accent (already configurable via `tenant_theme`)
  - **Implementation:** The manifest is served by Next.js dynamic route `app/manifest.ts` rather than a static file. It reads the tenant from the request host and assembles the response.
  - **Acceptance:** Install from `bozeman.saaslogic-utilities.com` produces a "SaaSLogic Utilities — Bozeman" home-screen icon distinct from a generic install.

- **FR-PWA-004** — Install prompt (Android Chrome): the BIP (`beforeinstallprompt`) event MUST be captured and stashed; an in-app install affordance ("Install app") appears in the user menu after the user has been active for ≥3 minutes OR has completed at least one form submission. Premature install prompts kill install rates.
  - **Acceptance:** Manual test on Android Chrome — load the app, immediately check the user menu (no install button visible), use the app for 3 minutes, the install button appears.

- **FR-PWA-005** — Install detection: when running standalone, the UI MUST detect this (`matchMedia('(display-mode: standalone)')`) and:
  1. Hide the in-app install affordance (already installed).
  2. Hide the browser-only "open in browser" link in the user menu.
  3. Use a slightly different chrome on the topbar to indicate the user is in the installed app.
  - **Acceptance:** Running installed PWA shows no install affordance; the topbar carries the standalone-mode marker.

### 4.2 Service worker architecture

- **FR-PWA-010** — A service worker MUST be registered at `/sw.js` with scope `/`. Implementation uses **Serwist** (the actively-maintained successor to `next-pwa`) integrated with Next.js's app router so route-based code splitting and the SW play nicely.
  - **Why Serwist:** `next-pwa` is unmaintained. Workbox-based generation is industry-standard, and Serwist exposes the same primitives without abandoning the Next.js integration.
  - **Acceptance:** `navigator.serviceWorker.controller` is non-null after first load + reload. DevTools "Application → Service Workers" shows the registration with no errors.

- **FR-PWA-011** — The service worker MUST be **skipWaiting + clientsClaim** disabled by default. Updates wait for a controlled handoff (see FR-PWA-040). This prevents "the service worker activated mid-session and now my form state is in an inconsistent shell version" bugs.

- **FR-PWA-012** — The service worker MUST register the following event handlers:
  - `install`: precache the offline shell + critical assets per FR-PWA-021
  - `activate`: clean up old cache versions
  - `fetch`: route requests to the cache strategy table (FR-PWA-020)
  - `message`: respond to `{type: "SKIP_WAITING"}` with skipWaiting (used by the update flow)
  - `sync` (Android only): drain the field-tech queue (FR-PWA-031)
  - `push`: explicitly NOT registered (push not promised — see §7)

- **FR-PWA-013** — Service worker source MUST be code-reviewed and version-tagged. Every deploy bumps an embedded `SW_VERSION` constant; the `activate` handler iterates `caches.keys()` and deletes any cache whose name doesn't include the current version. This is the only mechanism for purging stale caches in production.
  - **Acceptance:** After a deploy, browsers running an old SW receive an "update available" banner (FR-PWA-040) within 60 seconds of next request.

### 4.3 Cache strategies per resource type

The cache strategy table is the operational core of the PWA. Each resource type gets a documented strategy.

| Resource type | URL pattern | Strategy | Cache name | Max entries / age |
|---|---|---|---|---|
| HTML shell (app routes) | `^/(field/|portal/|.*)$` matching `Accept: text/html` | **Network-first**, fallback to cached `/offline.html` | `pages-v<N>` | 50 / 7 days |
| Static JS/CSS chunks | `^/_next/static/` | **Cache-first** (immutable: filename includes content hash) | `static-v<N>` | 200 / 30 days |
| Images (logos, icons, illustrations) | `^/images/`, `/icons/` | **Stale-while-revalidate** | `images-v<N>` | 100 / 30 days |
| User-uploaded attachments | `^/api/v1/attachments/[^/]+/download$` | **Cache-first**, then network | `attachments-v<N>` | 50 / 7 days |
| API GET requests | `^/api/v1/.*$` (method=GET) | **Network-first** with 3s timeout, fallback to cache | `api-v<N>` | 100 / 1 day |
| API POST/PATCH/DELETE | any | **Network-only**. If offline AND on `/field/*`, queue to IndexedDB (see FR-PWA-030); otherwise reject with a clear "you are offline" error |
| External resources (Mapbox tiles, fonts) | `^https://api.mapbox.com/`, `^https://fonts.gstatic.com/` | **Stale-while-revalidate** with cap | `external-v<N>` | 200 / 30 days |
| Manifest itself | `/manifest.json` | **Network-first**, no cache fallback (a stale manifest is worse than none) | n/a | n/a |

- **FR-PWA-020** — The service worker MUST implement the cache strategy table above. Each strategy is a Workbox `Strategy` instance routed via `registerRoute`.
  - **Acceptance:** Per-row test: instrument the SW with debug logging in dev, exercise each URL pattern, verify the right cache is hit.

- **FR-PWA-021** — Precache (install-time): the SW MUST precache:
  - `/offline.html` — the offline-fallback page
  - `/manifest.json`
  - The current build's main JS chunk + framework chunk (manifest is hash-versioned by Next.js)
  - The 192/512 PNG icons + apple-touch-icon
  - The DM Sans font subset (woff2)
  - **Acceptance:** First load over a 3G simulation; after install, kill network, reload — the offline page renders.

- **FR-PWA-022** — Cache size budgets (NFR):
  - Admin surface: ≤25 MB (limited use of cache; mostly online)
  - Portal surface: ≤25 MB
  - Field surface: ≤200 MB (route packs, attachments for assigned reads)
  - Total per origin: ≤250 MB on Android Chrome (browsers will evict beyond device storage budgets; we cap to keep behavior predictable)
  - On iOS Safari: hard cap at 50 MB (browser-imposed limit). Field surface MUST cope with this — the route-pack precache is sized to leave headroom for in-flight attachments.

### 4.4 Offline shell + degraded UX

- **FR-PWA-025** — When the SW serves a cached HTML page while offline, the UI MUST render an "Offline" banner pinned to the top of the viewport. The banner persists until the page completes a successful network round-trip.
  - **Implementation:** Listen to `online`/`offline` events on `window` AND verify with a periodic `HEAD /api/v1/health` ping (every 30s while online flag is true). The combination defeats the false-online state where the device is on a captive-portal Wi-Fi but can't reach our API.
  - **Acceptance:** Disable network in DevTools — banner appears within 30 seconds. Re-enable — banner disappears within 30 seconds.

- **FR-PWA-026** — Routes outside the cached offline shell (Tier 2 power-user pages, etc.) MUST render the offline-fallback page (`/offline.html`) explaining the route is unavailable offline and offering a "Retry" button.

- **FR-PWA-027** — Per-surface offline support level:
  - **Admin (`/`)**: lightweight offline. Cached pages + offline banner. Mutations rejected with "you are offline" — no queueing.
  - **Portal (`/portal/*`)**: same as admin — offline browse-only of cached account / bill data. No queued payments.
  - **Field (`/field/*`)**: full offline operation per [02-mobile-and-responsive-ui.md FR-MOB-T3-004](./02-mobile-and-responsive-ui.md). Reads + SR triage + photos queue and sync.

### 4.5 Background sync (field-tech queue)

- **FR-PWA-030** — Mutations from `/field/*` made offline MUST be persisted to IndexedDB in a `field_queue` object store keyed by client-generated UUID. Each entry holds: HTTP method, URL, headers, body (serialized; binary attachments stored separately as Blob refs), timestamp, retry count.
  - **Implementation:** A custom fetch wrapper in the field surface intercepts mutations; on `navigator.onLine === false` OR network failure, writes to IndexedDB and resolves the call optimistically with a synthetic-success response keyed to the queue entry UUID. UI shows the optimistic state and a "Pending sync" badge.

- **FR-PWA-031** — When connectivity returns, the queue MUST drain in chronological order:
  - **Android Chrome**: Background Sync API. Register a `sync` event named `field-queue-drain`; the SW handles it by replaying queued requests.
  - **iOS Safari** (no Background Sync): poll on `visibilitychange` event when the tab becomes visible AND `navigator.onLine === true`. The drain runs in the foreground; the user sees "Syncing 5 reads…" feedback.
  - **Acceptance:** Disable network, complete 5 meter reads + 2 SR updates + 3 photos, re-enable network, verify all 10 land server-side in chronological order; UI clears the "Pending sync" badges.

- **FR-PWA-032** — Queue entry conflict handling: if a queued mutation fails with HTTP 4xx (validation or auth error), the entry MOVES to a `field_queue_dlq` IndexedDB store. UI surfaces a "Failed to sync — review" badge with one-tap access to the DLQ list. The user can retry, edit, or discard.
  - **Acceptance:** Queue an SR update with a stale ETag; sync attempt returns 409; the entry moves to DLQ; UI surfaces it.

- **FR-PWA-033** — Auth token expiry during queue drain: if a queued request returns 401, the SW pauses the drain, prompts the user to re-authenticate (in the foreground), and resumes after fresh credentials. Pending mutations don't silently disappear.

- **NFR-PWA-001** — Queue cap: 500 entries. Above the cap, new mutations are rejected with a "Queue full — connect to sync" error. Documented in the field-tech runbook.

### 4.6 Update lifecycle

- **FR-PWA-040** — Update detection: the registered SW MUST check for updates on every page load AND every 60 minutes while the tab is foregrounded. When a new SW is detected (waiting state), the UI MUST surface a "New version available" banner with a "Reload" button.
  - **Implementation:** `registration.update()` in a `setInterval`. Listen for `updatefound` on the registration; when the new SW reaches `installed` state, show the banner.

- **FR-PWA-041** — Update activation: the user MUST initiate the reload (no silent reload). On click of the banner button:
  1. Send `{type: "SKIP_WAITING"}` to the new SW
  2. Listen for `controllerchange` on `navigator.serviceWorker`
  3. Reload the page
  - **Why no silent reload:** A CSR mid-form would lose unsaved input. The user-initiated reload is the safer default.

- **FR-PWA-042** — Critical-update force-reload: a security patch (server-side flag in `/api/v1/health` response: `forceReloadPriorTo: <SW_VERSION>`) bypasses the user-initiated requirement. The banner becomes a non-dismissible modal: "A security update is required. Reloading in 30 seconds…" with a countdown.
  - **Acceptance:** Set the server flag to a version newer than the client's; verify the modal renders; verify the reload happens after the countdown.

- **FR-PWA-043** — Stale-tab eviction: if a tab has been backgrounded for >24 hours AND the server reports a version older than the client by more than 7 days, the tab forces a reload on the next visibility-change event. Prevents zombie tabs running ancient code.

### 4.7 Push notifications — explicit non-commitment

- **FR-PWA-050** — Web Push notifications are **NOT in scope** for this RFP.
  - **Rationale:** iOS Safari support for Web Push only landed in 16.4 (March 2023) and only for installed PWAs, not for ordinary browser tabs. Coverage gap is too large for a credible "all field techs receive push notifications" promise. Field techs are notified by:
    1. In-app banner on next sync (FR-PWA-030)
    2. Email via the existing notification engine
    3. SMS via the existing notification engine (already supported per Module 13)
  - **Future extension path:** When iOS install rate among the City's field techs is ≥80% AND iOS 16.4+ is the floor, Web Push becomes feasible. Documented in §7 (out of scope).

### 4.8 iOS Safari constraints

iOS Safari has tighter PWA constraints than Android Chrome. Each is called out so design + product set realistic expectations.

| Constraint | iOS Safari behavior | Mitigation |
|---|---|---|
| Cache size | 50 MB hard cap per origin; eviction LRU | Field-pack precache sized ≤30 MB; attachments cached separately in IndexedDB (which has a separate, larger budget but still finite) |
| Idle eviction | Service worker caches evicted after 7 days of no use | Field surface refreshes the precache on every shift sign-in (`POST /api/v1/field/sign-in` triggers a SW message that re-precaches) |
| Background Sync API | Not supported | Foreground-only drain on visibilitychange (FR-PWA-031) |
| Periodic Background Sync | Not supported | N/A — we don't promise it |
| `beforeinstallprompt` | Not fired | iOS install instructions surfaced as a one-time tutorial: "To install: tap Share → Add to Home Screen" |
| Push notifications | Only on iOS 16.4+ AND only for installed PWAs | Out of scope (§4.7) |
| Standalone display | Supported | Use `apple-mobile-web-app-capable` + `apple-mobile-web-app-status-bar-style` meta tags |
| Splash screen | Static images only (no auto-generated like Android) | Generate per-device-size splash images (`apple-touch-startup-image` with `media` query per device-pixel-ratio) |

- **FR-PWA-060** — iOS-specific meta tags MUST be set in `app/layout.tsx`:
  ```html
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="SaaSLogic" />
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png" />
  <link rel="apple-touch-startup-image" media="..." href="/splash/iphone-13-pro.png" />
  ```
  - At minimum 6 splash images sized for the most common iPhone variants currently in use (12/13/14, 12/13/14 Pro, 12/13/14 Pro Max, SE 3rd gen, mini, plus a generic fallback).

- **FR-PWA-061** — iOS install tutorial: a one-time tutorial overlay appears on iOS Safari (not in installed mode, not on Android) the first time a user reaches the `/field/*` surface. Walk-through: "Install for offline use → tap Share → tap Add to Home Screen." Dismissible; never re-shown to the same user (stored in `localStorage`).

### 4.9 Per-surface configuration summary

| | Admin | Portal | Field |
|---|---|---|---|
| Manifest registered | Yes | Yes | Yes |
| Installable | Yes | Yes | Yes |
| Standalone display | Yes | Yes | Yes |
| Service worker | Yes | Yes | Yes (more aggressive precache) |
| Offline banner | Yes | Yes | Yes |
| Offline page navigation | Cached pages only | Cached pages only | Full offline operation |
| Mutation queue | No | No | Yes |
| Background sync | No | No | Yes (Android), foreground (iOS) |
| Cache budget | ≤25 MB | ≤25 MB | ≤200 MB Android / ≤30 MB iOS |
| Update banner | Yes | Yes | Yes |
| Force reload on security patch | Yes | Yes | Yes |
| Push notifications | No (out of scope) | No | No |

---

## 5. Data + infrastructure changes

**Frontend deps:**
- `@serwist/next@^9` — Next.js integration for Workbox-based SW generation
- `idb@^8` — typed IndexedDB wrapper (already proposed in mobile doc)
- `workbox-strategies@^7`, `workbox-routing@^7` — exposed via Serwist; pinned for the cache strategy table

**Public assets:**
```
packages/web/public/
  manifest.json                     # legacy fallback; primary served from app/manifest.ts
  sw.js                             # generated by Serwist build
  offline.html                      # offline-fallback page
  icons/
    icon-192.png
    icon-512.png
    icon-192-maskable.png
    icon-512-maskable.png
    apple-touch-icon-180.png
  splash/
    iphone-{model}-portrait.png    # ~6 device-sized splash images
```

**App-router files:**
```
packages/web/app/
  manifest.ts                       # Dynamic per-tenant manifest
  sw-register.tsx                   # Client component that registers /sw.js + sets up update banner
  layout.tsx                        # iOS meta tags (FR-PWA-060) + sw-register import
  offline/page.tsx                  # /offline route (precached)
  field/sw-helpers/                 # Field-specific SW client helpers (queue API)
```

**Tenant config — no schema change required.** The tenant's manifest fields (name, theme color) are derived from the existing `tenant_theme` data.

**No backend schema change** for §4.1 through §4.6. §4.5 (queue) is entirely client-side; the server sees the replayed mutations as ordinary requests.

**API additions (small):**
- `GET /api/v1/health` MUST include `{ swVersion: "1.2.3", forceReloadPriorTo: "1.2.0" | null }` so clients can detect critical updates per FR-PWA-042.
- `POST /api/v1/field/sign-in` MUST exist for FR-PWA-031 / iOS idle-eviction recovery — triggers a client-side SW message that refreshes the precache.

---

## 6. Implementation sequence

Each step is independently shippable. Steps 1-3 are prerequisites for the field surface; steps 4-6 are the field-specific work that overlaps with [02-mobile §3.4](./02-mobile-and-responsive-ui.md).

1. **Manifest + iOS meta tags + icon set + splash images.** No SW yet. Effort: S (~1-2 days, mostly asset generation).
2. **Service worker via Serwist with the basic cache strategy table (§4.3).** All resource types except mutations + queue. Includes update banner (§4.6) and per-surface manifest scoping (FR-PWA-003). Effort: M (~3-4 days).
3. **Offline shell + offline page + offline banner (§4.4).** All three surfaces get the banner; the field surface gets the more aggressive precache. Effort: S (~2 days).
4. **Field queue + IndexedDB + foreground-drain (iOS) (§4.5).** Effort: M (~3-4 days).
5. **Background Sync (Android) (§4.5).** Effort: S (~1 day, layered on step 4).
6. **Update lifecycle, force-reload, stale-tab eviction (§4.6).** Effort: S (~2 days).

**Recommended pre-signature scope:** items 1, 2, and 3. The PWA installs and works offline-banner-style without touching the field-tech specifics. Demonstrable to procurement reviewers in a 5-minute install-and-fly-airplane-mode demo. Steps 4-6 are committed as Phase 2 deliverables tied to the field-tech app surface.

**Total effort estimate:** ~13-16 engineering days across the six steps. Roughly a calendar 3-week sprint with one engineer focused.

---

## 7. Out of scope for this RFP

- **Native iOS / Android apps** (already excluded in mobile doc §6).
- **Web Push notifications** (FR-PWA-050).
- **Periodic Background Sync** (Android-only API; not promised).
- **Web Bluetooth, Web USB, Web Serial** (used for some meter-reader integrations; not promised in this commitment).
- **File System Access API** (Chromium-only; not promised — uploads use the standard `<input type="file">`).
- **Multi-account install** (a user installs the PWA once per device; if they switch tenants, they switch within the PWA, not by reinstalling).
- **App-shortcut menu items** (Android long-press app icon shortcuts). Could be added trivially via `manifest.shortcuts`; not promised in this version.
- **Share-target API** ("share to SaaSLogic" from another app). Not promised.
- **Window Controls Overlay layout** for the desktop installable. We declare the capability via `display_override` but don't redesign the topbar to use the title-bar API. Future enhancement.
- **PWA presence in Microsoft Store / Google Play** (TWA-style packaging). Future option if City demands store-listed presence; not in this commitment.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Serwist or Workbox upgrade ships a regression that breaks the SW behind everyone's back | Pin both at known-good versions; manual upgrade test that re-runs the cache-strategy test matrix before any version bump. |
| iOS 50 MB cap evicts the field-tech precache mid-shift on a tech with many photos | Photos go to IndexedDB (separate budget, ~20% of free disk on iOS). SW cache holds only routing data + UI assets. Documented in field-tech runbook. |
| Field tech installs the PWA on iOS via an old iOS version (<14.4) | Detect at install time; show "iOS 14.4+ required" warning. The tech can still use the browser-tab version of the same surface, just without the install. |
| Service worker bug causes infinite reload loop | Update SW only via the user-initiated banner (FR-PWA-041). Force-reload (FR-PWA-042) has a 30-sec countdown the user can read. Worst case: emergency switch via server-side flag to disable SW altogether (`{ disableServiceWorker: true }` in `/health` response), recovered on next page load. |
| User is offline + queue full + can't deliver work | Queue cap at 500; UI surfaces a warning at 400 ("Connect to sync soon"). Documented in the runbook. |
| Tenant changes their theme color → installed PWA's icon doesn't update | Document this caveat. The PWA's icon is captured at install time; theme changes require a reinstall to flow through. Acceptable — theme changes are rare. |
| Cookie-based session expires while PWA is in standalone mode → user is "logged out but in an app" | The standalone mode UI handles this with a top-banner login prompt. Non-intrusive; preserves the user's draft state where possible. |
| iOS users skipping install never see the offline experience | The mobile doc commits offline only for `/field/*`. Non-installed iOS users in `/field/*` still get the offline-banner UI but cache eviction is more aggressive. Acceptable for casual field tech use; documented. |

---

## 9. Acceptance criteria summary

The PWA commitment is satisfied when ALL of the following pass:

- [ ] Lighthouse "Progressive Web App" audit reports zero failed checks on representative pages (FR-PWA-001, FR-PWA-002, FR-PWA-010).
- [ ] Install on Android Chrome from the in-app prompt; the home-screen icon renders correctly with no padding artifacts (FR-PWA-002, FR-PWA-004).
- [ ] Install on iOS via Add-to-Home-Screen; the home-screen icon, splash, and standalone display work (FR-PWA-060).
- [ ] Tenant-aware install: bozeman.* produces a "SaaSLogic Utilities — Bozeman" install distinct from a generic install (FR-PWA-003).
- [ ] Offline banner appears within 30s of network loss; disappears within 30s of restoration (FR-PWA-025).
- [ ] Cached pages serve from SW after airplane-mode reload (FR-PWA-021).
- [ ] Field-surface mutations queue offline; sync drains in chronological order on reconnect (FR-PWA-030, FR-PWA-031).
- [ ] DLQ catches a poisoned (4xx-failing) sync attempt; UI surfaces it for the user (FR-PWA-032).
- [ ] Update banner appears within 60s of a deploy; user-initiated reload activates the new SW (FR-PWA-040, FR-PWA-041).
- [ ] Critical-update force-reload modal counts down and reloads on a security flag (FR-PWA-042).
- [ ] Cache budgets verified: admin ≤25 MB, portal ≤25 MB, field ≤200 MB Android / ≤30 MB iOS (FR-PWA-022).
- [ ] All Web Push code paths absent from the bundle (verifies the explicit non-commitment) (FR-PWA-050).
- [ ] Manual QA on iOS Safari + iPad Safari + Android Chrome + desktop Chrome + desktop Edge per release; results stored alongside release notes.

Sign-off: frontend lead + design lead + accessibility review + proposal owner.
