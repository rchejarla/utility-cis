# Theme and Configuration

**Module:** 18 — Theme and Configuration
**Status:** Built
**Entities:** UtilityTheme, UserPreference, UtilityConfig

## Overview

The Theme and Configuration module governs the visual identity and per-user display preferences for the Utility CIS admin UI. Each utility tenant can customize the application's color scheme, typography, logo, and border radius to match their organizational branding. Individual users can override the tenant theme with their preferred color mode (dark, light, or system default).

This module is foundational to the multi-tenant SaaS experience — each utility sees their own branded interface without code changes or deployments.

Primary users: utility administrators (for tenant theme setup), all admin UI users (for personal preferences).

## Entities

### UtilityTheme

Per-tenant UI theme configuration. One record per tenant. If no record exists, the system falls back to the default "Midnight" preset.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Unique — one theme per tenant (unique constraint) |
| preset | VARCHAR(50) | Active preset: "midnight", "daybreak", "dusk", "forest" |
| colors | JSONB | `{ "dark": { CSS vars... }, "light": { CSS vars... } }` |
| typography | JSONB | `{ "body": "font-family string", "display": "font-family string" }` |
| border_radius | INTEGER | Pixels, applied to all card/button/input components |
| logo_url | VARCHAR(500) | Nullable: tenant logo for sidebar and login page |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique constraint:** `[utility_id]`

#### colors JSONB Structure

The keys are the custom properties `globals.css` declares, and `theme.service.ts` holds the defaults. This section used to show a `--color-bg-primary` / `--color-accent` set that has never existed in either — documentation of a theme nobody shipped:

```json
{
  "dark": {
    "--accent-primary": "#6366f1",
    "--accent-secondary": "#22d3ee",
    "--success": "#4ade80",
    "--danger": "#f87171",
    "--warning": "#fbbf24",
    "--bg-deep": "#06080d",
    "--bg-surface": "#0c1018",
    "--sidebar-bg": "#0c1018",
    "--header-bg": "#0c1018",
    "--bg-card": "#111722",
    "--bg-elevated": "#171f2e",
    "--bg-hover": "#1c2640",
    "--border": "#1e293b",
    "--border-subtle": "#162033",
    "--text-primary": "#e8edf5",
    "--text-secondary": "#8494ad",
    "--text-muted": "#4a5a73"
  },
  "light": { "…the same keys": "indigo-led light values" }
}
```

All values are valid CSS custom property values. The admin UI applies these to the `<html>` element at runtime.

A tenant can only override a token `globals.css` already declares — `applyCSSVariables` sets whatever keys it is given, but a key nothing reads changes nothing. The reverse is the failure that actually happened, and it is silent: a component asking for a token that was never declared. CSS drops the whole declaration, and what it falls back to depends on the property. An inherited one like `color` takes the parent's value, so an accent link renders as body text; everything else takes its initial value, so `background: var(--nope)` is **transparent** — a filled button becomes its own label on whatever is behind it.

Six phantoms had accumulated across 23 sites: `--primary` (15 sites, 11 files, never defined anywhere), `--bg-base` (the AR dialogs' input wells, so every field in Record Payment, Refund and Adjust was transparent on a white card), `--accent-danger` (whose four sites carried `, #b00`, so a hardcoded maroon always won over the theme's own `--danger`), `--bg-input`, `--accent-rgb` and `--accent-primary-rgb`. The last two were `rgba()` wrapped around a channel triplet the theme has never shipped — it ships whole colors, so `color-mix(in srgb, var(--accent-primary) N%, transparent)` is the form that composes with it.

`packages/web/__tests__/css-tokens.test.ts` now fails on any `var(--token)` in the package that `globals.css` does not declare. It scans comments too, so a comment explaining a token's removal has to name it without the `var()` wrapper.

#### typography JSONB Structure

```json
{
  "body": "'Inter', 'system-ui', sans-serif",
  "display": "'Inter', 'system-ui', sans-serif"
}
```

Font families must be available via the tenant's configured font source (Google Fonts or self-hosted).

#### Interface scale

Type **size** is not part of the theme. Components set it inline — roughly 983 `fontSize` declarations across `packages/web`, with no Tailwind `text-*` utilities anywhere — so there is no central type scale to theme.

Overall interface size is therefore governed by a single declaration in `packages/web/app/globals.css`:

```css
html {
  zoom: 1.25;
}
```

Zoom rather than a font-size bump because spacing, row heights and badge dimensions are hardcoded in px alongside the type; growing text alone crowds and clips dense tables. Applied to the root element rather than `body` so it behaves like browser zoom and the `position: fixed; inset: 0` modal backdrops still cover the full viewport.

Not tenant- or user-configurable today. If that is wanted, the hook is a `--ui-scale` custom property driven from `UtilityTheme` or `UserPreference.preferences`, which would not require touching components. A real type scale replacing the inline sizes is the larger prerequisite for theming type properly.

---

### UserPreference

Per-user settings. Currently governs dark/light/system mode. The `preferences` JSONB field is extensible for future per-user settings.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| user_id | UUID | The authenticated user |
| theme_mode | ENUM | DARK, LIGHT, SYSTEM |
| preferences | JSONB | Extensible: currently `{ "sidebarCollapsed": boolean }` |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique constraint:** `[utility_id, user_id]`

**Default behavior:** If no UserPreference record exists for a user, the system reads `prefers-color-scheme` from the browser (SYSTEM behavior).

#### preferences JSONB Current Schema

```json
{
  "sidebarCollapsed": false
}
```

Future additions (non-breaking, additive):
- `defaultPage`: the page to land on after login
- `tablePageSize`: preferred rows-per-page in all tables
- `mapDefaultView`: last map center and zoom (premises map)
- `notificationToastDuration`: seconds to show toast notifications

---

### Where a tenant setting goes

Three places, and the rule for choosing between them is the thing worth
remembering (settled 2026-10-31):

> **A value every utility has goes in a column. A value only some have
> goes in jsonb.** And where "every utility has one" is arguable, the
> tiebreaker is mechanical: **a column if we filter on it in SQL, jsonb
> if we only read it once we already have the row.**

| Where | For | Cost of adding one |
|---|---|---|
| A column on `UtilityConfig` | tenant-wide, universal, sometimes filtered — `timezone`, `auto_post_bills` | a migration |
| A column on `SchedulerConfig` | something **every** configurable background job has — `enabled`, `run_hour_local` | a migration, and rare: those columns are what defines the set |
| `settings` jsonb (on either row) | anything only some utilities or some jobs need — `numberFormats`, `issuer` | nothing |

jsonb's real costs are *filtering* and *types*, never reading: pulling a
key off a row already in hand is free. So anything never used in a `WHERE`
is a fair candidate for jsonb.

The one case where the rule is not enough: a flag whose wrong default
reaches the outside world. `scheduler_config.enabled` for billing defaults
to false, and it is a column, because with jsonb a missing key is
indistinguishable from `false` only as long as every reader agrees — and
the day one reader defaults it to true, a utility that never asked for
automation bills its customers. A declared default in one place is the
mitigation; see "What is still unmanaged" below.

### UtilityConfig

Tenant-wide configuration flags that don't belong to the theme module. One row per utility, created lazily the first time any flag is set; absence of a row means "all defaults." Lives in its own table alongside UtilityTheme and UtilityModule so it can be extended without schema migrations via the `settings` JSONB bucket.

**It no longer holds per-scheduler settings.** Until 2026-10-31 it carried
three repeated groups of the same shape — an enable flag, a run hour and a
last-run timestamp, once per background job — which is a one-to-many
modelled as repeated column groups. Adding billing's group cost a
migration and seven files. Those nine columns are now rows in
`SchedulerConfig`.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Unique — one config per tenant (unique constraint) |
| require_hold_approval | BOOLEAN | Default false. When true, ServiceSuspensions require `service_suspensions.APPROVE` permission before activation. See spec 12 rule 14. |
| auto_post_bills | BOOLEAN | Default true. When false, a generated Bill waits for an explicit post. Overridable per account by the nullable `account.auto_post_bills`, where null inherits this value — so flipping this moves every account that has not opted out. |
| settings | JSONB | Bucket for small, additive tenant flags. Current shape documented below. |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique constraint:** `[utility_id]`

**RLS:** standard `utility_id = current_setting('app.current_utility_id')::uuid` policy.

#### settings JSONB Structure

```json
{
  "numberFormats": {
    "agreement": { "template": "SA-{YYYY}-{seq:4}", "startAt": 1 },
    "account":   { "template": "AC-{seq:5}",        "startAt": 1000 }
  },
  "branding": {
    "logoUrl": "https://cdn.example.com/logo.svg",
    "loginSplashUrl": "https://cdn.example.com/splash.jpg"
  },
  "notifications": {
    "senderEmail": "billing@example-utility.gov",
    "dailyDigestEnabled": false
  },
  "retention": {
    "auditRetentionDays": 2555,
    "softDeletePurgeDays": 90,
    "intervalReadRetentionDays": 1095,
    "attachmentRetentionYears": 10
  },
  "billing": {
    "saaslogicBaseUrl": "https://api-sandbox.saaslogic.io/v1",
    "sandbox": true,
    "pollMinutes": 5
  },
  "issuer": {
    "utilityName": "City of Bozeman Utilities",
    "remittanceAddressLine1": "PO Box 1230",
    "remittanceCity": "Bozeman",
    "remittanceState": "MT",
    "remittancePostalCode": "59771",
    "billingPhone": "406-582-2000"
  },
  "billDocuments": {
    "storageIntegration": "bill-pdfs",
    "storageConnection": ""
  }
}
```

The `numberFormats` key controls auto-generation of human-readable identifiers on create forms — see the Identifier Generation section below.

**Six** namespaces sit alongside the top-level keys, each with a typed `.strict()` Zod schema in `packages/shared/src/validators/tenant-settings.ts` and each patched through its own top-level field on `PATCH /api/v1/tenant-config`. The route shallow-merges each namespace so partial updates preserve unrelated keys, and individual field validators enforce bounds (e.g. `auditRetentionDays` must be between 365 and 3650). `.strict()` is load-bearing rather than tidy: a misspelled key is rejected at the API boundary instead of going quietly missing and surfacing much later as an unexplained render failure.

| Namespace | Schema | Edited at | Read by |
|---|---|---|---|
| `branding` | `brandingSettingsSchema` | `/settings/branding` | App chrome |
| `notifications` | `notificationSettingsSchema` | `/settings/notifications` | Notification send |
| `retention` | `retentionSettingsSchema` | `/settings/retention` | The purge and trim jobs |
| `billing` | `billingIntegrationSettingsSchema` | `/settings/billing` | Nothing yet — see the note below |
| `issuer` | `issuerSettingsSchema` | `/settings/bill-production` | The bill presentation loader; the platform console's tenant-readiness panel |
| `billDocuments` | `billDocumentSettingsSchema` | `/settings/bill-production` | The bill-document service, via apptor-connect's files plane |

The last two shipped with bill production and were undocumented here until 2026-10-21, which is why this section said "four". Two things about them are worth carrying:

- **`issuer` is a namespace rather than columns** because nothing queries a remittance address — it is edited in Settings and read by one loader. Five of its fields are required for a bill to be a valid document (`REQUIRED_ISSUER_FIELDS`: `utilityName`, `remittanceAddressLine1`, `remittanceCity`, `remittanceState`, `remittancePostalCode`), and the predicate for "set" travels with that list, because the settings page writes `""` for a cleared field and anything testing for mere key presence would call such a tenant complete while its bills refused to render.
- **`billDocuments` carries an integration name, not a location.** `storageIntegration` selects S3, Azure Blob or GCS on apptor-connect's side; no bucket, region or credential belongs here. This is the shape every integration setting should take.

> **The `billing` namespace is stale as of 2026-10-21 and is not yet fixed.** All three of its fields assume CIS dials SaaSLogic itself: a base URL to call, a sandbox flag, and a polling interval. SaaSLogic is now reached over apptor-connect's proxy plane (`docs/specs/21-saaslogic-billing.md` § Transport), where one integration name selects the instance — sandbox included — and the events plane replaces polling. The replacement is a single integration-name field, exactly as `billDocuments` above already does it. Nothing reads these three fields today, so the staleness costs an operator a page of questions with no effect rather than wrong behaviour. Changing it touches the schema, the route, `/settings/billing` and two integration tests, so it is build work and has not been done.

Additional keys can be added to the bucket for future tenant-level flags without schema changes.

---

### SchedulerConfig

What a tenant may configure about **one** background job. One row per
(utility, scheduler), added 2026-10-31.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | FK → `utility(id)` ON DELETE RESTRICT |
| scheduler_key | VARCHAR(50) | A `SchedulerKey` from `validators/automation-config.ts` |
| enabled | BOOLEAN | Default true. A missing row means the scheduler's declared default |
| run_hour_local | SMALLINT | Null where the job has no time of day — only `delinquency` and `billing` have one |
| last_run_at | TIMESTAMPTZ | Written by a dispatcher. Distinguishes a missed tick from one not yet due |
| settings | JSONB | Knobs only this job needs. No migration to add one |

**Unique constraint:** `[utility_id, scheduler_key]` — two rows for one
key would make "is billing enabled" a question with two answers.

**RLS:** standard one-argument policy. With no tenant set it raises rather
than returning nothing: "no rows" would read as "nothing is enabled", and
a dispatcher that believes that bills nobody and reports success.

**Keys are code; values are configuration.** Each key names a handler that
has to exist, so the set of keys lives in `SCHEDULER_DEFINITIONS` — one
entry per job carrying its label, help text, whether it has a run hour and
its default. A row whose key no build recognises is inert: nothing reads
it. There is deliberately **no `cron_pattern` column**; see
[27 — Job Scheduling](27-job-scheduling.md) §4 for why cadence stays in
code.

**A missing row means the declared default**, and that is load-bearing in
two directions:

- A scheduler added to `SCHEDULER_DEFINITIONS` appears for every existing
  tenant with no backfill, and its row materialises the first time anyone
  saves a setting.
- So **anything added from now on must default to disabled.** A new job
  defaulting to on would start doing work for every tenant the day it
  shipped. The three that default to true predate the table.
- And a cross-tenant read cannot filter on rows alone. `tenantsForScheduler`
  reads tenants and rows and joins in memory, because filtering would
  silently skip every tenant who never touched a setting — which for
  delinquency is all of them.

What this buys: **onboarding a utility is rows, not schema.** Adding a
scheduler is a list entry plus a handler. A knob only one scheduler needs
is a jsonb key and no migration at all.

### What is still unmanaged

`utility_setting(utility_id, name, value jsonb)` already exists — a
generic per-utility key-value store, with one consumer (the rate engine's
tenant loader). It is the storage half of a managed settings mechanism,
and it has none of the other halves: no declaration of what keys exist, no
label or help text, no control type, no validation, and no declared
default. So every key in it is hand-wired at both ends.

The smaller step, when the first one-off tenant knob arrives that is not
per-scheduler: give it the same treatment `SCHEDULER_DEFINITIONS` gave the
schedulers — one code-side declaration per key carrying label, type,
default and validation, with the settings page rendering from it. That
makes adding a knob a declaration plus one read at the point of behaviour,
and nothing else.

**What can never be configuration:** the behaviour itself. A knob that
nothing reads does nothing, so "don't bill under $5" needs code that
compares a total to a threshold however the value is stored. The target is
to make everything *except* that comparison free, not to pretend the
comparison can be declared away.

## Identifier Generation

Every tenant-visible identifier (`account_number`, `agreement_number`) is auto-generated by the backend when the caller omits it on create. The format is tenant-configurable via a template grammar stored in `utility_config.settings.numberFormats.{agreement|account}`.

**Supported tokens:**

| Token | Meaning | Example |
|---|---|---|
| `{YYYY}` | 4-digit year | `2026` |
| `{YY}` | 2-digit year | `26` |
| `{MM}` | 2-digit month | `04` |
| `{seq:N}` | Sequence, zero-padded to N digits | `{seq:4}` → `0042` |
| `{seq}` | Sequence, no padding | `42` |

Every template must contain exactly one `{seq}` or `{seq:N}` token. Zero or multiple sequence tokens are rejected at save time.

**Default templates** (used when the tenant hasn't configured anything):
- Agreement: `SA-{seq:4}` → `SA-0001`, `SA-0002`, ...
- Account: `AC-{seq:5}` → `AC-00001`, `AC-00002`, ...

**Parser / engine location:** `packages/shared/src/lib/number-template.ts` — pure functions `parseTemplate`, `format`, `previewTemplate`, `buildMatchPattern`, `nextSeq`. Consumed in two places so both always agree on behavior:
- API: `packages/api/src/lib/number-generator.ts` uses it to compute the next identifier on create.
- Web: the Numbering settings tab uses `previewTemplate` to render the live preview as the admin types.

**Generation algorithm:**
1. Read the tenant's template from `utility_config.settings.numberFormats[entity]` (fall back to the caller-supplied default).
2. Substitute the current date into the date tokens.
3. Build a POSIX regex from the literal parts with `\d+` standing in for the seq token (width-relaxed so legacy rows with a different padding still match).
4. Query the highest existing row matching that regex for this tenant. Parse the numeric tail. Take `max(startAt, existing + 1)`.
5. Format back into the template.
6. Retry the wrapped create up to 3 times on P2002 unique-constraint races.

**Implicit sequence reset:** because the regex is built from the current date on every call, including `{YYYY}` in the template automatically resets the counter every January 1 (new year prefix → no matching rows → restart from `startAt`). Including `{MM}` resets monthly. Templates with no date tokens never reset. No separate "reset policy" configuration is needed.

**Non-destructive format changes:** legacy rows keep their old identifiers forever because a new regex simply won't match them. New rows follow whatever template is current. Admins can change the prefix, padding, or date tokens at any time without touching existing data.

**Manual override:** CSRs can still type a custom identifier on any create form. The backend validates uniqueness per tenant but doesn't reject manual identifiers that don't match the current template.

**Wired into:**
- `POST /api/v1/service-agreements` (standard create)
- `POST /api/v1/accounts` (standard create)
- `POST /api/v1/workflows/move-in` (generates both account number and each agreement number when absent)
- `POST /api/v1/service-agreements/:id/transfer` (generates the target agreement number when absent)

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/theme` | Get the current tenant theme |
| PUT | `/api/v1/theme` | Create or replace the tenant theme |
| POST | `/api/v1/theme/reset` | Reset theme to default preset values |
| GET | `/api/v1/preferences` | Get current user's preferences |
| PUT | `/api/v1/preferences` | Create or replace current user's preferences |
| GET | `/api/v1/tenant-config` | Get tenant-wide config (`requireHoldApproval`, `settings.numberFormats`, `settings.branding`, `settings.notifications`, `settings.retention`, `settings.billing`, etc.). Authenticated — no module permission required so client pages can read it freely. |
| PATCH | `/api/v1/tenant-config` | Update tenant config. Gated by `settings.EDIT`. Accepts `requireHoldApproval`, `numberFormats`, a generic `settings` passthrough, and the four namespaced blocks (`branding`, `notifications`, `retention`, `billing`). Each namespace is validated by its Zod schema and shallow-merged into `settings.<namespace>` so partial updates preserve unrelated keys. |

### GET /api/v1/theme

Returns the UtilityTheme record for the authenticated tenant. If no record exists, returns the default preset (Midnight dark). Response always includes both dark and light color maps.

**Response example:**
```json
{
  "id": "...",
  "preset": "midnight",
  "colors": { "dark": {...}, "light": {...} },
  "typography": { "body": "...", "display": "..." },
  "border_radius": 8,
  "logo_url": "https://cdn.example.com/logos/utility-logo.png"
}
```

### PUT /api/v1/theme

Upserts the theme. Accepts partial updates — fields not included retain their current values. Validates that all provided CSS variable values are syntactically valid CSS values (no script injection).

### POST /api/v1/theme/reset

Resets all color values to the preset defaults for the specified `preset` name. Preserves `logo_url`. Body: `{ "preset": "midnight" | "daybreak" | "dusk" | "forest" }`.

## Business Rules

1. **One theme per tenant:** The unique constraint on `[utility_id]` enforces a single theme record per tenant. `PUT /api/v1/theme` is always an upsert — it creates if no record exists, updates if one does.

2. **Preset system:** Built-in presets provide sensible defaults for both dark and light modes. Selecting a preset overwrites the `colors` JSONB with the preset's values. After preset selection, individual colors can be further customized without changing the `preset` field.

3. **Built-in presets:**

   | Preset | Dark Mode Feel | Light Mode Feel |
   |--------|---------------|-----------------|
   | midnight | Deep navy + blue accent | White + blue accent |
   | daybreak | Warm dark + amber | Cream + amber |
   | dusk | Purple-tinted dark + violet | Soft gray + violet |
   | forest | Dark green + teal | White + teal |

4. **CSS variable application:** The frontend fetches the UtilityTheme on application load. Color values are applied as CSS custom properties on `<html data-theme="dark">` or `<html data-theme="light">`. All component styles reference these variables — no hardcoded color values exist in component code.

5. **User mode override:** UserPreference.theme_mode takes precedence over tenant defaults:
   - `SYSTEM` — reads `prefers-color-scheme` CSS media query; updates live when OS mode changes
   - `LIGHT` — forces light mode regardless of OS setting
   - `DARK` — forces dark mode regardless of OS setting

6. **Preference resolution order:**
   1. UserPreference.theme_mode (most specific)
   2. Tenant default theme mode (from UtilityTheme, if a default is set — future field)
   3. Browser `prefers-color-scheme` (fallback)

7. **Logo validation:** `logo_url` must be a valid HTTPS URL. Logos are not stored in CIS — they are hosted externally or in tenant-owned blob storage. Maximum URL length is 500 characters.

8. **Input sanitization:** CSS variable values are validated to reject any values that could be used for CSS injection (e.g., values containing `url()` with `javascript:`, or `expression()`). The validator allowlists standard CSS color formats: hex, rgb(), hsl(), named colors, and CSS variable references.

9. **Mapbox adaptation:** The admin UI map (premises module) adapts its basemap style based on the current theme mode: `mapbox://styles/mapbox/dark-v11` for dark mode, `mapbox://styles/mapbox/light-v11` for light mode. This is driven by the `data-theme` attribute change.

10. **Theme caching:** The UtilityTheme is cached in Redis with a TTL of 5 minutes (configurable). Theme updates via `PUT /api/v1/theme` invalidate the cache immediately. The Next.js frontend also caches the theme in React context for the session, re-fetching on theme save.

11. **preferences extensibility:** New keys added to `preferences` JSONB are backward compatible. Existing records without a new key use the application default for that key. No migration is required to add new preference keys.

12. **Administrator-only theme editing:** The theme editor UI and `PUT /api/v1/theme` are restricted to the ADMIN role. All users can read the theme (GET) and set their own mode preference (PUT /preferences).

## UI Pages

### Theme Editor (`/theme`) — Built

A live preview theme editor that lets administrators customize the utility's brand appearance.

**Layout:** Two-panel — controls on the left, live preview on the right.

**Controls:**
- **Preset selector:** Grid of 4 preset cards showing color swatches. Click to apply preset to all color values.
- **Dark/Light mode toggle:** Preview toggle to see changes in both modes without changing the user's actual preference.
- **Color pickers:** Per-variable color inputs for all CSS custom properties (grouped: Background, Text, Border, Accent, Status). Each picker shows: variable name, current value, color swatch, hex input.
- **Typography:** Font family selectors for body and display text (Google Fonts search).
- **Border radius:** Slider (0–20px) with live preview on sample components.
- **Logo upload:** URL input with preview. Link to external hosting documentation.

**Live preview:** Right panel shows a representative mock of the admin UI: sidebar with navigation items, a data table with badge examples, a form, status badges (success/warning/danger/info). Updates instantly on every color change.

**Save button:** Persists via `PUT /api/v1/theme`. Shows success toast. Emits `theme.updated` domain event (captured in AuditLog).

**Reset button:** Calls `POST /api/v1/theme/reset` with the currently selected preset. Prompts confirmation.

### User Preferences (Accessible from top bar) — Built

- Dark/Light/System toggle: three-button toggle in the top bar user menu
- Sidebar collapse state persists automatically without user action
- Future: additional preferences exposed in a settings drawer

### Admin navigation — what each section means

Defined in `packages/web/components/sidebar.tsx`. Each section answers one question, and that sentence decides what belongs in it:

| Section | Rule |
|---|---|
| Operations | The utility's business records, and the transactions on them. About customers and their service. |
| Configuration | Lists the business maintains. Many rows. |
| Settings | One value per tenant. One row. |
| Administration | The system itself: who may use it, and whether it is sound. About staff and the software. |

The first and last rules were originally written as "work somebody does" and "who may act, and whether the system is sound," which were too loose to decide anything — somebody reads the audit log too. What separates those two sections is the **subject**: customers and their service, versus staff and the software. That is also why one log sits in each — the delivery log answers "did my customer get their notice," the audit log answers "what did our staff do."

One entry straddles the line and is deliberately left straddling it: Operations → Notifications is a delivery log (Operations, by the rule) and a template list (Configuration, by the rule) on a single page. Splitting a working screen to satisfy a menu rule is the wrong trade.

Settings previously held 18 of the 44 entries and mixed all four kinds — single-value tenant config beside multi-row reference data (Custom Fields, Bill Messages, Service Request SLAs), beside access control, beside three things that are not settings at all. Applying the rules above moved five items and split one section, leaving 11 / 3 / 4 / 2 / 10 / 8 / 6 across Operations, Solid Waste, Billing, Collections, Configuration, Settings and Administration:

- **Imports** → Operations. A clerk loads reads or customers on a schedule; it is work, not configuration.
- **Custom Fields**, **Bill Messages**, **Service Request SLAs** → Configuration. Each is a list of rows.
- **Delinquency Rules** → Configuration, relabelled from "Rules", which was only readable while the Collections heading supplied its subject.
- **Administration** (new) → Users & Roles, API Keys & Webhooks, Retention & Audit, Audit Log, Ledger Integrity, Danger Zone.
- `/settings/notifications` relabelled **Notification Delivery**, because "Notifications" collided with Operations → Notifications, the send log. This page is the sender address, SMS provider and daily digest.

One gate did change afterwards: **Audit Log** moved from `audit_log` to `settings`, because that page reads the log unfiltered and an `audit_log`-only holder would have been shown a page that answers 403 — see spec 17. A section whose every entry is hidden now renders nothing at all, header included (`lib/nav-visibility.ts`), which Administration made reachable: the CSR and Field Technician presets hold no key in it.

Otherwise the reorganization deliberately left every `module` gate untouched, so it changes no one's access. Those gates remain inconsistent — `tenant_profile`, `settings` and `theme` are used across what now reads as three sections, and `/settings/ledger-integrity` is gated on `settings` while its endpoint is `accounts:VIEW` (on purpose — see the comment at its entry). Reconciling them is an API change, not a navigation change, and is still open.

### Settings (`/settings`) — Built

Consolidated tenant admin surface organized into tabs. The first four tabs are implemented today; new tabs can be added as tenant-level features grow.

- **General tab** (default landing tab) — tenant-wide on/off flags.
  - **Service Holds — Require approval before activation**: checkbox bound to `utility_config.require_hold_approval`. Explanatory copy describes the effect on the scheduler and manual activation. Save button is enabled only when the value has changed.
- **Users tab** — CIS user management (covered in spec 19).
- **Roles tab** — Role and permission management (covered in spec 19).
- **Numbering tab** — Identifier template configuration.
  - Two cards, one per configurable entity (Service Agreement, Account). Each card has a template input, a `startAt` number input, and a **live preview** rendered via the shared `previewTemplate` helper so admins see exactly what the next generated identifier will look like before saving. Invalid templates surface their parse error inline in red.
  - Token reference table below the cards documenting the full grammar.
  - "Reset to default" button per card.
  - Save button PATCHes `/api/v1/tenant-config` with a `numberFormats` payload; the backend validates every template via `parseTemplate` before persisting.

## Phase Roadmap

- **Phase 1 (Complete):**
  - UtilityTheme entity with full schema
  - UserPreference entity
  - `GET /api/v1/theme`, `PUT /api/v1/theme`, `POST /api/v1/theme/reset` endpoints
  - `GET /api/v1/preferences`, `PUT /api/v1/preferences` endpoints
  - Theme editor UI with preset selector, color pickers, typography, border radius, live preview
  - Dark/light/system mode toggle in top bar
  - Mapbox basemap adaptation
  - Redis theme caching with cache invalidation
  - CSS variable application system
  - AuditLog integration: `theme.updated` event

- **Phase 2 (Complete):**
  - UtilityConfig entity with `require_hold_approval` flag and extensible `settings` JSONB bucket
  - `GET /api/v1/tenant-config`, `PATCH /api/v1/tenant-config` endpoints
  - Number template engine in `@utility-cis/shared` (parser + formatter + regex builder + preview)
  - Backend identifier generator consuming the template engine, wired into every create and workflow path that produces an account or agreement number
  - Settings page refactored into tabs (General, Users, Roles, Numbering)
  - General tab with the hold approval toggle
  - Numbering tab with per-entity template inputs and live preview

- **Phase 2+ (Planned):**
  - Logo upload to CIS-managed blob storage (currently requires external URL)
  - Additional user preferences: default page, table page size, map default view
  - White-label login page with tenant logo and colors
  - Custom font hosting (currently limited to Google Fonts + system fonts)
  - Tenant-level default theme mode (admin sets a default that new users inherit)
  - Import/export theme configuration (JSON file) for theme sharing between environments

## Bozeman RFP Coverage

The Theme and Configuration module does not directly address Bozeman RFP functional requirements — it is internal utility staff tooling. However, it supports the broader goal of a configurable multi-tenant SaaS platform that each utility can brand as their own, reducing the need for custom development per deployment.

Indirectly relevant:
- **Multi-tenant architecture:** All 202 requirements assume a single system that can be configured per utility. The theme system is one component of this configurability.
- **Staff productivity:** A branded, comfortable UI environment supports adoption and reduces training friction for utility staff.
