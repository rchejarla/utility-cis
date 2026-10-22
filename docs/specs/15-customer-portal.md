# Customer Portal

**Module:** 15 — Customer Portal
**Status:** Phase 4.1 (MVP complete) — see roadmap
**Entities:** No new entities. Portal users are `CisUser` rows with a nullable `customerId` FK to `Customer`. RBAC uses the existing Role / UtilityModule system with four portal-specific modules.

## Overview

The Customer Portal is a customer-facing web application that allows utility customers to self-serve on their account — view bills, monitor usage, manage their profile, and — once module 21 lands — pay via SaaSLogic's hosted page. It is distinct from the admin UI (used by utility staff) and operates on the same authentication infrastructure with customer-level access controls.

The portal is a route segment within the existing Next.js app (`packages/web/app/portal/`) with its own layout (no admin sidebar or topbar). It shares UI components, the API client, and the token format with the admin side.

Primary users: residential and commercial utility customers.

## Architecture

### Unified JWT — no separate auth domain

The spec originally proposed a separate auth domain for portal users. This was changed to a **unified JWT format** shared between admin and portal. The same token shape, the same auth middleware, the same RBAC system.

A token carries:
```
{
  sub: "user-uuid",
  utility_id: "tenant-uuid",
  email: "...",
  name: "...",
  role: "Portal Customer",
  customer_id: "customer-uuid" | null
}
```

- `customer_id` is **null** for admin staff and **set** for portal customers.
- The auth middleware extracts `customer_id` into `request.user.customerId`.
- Portal API endpoints check `request.user.customerId` is set and use it to scope every query to that customer's data. Tokens without a `customerId` get 403 on portal routes.
- When ApptorID / federated SSO integrates, it issues tokens in this same format — zero migration needed.

### Data model — CisUser.customerId

Portal customers are **CisUser rows** with a `customerId` FK to `Customer`. No separate `PortalUser` entity.

| Field | Change |
|---|---|
| `cis_user.customer_id` | New nullable UUID FK to `customer`. `onDelete: SetNull`. Indexed. |

The previously planned fields (`account.portal_user_id`, `account.portal_registered_at`, `account.portal_last_login`, `service_agreement.portal_visible`) were not implemented. Portal user identity and login tracking live on the `CisUser` row (`lastLoginAt`), and agreement visibility is controlled by the customer-scoping query rather than a per-row flag.

### RBAC — portal modules and role

Four portal-specific modules added to the `MODULES` constant:

| Module | Purpose |
|---|---|
| `portal_accounts` | View own accounts, agreements, meters |
| `portal_billing` | View own bills and invoices |
| `portal_usage` | View own meter reads and consumption data |
| `portal_profile` | View and edit own contact information |

A `Portal Customer` preset role is seeded with:
```
portal_accounts: ["VIEW"]
portal_billing: ["VIEW"]
portal_usage: ["VIEW"]
portal_profile: ["VIEW", "EDIT"]
```

The existing admin roles (System Admin, Utility Admin, CSR, Field Technician, Read-Only) do not have portal module permissions. Portal customers do not have admin module permissions. The RBAC system enforces this separation without any middleware changes.

### Portal layout

`packages/web/app/portal/layout.tsx` — customer-facing chrome:

- **No admin sidebar or topbar.** The `AppShell` component skips admin chrome for any path starting with `/portal/`.
- **Horizontal nav** in a 56px header: Dashboard, Bills, Usage.
- **Avatar dropdown** on the right: shows customer name and initial, with Profile link and Sign out button.
- **Mobile bottom nav** for small screens.
- **Utility branding**: logo square and "My Utility" text (will read from `settings.branding.logoUrl` when that is wired).

### Login flow

Unified login page at `/login` serves both admin and portal:

1. User enters email and clicks Sign in (or clicks a quick-login pill).
2. `POST /api/v1/auth/dev-login` looks up the `CisUser`, builds a JWT, and returns `{ token, user, isPortal, redirectTo }`.
3. Token stored in `localStorage` as `cis_token`. Persists across page reloads.
4. `redirectTo` is `/portal/dashboard` for portal users, `/premises` for staff.
5. **Logout** clears all tokens and redirects to `/login`.
6. Root page `/` checks the stored user's `customerId` to decide admin vs portal redirect.
7. `handleResponse` in `api-client.ts` catches 401 → redirect to `/login`, 403 for portal users on admin pages → redirect to `/portal/dashboard`.

**Dev quick-login pills** on the login page: 5 staff roles + 2 portal customers (Jane Smith, Robert Johnson).

**Registration**: `POST /portal/api/auth/register` accepts account number + email + name, verifies the email matches the customer on the account, creates a `CisUser` with the `Portal Customer` role linked to that customer, and returns a JWT.

Note: password hashing, MFA, and real session management are deferred until ApptorID/SSO integration. The current flow uses unsigned dev JWTs.

## API Endpoints (Implemented)

### Authentication (skipAuth — no token required)

| Method | Path | Description |
|---|---|---|
| POST | `/api/v1/auth/dev-login` | Unified login for admin and portal (dev mode, non-prod only) |
| POST | `/portal/api/auth/register` | Customer self-registration (account number + email verification) |
| POST | `/portal/api/auth/login` | Customer login (returns JWT) |

### Portal data (customer-scoped, require portal_* module permissions)

| Method | Path | Module | Description |
|---|---|---|---|
| GET | `/portal/api/dashboard` | portal_accounts | Customer + accounts + agreements, each account carrying its `balance`, plus `amountDue` summed across them |
| GET | `/portal/api/accounts` | portal_accounts | List customer's accounts |
| GET | `/portal/api/accounts/:accountId` | portal_accounts | Account detail with agreements, meters, premises |
| GET | `/portal/api/accounts/:accountId/bills` | portal_accounts | The account's **posted** bills, with settlement fields (`overdue`, `partPaid`, `charge.openAmount`) |
| GET | `/portal/api/agreements/:id/usage` | portal_usage | Meter reads for an agreement (accepts `from`, `to` YYYY-MM params) |
| GET | `/portal/api/bills/:id/document` | accounts | The customer's own bill PDF, streamed through the API |
| GET | `/portal/api/profile` | portal_profile | Customer contact info |
| PATCH | `/portal/api/profile` | portal_profile | Update email, phone, altPhone |

**Why these are separate routes rather than the admin ones** (added 2026-10-22, when the bills route landed): every staff equivalent filters on tenant and the record's id and deliberately asks nothing about ownership, because a CSR may read any account in the tenant. So there is no ownership check to borrow, and granting a portal token `accounts:VIEW` would let any signed-in customer read a stranger's data by passing their id. Each portal route instead calls `requireCustomerId` and puts `customerId` in the `where`. Three consequences worth keeping:

- **A miss is 404, not 403.** Whether another customer's account exists is not this caller's to learn, so "not yours" and "not there" are indistinguishable from outside.
- **Unposted bills are withheld.** A bill is a calculation until it is posted — it has raised no receivable and moved no balance, so the customer does not owe it. The filter sits in the route rather than the shared `listBillsForAccount`, because the staff Bills tab must still show them: that is where posting happens.
- **`amountDue` is summed server-side** from `Account.balance`, the ledger-maintained cache, rather than recomputed in the browser from bill totals. A client-side sum of totals counts bills already paid.

## UI Pages (Implemented)

| Page | Path | Description |
|---|---|---|
| Login | `/login` | Unified login (shared with admin), quick-login pills |
| Register | `/portal/register` | Account number + email verification |
| Dashboard | `/portal/dashboard` | **Amount due** per account with a tie-out total, current usage, account cards |
| Bills | `/portal/bills` | The customer's posted bills across every account they hold (`components/portal/bills-list.tsx`), with settlement status and a PDF action |
| Usage | `/portal/usage` | Premise/meter picker, monthly bar chart, date range (MonthPicker), data table with UOM |
| Account detail | `/portal/accounts/[id]` | Premises → agreements → meters hierarchy, View usage links |
| Profile | `/portal/profile` | Contact info view + inline edit for email/phone |

## Business Rules

1. **Customer-scoped authorization:** Every portal data endpoint checks `request.user.customerId` and filters queries to that customer's accounts. Tokens without a `customerId` get 403, and asking for a record that belongs to someone else gets **404** rather than 403 — "not yours" and "not there" are deliberately indistinguishable from outside. This is why portal routes exist at all instead of reusing the admin ones, which filter on tenant and id only because a CSR may read any account.

2. **Read-only for sensitive fields:** Customers can only edit email, phone, and altPhone via the profile endpoint. Account number, account type, status, billing cycle, and rate schedule are not editable through the portal.

3. **Payment delegation:** CIS never handles payment data. Paying will redirect to SaaSLogic's hosted payment page, reached over apptor-connect (`docs/specs/21-saaslogic-billing.md` § Transport). There is no Pay button yet — the invoice detail page that carried a disabled one was deleted on 2026-10-22.

4. **Unified identity:** Portal customers and admin staff share the same `CisUser` table, `Role` system, `UtilityModule` system, and JWT format. The only distinction is the `customerId` FK and the role's module permissions.

5. **Usage data visibility:** Customers can view meter read data for their active service agreements via the usage page. Date range is configurable (from/to month pickers, default trailing 12 months). UOM is frozen on each read and displayed alongside consumption.

6. **Bills are real, and only posted ones are shown** (since 2026-10-22). The portal reads `Bill` rows through `GET /portal/api/accounts/:accountId/bills`; an unposted bill is withheld, because it has raised no receivable and the customer does not owe it. Settlement state comes from the shared `BillStatusPill`, which reads `overdue`, `partPaid` and `charge.openAmount` as the API decides them — working it out in the browser from the money columns is the specific bug that component exists to prevent.

   This replaced `packages/web/lib/mock-billing.ts`, now deleted. The note that used to sit here — that bills would switch to real data "when the SaaSLogic invoice mirror ships (Phase 3)" and that the mock shapes made it "a one-line change" — was wrong on both counts and is worth recording as a lesson: the invoice mirror was **cancelled** on 2026-10-09 when CIS took over rating, so the screens were waiting on something nobody was going to build, while the real source had been there all along. And the shapes did not port: the mock invented a premise, a commodity list, a lifetime-paid figure and an on-time rate, three of which have no source in this data model at all.

7. **Bill PDFs are fetch-only in the portal.** `BillPdfButton` takes `surface="portal"`, which routes to `/portal/api/bills/:id/document` and, on a 404, says the bill is not available yet instead of generating one. Generating is `accounts:EDIT`, which no portal token holds, so the staff fetch-then-generate fallback would have shown a customer an authorization error for a bill that is legitimately theirs.

## Phase Roadmap

### Phase 4.1 (Complete)
- Unified JWT auth with `CisUser.customerId` FK
- Portal Customer role + portal_* modules
- Dev-mode registration and login
- Portal layout (horizontal nav, avatar dropdown, mobile bottom nav)
- Dashboard: amount due per account, current usage, account cards
- Bills page — real posted bills across the customer's accounts, with settlement status and a PDF action (2026-10-22; mock until then)
- Usage page: premise/meter picker, MonthPicker date range, monthly bar chart, data table with UOM
- Account detail: premises → agreements → meters hierarchy
- Profile: view + inline edit for email/phone
- Unified login page with quick-login pills for dev testing
- Logout across admin and portal
- Token persistence in localStorage, 401/403 redirect handling

### Phase 4.2 (partly done)
- ~~Real invoice data from SaaSLogic invoice mirror~~ — **done 2026-10-22, from CIS's own `Bill` rows.** The invoice mirror was cancelled on 2026-10-09; nothing was blocked on Phase 3 after that, which took twelve days to notice.
- ~~Bill PDF download~~ — **done 2026-10-22.** The endpoint had been live since bill production slice 1; what was missing was a real bill id to pass it.
- Itemized charge breakdown — the per-agreement detail exists as `BillSegment` + `BillSegmentLine`; the portal does not surface it yet
- Pay Now redirecting to SaaSLogic's hosted page — blocked on module 21, which is blocked on vendor answers, not on CIS
- Autopay enrollment status — blocked on module 21
- Paperless billing toggle — needs the `POSTAL` notification channel that `NotificationChannel` lacks

### Phase 4.3 (Planned — blocked on Modules 13 + 14)
- Service request submission and tracking (Module 14)
- Start/stop/transfer service wizards (ApptorFlow-backed)
- Communication preferences (Module 13) with SMS consent (TCPA)
- Solid waste vacation hold request (Module 12)

### Phase 4.4 (Planned)
- Multi-account view (one login → multiple linked accounts)
- Third-party payer access (restricted portal role)
- Outage and service status page (external system integration)
- Real authentication: password hashing, email verification, MFA via ApptorID
- AMI interval data visualization on usage page (daily/hourly granularity)

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 34 | Secure portal | Phase 4.1: customer auth with customer-scoped JWT (MFA deferred to 4.4 with ApptorID) |
| 35 | Account registration | Phase 4.1: self-registration with account number + email verification |
| 36 | Bill viewing | **Done 2026-10-22** — real posted bills with settlement status, and the bill PDF |
| 37 | Portal payments | Phase 4.2: SaaSLogic redirect (Pay Now button present but disabled in 4.1) |
| 38 | Usage dashboard | Phase 4.1: monthly consumption chart with date range and UOM |
| 39 | Start/stop/transfer service | Phase 4.3: service request wizards + ApptorFlow |
| 40 | Outage/service status | Phase 4.4: status page with external system integration |
| 41 | Communication preferences in portal | Phase 4.3: preferences management + SMS consent |
| 128–129 | Portal bill display, consolidated view | Phase 4.1: bill history (4.2: charge breakdown from SaaSLogic) |
| 132 | Paperless billing enrollment | Phase 4.2: portal toggle |
| 152–156 | Multi-account, third-party payer, payment allocation | Phase 4.4: multi-account view, third-party payer role |
