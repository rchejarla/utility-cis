# Customer Portal

**Module:** 15 — Customer Portal
**Status:** Phase 4.1 (MVP complete) — see roadmap
**Entities:** No new entities. Portal users are `CisUser` rows with a nullable `customerId` FK to `Customer`. RBAC uses the existing Role / TenantModule system with four portal-specific modules.

## Overview

The Customer Portal is a customer-facing web application that allows utility customers to self-serve on their account — view bills, monitor usage, manage their profile, and (when Phase 3 billing integration lands) pay bills via SaaSLogic. It is distinct from the admin UI (used by utility staff) and operates on the same authentication infrastructure with customer-level access controls.

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
| GET | `/portal/api/dashboard` | portal_accounts | Customer + accounts + agreements (dashboard data) |
| GET | `/portal/api/accounts` | portal_accounts | List customer's accounts |
| GET | `/portal/api/accounts/:id` | portal_accounts | Account detail with agreements, meters, premises |
| GET | `/portal/api/agreements/:id/usage` | portal_usage | Meter reads for an agreement (accepts `from`, `to` YYYY-MM params) |
| GET | `/portal/api/profile` | portal_profile | Customer contact info |
| PATCH | `/portal/api/profile` | portal_profile | Update email, phone, altPhone |

## UI Pages (Implemented)

| Page | Path | Description |
|---|---|---|
| Login | `/login` | Unified login (shared with admin), quick-login pills |
| Register | `/portal/register` | Account number + email verification |
| Dashboard | `/portal/dashboard` | Pending payments, current usage, account cards |
| Bills | `/portal/bills` | Invoice list with status badges (reuses CustomerBillsTab) |
| Invoice detail | `/portal/invoices/[id]` | Invoice details, payment summary, disabled Pay Now button |
| Usage | `/portal/usage` | Premise/meter picker, monthly bar chart, date range (MonthPicker), data table with UOM |
| Account detail | `/portal/accounts/[id]` | Premises → agreements → meters hierarchy, View usage links |
| Profile | `/portal/profile` | Contact info view + inline edit for email/phone |

## Business Rules

1. **Customer-scoped authorization:** Every portal data endpoint checks `request.user.customerId` and filters queries to that customer's accounts. Tokens without a `customerId` get 403. No cross-customer data leakage is possible.

2. **Read-only for sensitive fields:** Customers can only edit email, phone, and altPhone via the profile endpoint. Account number, account type, status, billing cycle, and rate schedule are not editable through the portal.

3. **Payment delegation:** CIS never handles payment data. The "Pay Now" button on the invoice detail page will redirect to SaaSLogic's hosted payment page when Phase 3 billing integration is live.

4. **Unified identity:** Portal customers and admin staff share the same `CisUser` table, `Role` system, `TenantModule` system, and JWT format. The only distinction is the `customerId` FK and the role's module permissions.

5. **Usage data visibility:** Customers can view meter read data for their active service agreements via the usage page. Date range is configurable (from/to month pickers, default trailing 12 months). UOM is frozen on each read and displayed alongside consumption.

6. **Mock invoice data:** Bills and invoice detail pages currently render deterministic mock data from `packages/web/lib/mock-billing.ts`. When the SaaSLogic invoice mirror ships (Phase 3), these will switch to real API calls. The mock data shapes match the planned response format so porting is a one-line change.

## Phase Roadmap

### Phase 4.1 (Complete)
- Unified JWT auth with `CisUser.customerId` FK
- Portal Customer role + portal_* modules
- Dev-mode registration and login
- Portal layout (horizontal nav, avatar dropdown, mobile bottom nav)
- Dashboard: pending payments, current usage, account cards
- Bills page with mock invoice data
- Invoice detail page with payment summary and disabled Pay Now
- Usage page: premise/meter picker, MonthPicker date range, monthly bar chart, data table with UOM
- Account detail: premises → agreements → meters hierarchy
- Profile: view + inline edit for email/phone
- Unified login page with quick-login pills for dev testing
- Logout across admin and portal
- Token persistence in localStorage, 401/403 redirect handling

### Phase 4.2 (Planned — blocked on Phase 3 billing integration)
- Real invoice data from SaaSLogic invoice mirror (replaces mock data)
- Pay Now redirects to SaaSLogic hosted payment page
- Itemized charge breakdown on invoice detail
- Autopay enrollment status
- Paperless billing toggle

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
| 36 | Bill viewing | Phase 4.1: bill list + invoice detail (mock data; real data in 4.2) |
| 37 | Portal payments | Phase 4.2: SaaSLogic redirect (Pay Now button present but disabled in 4.1) |
| 38 | Usage dashboard | Phase 4.1: monthly consumption chart with date range and UOM |
| 39 | Start/stop/transfer service | Phase 4.3: service request wizards + ApptorFlow |
| 40 | Outage/service status | Phase 4.4: status page with external system integration |
| 41 | Communication preferences in portal | Phase 4.3: preferences management + SMS consent |
| 128–129 | Portal bill display, consolidated view | Phase 4.1: bill history (4.2: charge breakdown from SaaSLogic) |
| 132 | Paperless billing enrollment | Phase 4.2: portal toggle |
| 152–156 | Multi-account, third-party payer, payment allocation | Phase 4.4: multi-account view, third-party payer role |
