# Meter Management

**Module:** 03 — Meter Management
**Status:** Built (Phase 1)
**Entities:** Meter, MeterRegister

## Overview

The Meter Management module tracks the physical devices that measure utility consumption at a premise. Meters are durable assets: they are installed, read, and eventually removed or replaced, but they persist across customer and account changes. A meter's reading history stays with it regardless of who the account holder is.

MeterRegister supports multi-register (multi-channel) meters, such as AMI electric meters that simultaneously record on-peak and off-peak kilowatt-hours, or water meters with both flow and pressure channels.

**Who uses it:** Field operations staff installing and removing meters, CSRs looking up meter details when handling service calls, billing staff confirming meter-to-agreement assignments.

**Why it matters:** The meter is the physical foundation of consumption billing. Without accurate meter records — correct multiplier, UOM, install date, status — calculated consumption and resulting bills will be wrong. Meter-to-agreement linkage determines which reads feed which billing calculations.

## Entities

### Meter

Physical device measuring utility consumption at a specific premise.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| premise_id | UUID | FK → Premise (required; where this meter is installed) |
| meter_number | VARCHAR(100) | Unique per utility; the physical serial/asset number |
| commodity_id | UUID | FK → Commodity (what this meter measures) |
| meter_type | ENUM | `AMR`, `AMI`, `MANUAL`, `SMART` |
| uom_id | UUID | FK → UnitOfMeasure (the unit for raw dial readings) |
| dial_count | INTEGER | Optional; number of dials on the physical meter |
| multiplier | DECIMAL(10,4) | Default 1.0; applied to raw readings to get billed consumption |
| install_date | DATE | Required; date meter was placed in service |
| removal_date | DATE | Optional; null = currently installed |
| status | ENUM | `ACTIVE`, `REMOVED`, `DEFECTIVE`, `PENDING_INSTALL` |
| notes | TEXT | Optional free-text notes |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique constraint:** `[utility_id, meter_number]` — meter numbers are unique within a utility.

**Relationships:**
- `premise` → Premise (the location where this meter is installed)
- `commodity` → Commodity (what the meter measures)
- `uom` → UnitOfMeasure (unit for raw readings)
- `registers` → MeterRegister[] (one or more channels on this meter)
- `serviceAgreementMeters` → ServiceAgreementMeter[] (current and historical agreement assignments)
- `meterReads` → MeterRead[] (all readings from this meter)

**Meter type definitions:**
- `AMR` — Automatic Meter Reading (one-way communication, drive-by reads)
- `AMI` — Advanced Metering Infrastructure (two-way communication, smart grid)
- `MANUAL` — Field staff manually record the dial reading
- `SMART` — Smart meter with interval data capability (used interchangeably with AMI in some contexts)

### MeterRegister

A channel or register on a physical meter. Single-register meters have one MeterRegister; multi-register meters (AMI electric, irrigation with flow+pressure) have more.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| meter_id | UUID | FK → Meter (required) |
| register_number | INTEGER | Position on the meter (1, 2, 3...) |
| description | VARCHAR(100) | Optional; e.g., "High Flow", "On-Peak kWh", "Off-Peak kWh" |
| uom_id | UUID | FK → UnitOfMeasure (may differ from the parent meter's UOM) |
| multiplier | DECIMAL(10,4) | Default 1.0; register-level multiplier |
| is_active | BOOLEAN | Default true |
| created_at | TIMESTAMPTZ | |

**Unique constraint:** `[meter_id, register_number]` — register numbers are unique per meter.

**Relationships:**
- `meter` → Meter
- `uom` → UnitOfMeasure
- `meterReads` → MeterRead[] (reads tied to this specific register)

## API Endpoints

All endpoints require JWT authentication with `utility_id` claim.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/meters` | List meters (paginated, filterable) |
| POST | `/api/v1/meters` | Create (commission) a new meter |
| GET | `/api/v1/meters/:id` | Get meter by ID (includes registers and agreements) |
| PATCH | `/api/v1/meters/:id` | Update meter fields |

**Query parameters for `GET /meters`:**

| Parameter | Type | Description |
|-----------|------|-------------|
| page | integer | Default 1 |
| limit | integer | Default 20, max 500 |
| sort | string | Default `createdAt` |
| order | `asc` \| `desc` | Default `desc` |
| status | MeterStatus | Filter by status |
| meterType | MeterType | Filter by type |
| premiseId | UUID | Filter to meters at a specific premise |
| commodityId | UUID | Filter by commodity |

**Create request body:**

| Field | Required | Validation |
|-------|----------|------------|
| premiseId | Yes | UUID |
| meterNumber | Yes | min 1, max 100 chars |
| commodityId | Yes | UUID |
| meterType | Yes | AMR, AMI, MANUAL, SMART |
| uomId | Yes | UUID |
| dialCount | No | positive integer |
| multiplier | No | positive number, default 1.0 |
| installDate | Yes | ISO date string |
| status | No | Default ACTIVE |
| notes | No | free text |

**Update restrictions:** `premiseId` and `meterNumber` cannot be changed via PATCH (`updateMeterSchema` omits both). To move a meter to a different premise, remove it from the current premise (set `removal_date`, `status = REMOVED`) and commission a new meter record at the new premise.

## Business Rules

### Meter-Premise Commodity Match

When a meter is assigned to a ServiceAgreement via ServiceAgreementMeter, the meter's `commodity_id` must exist in the premise's `commodity_ids` array. This prevents assigning a gas meter to an electric service agreement. Enforced in the service layer at agreement creation time.

### Meter Uniqueness

`meter_number` is unique per utility. Attempting to create a meter with a duplicate number returns a conflict error.

### Meter Assignment Uniqueness

A meter can only be in one active ServiceAgreement per commodity at a time. This is enforced inside a `$transaction` at agreement creation: if the proposed meter is already linked to an active agreement for the same commodity, the transaction rolls back with a conflict error.

### Status Lifecycle

```
PENDING_INSTALL → ACTIVE → REMOVED
                         → DEFECTIVE → REMOVED
```

- `PENDING_INSTALL` — meter is in inventory, not yet installed
- `ACTIVE` — meter is installed and in service
- `DEFECTIVE` — meter has failed or been flagged; still physically present
- `REMOVED` — meter has been pulled from the premise

Status transitions go forward only. A `REMOVED` meter cannot be re-activated (commission a new meter record instead).

### Multiplier

The `multiplier` field scales raw dial readings to billing consumption. For example, a meter with a multiplier of 100 converts a reading difference of 1.5 dials into 150 gallons (or whatever the UOM specifies). Default is 1.0 for most residential meters.

MeterRegisters also have their own `multiplier` for register-level scaling.

### Removal Date

Setting `removal_date` to a non-null date signals the meter has been removed. Any active ServiceAgreementMeter entries for this meter should be closed simultaneously (set `removed_date` on the junction record).

### Multi-Register Meters

When a meter has multiple registers, each MeterRead must specify which register it belongs to via the nullable `register_id` FK. A single physical meter reading event may produce multiple MeterRead records (one per register). Billing calculations sum or select registers per the rate schedule configuration.

### Inventory Management

Phase 1 tracks meters as either installed at a premise or removed. Full inventory lifecycle (warehouse location, check-out/check-in, manufacturer, model, size, testing records) is a Phase 2 enhancement (Bozeman Reqs 106-123).

## UI Pages

| Page | Path | Features |
|------|------|----------|
| Meters List | `/meters` | Table with meter number, premise address, commodity, type, status; filter by commodity and status |
| Meter Detail | `/meters/:id` | Tabs: Overview (inline editable fields + registers), Agreements (current and historical service agreement assignments); Remove Meter button with confirmation dialog; DatePicker for install date field |
| Meters at Premise | `/premises/:id` (Meters tab) | List of meters installed at a given premise; Add Meter inline form (commodity pre-filtered to premise commodities, multiplier behind Advanced toggle, DatePicker for install date) |

## Phase Roadmap

- **Phase 1 (Complete):** Full Meter CRUD, MeterRegister entity, meter-premise and meter-commodity relationships, meter assignment uniqueness constraint, status lifecycle, UI with filters.
- **Phase 2 (Built):** Meter detail inline editing. Remove Meter button with confirmation dialog. DatePicker component for install date on meter create and detail. Add Meter inline form on Premise detail Meters tab (commodity-filtered, multiplier behind Advanced toggle). Still planned for Phase 2: MeterRead CRUD, meter events entity, inventory enhancements, MeterTest entity, split-read handling, exception thresholds.
- **Phase 3+:** Meter events triggering billing holds and notifications via ApptorFlow. Read freeze after billing. Rollover handling for dial wrap-around. Backflow/reverse flow consumption rules.
- **Phase 3+:** Meter events triggering billing holds and notifications via ApptorFlow. Read freeze after billing. Rollover handling for dial wrap-around. Backflow/reverse flow consumption rules.

## Bozeman RFP Coverage

| Req | Requirement | Status |
|-----|-------------|--------|
| 65 | Meter multiplier/scaling factors | Covered — `Meter.multiplier` and `MeterRegister.multiplier` |
| 75-76 | Meter reading system as authoritative, API integration | Planned (Phase 2) — MeterRead CRUD |
| 78 | Read cycle scheduling, route grouping | Covered — `BillingCycle` + `ServiceAgreement.readSequence` |
| 80 | Associate reads to meters | Covered — `MeterRead.meterId` FK |
| 81 | Multi-register meter handling | Covered — MeterRegister entity |
| 82 | Label estimated vs actual reads | Covered — `MeterRead.readType` enum |
| 83 | Retain raw interval data | Covered — TimescaleDB hypertable |
| 84 | Meter events (leaks, tamper, reverse flow) | Gap (Phase 2) — MeterEvent entity planned |
| 87 | Before/after for corrected reads | Covered — `readType = CORRECTED` + AuditLog |
| 88 | Audit trail for reads | Covered — AuditLog entity |
| 90 | New/replacement meters attached any time | Covered — ServiceAgreementMeter with `addedDate`/`removedDate` |
| 91 | Replaced meters mid-cycle, both reads total to usage | Gap (Phase 2) — split-read calculation needed |
| 106-107 | Sync with meter management system, bulk imports | Gap (Phase 2) |
| 108-109 | Meter inventory tracking, asset registry | Partial — Meter entity exists; location tracking planned Phase 2 |
| 110 | Chain-of-custody history | Gap (Phase 2) |
| 111 | Effective-dated meter/property/account associations | Covered — ServiceAgreementMeter with dates |
| 112 | Master/sub-meter, multi-register | Covered — MeterRegister; parent_meter_id planned Phase 2 |
| 113 | Multiple meter types (temp, construction, irrigation) | Partial — MeterType enum may need additional values |
| 114 | Manufacturer, model, size, serial | Partial — `meterNumber` exists; manufacturer/model/size planned Phase 2 |
| 115 | Inventory location tracking | Gap (Phase 2) |
| 116 | Install/removal/change-out events with read continuity | Covered — Meter status + ServiceAgreementMeter dates |
| 117 | Meter rollovers and register changes | Gap (Phase 2) |
| 118 | Meter testing, certification, failure status | Gap (Phase 2) — MeterTest entity planned |
| 123 | Meter location in multi-unit buildings | Gap (Phase 2) |
