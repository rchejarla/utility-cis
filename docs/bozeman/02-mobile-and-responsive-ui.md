# 02 — Mobile & Responsive UI

**RFP commitment owner:** SaaSLogic Utilities (web frontend in `packages/web`)
**Status:** Drafted — implementation pending. The current frontend is desktop-only with two minor responsive CSS rules. The RFP commits a three-tier mobile strategy that requires significant work: a mobile-first navigation pattern, mobile-optimized data display for ~30 list pages, a field-technician application surface that doesn't exist yet, and a PWA shell.
**Effort estimate:** XL (~6-8 weeks engineering across three tiers, plus ~1 week design).

---

## 1. RFP commitment (verbatim)

> Core customer service, account lookup, service request intake, attachment upload and review, payment lookup, and audit-log review are fully accessible on mobile. Power-user workflows involving large data grids or multi-window comparisons (e.g., bill-run review, rate-configuration editing) are optimized for desktop but remain usable on tablets. Field-technician workflows are specifically designed for mobile use.

The commitment defines three explicit tiers. Each tier has a different bar for what "supported" means.

| Tier | Bar | Examples cited in RFP |
|---|---|---|
| **1 — Mobile-first** | Fully accessible on phone (≤480px viewport). Primary actions reachable in one thumb. No horizontal scroll for content. | Customer service, account lookup, SR intake, attachment upload/review, payment lookup, audit-log review |
| **2 — Desktop-optimized, tablet-usable** | Works on tablet landscape (≥1024px). Phone access not promised. Tablet portrait shows a "use desktop for best experience" hint but doesn't block. | Bill-run review, rate-configuration editing, large data grids, multi-window comparisons |
| **3 — Mobile-first** | Designed for phone use in the field (≤480px). Offline-capable. Camera + GPS integration. No desktop equivalent required (though desktop fallback should function for testing). | Field-technician workflows |

---

## 2. Current-state gap analysis

### 2.1 What exists today

- **Two responsive CSS rules** in `packages/web/app/globals.css` (lines 162-183):
  - Tablet (≤1199px): `table { display: block; overflow-x: auto }` — tables scroll horizontally
  - Mobile (≤767px): three opt-in classes (`.responsive-grid`, `.stats-row`, `.page-header`) that switch to a single column
- **Portal route segment** (`/portal/*`) has its own layout with one media query for header collapse (`packages/web/app/portal/layout.tsx:150`). Slightly more mobile-friendly than admin but still mostly desktop-shape.
- **Customer-graph view** has a fullscreen toggle but layout is desktop fixed.
- **No explicit viewport meta tag** in `packages/web/app/layout.tsx`. Next.js's default applies (`width=device-width, initial-scale=1`) but no theme-color, no PWA manifest, no apple-touch-icon, no viewport-fit.

### 2.2 What's broken on mobile (≤480px)

| Issue | Where | Impact |
|---|---|---|
| Sidebar fixed at 240px expanded / 64px collapsed, no overlay drawer | `packages/web/components/sidebar.tsx:325` | Sidebar takes 60-70% of phone-screen width when expanded; covers main content. Collapsed mode (64px) shows only icons — no labels, hard to identify nav items. |
| Topbar fixed-pixel layout with full label set | `packages/web/components/topbar.tsx` | Text overflows below 600px; user menu falls behind logo. |
| Tables horizontal-scroll instead of card-rendering | All ~31 list pages | Reading row by side-scrolling is unusable on a phone. The City's CSRs taking calls on iPads in the field will fight this. |
| Forms use fixed-width inputs (`width: 280px`, `width: 320px`) | `settings-shell.tsx`, `entity-form-page.tsx`, many ad-hoc forms | Inputs overflow viewport. Save bars not sticky on small screens. |
| Touch targets undersized | Most icon buttons | Many buttons are 24-30px high. WCAG 2.5.5 (Target Size) recommends 44x44px minimum. |
| Modals + drawers fixed-width | Customer-graph node drawer, EntityFormPage modals | A 400px-wide drawer on a 375px screen leaves no room for content. |
| Settings pages use a two-column grid (label left, control right) | All settings pages | At 375px, the label gets crushed and the control overflows. |
| Customer-graph + premise map | `customer-graph-view.tsx`, `premises/map-view.tsx` | Graph nodes are 180×72px; can't fit 3-4 columns on phone. Map controls overlay obscures content on small screens. |

### 2.3 What's missing entirely

- **Mobile navigation pattern (slide-out drawer with overlay).** No drawer component, no hamburger-toggle on top bar, no swipe-to-dismiss, no scrim.
- **PWA capabilities.** No `manifest.json`, no service worker, no `apple-touch-icon`, no installable shell, no offline cache.
- **Offline support.** No IndexedDB usage, no offline queue, no sync-on-reconnect logic.
- **Field-technician application surface.** Zero mobile-first workflows. The only "field" reference in source is a placeholder string in a meter-read notes field (`meter-reads/[id]/page.tsx:466`). No route-list view, no GPS-tagged reads, no photo capture, no barcode/QR scan, no signature capture, no offline route packs.
- **Camera + media capture.** No `<input type="file" capture="environment">` usage anywhere; existing attachment upload (admin side) assumes a file picker.
- **Tablet-specific layout.** The 1199px breakpoint only affects table overflow; otherwise tablet renders the desktop layout shrunk.
- **Touch-vs-pointer feature detection.** No `(hover: hover)` / `(pointer: coarse)` queries to swap hover-only affordances (tooltips, hover-reveal action buttons) for tap-based equivalents.
- **Accessibility audit pass for mobile.** No published WCAG conformance level, no automated a11y testing in CI, no screen-reader testing on iOS VoiceOver / Android TalkBack.

### 2.4 Numerical scorecard (≤480px viewport)

Roughly tested by reading layout code, not by browser inspection:

| Tier | Pages claimed | Pages currently usable on phone |
|---|---|---|
| Tier 1 (CSR workflows) | ~12 (customer/account/SR/attachment/payment/audit) | **0** — all are desktop layouts that overflow |
| Tier 2 (power user, tablet OK) | ~8 (bill runs, rate config, etc.) | Most exist as desktop screens; tablet landscape is acceptable today; tablet portrait broken |
| Tier 3 (field tech) | New — doesn't exist | **0** — no field-tech app surface exists |

---

## 3. Functional requirements

Requirements grouped by tier plus cross-cutting infrastructure.

### 3.1 Cross-cutting infrastructure (FR-MOB-CC-XXX)

These apply to every tier. Implementing them is a prerequisite for any tier-specific work.

- **FR-MOB-CC-001** — Root layout MUST set explicit viewport meta with `width=device-width, initial-scale=1, viewport-fit=cover`. The `viewport-fit=cover` enables safe-area-inset support on iOS notch / Android cutouts.
  - **Acceptance:** Inspect rendered HTML; `<meta name="viewport">` is present with the documented value.

- **FR-MOB-CC-002** — Root layout MUST register a PWA manifest with at minimum: `name`, `short_name`, `start_url`, `display: standalone`, `theme_color`, `background_color`, and 192×192 + 512×512 icons.
  - **Acceptance:** Chrome DevTools "Application → Manifest" shows the manifest with no errors. The "Install" prompt appears on supported browsers.

- **FR-MOB-CC-003** — A breakpoint system MUST be defined as design tokens in `globals.css` and consumed via JS hook `useBreakpoint()`:
  - `--bp-phone`: 480px
  - `--bp-tablet`: 768px
  - `--bp-tablet-landscape`: 1024px
  - `--bp-desktop`: 1280px
  - **Implementation:** `useBreakpoint()` returns one of `"phone" | "tablet-portrait" | "tablet-landscape" | "desktop"`. Re-renders only when the band changes (not on every resize tick).
  - **Acceptance:** Hook unit-tested with `vi.useFakeTimers` + `matchMedia` mocks. Components import the hook rather than embedding raw `@media` queries except for layout primitives.

- **FR-MOB-CC-004** — Touch-target size: every interactive element (button, link, icon-button, toggle, select trigger, table row) MUST present a minimum 44×44px hit target on phone and tablet-portrait. Smaller visual chrome is allowed if the hit area is padded.
  - **Acceptance:** Lighthouse mobile audit "Tap targets are sized appropriately" passes. CI runs `axe-core` on representative pages and asserts no `target-size` violations.

- **FR-MOB-CC-005** — Touch-vs-pointer detection: hover-only affordances (tooltip-on-hover, hover-reveal action buttons) MUST have a tap equivalent on coarse-pointer devices. Implementation uses `@media (hover: hover)` to gate hover styles and an explicit tap handler for coarse-pointer.
  - **Acceptance:** A representative page (account detail) renders identical action affordances on a phone (without hover) and on a desktop with mouse hover.

- **FR-MOB-CC-006** — Mobile navigation: replace the current fixed sidebar with a slide-out drawer pattern below the tablet-landscape breakpoint. On phone + tablet-portrait, the drawer is closed by default; opens via hamburger on the topbar; closes via scrim tap, Escape key, or swipe-left.
  - **Acceptance:** Component test of `<Sidebar>` shows the drawer state machine. Manual test on iPhone-class width: hamburger opens, scrim dims content, swipe closes.

- **FR-MOB-CC-007** — Sticky save bars on form pages must remain pinned to the bottom on phone with the keyboard open. Use `position: fixed; bottom: 0; padding-bottom: env(safe-area-inset-bottom)`. The form scroll area accounts for the bar's height so the last field isn't hidden.
  - **Acceptance:** Manual test on a phone-class viewport with the soft keyboard open: save bar visible, last form field reachable.

- **NFR-MOB-CC-001** — First Contentful Paint on a 4G mobile connection (Lighthouse simulation) MUST be ≤2.5s for the public Tier-1 surface. The bundle MUST be code-split per route — no single chunk over 250kB gzipped.
  - **Acceptance:** CI runs Lighthouse-CI on the production build for the documented routes; thresholds enforced.

- **NFR-MOB-CC-002** — Accessibility: all Tier-1 pages MUST conform to WCAG 2.1 AA. Tier-2 desktop-only screens MUST conform to WCAG 2.1 A at minimum.
  - **Acceptance:** `@axe-core/playwright` integrated in CI; no AA violations on Tier-1 pages.

### 3.2 Tier 1 — Mobile-first CSR workflows (FR-MOB-T1-XXX)

The RFP names six workflow areas. Each gets a requirement covering its mobile UX.

- **FR-MOB-T1-001 — Customer search & lookup.** The customer search box, results list, and customer-detail summary MUST render usable on phone (≤480px).
  - **Behavior:** Search box full-width with autosubmit. Results list is a vertical card stack (avatar, name, account count, status chip) — not the desktop table. Tapping a result opens the customer detail page in mobile layout (tabs collapse to an accordion or segmented control; key fields stacked).
  - **Acceptance:** Manual + axe-core pass on `/customers`, `/customers/[id]` at 375×667 viewport.

- **FR-MOB-T1-002 — Account lookup.** Account-detail page renders mobile-friendly: tabs collapse to segmented control or pull-down; balance + status surface above the fold; payment history scrolls vertically without horizontal-scroll table.
  - **Acceptance:** Manual pass on `/accounts/[id]` at phone viewport.

- **FR-MOB-T1-003 — Service request intake.** The new-SR form MUST work fully on phone — type picker as a native-style sheet, account search inline, description textarea full-width, submit button sticky-bottom. Existing form (`/service-requests/new`) is rebuilt against the mobile layout primitives.
  - **Acceptance:** A CSR can complete an SR creation flow on a phone in ≤30 seconds for a known account.

- **FR-MOB-T1-004 — Attachment upload.** Attachment upload MUST support `<input type="file" capture="environment">` so the OS file-picker on a phone offers the camera as a source. Photo orientation EXIF data MUST be stripped or normalized server-side so portrait photos don't display rotated. Uploaded thumbnails render at appropriate size (no oversized hero images on a phone).
  - **Acceptance:** Snap a photo from a phone in the SR detail page; thumbnail renders correctly in the attachment list.

- **FR-MOB-T1-005 — Attachment review.** The attachment list displays as a 2-column grid of thumbnails on phone (1-column for non-image attachments with file-type icon). Tap opens the full-size view with pinch-to-zoom; download action available from the full-size view's action menu.
  - **Acceptance:** Manual pass on a customer/account/SR with mixed attachments.

- **FR-MOB-T1-006 — Payment lookup.** Payment list renders as a vertical card stack on phone (date, amount, method, status). The desktop list view's table layout is preserved for tablet-landscape and desktop. Payment detail surfaces as a modal sheet that fills the viewport on phone.
  - **Acceptance:** Manual pass on `/accounts/[id]/payments` (or wherever payment lookup lives once Module 10 lands).

- **FR-MOB-T1-007 — Audit-log review.** The audit-log page MUST be filterable + scrollable on phone. The current desktop table is replaced by a card stack on phone (timestamp, actor, action, entity link), with the row-detail expansion showing before/after JSON in a collapsible code block. Filter chips are sticky-top and tap-friendly.
  - **Acceptance:** A manager can filter audits by date range + actor on a phone in ≤15 seconds.

- **NFR-MOB-T1-001** — Tier-1 pages MUST function without horizontal scroll for primary content at viewport widths from 320px to 480px. Optional secondary panels (e.g., a "context" sidebar) may collapse to behind a "Details" tap reveal.

### 3.3 Tier 2 — Power-user workflows (FR-MOB-T2-XXX)

The RFP says these are "optimized for desktop but remain usable on tablets." Translation: tablet landscape is the bar; tablet portrait should display a "switch to landscape or use desktop" hint without blocking; phone access is not promised but pages should not crash.

- **FR-MOB-T2-001 — Bill-run review (Module 9).** The bill-run review screen MUST be usable on tablet landscape (≥1024px). Tablet portrait + phone display a banner explaining the screen is best on a larger display, with a "Continue anyway" link that proceeds with a desktop-shape layout the user can pinch-zoom.
  - **Note:** Module 9 is partial today; this requirement applies once the bill-run review screen is built. The mobile UX considerations must be designed into that screen at build time, not retrofitted.

- **FR-MOB-T2-002 — Rate-configuration editing.** Same shape as FR-MOB-T2-001. Existing `/rate-schedules` and `/rate-schedules/[id]` pages get the tablet-landscape audit; phone shows the "best on a larger display" banner.

- **FR-MOB-T2-003 — Large data grids.** Pages with grids of 50+ columns or virtualized rows MUST display the "best on a larger display" banner below tablet landscape. Above the banner, the page renders normally. Pinch-zoom is enabled (no `user-scalable=no` on viewport).

- **FR-MOB-T2-004 — Multi-window comparisons.** Out of scope for mobile entirely. The user's desktop workflow assumes two browser windows side-by-side; on a phone or tablet, the analogous flow is sequential — open one, close it, open the next. The UI doesn't try to recreate side-by-side; it offers a "Compare" action that opens the second item in a new tab.

### 3.4 Tier 3 — Field-technician workflows (FR-MOB-T3-XXX)

This is a new application surface. None of it exists today. The route segment should be `/field/*` to make the surface discoverable and to allow a different navigation chrome (no admin sidebar; bottom-tab nav suited to single-handed phone use).

- **FR-MOB-T3-001 — Field-tech persona + RBAC.** A new `Field Technician` role with a tightly-scoped permission set: `meter_reads:CREATE`, `meter_reads:VIEW` (own routes only), `service_requests:VIEW`, `service_requests:EDIT` (assigned ones), `attachments:CREATE`. No customer-detail edit, no billing, no rate config.
  - **Implementation:** Add the role to `seed.js` PRESET_ROLES. Add an `assignedToUserId` filter to meter-read and service-request listings.

- **FR-MOB-T3-002 — Daily route view.** `/field/route` displays today's assigned meter reads as a vertical list grouped by neighborhood / route order. Each item shows: meter number, address, last-read date+value, sequence number. The list works offline (cached at start-of-shift sync).
  - **Acceptance:** Tech taps a route item, sees the meter detail screen ready for read entry.

- **FR-MOB-T3-003 — Meter-read entry.** `/field/meter-reads/new?meterId=X` on phone:
  - Numeric keypad input mode (`<input inputmode="numeric">`)
  - Camera capture button — required photo of the dial display
  - GPS auto-tag (lat/lng captured at submission; off-by-default if the user's location permission is denied, in which case submission proceeds without coords)
  - Barcode/QR scan button to confirm meter ID matches the physical meter (uses the browser's BarcodeDetector API where available; falls back to manual entry)
  - Submit button sticky-bottom
  - **Acceptance:** Field tech can complete a read in ≤20 seconds for a known meter; the resulting MeterRead row carries the photo attachment, GPS coords, and reading.

- **FR-MOB-T3-004 — Offline operation.** The field-tech app surface MUST function offline for the entire workflow described in FR-MOB-T3-002 + FR-MOB-T3-003. Reads taken offline queue locally (IndexedDB) and sync to the server when connectivity returns. The user sees an "Offline — N reads queued" banner; tapping the banner shows the queue.
  - **Implementation:** Service worker caches the route-pack (today's assigned reads + last 30 days of read history per meter, ~few hundred KB). IndexedDB stores pending submissions. Background Sync API (Chrome) or visibility-change polling (iOS) drains the queue.
  - **Acceptance:** Disable network, complete 5 reads, re-enable network, verify all 5 land in the server's MeterRead table with correct photos, GPS, and timestamps.

- **FR-MOB-T3-005 — Service-request triage from the field.** A field tech assigned to an SR can open the SR on their phone, see the description + attachments + customer name + premise address (with one-tap navigation to maps), update status (e.g., to `IN_PROGRESS`), add a note, and add photos. Cannot reassign or delete.
  - **Acceptance:** Tech opens an assigned SR offline, drafts a status update + photo, syncs when back online.

- **FR-MOB-T3-006 — Signature capture.** For SRs requiring customer sign-off (e.g., new service installation), the SR detail screen offers a signature canvas (`<canvas>` with touch event handling) that captures a customer signature and uploads it as a typed attachment with `kind: "signature"`. Signatures display on subsequent views with the date and the customer's name.
  - **Acceptance:** Tech captures a signature on a phone; the resulting attachment renders on both the field view and the desktop SR detail page.

- **FR-MOB-T3-007 — Bottom-tab navigation chrome.** `/field/*` routes use a bottom-tab nav (Routes / SRs / More) instead of the admin sidebar. Top bar shows the user's name + offline indicator + a "Sync" button when items are queued.

- **FR-MOB-T3-008 — Battery & data conservation.** GPS sampling MUST not run continuously; only on submission and on demand. Photo uploads MUST resize client-side to ≤2 MB before submission. Map tiles cached aggressively.
  - **Acceptance:** A typical 8-hour shift consumes ≤200 MB of data and shouldn't drop battery below 30% for a phone starting at 100%.

- **NFR-MOB-T3-001** — The `/field` route segment MUST work without the admin chrome bundle. Code-split so the field app's First Load JS is ≤150kB gzipped, distinct from the admin shell.

### 3.5 Tier classification table (per route)

This table fixes which existing or future routes belong to which tier. It's the source of truth for which mobile bar each page must hit.

| Route | Tier | Notes |
|---|---|---|
| `/login`, `/portal/login`, `/portal/register` | 1 | Already mostly OK; needs viewport audit |
| `/customers`, `/customers/[id]` | 1 | Needs card list + tab collapse |
| `/accounts`, `/accounts/[id]` | 1 | Needs card list + payment list rebuild |
| `/service-requests`, `/service-requests/new`, `/service-requests/[id]` | 1 | Sticky save bar, attachment camera |
| `/audit-log` | 1 | Card list + filter chips |
| `/portal/*` (customer self-service) | 1 | Already partially mobile-friendly; finish the job |
| `/premises`, `/premises/[id]` | 1 | Map view stays desktop; list view becomes mobile-card |
| `/meters`, `/meters/[id]` | 1 (lookup) / 3 (read entry) | Two surfaces: CSR lookup is Tier 1; field read entry is Tier 3 |
| `/billing-cycles/[id]` (bill-run review) | 2 | Tablet-landscape OK; phone shows banner |
| `/rate-schedules/[id]/new`, `/rate-schedules/[id]` | 2 | Same |
| `/settings/*` | 2 | Configuration UI; tablet OK |
| `/users-roles` | 2 | Permission matrix is wide; tablet OK |
| `/workflows/*` | 1 | Workflow flows should work on phone for CSRs |
| `/customers/[id]/graph` | 2 | Already has fullscreen; not mobile-optimized |
| `/dev/*` (dev quick-login etc.) | n/a | Internal-only; no mobile commitment |
| `/field/*` (NEW) | 3 | Entire surface mobile-first |

### 3.6 What this requires from the design team

- Mobile navigation drawer mockups (open/closed/swipe states)
- Phone + tablet-portrait layouts for every Tier-1 page
- Tablet "best on larger display" banner spec
- Field-tech bottom-tab nav
- Field-tech meter-read entry, route list, SR triage screens
- Signature capture canvas spec
- Offline / queued-reads banner states
- Touch-target audit + button-size catalog
- Color-contrast audit for AA compliance on dark + light themes

---

## 4. Data + infrastructure changes

```prisma
// Field-tech route assignment (FR-MOB-T3-002)
model MeterReadRoute {
  id            String   @id @default(uuid()) @db.Uuid
  utilityId     String   @map("utility_id") @db.Uuid
  routeName     String   @map("route_name") @db.VarChar(100)
  technicianId  String?  @map("technician_id") @db.Uuid
  scheduledDate DateTime @map("scheduled_date") @db.Date
  status        RouteStatus @default(SCHEDULED)
  meterIds      String[] @map("meter_ids") @db.Uuid

  technician CisUser? @relation(fields: [technicianId], references: [id], onDelete: SetNull)

  @@index([utilityId, technicianId, scheduledDate])
  @@index([utilityId, scheduledDate, status])
  @@map("meter_read_route")
}

enum RouteStatus { SCHEDULED IN_PROGRESS COMPLETED CANCELLED }

// Photo + GPS coords on MeterRead (FR-MOB-T3-003)
model MeterRead {
  // ... existing fields ...
  capturedPhotoId String?   @map("captured_photo_id") @db.Uuid  // FK to attachment
  gpsLat          Decimal?  @map("gps_lat") @db.Decimal(9, 6)
  gpsLng          Decimal?  @map("gps_lng") @db.Decimal(9, 6)
  capturedOffline Boolean   @default(false) @map("captured_offline")
  syncedAt        DateTime? @map("synced_at") @db.Timestamptz
}

// New attachment kind for signatures (FR-MOB-T3-006)
enum AttachmentKind { GENERAL CONTRACT PHOTO SIGNATURE INVOICE READING_PROOF }
```

**Routes / app surface:**

```
packages/web/app/field/
  layout.tsx               # No admin chrome; bottom-tab nav
  route/page.tsx           # Today's assigned reads
  meter-reads/[id]/page.tsx
  meter-reads/new/page.tsx
  service-requests/page.tsx
  service-requests/[id]/page.tsx
  more/page.tsx            # Profile, sync status, sign out
```

**Service worker / PWA assets:**
- `public/manifest.json`
- `public/sw.js` (or generated by `next-pwa`)
- `public/icons/icon-192.png`, `icon-512.png`
- `public/apple-touch-icon.png`

**New deps:**
- `next-pwa@^5` (or `serwist` if Next.js 14+ aligned)
- `idb@^8` (IndexedDB wrapper)
- `@zxing/browser` or browser-native `BarcodeDetector` polyfill
- `@axe-core/playwright` (dev — accessibility CI)
- `@lhci/cli` (dev — Lighthouse CI)

---

## 5. Implementation sequence

Each step is independently shippable. Steps 1-3 are prerequisites for tier-specific work; steps 4-6 cover the three tiers.

1. **Cross-cutting infrastructure (steps 1, 2, 3 from §3.1).** Viewport meta, PWA manifest, breakpoint system, mobile navigation drawer, sticky save bars, touch-target audit, hover/coarse-pointer detection. Effort: M (~3-4 days).

2. **Touch-target audit + WCAG AA pass.** Run axe-core across every page; fix violations. Effort: M (~3 days).

3. **Lighthouse CI + bundle splitting.** Wire `@lhci/cli` into the GitHub Actions workflow; enforce thresholds. Code-split the app shell so admin chrome doesn't ship to `/portal/*` or `/field/*`. Effort: M (~2 days).

4. **Tier 1 — CSR mobile rebuild.** ~12 pages. Each gets a card-stack mobile variant + sticky save bar + tab collapse. Most reuse the breakpoint system; some need bespoke layouts. Effort: L (~7-10 days).

5. **Tier 2 — banner + tablet-landscape audit.** Add the "best on larger display" banner component; show below tablet-landscape on Tier-2 pages. Verify each page renders without crashing on phone. Effort: S (~2 days).

6. **Tier 3 — field-tech app.** New route segment, bottom-tab nav, route list, meter-read entry with camera/GPS/barcode, offline queue with service worker, signature capture, SR triage. Effort: XL (~3-4 weeks).

**Recommended pre-signature scope:** items 1, 2, 3, and a Tier-1 audit-log + customer-search prototype. The remaining tier-1 work and all of Tier 3 can be Phase 2 deliverables in the contract — explicit milestones in the SOW.

---

## 6. Out of scope for this RFP

These items are NOT committed by this requirements doc:

- **Native iOS / Android apps.** The commitment is a responsive web + PWA. Apple's App Store and Google Play submissions are not in scope. The PWA install prompt is the install path on both platforms.
- **Push notifications.** Web Push for browsers is not promised. Field techs are notified by email, in-app banner on next sync, or SMS via existing notification engine.
- **Background location tracking.** GPS is captured at submission only (FR-MOB-T3-003). No continuous-location tracking, no geofencing, no "tech is at premise" alerts.
- **Rich-text or markdown in the field app.** SR notes from the field are plain text. Formatted note input is desktop-only.
- **Bulk operations from mobile.** Mass-edit, bulk-tag, etc. are desktop-only.
- **Multi-window / split-screen optimization.** Tablet split-screen mode (iPad Slide Over, Android Multi-Window) renders the smaller pane as a phone-class layout; we don't add a third "split-screen" layout band.
- **Print-from-mobile workflows.** Bill print and statement print remain desktop-only.
- **Voice input.** Browsers' Web Speech API isn't reliably supported across iOS Safari + Android Chrome; not promised.
- **Embedded payment processing in the field app.** A field tech does not collect payment via the phone app in this scope.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Service worker mishandling causes stale data after deploy | Versioned cache keys; service worker checks version on activation and force-refreshes; documented in runbook. |
| iOS Safari quirks with `position: sticky` keyboard interaction | Explicit testing on iOS Safari at every Tier-1 milestone; add a manual-test checklist that covers each Safari-specific behavior. |
| Field-tech offline queue grows unbounded if connectivity stays bad | Queue cap (500 items); UI surfaces a warning at 80%; oldest items spill into a hardened error state requiring manual handling. |
| Photo storage costs (one photo per meter read × thousands of reads/day) | Client-side resize ≤2MB; server-side recompress on upload; configurable retention on photo attachments separate from text data. |
| BarcodeDetector API spotty on iOS | Fallback to manual entry is documented; iOS users still complete the workflow without barcode; test gates require both paths. |
| Test surface for Tier 3 is large (offline behavior is hard to automate) | Contract a manual QA pass on real devices (iPhone, mid-range Android) per release; document the test matrix. |
| "Tablet portrait" between phone and tablet-landscape is ambiguous | Explicit breakpoint at 768px-1024px treated as tablet-portrait. Default to mobile-card layout; show a Tier-2 banner on Tier-2 pages. |
| Existing settings + admin pages don't fit the breakpoint system without rewrites | Phased rollout: each settings page gets the breakpoint-system retrofit when next touched, not all at once. New pages must use it from day one. |

---

## 8. Acceptance criteria summary

The RFP commitment is satisfied when ALL of the following pass:

- [ ] PWA manifest is valid and the app is installable on iOS Safari + Android Chrome (FR-MOB-CC-002).
- [ ] Lighthouse mobile score ≥90 across Performance, Accessibility, Best Practices, and PWA on representative Tier-1 pages (NFR-MOB-CC-001, NFR-MOB-CC-002).
- [ ] axe-core CI gate passes with zero AA violations on every Tier-1 page (NFR-MOB-CC-002).
- [ ] Manual QA on iPhone-class (375×667) and Android mid-range (412×915) viewports for every Tier-1 page in §3.5.
- [ ] Tablet portrait (768×1024) renders Tier-2 pages with the "best on larger display" banner; tap-through to the page shows desktop-shape layout that pinch-zooms (FR-MOB-T2-001 through 003).
- [ ] Field tech can: log in, view today's route offline, complete a meter read with photo + GPS + barcode confirmation, complete an SR triage with status update + photo, sync when reconnected — all on a phone (FR-MOB-T3-001 through 008).
- [ ] No horizontal scroll for primary content on Tier-1 pages from 320px to 480px (NFR-MOB-T1-001).
- [ ] Bundle splitting verified: `/portal/*` First Load JS < 200kB; `/field/*` First Load JS < 150kB; admin shell First Load JS < 350kB (NFR-MOB-T3-001).
- [ ] Test matrix documents iOS Safari + Android Chrome + iPad Safari runs per release; results stored alongside release notes.

Sign-off: design lead + frontend lead + accessibility review + proposal owner.
