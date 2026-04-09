# Commodities & Units of Measure

**Module:** 06 — Commodities & Units of Measure
**Status:** Built (Phase 1)
**Entities:** Commodity, UnitOfMeasure

## Overview

The Commodities & Units of Measure module defines the configurable foundation for what utility services exist and how they are measured. Rather than hardcoding commodity types (WATER, ELECTRIC, GAS) as an enum, the system treats commodities as tenant-configurable data records. A utility that serves water, sewer, and stormwater configures those three commodities. A multi-utility serving all six services (water, electric, gas, sewer, solid waste, stormwater) configures six.

Units of Measure (UOM) are similarly configurable and tied to a specific commodity. Water might be measured in gallons (GAL), centum cubic feet (CCF), or cubic meters (M3). Each UOM has a conversion factor relative to the commodity's base unit, enabling reporting and rate calculations across different measurement systems.

**Who uses it:** System administrators and utility managers configuring the system at initial setup and when adding new service types. Not a day-to-day workflow for CSRs.

**Why it matters:** Commodities are referenced by Premises (which commodities are served here), Meters (what this device measures), ServiceAgreements (the commodity being billed), and RateSchedules (the pricing for a commodity). Every downstream entity depends on these reference records being correctly configured.

## Entities

### Commodity

Configurable utility service type. One record per commodity per tenant. No hardcoded enum — adding a new commodity type is a data operation, not a code change.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| code | VARCHAR(50) | Short identifier; auto-uppercased; e.g., `"WATER"`, `"ELECTRIC"`, `"GAS"`, `"SEWER"`, `"STORMWATER"`, `"SOLID_WASTE"` |
| name | VARCHAR(100) | Human-readable display name; e.g., `"Potable Water"`, `"Natural Gas"` |
| default_uom_id | UUID | Nullable FK → UnitOfMeasure (the UOM used by default for meters and reads on this commodity) |
| is_active | BOOLEAN | Default true; inactive commodities are hidden from dropdowns and blocked from new assignments |
| display_order | INTEGER | Default 0; controls sort order in UI lists and dropdowns |
| created_at | TIMESTAMPTZ | |

**Unique constraint:** `[utility_id, code]` — commodity codes are unique within a utility.

**Relationships:**
- `defaultUom` → UnitOfMeasure (nullable; the default measurement unit for this commodity)
- `unitsOfMeasure` → UnitOfMeasure[] (all UOMs defined for this commodity)
- `meters` → Meter[] (meters measuring this commodity)
- `serviceAgreements` → ServiceAgreement[] (agreements billing this commodity)
- `rateSchedules` → RateSchedule[] (pricing rules for this commodity)

### UnitOfMeasure

A measurement unit for a specific commodity. Each commodity may have multiple UOMs (e.g., water could have GAL, CCF, M3). One UOM per commodity is designated as the base unit.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| code | VARCHAR(20) | Short identifier; auto-uppercased; e.g., `"GAL"`, `"CCF"`, `"KWH"`, `"MCF"` |
| name | VARCHAR(100) | Human-readable name; e.g., `"Gallons"`, `"Centum Cubic Feet"`, `"Kilowatt Hours"` |
| commodity_id | UUID | FK → Commodity (required; which commodity this UOM belongs to) |
| conversion_factor | DECIMAL(15,8) | Factor to convert this UOM to the base unit; base unit has conversion_factor = 1.0 |
| is_base_unit | BOOLEAN | True for exactly one UOM per commodity per utility |
| is_active | BOOLEAN | Inactive UOMs are hidden from dropdowns |
| created_at | TIMESTAMPTZ | |

**Unique constraint:** `[utility_id, commodity_id, code]` — UOM codes are unique within a commodity within a utility.

**Relationships:**
- `commodity` → Commodity
- `meters` → Meter[] (meters using this UOM for raw readings)
- `meterRegisters` → MeterRegister[] (registers using this UOM)

**Conversion factor examples:**

| Commodity | UOM Code | Conversion Factor | Is Base Unit |
|-----------|----------|-------------------|--------------|
| Water | GAL | 1.0 | Yes |
| Water | CCF | 748.052 | No |
| Water | M3 | 264.172 | No |
| Electric | KWH | 1.0 | Yes |
| Electric | MWH | 1000.0 | No |
| Gas | MCF | 1.0 | Yes |
| Gas | CCF | 0.1 | No |
| Gas | THERM | 1.02 | No |

## API Endpoints

All endpoints require JWT authentication with `utility_id` claim.

### Commodity Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/commodities` | List all commodities for the utility (no pagination — typically < 10 records) |
| POST | `/api/v1/commodities` | Create a new commodity |
| PATCH | `/api/v1/commodities/:id` | Update commodity fields |

**Create commodity request body:**

| Field | Required | Validation |
|-------|----------|------------|
| code | Yes | min 1, max 50 chars; auto-uppercased |
| name | Yes | min 1, max 100 chars |
| defaultUomId | No | UUID |
| isActive | No | boolean, default true |
| displayOrder | No | integer, default 0 |

**Note:** No DELETE endpoint. Deactivation via `isActive = false` is the supported pattern.

### UOM Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/uom` | List UOMs, optionally filtered by commodityId |
| POST | `/api/v1/uom` | Create a new UOM |
| PATCH | `/api/v1/uom/:id` | Update UOM fields |
| DELETE | `/api/v1/uom/:id` | Delete a UOM (BR-UO-005 and BR-UO-006 guards apply) |

**Query parameter for `GET /uom`:**

| Parameter | Type | Description |
|-----------|------|-------------|
| commodityId | UUID | Optional; filter to UOMs for a specific commodity |

**Create UOM request body:**

| Field | Required | Validation |
|-------|----------|------------|
| code | Yes | min 1, max 20 chars; auto-uppercased |
| name | Yes | min 1, max 100 chars |
| commodityId | Yes | UUID |
| conversionFactor | Yes | positive number |
| isBaseUnit | No | boolean, default false |
| isActive | No | boolean, default true |

**Note:** The `GET /uom` endpoint supports an optional `commodityId` query parameter to retrieve only the UOMs for a specific commodity. This is used by forms when selecting a UOM for a meter or register.

## Business Rules

### Code Auto-Uppercasing

Both `Commodity.code` and `UnitOfMeasure.code` are automatically uppercased by the Zod validator using `.transform((v) => v.toUpperCase())`. Input `"water"` becomes `"WATER"` in storage.

### Uniqueness

- Commodity `code` is unique per utility (`[utility_id, code]`)
- UOM `code` is unique per commodity per utility (`[utility_id, commodity_id, code]`)

Attempting to create a duplicate code returns a conflict error.

### Base Unit

Exactly one UOM per commodity must be designated `is_base_unit = true`. The base unit has `conversion_factor = 1.0`. All other UOMs for that commodity express their conversion relative to this base.

Setting `isBaseUnit = true` on a UOM (via POST or PATCH) automatically unmarks any existing base unit for that commodity. This is enforced at the API service layer (BR-UO-003). The UI conversion factor label dynamically shows the base unit code to provide context (e.g., "1 unit = ? GAL").

### Conversion Factor

`conversion_factor` converts from this UOM to the base unit:

```
base_quantity = raw_quantity * conversion_factor
```

Example: A reading in CCF with `conversion_factor = 748.052` (gallons per CCF) converts to gallons for reporting when GAL is the base unit.

### Deactivation vs Deletion

No DELETE endpoint exists for Commodity. Setting `is_active = false` on a Commodity:
- Hides it from all selection dropdowns in the UI
- Does not remove it from existing records (meters, agreements) that reference it
- Existing meters with `commodity_id` pointing to an inactive commodity continue to function

To fully retire a commodity, it must first have no active meters or agreements referencing it (enforcement planned as a Phase 2 guard).

UOM records support hard delete via `DELETE /api/v1/uom/:id`, subject to two guards (BR-UO-005, BR-UO-006):
1. Cannot delete a UOM referenced by any meter (`uom_id` FK on Meter or MeterRegister) — returns a conflict error.
2. Cannot delete a UOM that is set as a commodity's `default_uom_id` — returns `UOM_IS_DEFAULT` error.

The delete action is accessible from the Commodities & UOM admin page with a confirmation dialog that warns about the BR-UO-005 constraint.

### Default UOM

`Commodity.default_uom_id` sets the UOM that is pre-selected when creating a new meter for this commodity. It is advisory only; the user can select any active UOM for that commodity.

### Display Order

`Commodity.display_order` controls the sort order in the UI's commodity dropdown and the Commodities & UOM admin page. Lower numbers appear first. This allows utilities to surface their most common commodity (e.g., water) at the top.

### Commodity Code Conventions

Suggested codes by commodity type (not enforced by the system):

| Service | Suggested Code |
|---------|---------------|
| Potable water | `WATER` |
| Wastewater / sewer | `SEWER` |
| Electric | `ELECTRIC` |
| Natural gas | `GAS` |
| Solid waste / trash | `SOLID_WASTE` |
| Stormwater | `STORMWATER` |
| Irrigation | `IRRIGATION` |

## UI Pages

| Page | Path | Features |
|------|------|----------|
| Commodities & UOM | `/commodities` | Single page: commodity list at top with inline edit; UOM table per commodity below; add/deactivate actions; display order drag-and-drop (planned) |

**Commodities section:** Displays code, name, default UOM (resolved to name, not UUID), active status, display order. Inline edit allows toggling `is_active` and adjusting `display_order` without navigating away. Add Commodity button is in the PageHeader (not inline).

**UOM section (per commodity):** Displays code, name, conversion factor (label shows base unit code, e.g., "1 unit = ? GAL"), base unit indicator, active status. Allows adding new UOMs, inline editing existing UOMs, and deleting UOMs with a confirmation dialog (BR-UO-005 warning). Commodities view shows UOM names instead of raw UUIDs.

## Phase Roadmap

- **Phase 1:** Full Commodity and UOM CRUD (GET list, POST create, PATCH update), code auto-uppercasing, unique constraints, default UOM relationship, display order, is_active flags, inline edit UI on `/commodities` page.
- **Phase 2 (Built):** UOM DELETE endpoint with BR-UO-005 (meter reference guard) and BR-UO-006 (commodity default guard). BR-UO-003 auto-enforcement: setting isBaseUnit=true automatically unmarks any existing base unit for that commodity. UOM inline edit on Commodities page. Conversion factor label shows base unit code dynamically. Commodities view resolves UOM names instead of raw UUIDs. Add Commodity button moved to PageHeader. Still planned for Phase 2: Guard against deactivating a commodity with active meters/agreements. Commodity categories or groupings.
- **Phase 3+:** Rate-to-commodity-to-UOM validation when running billing calculations. Cross-commodity conversion reporting (e.g., water consumption in both GAL and CCF on the same bill). Stormwater commodity with impervious surface area UOM (sq ft, acres).

## Bozeman RFP Coverage

| Req | Requirement | Status |
|-----|-------------|--------|
| 8 | Multiple service types at locations | Covered — `Premise.commodity_ids` array references multiple Commodity records |
| 43 | Multiple waste service types per property | Covered — multiple ServiceAgreements per Premise, each with its own commodity |
| 60 | Separate water, wastewater, stormwater services | Partial — WATER and SEWER commodities typically configured; STORMWATER is a data addition, not code change |
| 65 | Meter multiplier/scaling factors | Covered — Meter.multiplier (see Module 03); UOM conversion_factor provides unit-level scaling |
| 66 | Multiple water rate structures | Covered — multiple RateSchedule records per commodity (see Module 07) |
| 58 | Future-dated rate/policy changes | Covered — RateSchedule.effectiveDate (see Module 07); commodity and UOM records are stable reference data |
