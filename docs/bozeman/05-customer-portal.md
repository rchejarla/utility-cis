# 05 — Customer Portal

**RFP commitment owner:** SaaSLogic Utilities (`packages/api/src/routes/portal-*` + `packages/web/app/portal/*`) with notification engine in shared platform services and Apptorflow handling DMS + voice integration.
**Status:** Drafted — partial implementation. The portal exists as a route segment with login/register/dashboard/profile and a bills page on mock data. The RFP commits ~30 capabilities; **roughly four are partially built today**, the rest are net-new. This is the largest gap in the RFP response so far.
**Effort estimate:** XL (~8-12 weeks engineering across portal UI + payments wiring + notification engine extensions + multi-account/delegation data model + Apptorflow voice integration). Single largest scope in the proposal.

---

## 1. RFP commitment (verbatim)

> Residents can view current and historical bills (PDF and itemized line view), view consumption history with charts, make one-time and scheduled payments, enroll in AutoPay, sign up for paperless billing, request service start/stop/transfer, view and update contact preferences, submit service requests, view service-request status, manage payment plans (where eligible), download tax documents, and message the City's customer-service team.

> A single resident login can hold multiple accounts (e.g., a primary residence and a rental property). Account switching is one click. Landlord/property-management users can be granted view-only or limited-action access across a portfolio of properties. Authorized representatives (e.g., a family member managing a senior's account) can be added with audit-logged delegation.

> Email, SMS, in-portal messages, and web push are supported. Voice (IVR / robocall) integration is available through Apptorflow if the City uses a voice-notification service. Notifications are templated, configurable by event (bill ready, payment due, payment received, high-usage alert, service interruption), and respect resident-set preferences.

The commitment breaks into three blocks:

- **Block A — Self-service capabilities** (~13 items): bill view, consumption, payments, AutoPay, paperless, service start/stop/transfer, contact preferences, SR intake + tracking, payment plans, tax docs, messaging.
- **Block B — Multi-account + delegation** (~4 items): single login → multiple accounts, one-click switching, landlord portfolio access, authorized representatives.
- **Block C — Notifications** (~5 items): email + SMS + in-portal + web push + voice (Apptorflow), templated, event-configurable, preference-respecting.

---

## 2. Current state — what exists today

### 2.1 Portal route segment

`packages/web/app/portal/`:

| Route | Status |
|---|---|
| `/portal/login` | Built — email-only "dev quick-login" stub |
| `/portal/register` | Built — basic enrollment |
| `/portal/dashboard` | Built — pulls from `GET /portal/api/dashboard`; shows "no outstanding payments" placeholder + usage card |
| `/portal/accounts/[id]` | Built — pulls from `GET /portal/api/accounts/:id` |
| `/portal/profile` | Built — `GET/PATCH /portal/api/profile` |
| `/portal/usage` | Built — pulls usage data |
| `/portal/bills` | Built UI — **uses mock data**; no API wiring |
| `/portal/invoices/[id]` | Built UI — same mock-data caveat |

`packages/api/src/routes/portal-*.ts`:

| API | Method | Status |
|---|---|---|
| `/portal/api/auth/register` | POST | Built |
| `/portal/api/auth/login` | POST | Built |
| `/portal/api/dashboard` | GET | Built |
| `/portal/api/accounts` | GET | Built — but returns one account per the customer FK |
| `/portal/api/accounts/:id` | GET | Built |
| `/portal/api/agreements/:id/usage` | GET | Built |
| `/portal/api/profile` | GET / PATCH | Built |

### 2.2 Auth + data model

- Portal users are `CisUser` rows with a non-null `customerId` FK and a `Portal Customer` role granting `portal_*` permissions.
- One CisUser → one Customer. **One Customer → many Accounts is supported in the schema**, but the portal API currently filters accounts to `WHERE customerId = portalUser.customerId`.
- A landlord with rental properties under multiple customers cannot today access more than one Customer's accounts from a single login. **No portfolio model.**
- Authorized representatives — i.e., a person managing a relative's account — has no schema support.

### 2.3 Coverage map vs RFP

| RFP capability | Current state |
|---|---|
| View current bill (PDF) | ✗ Mock data, no PDF generation, no Bill entity wired (Module 9 partial) |
| View current bill (itemized) | ✗ Mock data |
| View historical bills | ✗ Mock data |
| Consumption history with charts | ⚠️ `/portal/usage` exists; chart present; data backed by real `agreements/:id/usage` API |
| Make one-time payment | ✗ No payment processing integration; no payment routes |
| Make scheduled payment | ✗ |
| Enroll in AutoPay | ✗ |
| Sign up for paperless billing | ✗ No `paperless_billing` toggle in portal UI; column exists on `Account` table but unwired |
| Request service start | ✗ |
| Request service stop | ✗ |
| Request service transfer | ✗ |
| View / update contact preferences | ⚠️ Partial — `/portal/profile` allows email + phone update, but no notification preferences UI |
| Submit service requests | ✗ Module 14 SR intake is admin-only today; portal intake is in Slice C deferred list |
| View service-request status | ✗ Same as above |
| Manage payment plans | ✗ Module 11 (delinquency) has plan structure server-side; no portal UI |
| Download tax documents | ✗ No tax doc generation, no listing |
| Message customer-service team | ✗ No in-portal mailbox or message thread |
| Single login, multiple accounts | ✗ One CisUser ⟶ one Customer FK; cannot span multiple Customers |
| One-click account switching | ✗ |
| Landlord/property-mgmt portfolio access | ✗ |
| Authorized representative delegation | ✗ |
| Email notifications | ⚠️ Engine exists (`services/notification.service.ts` + ConsoleProvider); no production email provider; no portal-event templates |
| SMS notifications | ⚠️ Same engine, no SMS provider wired |
| In-portal messages | ✗ No inbox model |
| Web push | ✗ Per [03-progressive-web-app.md §4.7](./03-progressive-web-app.md), explicitly out of scope for the PWA — but the RFP commits it for the portal. **Reconcile or revise.** |
| Voice / IVR via Apptorflow | ✗ Apptorflow integration not built (covered by [04-attachments.md §4.7](./04-attachments.md) for DMS; voice is a separate Apptorflow channel) |
| Templated notifications | ⚠️ `NotificationTemplate` table + per-event templates exist server-side, but no portal-event templates seeded |
| Event configurability | ✗ No per-resident event-toggle UI |
| Preference-respecting | ✗ |

### 2.4 Reconciliation needed: web push

[03-progressive-web-app.md §4.7](./03-progressive-web-app.md) explicitly puts web push **out of scope** because of iOS Safari coverage gaps. This RFP commitment for the portal **promises web push as a notification channel.** The two docs are inconsistent.

Resolution options:

1. **Honor the portal commitment, narrow doc 03 to admin/field surfaces only.** Web push enabled on `/portal/*` but explicitly not promised on `/admin` or `/field/*`. Tenants on iOS Safari < 16.4 receive email/SMS fallback automatically.
2. **Revise the RFP response paragraph.** Drop "web push" from the portal channel list. Keep email + SMS + in-portal + voice (via Apptorflow). This is the safer commitment.
3. **Honor with tier-by-tier degradation.** Web push attempted; users without support fall back. Document in-product so a resident knows they're on email-fallback.

**Recommendation: Option 1 + Option 3** — implement web push, scope it to portal/PWA-installed-on-modern-browsers, document the fallback. Update doc 03's out-of-scope wording to say "web push is a portal-only channel; admin/field surfaces don't promise it."

---

## 3. Gap matrix

Capability scope is large enough that I've consolidated the per-feature gap into the §2.3 table above rather than repeating it here. The next section converts each gap into a numbered FR.

---

## 4. Functional requirements

Grouped by the three RFP blocks: **A — self-service**, **B — multi-account + delegation**, **C — notifications**.

### 4.1 Block A — Bill viewing

- **FR-PORTAL-001** — Portal MUST render a "Bills" tab listing every bill across every account the resident has access to (see Block B for multi-account scoping). Each row shows: bill number, billing cycle, amount due, due date, balance, status. Pagination + filter by account + filter by date range.
  - **Pre-condition:** The `Bill` entity from Module 9 must be the system of record. Bills are produced by SaaSLogic Billing and mirrored back to SaaSLogic Utilities for portal display.
  - **Acceptance:** A resident sees their last 24 months of bills across all accessible accounts.

- **FR-PORTAL-002** — Each bill MUST be openable in two views:
  - **PDF view** — the printable/branded bill document (rendered by SaaSLogic Billing on demand or fetched from cached storage). Open in-browser via `<embed>`/iframe with download button.
  - **Itemized line view** — HTML rendering with line items, charges, taxes, prior balance, payments applied, amount due. Built from the bill entity's structured data, not the PDF.
  - **Acceptance:** Both views land within 2s on a residential broadband connection. Itemized view is screen-reader-accessible (PDF is not promised to be).

- **FR-PORTAL-003** — Bills MUST be searchable by amount range and bill number within a single account.
  - **Acceptance:** Filter chips on the Bills tab.

### 4.2 Block A — Consumption history

- **FR-PORTAL-010** — The Usage tab MUST show consumption charts per agreement (one chart per commodity if multi-commodity). Time axis defaults to "Last 12 months"; range selector exposes 3M / 12M / 24M / "All".
  - **Today:** `/portal/usage` page exists with charts; the API `GET /portal/api/agreements/:id/usage` returns real meter-read data. Coverage is partial — multi-account residents see only one agreement at a time today.
  - **Gap:** Account switcher integration; chart-per-commodity layout when an account has multiple agreements.

- **FR-PORTAL-011** — The chart MUST overlay billing-period markers + average baseline computed from the prior 12 months. High-consumption alerts (FR-PORTAL-070) flag the periods where consumption exceeded the configured threshold.

- **FR-PORTAL-012** — Consumption data MUST be downloadable as CSV (per agreement, per range). One-click download from the chart.

### 4.3 Block A — Payments

- **FR-PORTAL-020** — One-time payment: resident selects an account → enters amount (default: full balance) → selects a stored payment method or enters new one → confirms. Receipt rendered in-portal + emailed.
  - **Pre-condition:** A payment-processor integration (Stripe / Authorize.Net / Paymentus / etc.) MUST be configured. The RFP doesn't commit to a specific processor; this requirement assumes one is selected during design phase.
  - **Acceptance:** End-to-end test in staging against the chosen processor's sandbox.

- **FR-PORTAL-021** — Scheduled payment: resident selects a future date + amount + payment method. Stored as a `scheduled_payment` row with `status = SCHEDULED`. A daily worker triggers the actual processor charge on the scheduled date and updates the status.
  - **Acceptance:** Resident schedules a payment for the next billing cycle; verifies it appears in pending; verifies it executes on the scheduled date.

- **FR-PORTAL-022** — AutoPay enrollment: resident selects an account → toggles AutoPay → chooses payment method + trigger (X days before due date) + max-charge cap. Persisted as `autopay_enrollment` row. Daily worker evaluates pending bills against active enrollments and triggers charges.
  - **Acceptance:** Resident enrolls; verifies enrollment shown in account settings; verifies a future bill triggers the charge; verifies receipt notification fires.

- **FR-PORTAL-023** — AutoPay disable: a resident MUST be able to disable AutoPay at any time. The disable action propagates to the `autopay_enrollment` row's `disabled_at` and emits a notification (per FR-PORTAL-080).
  - **Acceptance:** Disable test; subsequent bill does not auto-charge.

- **FR-PORTAL-024** — Payment plans: where eligible (defined by the City's delinquency policy + Module 11's plan rules), a resident MUST be able to view a proposed plan, accept it, and view the plan's installment schedule. Each installment is a `scheduled_payment` row.
  - **Pre-condition:** Module 11 (delinquency) has plan structure; portal-side eligibility check + UI is the gap.
  - **Acceptance:** A delinquent resident sees the offered plan, accepts, and sees the resulting installment schedule.

- **FR-PORTAL-025** — Stored payment methods: residents MUST be able to add, view, set-default, and remove stored payment methods. Card numbers are tokenized via the processor; SaaSLogic stores only the processor-provided token + last-4 + brand + exp.
  - **Compliance:** PCI-DSS scope is minimized via tokenization. Full PAN never lands in our system. Documented in §7.
  - **Acceptance:** Add card; verify PAN never in our DB; remove card; verify token revoked at processor.

### 4.4 Block A — Paperless billing

- **FR-PORTAL-030** — Per-account paperless toggle. Default off (paper bills). Toggle on flips `account.paperless_billing = true` (column already exists). Bill-generation logic in Module 9 honors the flag — paperless accounts get email-only delivery; non-paperless get email + mailed PDF.
  - **Acceptance:** Toggle on; next bill cycle: no mailed PDF generated for this account; email-only.

- **FR-PORTAL-031** — Enrollment confirmation MUST be auditable. Toggling fires an audit row of class `OPERATIONAL` (per [01-audit §3.4](./01-audit-and-tamper-evidence.md)) with before/after.

### 4.5 Block A — Service start/stop/transfer requests

- **FR-PORTAL-040** — Three new self-service workflows:
  - **Start service**: resident requests new service at a premise. Form captures: premise address, requested start date, commodity types, contact info. Generates a `service_request` row of type `START_SERVICE` (new request type definition needed).
  - **Stop service**: resident requests service termination on an existing agreement. Form captures: agreement, requested stop date, forwarding address (for final bill). Generates an SR of type `STOP_SERVICE`.
  - **Transfer service**: resident requests moving service from one premise to another (move-out + move-in combined). Form captures: outgoing agreement, incoming premise, target dates. Generates an SR of type `TRANSFER_SERVICE`.
  - **Pre-condition:** Module 14 SR type-defs must include these three types (currently has 8 type-defs but they're for issue/incident reporting, not service-lifecycle workflows). New type-defs added during portal build.
  - **Acceptance:** A resident submits each request; CSR-side queue receives each one and can process via the existing workflow tooling.

- **FR-PORTAL-041** — Identity verification on START_SERVICE: a resident new to the City MUST provide identity proof (driver's license photo upload + last 4 SSN OR equivalent City-policy verification). The verification step generates an attachment of category `IDENTIFICATION` (per [04-attachments.md §4.8](./04-attachments.md)) on the customer record.
  - **Compliance:** Privacy-relevant data; encrypted at rest, audit-logged on access.

### 4.6 Block A — Service requests (issues, not lifecycle)

- **FR-PORTAL-050** — A "Submit a request" surface allows residents to file new service requests (leaks, billing inquiry, no-water, etc.) The available request types come from `service_request_type_def` rows scoped to portal-permitted types.
  - **Pre-condition:** Module 14 Slice C (portal SR intake) — currently in deferred list. This requirement is Slice C's actual driver.
  - **Form fields:** request type, account, premise (auto-derived from account), description, optional photo attachment (upload via Tier-1 mobile flow per doc 02), priority is set by the system, not by the resident.
  - **Acceptance:** A resident submits an SR from the portal; CSR queue receives it with `source = "PORTAL"` and the resident as `created_by`.

- **FR-PORTAL-051** — SR status tracking: a "My Service Requests" list shows all SRs filed by the resident with current status, last update, and a comment thread. Status updates from the CSR side push notifications (per Block C).
  - **Acceptance:** Resident files SR; CSR transitions it; resident receives notification + sees updated status in list.

### 4.7 Block A — Tax documents

- **FR-PORTAL-060** — A "Documents" tab lists tax-relevant statements available for download (1099-style annual summaries, year-end usage statements, etc.). Each is a generated PDF stored as an attachment of category `BILLING_DOCUMENT` (per [04-attachments.md §4.8](./04-attachments.md)) tied to the customer record.
  - **Pre-condition:** A tax-document generator MUST exist in Module 9 (billing) that produces the documents on a yearly schedule. Generation is server-side; portal only displays the list.
  - **Acceptance:** A resident can download their last 7 tax years of statements (matching the financial-events 7-year retention from [04-attachments.md §4.8](./04-attachments.md)).

### 4.8 Block A — Customer-service messaging

- **FR-PORTAL-070** — In-portal mailbox: residents see message threads with the City's customer-service team. Each thread has a subject + ordered list of messages with timestamps + sender (resident or staff). Replies inline.
  - **Implementation:** New `portal_message_thread` and `portal_message` entities.
  - **CSR-side:** Staff inbox surfaces all open threads; route via existing role-based assignment if Module 13 (notifications) supports it.
  - **Notifications:** New message → sender gets an out-of-band notification (email by default; SMS or web-push if resident has opted in).
  - **Acceptance:** Resident sends a message; CSR receives notification + opens the thread; replies; resident sees reply both in-portal and via their preferred channel.

- **FR-PORTAL-071** — Attachments to messages: residents can attach images / PDFs / documents to a message (per [04-attachments.md FR-ATT-001](./04-attachments.md), `PortalMessage` is added to ATTACHMENT_ENTITY_TYPES). Same file-type and size limits as elsewhere.

### 4.9 Block A — Contact preferences

- **FR-PORTAL-080** — A "Notifications" preferences page lets residents:
  - Opt in / out per channel (email, SMS, in-portal, web push, voice via Apptorflow)
  - Opt in / out per event class (bill ready, payment due, payment received, high-usage alert, service interruption, SR status update)
  - Set quiet hours per channel (already supported per [scheduler-migration §3.4](../superpowers/specs/2026-04-24-job-scheduler-migration-design.md), extended to be per-resident not just per-tenant)
  - Set primary email + primary phone (drives where notifications go)
  - **Acceptance:** A resident disables SMS for "high-usage alert"; verifies high-usage alerts arrive only via email + in-portal next cycle.

- **FR-PORTAL-081** — Preferences MUST be respected by every notification path. The notification engine consults `portal_notification_preference` rows before dispatching a message; if no row exists, fall back to tenant-default preferences.

### 4.10 Block B — Multi-account architecture

The current data model has CisUser → 1 Customer → N Accounts. The RFP commits a single login holding accounts that may belong to **multiple Customers** (e.g., a homeowner who also rents out a separate property under a different Customer record). This is a fundamental data-model change.

- **FR-PORTAL-100** — A new `portal_account_access` join table captures `(portalUserId, accountId, role, status)` where:
  - `role` ∈ `OWNER` (full self-service), `LANDLORD` (view-only OR limited-action across the portfolio per FR-PORTAL-110), `REPRESENTATIVE` (delegated access per FR-PORTAL-120).
  - `status` ∈ `ACTIVE`, `PENDING_VERIFICATION`, `REVOKED`.
  - **Schema:** Adds the join table; deprecates the `cisUser.customerId` 1:1 binding (kept for backward compat, used as the "primary" account during transition).
  - **Acceptance:** A portal user can have rows in `portal_account_access` for multiple accounts spanning multiple customers.

- **FR-PORTAL-101** — Account switcher UI: the portal topbar carries an account selector. Default account is the first OWNER row by `created_at`. Switching is one click; the chosen account is persisted as `selected_account_id` in localStorage so reload preserves state.
  - **Acceptance:** Multi-account resident sees the switcher; selects account B; reloads; account B remains selected.

- **FR-PORTAL-102** — All portal queries scope to the selected account. The dashboard, bills, usage, payments, SRs, attachments, messages — every page uses the active account context, never a "show all" mode (avoids data-leakage if a portfolio user accidentally takes a screenshot of one account's data while expecting another).

- **FR-PORTAL-103** — Each account in the switcher displays: account number, premise address (truncated), role badge (`OWNER` / `LANDLORD` / `REP`), and a status indicator (current balance OK / due / overdue).

- **FR-PORTAL-104** — Adding an account: an OWNER MAY add another account they own via the "Add account" flow (account number + premise zip + identity verification challenge). New rows land with `status = PENDING_VERIFICATION` until CSR-side approval; auto-approved if verification challenge passes deterministic checks.

### 4.11 Block B — Landlord / property-management portfolio

- **FR-PORTAL-110** — A `LANDLORD` role can be granted by a tenant admin (or by automated workflow when an OWNER's account record indicates landlord status). The role:
  - Spans multiple accounts in the landlord's portfolio (potentially hundreds of rental units)
  - Has `access_scope` ∈ `VIEW_ONLY` (read bills + usage + balance; no actions) or `LIMITED_ACTION` (view + can pay bills + can submit non-service-impacting SRs; cannot terminate service or transfer)
  - Optionally has a per-tenant ceiling on number of accounts (default unlimited; tenant may cap at 500 to bound resource use)
  - **Acceptance:** A landlord with 50 rental properties signs in, sees a portfolio dashboard, can pay any of the 50 bills, but cannot terminate service.

- **FR-PORTAL-111** — Landlord portfolio view: in addition to the per-account drill-down, a "Portfolio" tab summarizes all accounts:
  - Count of accounts by status (OK / due / overdue / suspended)
  - Total outstanding balance across portfolio
  - Top 10 high-usage accounts in the current period
  - Sortable by address, balance, last-payment date
  - **Acceptance:** Portfolio view loads in <3s for 500 accounts.

- **FR-PORTAL-112** — Account-grant workflow: an OWNER can grant a landlord access to their account via the "Add representative" flow (FR-PORTAL-120 generalizes this). The OWNER → LANDLORD path is the same UX as authorized representatives; only the granted role differs.

### 4.12 Block B — Authorized representatives (delegation)

- **FR-PORTAL-120** — A resident OWNER can add an authorized representative via the portal:
  - Form captures: representative's email, relationship type (`FAMILY_MEMBER`, `LEGAL_GUARDIAN`, `POWER_OF_ATTORNEY`, `OTHER`), proposed access scope (`VIEW_ONLY`, `LIMITED_ACTION`, `FULL`), expiration date (optional)
  - System sends invitation email with one-time-link to accept
  - Acceptance creates a `portal_account_access` row with role `REPRESENTATIVE`, the chosen scope, and the expiration

- **FR-PORTAL-121** — Audit-logged delegation: every grant, modify, accept, decline, revoke, expire MUST emit an audit row of class `SECURITY` (per [01-audit §3.4 FR-AUDIT-032](./01-audit-and-tamper-evidence.md)) with before/after state including the relationship type, scope, and both parties' IDs.
  - **Acceptance:** Test the full lifecycle and assert one audit row per state transition.

- **FR-PORTAL-122** — Scope enforcement: every API call from a representative is checked against the access_scope of their `portal_account_access` row. `VIEW_ONLY` representatives reject mutating operations with 403. `LIMITED_ACTION` permits payments + SR submission; rejects service-stop, autopay-enrollment, payment-method changes.
  - **Acceptance:** Comprehensive permission matrix test.

- **FR-PORTAL-123** — Delegation expiry: representatives whose `expires_at` is in the past MUST have their access automatically revoked. A daily sweep flips status to `EXPIRED`. Notifications to both parties on expiry.

- **FR-PORTAL-124** — Self-revocation: an OWNER can revoke a representative at any time. Effect is immediate; representative's session is invalidated; both parties receive notification.

### 4.13 Block C — Notification channels

- **FR-PORTAL-130** — Email channel: existing notification engine in `services/notification.service.ts`. Today wired to a `ConsoleProvider` (logs only). Production deployment configures an SMTP / SES / SendGrid provider; portal events use this channel.
  - **Acceptance:** Production smoke test sends a "bill ready" notification; resident receives in their inbox.

- **FR-PORTAL-131** — SMS channel: same engine, swap provider per channel. Twilio / Vonage / AWS SNS Pinpoint. Tenant config exposes provider selection.
  - **Acceptance:** Production smoke test sends an SMS to a test phone.

- **FR-PORTAL-132** — In-portal channel: a `notification_inbox` row per resident captures notifications that should appear in the portal regardless of email/SMS reach. Inbox bell icon in topbar with unread count; clicking opens a tray with last 50 messages; mark-as-read; archive.
  - **Implementation:** New entity. Notifications dual-write: into the existing `notification` table (for delivery channels) AND into `portal_notification_inbox` (for the in-portal display).

- **FR-PORTAL-133** — Web push channel: implements the partial path from [03-progressive-web-app.md §4.7](./03-progressive-web-app.md). Reconciliation: web push is committed for the **portal surface only**; admin and field surfaces don't promise it.
  - **Implementation:** Service worker `push` event handler; subscription endpoint at `POST /portal/api/push/subscribe`; per-resident subscription rows; outbound dispatch via Apple Push Notification Service / FCM / VAPID-based service.
  - **Acceptance:** A resident on Chrome enables push notifications; receives a "bill ready" push when their next bill is generated.

- **FR-PORTAL-134** — Voice / IVR via Apptorflow: when the City has a voice-notification service (typically a third-party robocall vendor), Apptorflow holds the integration. SaaSLogic Utilities sends the templated voice message + recipient phone number to Apptorflow; Apptorflow's voice connector dispatches to the vendor.
  - **Reuses [04-attachments.md FR-ATT-060](./04-attachments.md)** Apptorflow client pattern: same `ApptorflowClient`, different method (`voice.dispatch(template, recipient, variables)`).
  - **Conditional commitment:** Voice channel ONLY available if the City has selected a voice vendor and Apptorflow has a connector. Documented in design phase. Default tenant config: `voiceChannelEnabled = false`.
  - **Acceptance:** With voice enabled, a high-priority notification (e.g., "service interruption") triggers an outbound voice call via the configured Apptorflow connector.

### 4.14 Block C — Templates, events, preferences

- **FR-PORTAL-140** — `notification_template` rows define per-event templates per channel. Existing schema covers this. New rows seeded for the events the RFP enumerates:
  - `bill.ready` — bill generated and available for view/payment
  - `payment.due_soon` — bill is N days from due date (N configurable per tenant)
  - `payment.received` — payment processed and applied
  - `payment.failed` — autopay or scheduled payment failed (rejected card, insufficient funds, etc.)
  - `usage.high` — consumption in current period exceeds the configured threshold
  - `service.interruption` — service is interrupted (planned or unplanned)
  - `service_request.status_changed` — SR moved to a new status
  - `delegation.granted` / `.accepted` / `.revoked` / `.expired` — delegation lifecycle events
  - `paperless.enrolled` — paperless billing turned on
  - `autopay.enrolled` / `.disabled`
  - `portfolio.weekly_summary` — landlord weekly digest of portfolio status
  - **Acceptance:** Each template available for all configured channels (email + SMS + in-portal + push + voice if enabled).

- **FR-PORTAL-141** — Per-event configurability: tenant admins MAY edit each event's template body + subject for each channel via the existing notifications-settings UI in `/settings/notifications`. Variable substitution uses the existing template engine (`{{customerName}}`, `{{billAmount}}`, `{{dueDate}}`, etc.).

- **FR-PORTAL-142** — Per-resident preferences: each event × channel pair is opt-in/out per resident (FR-PORTAL-080). Some events are **non-suppressible** (compliance):
  - `service.interruption` — public-safety reason; cannot be opted out of email + SMS at a minimum
  - `delegation.*` events — security reason; the OWNER and the representative both receive these regardless of opt-out
  - `payment.failed` — financial-impact; cannot be opted out of email
  - **Acceptance:** Preference UI surfaces these as "Required" with no toggle; the engine enforces dispatch regardless of preference.

- **FR-PORTAL-143** — Quiet hours: existing tenant-level quiet hours from [scheduler-migration §3.4](../superpowers/specs/2026-04-24-job-scheduler-migration-design.md) extended to be per-resident overridable. Voice + SMS suppressed during quiet hours; email + in-portal continue (no audible interruption).

- **FR-PORTAL-144** — Notification audit: every dispatched notification creates a row in the existing `notification` table with `status`, `provider`, `providerMessageId`, plus an `audit_log` row of class `OPERATIONAL` capturing dispatch + delivery confirmation events. Failed dispatches retry per the channel's retry policy and surface in the operator dashboard.

---

## 5. Data + infrastructure changes

### 5.1 Schema additions

```prisma
// Block B — multi-account + delegation

enum PortalAccountAccessRole {
  OWNER
  LANDLORD
  REPRESENTATIVE
}

enum PortalAccountAccessScope {
  VIEW_ONLY
  LIMITED_ACTION
  FULL
}

enum PortalAccountAccessStatus {
  PENDING_VERIFICATION
  ACTIVE
  REVOKED
  EXPIRED
}

enum DelegationRelationship {
  FAMILY_MEMBER
  LEGAL_GUARDIAN
  POWER_OF_ATTORNEY
  OTHER
}

model PortalAccountAccess {
  id                  String                       @id @default(uuid()) @db.Uuid
  utilityId           String                       @map("utility_id") @db.Uuid
  portalUserId        String                       @map("portal_user_id") @db.Uuid     // CisUser FK
  accountId           String                       @map("account_id") @db.Uuid
  role                PortalAccountAccessRole
  scope               PortalAccountAccessScope     @default(FULL)
  status              PortalAccountAccessStatus    @default(PENDING_VERIFICATION)
  relationship        DelegationRelationship?
  grantedBy           String?                      @map("granted_by") @db.Uuid       // OWNER who delegated
  invitedAt           DateTime?                    @map("invited_at") @db.Timestamptz
  acceptedAt          DateTime?                    @map("accepted_at") @db.Timestamptz
  expiresAt           DateTime?                    @map("expires_at") @db.Timestamptz
  revokedAt           DateTime?                    @map("revoked_at") @db.Timestamptz
  createdAt           DateTime                     @default(now()) @map("created_at") @db.Timestamptz
  updatedAt           DateTime                     @updatedAt @map("updated_at") @db.Timestamptz

  portalUser CisUser @relation("portal_user", fields: [portalUserId], references: [id], onDelete: Cascade)
  account    Account @relation(fields: [accountId], references: [id], onDelete: Cascade)

  @@unique([portalUserId, accountId])  // one row per (user, account)
  @@index([utilityId, portalUserId, status])
  @@index([utilityId, accountId, status])
  @@index([utilityId, status, expiresAt])  // expiry sweep
  @@map("portal_account_access")
}

// Block A — payments

enum PaymentMethodKind {
  CARD
  ACH
  WALLET
}

model PaymentMethod {
  id              String   @id @default(uuid()) @db.Uuid
  utilityId       String   @map("utility_id") @db.Uuid
  portalUserId    String   @map("portal_user_id") @db.Uuid
  kind            PaymentMethodKind
  processorToken  String   @map("processor_token") @db.VarChar(255)
  brand           String?  @db.VarChar(20)         // VISA, MC, AMEX, ACH bank code
  last4           String?  @db.Char(4)
  expirationMonth Int?     @map("expiration_month") @db.SmallInt
  expirationYear  Int?     @map("expiration_year") @db.SmallInt
  isDefault       Boolean  @default(false) @map("is_default")
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
  revokedAt       DateTime? @map("revoked_at") @db.Timestamptz

  @@index([utilityId, portalUserId])
  @@map("payment_method")
}

model ScheduledPayment {
  id                String   @id @default(uuid()) @db.Uuid
  utilityId         String   @map("utility_id") @db.Uuid
  portalUserId      String   @map("portal_user_id") @db.Uuid
  accountId         String   @map("account_id") @db.Uuid
  paymentMethodId   String   @map("payment_method_id") @db.Uuid
  amount            Decimal  @db.Decimal(14, 2)
  scheduledDate     DateTime @map("scheduled_date") @db.Date
  status            String   @db.VarChar(30)  // SCHEDULED | EXECUTED | FAILED | CANCELLED
  providerChargeId  String?  @map("provider_charge_id") @db.VarChar(255)
  executedAt        DateTime? @map("executed_at") @db.Timestamptz
  failureReason     String?   @map("failure_reason") @db.Text
  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@index([utilityId, status, scheduledDate])
  @@map("scheduled_payment")
}

model AutopayEnrollment {
  id              String    @id @default(uuid()) @db.Uuid
  utilityId       String    @map("utility_id") @db.Uuid
  accountId       String    @unique @map("account_id") @db.Uuid  // one enrollment per account
  paymentMethodId String    @map("payment_method_id") @db.Uuid
  triggerDaysBeforeDue Int  @default(0) @map("trigger_days_before_due")  // 0 = day of
  maxChargeCents  Int?      @map("max_charge_cents")  // null = no cap
  enrolledAt      DateTime  @default(now()) @map("enrolled_at") @db.Timestamptz
  enrolledBy      String    @map("enrolled_by") @db.Uuid
  disabledAt      DateTime? @map("disabled_at") @db.Timestamptz
  disabledBy      String?   @map("disabled_by") @db.Uuid

  @@index([utilityId, accountId])
  @@map("autopay_enrollment")
}

// Block A — in-portal messaging

model PortalMessageThread {
  id                String   @id @default(uuid()) @db.Uuid
  utilityId         String   @map("utility_id") @db.Uuid
  accountId         String   @map("account_id") @db.Uuid
  subject           String   @db.VarChar(255)
  status            String   @db.VarChar(30)  // OPEN | CLOSED
  lastMessageAt     DateTime @map("last_message_at") @db.Timestamptz
  createdBy         String   @map("created_by") @db.Uuid  // CisUser id (resident)
  assignedToUserId  String?  @map("assigned_to_user_id") @db.Uuid  // CSR
  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz

  messages PortalMessage[]

  @@index([utilityId, accountId, lastMessageAt])
  @@index([utilityId, assignedToUserId, status])
  @@map("portal_message_thread")
}

model PortalMessage {
  id        String   @id @default(uuid()) @db.Uuid
  utilityId String   @map("utility_id") @db.Uuid
  threadId  String   @map("thread_id") @db.Uuid
  senderId  String   @map("sender_id") @db.Uuid  // CisUser id (resident or staff)
  isStaff   Boolean  @map("is_staff")
  body      String   @db.Text
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz

  thread PortalMessageThread @relation(fields: [threadId], references: [id], onDelete: Cascade)

  @@index([utilityId, threadId, createdAt])
  @@map("portal_message")
}

// Block C — preferences + push subscriptions

model PortalNotificationPreference {
  id              String   @id @default(uuid()) @db.Uuid
  utilityId       String   @map("utility_id") @db.Uuid
  portalUserId    String   @map("portal_user_id") @db.Uuid
  eventType       String   @map("event_type") @db.VarChar(100)
  channel         String   @db.VarChar(20)  // EMAIL | SMS | IN_PORTAL | WEB_PUSH | VOICE
  enabled         Boolean
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz

  @@unique([portalUserId, eventType, channel])
  @@index([utilityId, portalUserId])
  @@map("portal_notification_preference")
}

model PortalPushSubscription {
  id              String   @id @default(uuid()) @db.Uuid
  utilityId       String   @map("utility_id") @db.Uuid
  portalUserId    String   @map("portal_user_id") @db.Uuid
  endpoint        String   @db.Text
  p256dhKey       String   @map("p256dh_key") @db.VarChar(255)
  authKey         String   @map("auth_key") @db.VarChar(255)
  userAgent       String?  @db.VarChar(500)
  lastUsedAt      DateTime? @map("last_used_at") @db.Timestamptz
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@unique([endpoint])
  @@index([utilityId, portalUserId])
  @@map("portal_push_subscription")
}

model PortalNotificationInbox {
  id            String   @id @default(uuid()) @db.Uuid
  utilityId     String   @map("utility_id") @db.Uuid
  portalUserId  String   @map("portal_user_id") @db.Uuid
  eventType     String   @map("event_type") @db.VarChar(100)
  subject       String   @db.VarChar(255)
  body          String   @db.Text
  ctaUrl        String?  @map("cta_url") @db.VarChar(500)
  isRead        Boolean  @default(false) @map("is_read")
  archivedAt    DateTime? @map("archived_at") @db.Timestamptz
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@index([utilityId, portalUserId, isRead, createdAt])
  @@map("portal_notification_inbox")
}
```

### 5.2 New API surface (high-level)

| Method | Route | Purpose |
|---|---|---|
| GET | `/portal/api/accounts` | List ALL accounts the resident has access to (replaces single-customer scope) |
| POST | `/portal/api/accounts/grant` | OWNER adds a representative or landlord |
| POST | `/portal/api/accounts/:id/revoke` | OWNER revokes a representative |
| GET | `/portal/api/bills` | Across selected account: list + filter |
| GET | `/portal/api/bills/:id/pdf` | Stream the bill PDF |
| GET | `/portal/api/bills/:id/itemized` | Itemized JSON view |
| POST | `/portal/api/payments/one-time` | Process a one-time payment via configured processor |
| POST | `/portal/api/payments/scheduled` | Schedule a future payment |
| GET/POST/DELETE | `/portal/api/payment-methods/:id?` | Manage stored payment methods |
| GET | `/portal/api/autopay/:accountId` | View AutoPay enrollment |
| POST | `/portal/api/autopay/:accountId/enroll` | Enroll AutoPay |
| POST | `/portal/api/autopay/:accountId/disable` | Disable AutoPay |
| POST | `/portal/api/paperless/:accountId/toggle` | Toggle paperless |
| POST | `/portal/api/service/start` | Start service request |
| POST | `/portal/api/service/stop` | Stop service request |
| POST | `/portal/api/service/transfer` | Transfer service request |
| POST | `/portal/api/service-requests` | Submit issue-style SR |
| GET | `/portal/api/service-requests` | My SRs |
| GET | `/portal/api/service-requests/:id` | SR detail + thread |
| GET | `/portal/api/payment-plans/:accountId` | Eligible plan |
| POST | `/portal/api/payment-plans/:accountId/accept` | Accept plan |
| GET | `/portal/api/tax-documents` | List tax documents |
| GET | `/portal/api/tax-documents/:id/download` | Download |
| GET | `/portal/api/messages` | List threads |
| POST | `/portal/api/messages` | Start a thread |
| POST | `/portal/api/messages/:id/reply` | Reply |
| GET / PATCH | `/portal/api/notification-preferences` | View / set preferences |
| POST | `/portal/api/push/subscribe` | Web-push subscription |
| DELETE | `/portal/api/push/subscribe/:id` | Unsubscribe |
| GET | `/portal/api/inbox` | In-portal notifications |
| POST | `/portal/api/inbox/:id/read` | Mark read |

### 5.3 Workers

- `scheduled-payment-charge` — daily worker that scans `scheduled_payment` for `scheduledDate <= today AND status = SCHEDULED` and triggers the processor. New BullMQ queue per the scheduler-migration plan.
- `autopay-charge` — daily worker that finds `autopay_enrollment` rows with bills due in `triggerDaysBeforeDue` days and triggers the processor.
- `delegation-expiry-sweep` — daily, reuses pattern from §4.12 FR-PORTAL-123.
- `notification-dispatch` — extends the existing `notification-send` worker from the scheduler migration with the new event types and channels.
- `web-push-dispatch` — separate from email/SMS because of VAPID/JWT signing latency. Could be folded into `notification-send` if perf permits.
- `voice-dispatch` — Apptorflow voice channel; gates on `tenant_config.voiceChannelEnabled`.
- `portfolio-weekly-summary` — weekly cron generating landlord digest emails.

### 5.4 Apptorflow integration

Reuses the `ApptorflowClient` from [04-attachments.md FR-ATT-060](./04-attachments.md). New methods on the client:

- `voice.dispatch(template, recipient, variables)` — outbound voice call
- `voice.deliveryStatus(callId)` — query delivery confirmation

Voice connectors (Twilio Voice / Genesys / city-specific IVR vendors) live on the Apptorflow side; SaaSLogic Utilities does not own them.

### 5.5 PWA reconciliation

[03-progressive-web-app.md §4.7](./03-progressive-web-app.md) currently has Web Push out of scope. This doc commits Web Push for the portal surface only. The reconciliation is to update doc 03's §4.7 — Web Push remains out of scope for admin + field surfaces, but is a portal-surface deliverable. The same SW handler infrastructure (FR-PWA-012) is extended with the `push` event handler when `/portal/*` is the active surface.

---

## 6. Implementation sequence

The portal scope is large enough that I've split implementation into five sub-projects. Each one is sized for a 1-2 sprint cadence with one engineer; in practice a 2-3 person team takes the whole thing in 2-3 months elapsed.

### Phase A — Foundation refactor (data model + auth)

1. **Multi-account data model.** `PortalAccountAccess` join table; backfill existing 1:1 bindings into rows; deprecate the `cisUser.customerId` constraint. Effort: M (~3-4 days).
2. **Account switcher UI + scoped queries.** Topbar selector; `selected_account_id` localStorage; every existing portal endpoint refactored to use the active account. Effort: M (~3-4 days).
3. **Delegation flow + audit-logged grants.** Invitation email; one-time link; accept/decline; revoke; expiry sweep. Effort: L (~5-7 days).

### Phase B — Bills + payments + AutoPay

4. **Bill viewing — PDF + itemized.** Wire to SaaSLogic Billing once Module 9 ships the bill entity. Currently mock data; replace. Effort: M (~3-4 days, gated on Module 9).
5. **Payment processor integration.** Choose vendor during design; implement the integration layer (Stripe/Authorize.Net/Paymentus). Tokenized stored methods; one-time charges. Effort: L (~7-10 days).
6. **Scheduled payments + AutoPay.** Two new BullMQ queues; enrollment UI; disable flow. Effort: M (~5 days).
7. **Payment plans (where eligible).** Reuse Module 11 plan structure; surface in portal; accept/manage. Effort: M (~3-4 days, gated on Module 11 finishing the plan rules).

### Phase C — Self-service flows

8. **Paperless billing toggle.** Trivial toggle + audit. Effort: S (~1 day).
9. **Service start/stop/transfer requests.** New SR type-defs in Module 14; portal forms; CSR-side queue routing. Effort: L (~5-7 days, plus Module 14 type-def update).
10. **Portal SR intake (issue-style).** Module 14 Slice C — promotes the deferred Slice C work into Phase 1 of the RFP. Effort: M (~5 days).
11. **Tax document downloads.** Pre-condition: a tax-doc generator in Module 9. Portal-side display is trivial; effort sits in the generator. Out of this doc's scope.
12. **Customer-service messaging.** Threads + messages + CSR inbox + notifications. Effort: L (~7-10 days).

### Phase D — Notifications + preferences

13. **Notification preferences UI + per-resident overrides.** Effort: M (~3-4 days).
14. **In-portal inbox channel.** New entity + bell icon + tray. Effort: M (~3-4 days).
15. **Email + SMS production providers.** Configure SES + Twilio (or alternatives); per-tenant config. Effort: S (~2 days, plus vendor account setup).
16. **Web push.** Service worker push handler; subscription endpoint; VAPID key generation; outbound dispatch. Reconcile with doc 03. Effort: M (~3-4 days).
17. **Voice via Apptorflow.** Extends the Apptorflow client with voice methods; gated on `tenant_config.voiceChannelEnabled`. Effort: M (~3-4 days, plus Apptorflow-side connector availability).
18. **Notification template seed for the 11 events.** Effort: S (~1-2 days).

### Phase E — Landlord portfolio

19. **LANDLORD role + scope enforcement.** Effort: M (~3-4 days).
20. **Portfolio dashboard + summary endpoints.** Effort: M (~3-4 days).
21. **Portfolio weekly digest.** Effort: S (~1-2 days, leverages the notification engine).

### Pre-signature scope recommendation

Phases A + B + the SR + portal-intake parts of C, plus minimal D (preferences + email/SMS providers + 11 templates). Roughly the first 14 items above — ~6-7 weeks engineering. That demonstrably gives a resident a portal that:

- Holds multiple accounts with delegation
- Shows bills (PDF + itemized) for each account
- Pays bills (one-time, scheduled, AutoPay)
- Submits + tracks SRs
- Receives email + SMS notifications with preferences

Phase E (landlord portfolio), web push, voice via Apptorflow, and the messaging mailbox commit as Phase 1 sprint deliverables in the SOW with explicit milestone dates.

**Total effort: ~10-14 weeks for the full scope** including Phase E and notification channels D. **Pre-signature minimum: ~6-7 weeks.**

---

## 7. Out of scope for this RFP

- **Native mobile app for residents** — covered by [02-mobile-and-responsive-ui.md](./02-mobile-and-responsive-ui.md) + [03-progressive-web-app.md](./03-progressive-web-app.md). The portal is a PWA, not a native app.
- **Payment processor selection** — assumed to happen during design phase. Specific processor not committed in this requirements doc.
- **Cryptocurrency / crypto-wallet payments** — not promised.
- **In-portal bill dispute workflow** — disputes go through the SR intake (FR-PORTAL-050 with type `BILL_DISPUTE`). No specialized dispute resolution UI.
- **Document upload for customer onboarding beyond identification proof** — only the START_SERVICE flow accepts an ID upload (FR-PORTAL-041). Other onboarding paths don't.
- **Delegation to non-residents** — representatives must have (or create) a portal login. SMS-only or phone-only delegation is not promised.
- **Per-account currency** — every account in the portfolio is in USD. Multi-currency is not promised.
- **Landlord-to-tenant rent collection** — the portal facilitates utility payments only. Rent / lease management is not a SaaSLogic Utilities concern.
- **Weekly portfolio digest customization** — landlords get a fixed digest format. Custom report-builder is not promised.
- **Direct API access for developers** — there's no developer portal, no API key issuance for residents, no public OpenAPI spec for the portal API.
- **Read-receipt confirmation per notification** — email-open tracking, SMS-delivered tracking, voice-call-answered tracking are not promised. We track *dispatch* status (sent / failed at our end), not the recipient's interaction.
- **Voice connectors built in-house** — the voice channel goes through Apptorflow only. SaaSLogic Utilities doesn't ship a Twilio or Vonage connector directly.
- **Real-time chat** — the messaging feature is async (threads + replies), not real-time chat. No typing indicators, no presence.
- **Hosted payment page redirect** — payment UI is in-portal, not a redirect to a hosted vendor page. (Some processors require the redirect; if so, that's a vendor-specific deviation captured in design phase.)
- **Service-interruption map / outage map** — the portal surfaces interruption notifications per FR-PORTAL-140, but a public outage map is a different feature.
- **Push notifications on iOS Safari < 16.4** — falls back to email/SMS. Documented in the resident-facing FAQ.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Bills depend on Module 9 (SaaSLogic Billing integration), which is partial | Portal mock data persists until Module 9 ships. The portal MVP can still ship with payments + SRs + delegation against existing schema; bills become real when Module 9 lands. |
| Payment processor outages | Fail-open with clear error messaging. Scheduled and AutoPay charges retry per processor's documented retry policy; persistent failures notify the resident + escalate to CSR. |
| PCI-DSS scope creep if a payment-processor change requires holding more card data | Staying in tokenized scope; full PAN never lands in our DB. Documented in §7. New processor selection requires a PCI scope review. |
| Delegation invitation links phished | Single-use; 72-hour expiry; signed with HMAC; bound to invitation email's recipient — accepting from a different email address fails. |
| Self-revocation race: OWNER revokes while representative has a session in flight | Sessions consult `portal_account_access.status` on every request (small Redis cache, 60s TTL). Worst-case: representative completes the in-flight request but next request 401s. |
| Multi-account residents accidentally pay the wrong account | Account selector visible in topbar; payment confirmation modal includes account number + premise address; confirmation-required toast on success. |
| Landlord with 500 accounts hits perf cliffs on portfolio dashboard | Cap UI rendering at 50 visible rows with virtualization for >50; aggregate stats from server-side rollup queries with 5-minute cache. Document the 500-account ceiling. |
| Voice channel lock-in to Apptorflow | Acceptable; the City selects the voice vendor during design and owns the relationship via Apptorflow. SaaSLogic Utilities is not the bottleneck. |
| Web push iOS gap | Documented per RFP non-commitment fallback to email/SMS. iOS Safari ≥16.4 in installed-PWA mode does work; we surface availability per-device. |
| Payment plan eligibility logic differs from Module 11's delinquency rules | Single source of truth in Module 11; portal calls Module 11 services for eligibility; no duplicated logic. |
| In-portal messaging spam from compromised resident accounts | Rate-limit message creation (10/hour/resident); CSR-side report-spam action. |
| Tax document generation lag — 1099-style docs not ready by January 31 | Tax-doc generation is out of this doc's scope but flagged as a hard deadline; Module 9's bill engine team owns delivery. Coordinated in design phase. |
| Notification opt-out breaks compliance for non-suppressible events | Engine enforces non-suppressibility (FR-PORTAL-142). Tested explicitly in CI. |
| Residents disable email + SMS + push and complain about missed notices | In-portal inbox is always-on; UI surfaces unread count. Documented in resident FAQ. |
| Landlord switching role from OWNER to LANDLORD on their own account loses self-service capabilities | A user is OWNER on their own account by default. Switching to LANDLORD on accounts they own personally is rejected — landlord scope is for properties they don't reside in. Validation rule in the grant flow. |

---

## 9. Acceptance criteria summary

The Customer Portal commitment is satisfied when ALL of the following pass:

**Block A — Self-service**
- [ ] Resident views current + last-24-month bills in PDF + itemized line view (FR-PORTAL-001, FR-PORTAL-002).
- [ ] Resident views consumption charts with billing-period overlays + average baseline + range selector (3M/12M/24M/All) (FR-PORTAL-010, FR-PORTAL-011).
- [ ] One-time payment processes via the configured processor; receipt rendered + emailed (FR-PORTAL-020).
- [ ] Scheduled payment executes on the chosen date; resident receives confirmation (FR-PORTAL-021).
- [ ] AutoPay enrollment covers a future bill cycle automatically; disable flow stops the next charge (FR-PORTAL-022, FR-PORTAL-023).
- [ ] Stored payment methods are tokenized; PCI scope minimized; no PAN in our DB (FR-PORTAL-025).
- [ ] Payment plan eligibility flows from Module 11; resident accepts and sees installment schedule (FR-PORTAL-024).
- [ ] Paperless toggle audit-logged; bill-cycle delivery honors flag (FR-PORTAL-030, FR-PORTAL-031).
- [ ] Service start / stop / transfer requests create properly-typed SRs in the CSR queue (FR-PORTAL-040).
- [ ] Portal SR intake works for issue-style requests with attachment support (FR-PORTAL-050, FR-PORTAL-051).
- [ ] Tax documents (when generated by Module 9) appear in the portal Documents tab; downloadable for at least 7 years (FR-PORTAL-060).
- [ ] In-portal mailbox supports threads + replies + CSR-side inbox (FR-PORTAL-070, FR-PORTAL-071).

**Block B — Multi-account + delegation**
- [ ] One resident login can hold accounts spanning multiple Customer records; switcher visible in topbar (FR-PORTAL-100, FR-PORTAL-101).
- [ ] All portal queries scope to the selected account; no cross-account data leakage in any UI surface (FR-PORTAL-102).
- [ ] OWNER can grant LANDLORD or REPRESENTATIVE access; full lifecycle (grant / accept / revoke / expire) audit-logged (FR-PORTAL-110, FR-PORTAL-120, FR-PORTAL-121).
- [ ] Scope enforcement: VIEW_ONLY rejects mutations; LIMITED_ACTION permits payments + SRs but blocks service-stop and autopay-changes (FR-PORTAL-122).
- [ ] Landlord portfolio loads in <3s for 500 accounts; weekly digest fires on schedule (FR-PORTAL-111, Phase E item 21).

**Block C — Notifications**
- [ ] Email + SMS dispatched via configured production providers (FR-PORTAL-130, FR-PORTAL-131).
- [ ] In-portal inbox shows unread count + tray with last 50 notifications + mark-as-read (FR-PORTAL-132).
- [ ] Web push delivers on Chrome + Edge + Firefox; iOS Safari ≥16.4 installed-PWA delivers; iOS <16.4 falls back gracefully (FR-PORTAL-133).
- [ ] Voice via Apptorflow delivers when configured (conditional commitment) (FR-PORTAL-134).
- [ ] Per-event templates for the 11 documented events available across all configured channels (FR-PORTAL-140).
- [ ] Per-resident preference overrides respected; non-suppressible events (service interruption, payment failed, delegation events) bypass opt-out (FR-PORTAL-142).
- [ ] Quiet hours suppress voice + SMS for residents who set them; email + in-portal continue (FR-PORTAL-143).
- [ ] Notification dispatch status auditable via `notification` table + `audit_log` rows (FR-PORTAL-144).

Sign-off: backend lead + frontend lead + design lead + payment-processor integration lead + Apptorflow integration lead + security review + proposal owner.
