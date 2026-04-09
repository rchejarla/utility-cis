# Premise Management

**Module:** 02 — Premise Management
**Status:** Built (Phase 1)
**Entities:** Premise

## Overview

The Premise Management module manages physical service locations — the addresses where utility service is delivered. A Premise is permanent: it outlives any particular customer or account. When service changes hands (tenant moves out, new tenant moves in), the Premise record stays; only the ServiceAgreements attached to it change.

**Who uses it:** CSRs setting up new service locations, field operations staff managing service territory, GIS administrators maintaining geographic data.

**Why it matters:** Premise is the stable anchor of the utility domain. Meters are installed at premises. Service agreements link accounts to premises. Billing is calculated for consumption at a premise. Without accurate premise data, none of the downstream billing, metering, or operations can function correctly.

## Entities

### Premise

Physical address where utility service is delivered.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| owner_id | UUID | Nullable FK → Customer (property owner, not necessarily the account holder) |
| address_line1 | VARCHAR(255) | Required |
| address_line2 | VARCHAR(255) | Optional (unit, suite, etc.) |
| city | VARCHAR(100) | Required |
| state | CHAR(2) | Required; 2-letter state code |
| zip | VARCHAR(10) | Required; 5 or 9 digit |
| geo_lat | DECIMAL(9,6) | Optional; latitude for map view |
| geo_lng | DECIMAL(9,6) | Optional; longitude for map view |
| premise_type | ENUM | `RESIDENTIAL`, `COMMERCIAL`, `INDUSTRIAL`, `MUNICIPAL` |
| commodity_ids | UUID[] | Array of FK → Commodity (which commodities are served here) |
| service_territory_id | UUID | Optional; future use for territory management |
| municipality_code | VARCHAR(50) | Optional; jurisdiction code |
| status | ENUM | `ACTIVE`, `INACTIVE`, `CONDEMNED` |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Relationships:**
- `owner` → Customer (nullable; property owner, not account holder)
- `meters` → Meter[] (all meters installed at this premise)
- `serviceAgreements` → ServiceAgreement[] (all agreements at this premise)

## API Endpoints

All endpoints require JWT authentication with `utility_id` claim.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/premises` | List premises (paginated, filterable) |
| POST | `/api/v1/premises` | Create a new premise |
| GET | `/api/v1/premises/:id` | Get premise by ID (includes meters and agreements) |
| PATCH | `/api/v1/premises/:id` | Update premise fields |
| GET | `/api/v1/premises/geo` | GeoJSON FeatureCollection for map view |

**Query parameters for `GET /premises`:**

| Parameter | Type | Description |
|-----------|------|-------------|
| page | integer | Default 1 |
| limit | integer | Default 20, max 500 |
| sort | string | Default `createdAt` |
| order | `asc` \| `desc` | Default `desc` |
| status | PremiseStatus | Filter by status |
| premiseType | PremiseType | Filter by type |
| serviceTerritoryId | UUID | Filter by territory |

**`GET /api/v1/premises/geo` response:** GeoJSON FeatureCollection where each Feature contains the premise's coordinates as a Point geometry and key fields (id, address, premiseType, status) as properties. Used by the Mapbox map view with Supercluster for client-side clustering.

**Create request body:**

| Field | Required | Validation |
|-------|----------|------------|
| addressLine1 | Yes | min 1, max 255 chars |
| addressLine2 | No | max 255 chars |
| city | Yes | min 1, max 100 chars |
| state | Yes | exactly 2 chars |
| zip | Yes | min 5, max 10 chars |
| geoLat | No | -90 to 90 |
| geoLng | No | -180 to 180 |
| premiseType | Yes | RESIDENTIAL, COMMERCIAL, INDUSTRIAL, MUNICIPAL |
| commodityIds | Yes | Array of UUIDs, min 1 |
| serviceTerritoryId | No | UUID |
| municipalityCode | No | max 50 chars |
| status | No | Default ACTIVE |

## Business Rules

### Premise is Permanent

Premises are never deleted. When a property is demolished or taken out of service, set `status = CONDEMNED` or `status = INACTIVE`. Condemned premises cannot have new service agreements created on them.

### Commodity Assignments

`commodity_ids` is a UUID array that defines which utility commodities are served at this location. For example, a residential premise might have `[water_id, sewer_id]`; a commercial premise might also include `[electric_id]`.

When a Meter is installed at a premise, the meter's `commodity_id` must exist in the premise's `commodity_ids` array. This is the **meter-premise commodity match** rule enforced at the service layer.

### Address Validation

- `state` must be exactly 2 characters (state code)
- `zip` must be 5–10 characters
- `addressLine1` is required (non-empty)
- GeoJSON coordinates: lat in `[-90, 90]`, lng in `[-180, 180]`

### Owner vs Account Holder

The `owner_id` field links a premise to the Customer who owns the property (the landlord). This is distinct from the Account holder (the tenant or service recipient). A premise may have no owner recorded (`owner_id` is nullable). Landlord billing features (charging the owner for specific services) are a Phase 2 feature.

### Soft Delete Only

`status` transitions:
- `ACTIVE` → `INACTIVE` (temporarily out of service)
- `ACTIVE` → `CONDEMNED` (property demolished or condemned)
- No status can transition backwards

### Map View

Premises with `geo_lat` and `geo_lng` populated appear on the Mapbox GL JS map. Supercluster handles client-side clustering. Map points are color-coded by `premise_type`. Popups show address, type, status, and a link to the premise detail page.

### Service Territory

`service_territory_id` is stored but not yet enforced. Phase 2 will add a ServiceTerritory entity and rules that restrict which rate schedules are available based on territory.

### Address History

Phase 1 stores only the current address. Phase 2 (Bozeman Req 4) will add an `AddressHistory` entity to preserve GIS-sourced address changes over time.

## UI Pages

| Page | Path | Features |
|------|------|----------|
| Premises List | `/premises` | Table view with search; map toggle; stats bar (total, by type, by status); filter by type and status |
| Premises Map | `/premises` (map view) | Mapbox GL JS full-screen map; Supercluster clustering; popups on click; filter by premise type; adapts to dark/light theme |
| Premise Detail | `/premises/:id` | Tabs: Overview (all fields), Meters (meters installed here), Agreements (service agreements at this address) |
| Premise Create | `/premises/new` | Form with address fields, type selector, commodity multi-select, optional geo coordinates |

**Stats bar (list view):** Shows total count, counts by type (Residential / Commercial / Industrial / Municipal), and counts by status (Active / Inactive / Condemned).

## Phase Roadmap

- **Phase 1:** Full Premise CRUD, geo coordinates storage, map view with Supercluster clustering, commodity_ids array, owner_id relationship, GeoJSON endpoint.
- **Phase 2:** GIS integration as authoritative source (Bozeman Req 1-7). Parcel ID and GIS premise ID fields. Address history table. GIS sync schedules (real-time and batch). GIS-to-rate mapping rules. ServiceTerritory entity with eligibility rules. RBAC for GIS field overrides. Full-text address search. Container/cart management for solid waste (linked to premise).
- **Phase 3+:** Special assessment district assignment at premise level. Parcel-based assessments (Phase 5).

## Bozeman RFP Coverage

| Req | Requirement | Status |
|-----|-------------|--------|
| 1 | GIS as authoritative system of record for premises | Gap (Phase 2) — geo lat/lng stored; full GIS sync not built |
| 2 | Configurable GIS sync schedules | Gap (Phase 2) |
| 3 | Store GIS-origin IDs (Parcel ID, Premise ID) | Partial (Phase 2) — `id` exists; parcel_id and gis_premise_id not yet added |
| 4 | Display GIS-sourced addresses, preserve address history | Gap (Phase 2) — current address stored; history table not built |
| 5 | Effective-dated account-to-property relationships | Covered — ServiceAgreement has `start_date`/`end_date` |
| 6 | GIS attributes determine default rates and service availability | Gap (Phase 2) |
| 7 | Restrict manual GIS overrides to authorized users with audit | Partial — AuditLog exists; RBAC for GIS fields planned Phase 2 |
| 8 | Multiple service types at locations | Covered — `commodity_ids` array |
| 9 | Multiple accounts per property | Covered — multiple ServiceAgreements per Premise |
| 25 | Historical GIS property records | Gap (Phase 2) |
| 42 | GIS-based solid waste eligibility | Gap (Phase 2) |
| 43 | Multiple waste service types per property | Covered — multiple ServiceAgreements per Premise |
