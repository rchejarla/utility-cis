# Theme and Configuration

**Module:** 18 — Theme and Configuration
**Status:** Built
**Entities:** TenantTheme, UserPreference

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

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/theme` | Get the current tenant theme |
| PUT | `/api/v1/theme` | Create or replace the tenant theme |
| POST | `/api/v1/theme/reset` | Reset theme to default preset values |
| GET | `/api/v1/preferences` | Get current user's preferences |
| PUT | `/api/v1/preferences` | Create or replace current user's preferences |

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
