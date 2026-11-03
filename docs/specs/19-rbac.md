# RBAC — Roles, Permissions & Access Control

**Module:** 19 — RBAC
**Status:** Built
**Date:** 2026-04-09

---

## Overview

Role-based access control for the Utility CIS. Hybrid model: external SSO handles authentication, CIS manages authorization via local User records, custom Roles with JSONB permissions, and tenant module enablement.

A single permission model drives both navigation visibility and operation access — no dual mapping.

### What this module does *not* do: keep tenants apart

Permissions answer "may this user do this?", never "whose rows are these?".
A tenant's System Admin holds every permission this module can grant and
still reads only its own tenant's data, and that is not because the
permission set withholds anything — it is a separate mechanism.

Tenant isolation is enforced by PostgreSQL row-level security on the
connection: the application connects as `cis_app`, a role with no bypass,
and the acting tenant reaches the policies through
`runAsTenant`/`runAsPlatform` (`lib/tenant-context.ts`). Two consequences
land in this module's territory:

- **The platform actor is above tenants, not a role within one.** It is a
  `cis_user` with a null `utility_id` and *no* `user_role` row — being the
  platform actor is the authority. Platform routes declare
  `{ config: { platform: true } }` rather than a module and permission, and
  a tenant's System Admin is refused there. Its database authority is
  `cis_platform`, which holds BYPASSRLS and is the only role that may cross
  tenants.
- **Granting a portal token a staff permission would not be a wider
  permission, it would be a data leak.** The portal routes carry their
  ownership check in the query because the staff equivalents filter on
  tenant and account only — a CSR may read any account in the tenant. RLS
  confines a portal user to their tenant; it does not confine them to their
  own customer.

Full account: `docs/design/utility-cis-architecture.md` §7.1.

---

## Entities

### User

Local record linked to external SSO identity. No password storage.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| external_id | VARCHAR(255) | SSO provider's user ID (e.g., Azure AD object ID) |
| email | VARCHAR(255) | Unique per tenant |
| name | VARCHAR(255) | Display name |
| role_id | UUID | FK → Role |
| is_active | BOOLEAN | Default true |
| last_login_at | TIMESTAMPTZ | Nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique:** [utility_id, email]

### Role

Custom roles with JSONB permissions matrix.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| name | VARCHAR(100) | e.g., "CSR", "Admin". Unique per tenant |
| description | VARCHAR(500) | |
| permissions | JSONB | `{ "customers": ["VIEW","CREATE","EDIT"], ... }` |
| is_system | BOOLEAN | Default false. True = preset, cannot be deleted |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique:** [utility_id, name]

### UtilityModule

Which modules are enabled per tenant. Managed by SaaSLogic subscription — no CIS admin UI for this.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| module_key | VARCHAR(50) | e.g., "customers", "premises" |
| is_enabled | BOOLEAN | |
| enabled_at | TIMESTAMPTZ | |

**Unique:** [utility_id, module_key]

---

## Module Keys & Permissions

### Module Keys (shared constant)

```typescript
export const MODULES = [
  "customers",       // Customer, Contact, BillingAddress
  "premises",        // Premise (+ map view)
  "meters",          // Meter, MeterRegister
  "accounts",        // Account
  "agreements",      // ServiceAgreement, ServiceAgreementMeter
  "commodities",     // Commodity, UnitOfMeasure
  "rate_schedules",  // RateSchedule
  "billing_cycles",  // BillingCycle
  "audit_log",       // AuditLog (VIEW only)
  "attachments",     // Attachment (cross-entity)
  "theme",           // UtilityTheme, UserPreference
  "settings",        // System config. NOT user/role management — see below
  "tenant_users",    // User management, Role management
  "billing",         // Billing runs, posting, delivery; the cross-account bill list
] as const;
```

### Permission Types

```typescript
export const PERMISSIONS = ["VIEW", "CREATE", "EDIT", "DELETE"] as const;
```

**Implicit rules:**
- CREATE, EDIT, DELETE all require VIEW — granting CREATE auto-grants VIEW
- Unchecking VIEW removes all other permissions for that module

---

## Backend Enforcement

### Route Declaration

Each route declares its module and required permission inline:

```typescript
app.get("/api/v1/customers", {
  config: { module: "customers", permission: "VIEW" }
}, handler);

app.post("/api/v1/customers", {
  config: { module: "customers", permission: "CREATE" }
}, handler);

app.patch("/api/v1/customers/:id", {
  config: { module: "customers", permission: "EDIT" }
}, handler);
```

### Authorization Middleware

Runs after auth + tenant middleware, before route handler:

```
1. Platform route? (`{ platform: true }`, or any URL under /admin/queues)
   → require a real platform-actor row: no row → 403 PLATFORM_REQUIRED /
     FORBIDDEN; a valid one → allow, and stop here. No module, no
     permission: identity is the whole authority.
2. Platform token on a tenant route → 403 TENANT_CONTEXT_REQUIRED
3. No module declared → allow (unprotected route, log warning in dev for
   /api/v1/* routes except /api/v1/auth/*)
4. Fetch utility status, enabled modules and user role in parallel, then
   check in this order:
   a. Utility SUSPENDED            → 403 UTILITY_SUSPENDED
   b. Module not enabled           → 403 MODULE_DISABLED
   c. No cis_user row / no role    → 403 USER_NOT_PROVISIONED
   d. Role inactive                → 403 USER_INACTIVE (BR-RB-009)
   e. Permission not in role       → 403 FORBIDDEN
```

Three notes on that order, each of which was a bug once:

- **Suspension is checked before the module.** "Module not enabled" for a
  suspended tenant sends an operator to the wrong screen entirely. A
  **null** status means the status could not be read, which is not a
  suspension.
- **The lookups are parallel, the checks are sequential.** Neither lookup
  depends on the other, and awaiting them in sequence was adding a flat
  two seconds to every authenticated request on a sick cache. The check
  order is unchanged, so the error a caller gets is the same.
- **4c used to return early and *allow* the request** — "backwards
  compatibility during migration", long done. What it did was hand every
  permission on every tenant route to any token whose subject had no
  `cis_user` row, which is exactly what the web login form mints.

### The platform actor sits outside this model

A `CisUser` with a **null `utility_id`** — the one identity above tenants.
It holds no `user_role` row, because being the platform actor *is* the
authority, so its routes declare `{ config: { platform: true } }` instead
of a module and a permission.

A tenant's own System Admin is refused on those routes, which is the
point: it holds every permission a *tenant* can grant, which is not the
same authority. And a platform token is refused on tenant routes, which
is what lets `request.user.utilityId` stay a non-nullable string at all
243 of its read sites — `request.user` is not set on a platform request;
`request.platformActor` is.

`getPlatformActor` is the gate: a real row, no tenant, active. The token's
claim only chose the branch. Note what is deliberately absent — the tenant
path's 4c fallback above. A positive lookup cannot have that shape.

What the platform actor does with that authority is
[25 — Platform Console](25-platform-console.md); the tenancy model behind
it is
[`docs/superpowers/specs/2026-10-17-tenancy-and-platform-admin-design.md`](../superpowers/specs/2026-10-17-tenancy-and-platform-admin-design.md).

### Caching

- **User role:** Cached in Redis on first request per user. Key: `user-role:{userId}`. TTL: 5 minutes. Invalidated on role change or user update.
- **Tenant modules:** Cached in Redis per tenant. Key: `tenant-modules:{utilityId}`. TTL: 10 minutes. Invalidated on module change.

### New API Endpoint

```
GET /api/v1/auth/me → {
  user: { id, email, name, roleId, roleName, customerId },
  utility: { id, name, status } | null,
  permissions: { "customers": ["VIEW","CREATE","EDIT"], "premises": ["VIEW"], ... },
  enabledModules: ["customers", "premises", "meters", ...]
}
```

Loaded once on frontend app startup. Refreshed on login or role change.

**`utility` — which tenant this is (2026-10-26).** The admin chrome named
the product and the tenant nowhere: the sidebar's brand row read "Utility
CIS" over "Admin Portal", and on a phone, where there is no sidebar, the
compact header was a hardcoded product name. Every screen below is one
tenant's data, so an operator with two tabs open had nothing on screen
saying which one they were about to charge.

It rides on this call rather than behind its own endpoint because every
page already makes it, and a second fetch for one name is a second thing
to fail. It is read **outside** `getAuthMe`, whose answer is cached in
Redis per user: a suspension has to be visible as soon as it happens, and
a primary-key lookup on one row is not what makes this route cost
anything. `utility` is `null` when the row cannot be read — not the same
as a tenant with no name — and the chrome then names the product.
Answering 500 here would take down every authenticated page over a
caption.

**Where it shows.** The tenant's name takes the sidebar brand row's
second line, replacing "Admin Portal" rather than joining it: the row has
one line for it, and "which utility" is the sharper form of the same
question that caption was answering. The platform screens mount no
`AuthPermissionProvider`, so `useAuth` there is the default context and
their explicit `brandSubtitle="Platform"` stands — the contrast still
reads, a tenant name meaning you are inside that tenant and "Platform"
meaning you are above them all. A collapsed 64px rail has nowhere to
render it, so it rides in the toggle's tooltip; the compact header shows
it in place of the product name. `Utility.name` is the source, not
`UtilityConfig.settings.issuer.utilityName` — the latter is the *bill's*
issuer and may legitimately differ from the tenant row.

---

## Frontend Enforcement

### Auth Context

```typescript
interface AuthContext {
  user: { id, email, name, roleId, roleName };
  utility: { id, name, status } | null;
  permissions: Record<string, string[]>;
  enabledModules: string[];
}
```

Loaded via `GET /api/v1/auth/me` on app startup. Stored in React context.

### ModuleContext

Each page wraps its content in a ModuleContext that declares which module the page belongs to:

```tsx
<ModuleContext module="customers">
  <CustomerListPage />
</ModuleContext>
```

### usePermission Hook

```typescript
function usePermission(module?: string) {
  const { permissions, enabledModules } = useAuth();
  const contextModule = useModuleContext(); // from nearest ModuleContext
  const m = module ?? contextModule;

  const isEnabled = enabledModules.includes(m);
  const perms = permissions[m] ?? [];

  return {
    canView: isEnabled && perms.includes("VIEW"),
    canCreate: isEnabled && perms.includes("CREATE"),
    canEdit: isEnabled && perms.includes("EDIT"),
    canDelete: isEnabled && perms.includes("DELETE"),
  };
}
```

### Usage Patterns

**Sidebar** — module optional (reads from nav item config):
```tsx
{ canView && <NavItem ... /> }
```

**Same-module button** — no module needed, inherits from page context:
```tsx
const { canCreate } = usePermission();
{ canCreate && <button>+ Add Customer</button> }
```

**Cross-module button** — explicit module:
```tsx
const { canCreate: canCreateMeter } = usePermission("meters");
{ canCreateMeter && <button>+ Add Meter</button> }
```

**Page-level guard:**
```tsx
const { canView } = usePermission();
if (!canView) return <AccessDenied />;
```

**`<AccessDenied />` renders nothing while the permissions are in
flight.** `auth-context` starts at `loading: true` with no permissions
and no enabled modules, and `usePermission` reads those directly — so for
the width of the `/auth/me` round trip, every one of the 47 pages with
the guard above asks a question whose answer is not known yet and gets
"no". That flashed a lock and "Access Denied" on every login, before the
page the person was entitled to appeared.

The fix lives in the component rather than in `usePermission`,
deliberately: the 47 call sites all read the same way, and the claim is
the component's to make. A page cannot render "denied" too early if the
thing that renders "denied" refuses to do so without the facts. It holds
a 400px placeholder either way so the layout does not jump when the
answer arrives.

---

## User Management UI

### Settings Page (`/settings`)

Two tabs: **Users** and **Roles**. Only visible to users with `tenant_users:VIEW`.

### Users Tab

- DataTable: Name, Email, Role (badge), Status (Active/Inactive), Last Login
- "Add User" button (tenant_users:CREATE): inline form — email, name, role dropdown, isActive
- Inline edit (tenant_users:EDIT): change role, toggle active status
- Search by name/email
- No password management — SSO handles authentication

### Roles Tab

- DataTable: Name, Description, System (badge), Users Count
- "Add Role" button (tenant_users:CREATE): opens role editor
- System roles: viewable but not deletable
- Custom roles: full CRUD

### Role Editor — Permissions Matrix

Modules as rows, permissions as columns. Checkbox grid:

```
                    VIEW    CREATE    EDIT    DELETE
Customers            ✓        ✓        ✓        □
Premises             ✓        ✓        ✓        □
Meters               ✓        □        □        □
...
```

**Interaction rules:**
- Checking CREATE/EDIT/DELETE auto-checks VIEW
- Unchecking VIEW unchecks all for that module
- "Select All" per row and per column
- System roles: read-only display

---

## Preset Roles

Seeded on tenant creation (`is_system: true`):

| Role | customers | premises | meters | accounts | **billing** | agreements | rate_schedules | delinquency | audit_log | **tenant_profile** | **tenant_users** | settings |
|------|-----------|----------|--------|----------|-------------|------------|----------------|-------------|-----------|--------------------|------------------|----------|
| **System Admin** | VCED | VCED | VCED | VCED | VCED | VCED | VCED | VCED | V | VCED | VCED | VCED |
| **Utility Admin** | VCED | VCED | VCED | VCED | VCED | VCED | VCED | VCED | V | VCED | VCED | V |
| **CSR** | VCE | VCE | V | VCE | **V** | VCE | V | **VC** | V | — | — | — |
| **Field Technician** | V | VE | VE | V | — | V | — | — | V | — | — | — |
| **Read-Only** | V | V | V | V | V | V | V | V | V | V | V | — |

V=VIEW, C=CREATE, E=EDIT, D=DELETE, —=no access

**`role-presets.ts` is the source of truth; this is a summary and is
maintained by hand.** It cannot be otherwise without 33 columns, so it
shows the keys where a role's authority is most often misread — and it
has drifted before: the CSR had no `delinquency` key at all until
2026-10-29, and the three bold columns were missing on 2026-11-03 while
two of them were the keys being got wrong.

`everyModule()` gives both admin roles every module, so an absent
column means VCED for them; Read-Only gets VIEW on all but `settings`,
`theme` and the portal. `role-presets.test.ts` guards the grants
themselves, and `presetDrift` reports a tenant whose copy of a role has
since been edited.

The three added on 2026-11-03 are the keys a menu review found were not
doing what their names said:

- **`billing`** — running a cycle, posting, delivery, documents, and the
  cross-account bill list. It was `accounts:EDIT`, the verb that edits a
  mailing address, so every CSR could bill the cycle and send the bills.
  A CSR keeps VIEW: reading a bill is counter work.
- **`tenant_users`** — staff users and roles. The APIs gated on
  `settings`, which Utility Admin holds VIEW-only, so that role could
  not create a user; and no route enforced `tenant_users` at all while
  two menus named it.
- **`tenant_profile`** — the tenant's own configuration, which now
  includes bill messages, custom fields, suspension types and the
  premise / account / measure type lists. Those writes answered to
  `settings` or to an operational key, so a Field Technician holding
  `premises:EDIT` for field work could rewrite the premise type list.

**The CSR's `delinquency: VC` was added 2026-10-29**, with payment plans
slice 1. It had **no `delinquency` key at all** — not VIEW — so the role
the whole collections design is written for could not open
`/delinquency/shutoff-eligible`, which refuses on `canView`. CREATE
agrees a payment plan; EDIT is withheld, because waiving an action,
authorising a disconnect and cancelling a live plan are a supervisor's
and all three are gated on that verb.

Two things follow from how presets work (see `presetDrift`): each
utility owns its copies, so this reaches **newly provisioned tenants
only** — an existing tenant's CSR role is unchanged until an operator
edits it or the tenant is reseeded. And a tenant that wants plans to be
supervisor-only removes the verb in the role editor; it is not a
migration.

---

## API Endpoints

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| GET | /api/v1/auth/me | (authenticated) | Get current user permissions + modules, and which tenant this is |
| GET | /api/v1/users | tenant_users:VIEW | List users |
| POST | /api/v1/users | tenant_users:CREATE | Create user |
| GET | /api/v1/users/:id | tenant_users:VIEW | Get user detail |
| PATCH | /api/v1/users/:id | tenant_users:EDIT | Update user (role, active) |
| GET | /api/v1/roles | tenant_users:VIEW | List roles |
| POST | /api/v1/roles | tenant_users:CREATE | Create role |
| GET | /api/v1/roles/:id | tenant_users:VIEW | Get role detail |
| PATCH | /api/v1/roles/:id | tenant_users:EDIT | Update role permissions |
| DELETE | /api/v1/roles/:id | tenant_users:DELETE | Delete custom role |
| GET | /api/v1/tenant-modules | settings:VIEW | List enabled modules |

---

## Two keys that moved (2026-11-03)

A menu review measured what each preset role can actually reach and
found two grants that were not what their names said.

**`users` and `roles` answered to `settings`, not `tenant_users`.**
`settings` is the single key that separates Utility Admin from System
Admin — Utility Admin holds `settings: ["VIEW"]` — so a Utility Admin,
whose description is "full access except system settings modification",
**could not create a staff user or a role**. The page and the sidebar
already gated on `tenant_users`, so Read-Only (which holds it) was shown
a Users & Roles entry whose API answered 403. Both routes now use
`tenant_users`: Utility Admin administers users, Read-Only reads the
list, CSR and Field Technician reach neither.

**Billing work answered to `accounts`.** `POST /billing-runs`,
`/:id/post` and `/:id/send` required `accounts:EDIT`, the same verb that
lets a CSR correct a mailing address — so every CSR could bill a whole
cycle and send the bills. The new **`billing`** key covers the
cross-account bill list, posting, delivery, documents and runs; CSR
holds `billing:["VIEW"]`. An account's *own* bills stay on `accounts`,
which is the record in front of the clerk — the same scope rule the
audit log already uses for one entity's history.

The maintenance routes for the three type-definition lists (premise,
account, measure) moved from their operational keys to
`tenant_profile`, where Custom Fields already sits. Reading them stays
open, because every form that offers those types needs them; writing
them was reachable with `premises:EDIT`, which a Field Technician holds
for field work.

**Adding a key costs a `utility_module` row per tenant and a place in
each preset.** Nothing is backfilled: a tenant is reprovisioned or
reseeded, and `presetDrift` leaves an edited role alone on purpose.

---

## Business Rules

| ID | Rule | Enforcement |
|----|------|-------------|
| BR-RB-001 | Every user must have exactly one role. | FK constraint |
| BR-RB-002 | System roles (is_system=true) cannot be deleted. | API validation |
| BR-RB-003 | A role cannot be deleted if users are assigned to it. | API validation |
| BR-RB-004 | CREATE, EDIT, DELETE implicitly require VIEW. | UI auto-check + API validation |
| BR-RB-005 | Tenant modules are managed by SaaSLogic, not by CIS admin UI. | No UI for UtilityModule |
| BR-RB-006 | User role and tenant modules are cached in Redis (5min/10min TTL). | Cache + invalidation |
| BR-RB-007 | Routes without module declaration are allowed but logged in dev. | Middleware behavior |
| BR-RB-008 | The last System Admin cannot have their role changed. | API validation |
| BR-RB-009 | Deactivated users (is_active=false) are rejected at auth middleware. | Auth check |

---

## Migration Path

### Phase 1: Add entities + middleware (no enforcement)
- Add User, Role, UtilityModule entities
- Add authorization middleware in "audit mode" — logs what would be blocked but doesn't block
- Seed preset roles and enable all modules for existing tenant
- Add /api/v1/auth/me endpoint

### Phase 2: Enable enforcement + UI
- Turn on middleware enforcement
- Add usePermission hook + ModuleContext
- Update sidebar to filter by permissions
- Update all buttons/forms to check permissions
- Build Settings page (Users + Roles tabs)

### Phase 3: Route annotations
- Add `{ config: { module, permission } }` to all existing routes
- Add startup check for unannotated /api/v1/* routes
