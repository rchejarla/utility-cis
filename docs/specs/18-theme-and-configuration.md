# Theme and Configuration

**Module:** 18 — Theme and Configuration
**Status:** Built
**Entities:** TenantTheme, UserPreference, TenantConfig

## Overview

The Theme and Configuration module governs the visual identity and per-user display preferences for the Utility CIS admin UI. Each utility tenant can customize the application's color scheme, typography, logo, and border radius to match their organizational branding. Individual users can override the tenant theme with their preferred color mode (dark, light, or system default).

This module is foundational to the multi-tenant SaaS experience — each utility sees their own branded interface without code changes or deployments.

Primary users: utility administrators (for tenant theme setup), all admin UI users (for personal preferences).

## Entities

### TenantTheme

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

```json
{
  "dark": {
    "--color-bg-primary": "#0f1117",
    "--color-bg-secondary": "#1a1d27",
    "--color-bg-tertiary": "#242736",
    "--color-text-primary": "#e8eaf0",
    "--color-text-secondary": "#9197a8",
    "--color-text-muted": "#5c6375",
    "--color-border": "#2e3244",
    "--color-accent": "#4f8ef7",
    "--color-accent-hover": "#3d7af0",
    "--color-accent-muted": "#1a2d4f",
    "--color-success": "#34c97b",
    "--color-warning": "#f5a623",
    "--color-danger": "#e85050",
    "--color-info": "#4f8ef7"
  },
  "light": {
    "--color-bg-primary": "#ffffff",
    "--color-bg-secondary": "#f4f5f9",
    "--color-bg-tertiary": "#e9ebf0",
    "--color-text-primary": "#1a1d27",
    "--color-text-secondary": "#4a5068",
    "--color-text-muted": "#8892a4",
    "--color-border": "#d1d5e0",
    "--color-accent": "#2563eb",
    "--color-accent-hover": "#1d4ed8",
    "--color-accent-muted": "#dbeafe",
    "--color-success": "#16a34a",
    "--color-warning": "#d97706",
    "--color-danger": "#dc2626",
    "--color-info": "#2563eb"
  }
}
```

All values are valid CSS custom property values. The admin UI applies these to the `<html>` element at runtime.

#### typography JSONB Structure

```json
{
  "body": "'Inter', 'system-ui', sans-serif",
  "display": "'Inter', 'system-ui', sans-serif"
}
```

Font families must be available via the tenant's configured font source (Google Fonts or self-hosted).

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

### TenantConfig

Tenant-wide configuration flags that don't belong to the theme module. One row per utility, created lazily the first time any flag is set; absence of a row means "all defaults." Lives in its own table alongside TenantTheme and TenantModule so it can be extended without schema migrations via the `settings` JSONB bucket.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Unique — one config per tenant (unique constraint) |
| require_hold_approval | BOOLEAN | Default false. When true, ServiceSuspensions require `service_suspensions.APPROVE` permission before activation. See spec 12 rule 14. |
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
  }
}
```

The `numberFormats` key controls auto-generation of human-readable identifiers on create forms — see the Identifier Generation section below. Other keys can be added to this bucket for future tenant-level flags without schema changes.

---

## Identifier Generation

Every tenant-visible identifier (`account_number`, `agreement_number`) is auto-generated by the backend when the caller omits it on create. The format is tenant-configurable via a template grammar stored in `tenant_config.settings.numberFormats.{agreement|account}`.

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
1. Read the tenant's template from `tenant_config.settings.numberFormats[entity]` (fall back to the caller-supplied default).
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
| GET | `/api/v1/tenant-config` | Get tenant-wide config (`requireHoldApproval`, `settings.numberFormats`, etc.). Authenticated — no module permission required so client pages can read it freely. |
| PATCH | `/api/v1/tenant-config` | Update tenant config. Gated by `settings.EDIT`. Validates any `numberFormats` payload against the shared template parser at save time so an invalid template is rejected with a clean 400. |

### GET /api/v1/theme

Returns the TenantTheme record for the authenticated tenant. If no record exists, returns the default preset (Midnight dark). Response always includes both dark and light color maps.

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

4. **CSS variable application:** The frontend fetches the TenantTheme on application load. Color values are applied as CSS custom properties on `<html data-theme="dark">` or `<html data-theme="light">`. All component styles reference these variables — no hardcoded color values exist in component code.

5. **User mode override:** UserPreference.theme_mode takes precedence over tenant defaults:
   - `SYSTEM` — reads `prefers-color-scheme` CSS media query; updates live when OS mode changes
   - `LIGHT` — forces light mode regardless of OS setting
   - `DARK` — forces dark mode regardless of OS setting

6. **Preference resolution order:**
   1. UserPreference.theme_mode (most specific)
   2. Tenant default theme mode (from TenantTheme, if a default is set — future field)
   3. Browser `prefers-color-scheme` (fallback)

7. **Logo validation:** `logo_url` must be a valid HTTPS URL. Logos are not stored in CIS — they are hosted externally or in tenant-owned blob storage. Maximum URL length is 500 characters.

8. **Input sanitization:** CSS variable values are validated to reject any values that could be used for CSS injection (e.g., values containing `url()` with `javascript:`, or `expression()`). The validator allowlists standard CSS color formats: hex, rgb(), hsl(), named colors, and CSS variable references.

9. **Mapbox adaptation:** The admin UI map (premises module) adapts its basemap style based on the current theme mode: `mapbox://styles/mapbox/dark-v11` for dark mode, `mapbox://styles/mapbox/light-v11` for light mode. This is driven by the `data-theme` attribute change.

10. **Theme caching:** The TenantTheme is cached in Redis with a TTL of 5 minutes (configurable). Theme updates via `PUT /api/v1/theme` invalidate the cache immediately. The Next.js frontend also caches the theme in React context for the session, re-fetching on theme save.

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

### Settings (`/settings`) — Built

Consolidated tenant admin surface organized into tabs. The first four tabs are implemented today; new tabs can be added as tenant-level features grow.

- **General tab** (default landing tab) — tenant-wide on/off flags.
  - **Service Holds — Require approval before activation**: checkbox bound to `tenant_config.require_hold_approval`. Explanatory copy describes the effect on the scheduler and manual activation. Save button is enabled only when the value has changed.
- **Users tab** — CIS user management (covered in spec 19).
- **Roles tab** — Role and permission management (covered in spec 19).
- **Numbering tab** — Identifier template configuration.
  - Two cards, one per configurable entity (Service Agreement, Account). Each card has a template input, a `startAt` number input, and a **live preview** rendered via the shared `previewTemplate` helper so admins see exactly what the next generated identifier will look like before saving. Invalid templates surface their parse error inline in red.
  - Token reference table below the cards documenting the full grammar.
  - "Reset to default" button per card.
  - Save button PATCHes `/api/v1/tenant-config` with a `numberFormats` payload; the backend validates every template via `parseTemplate` before persisting.

## Phase Roadmap

- **Phase 1 (Complete):**
  - TenantTheme entity with full schema
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
  - TenantConfig entity with `require_hold_approval` flag and extensible `settings` JSONB bucket
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
