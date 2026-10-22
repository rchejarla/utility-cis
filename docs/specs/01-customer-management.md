# Customer Management

**Module:** 01 — Customer Management
**Status:** Built (Phase 1 + Phase 2)
**Entities:** Customer, Contact, BillingAddress

## Overview

The Customer Management module manages the people and organizations who receive utility service. A Customer is the top-level person or entity; an Account is the billing relationship; Contacts are additional people associated with an account (authorized users, emergency contacts, billing contacts); BillingAddresses allow bills to be sent to a different address than the service location.

**Who uses it:** Customer Service Representatives (CSRs) creating new service, transferring service, managing account holders, and looking up customers by name, phone, or email.

**Why it matters:** Customer is the root entity in the domain. Every Account, and therefore every ServiceAgreement and every bill, flows from a Customer record. Accurate customer data is required for compliance, billing, and communication.

## Entities

### Customer

The person or organization who receives utility service.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| customer_type | ENUM | `INDIVIDUAL`, `ORGANIZATION` |
| first_name | VARCHAR(100) | Required for INDIVIDUAL |
| last_name | VARCHAR(100) | Required for INDIVIDUAL |
| organization_name | VARCHAR(255) | Required for ORGANIZATION |
| email | VARCHAR(255) | Optional |
| phone | VARCHAR(20) | Optional |
| alt_phone | VARCHAR(20) | Optional |
| date_of_birth | DATE | Optional; for ID verification |
| drivers_license | VARCHAR(50) | Optional; for ID verification |
| tax_id | VARCHAR(50) | Optional; for organizations |
| status | ENUM | `ACTIVE`, `INACTIVE` |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** `[utility_id, last_name, first_name]`, `[utility_id, email]`, `[utility_id, phone]`

**Unique constraint:** None at the model level (duplicate detection is a Phase 3 feature).

### Contact

People associated with an account, with defined roles. A Contact may optionally link to a Customer record (e.g., a spouse who is also a system customer), or may simply be a standalone contact entry.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| account_id | UUID | FK → Account (required) |
| customer_id | UUID | Nullable FK → Customer |
| role | ENUM | `PRIMARY`, `BILLING`, `AUTHORIZED`, `EMERGENCY` |
| first_name | VARCHAR(100) | Required |
| last_name | VARCHAR(100) | Required |
| email | VARCHAR(255) | Optional |
| phone | VARCHAR(20) | Optional |
| is_primary | BOOLEAN | Default false |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Contact role definitions:**
- `PRIMARY` — Main account holder contact
- `BILLING` — Receives billing communications
- `AUTHORIZED` — Authorized to make account changes
- `EMERGENCY` — Contact for service emergencies only

### BillingAddress

Alternate bill-to address for an account. Supports international addresses. When present, bills are sent here instead of the service premise address.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| account_id | UUID | FK → Account (required) |
| address_line1 | VARCHAR(255) | Required |
| address_line2 | VARCHAR(255) | Optional |
| city | VARCHAR(100) | Required |
| state | VARCHAR(50) | Required |
| zip | VARCHAR(20) | Required |
| country | VARCHAR(2) | Default `"US"` (ISO 3166-1 alpha-2) |
| is_primary | BOOLEAN | Default true |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

## API Endpoints

All endpoints are live. Customer CRUD is at top-level routes; Contact and BillingAddress use flat routes filtered by `accountId`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/customers` | List customers (paginated, with search/filter) |
| POST | `/api/v1/customers` | Create a new customer |
| GET | `/api/v1/customers/:id` | Get customer by ID (includes accounts) |
| PATCH | `/api/v1/customers/:id` | Update customer fields |
| GET | `/api/v1/contacts` | List contacts (filter by `accountId`) |
| POST | `/api/v1/contacts` | Add a contact to an account |
| PATCH | `/api/v1/contacts/:id` | Update a contact |
| DELETE | `/api/v1/contacts/:id` | Remove a contact. Hard delete, audited — the `AuditLog` row carries the contact's full prior state in `before_state`, which is the only record of what was removed |
| GET | `/api/v1/billing-addresses` | List billing addresses (filter by `accountId`) |
| POST | `/api/v1/billing-addresses` | Add a billing address to an account |
| PATCH | `/api/v1/billing-addresses/:id` | Update a billing address |

**Query parameters for `GET /customers`:** `page`, `limit`, `sort`, `order`, `customerType`, `status`, `search`

**Common response shape:** `{ data: [...], meta: { total, page, limit, pages } }`

## Business Rules

### Customer Rules (BR-CU-001 – BR-CU-007)

- **BR-CU-001 — Customer type validation:** `INDIVIDUAL` requires `first_name` + `last_name`; `ORGANIZATION` requires `organization_name`. Enforced via Zod (`createCustomerSchema`). Error: `"Individual requires firstName+lastName; Organization requires organizationName"`
- **BR-CU-002 — Default status:** Status on creation is `ACTIVE`.
- **BR-CU-003 — Deactivation:** Deactivation sets `status = INACTIVE`; no hard deletes. A customer with active accounts cannot be deactivated (enforced at service layer).
- **BR-CU-004 — Immutable type:** `customer_type` cannot be changed after creation (`updateCustomerSchema` omits `customerType`). To reclassify, a new record must be created.
- **BR-CU-005 — Landlord/tenant:** `owner_id` on the Premise entity links a customer as property owner. SA-level landlord/tenant separation (`owner_account_id` vs `occupant_account_id`) is a Phase 2 feature.
- **BR-CU-006 — Duplicate detection:** Not implemented. Phase 3 will add a matching rules engine (name + DOB, email, phone, drivers_license).
- **BR-CU-007 — PII handling:** SSN and payment card data are never stored in CIS. `drivers_license`, `tax_id`, and `date_of_birth` are stored for ID verification only. All reads/writes are tenant-scoped via RLS.

### Contact Rules (BR-CT-001 – BR-CT-004)

- **BR-CT-001:** `account_id` is required; contacts belong to an account.
- **BR-CT-002:** `customer_id` is optional; a contact may or may not be a system customer record.
- **BR-CT-003:** Multiple contacts per account are allowed (no limit).
- **BR-CT-004:** `is_primary` should have at most one `true` per account (UI enforcement; no DB unique constraint).

### BillingAddress Rules (BR-BA-001 – BR-BA-005)

- **BR-BA-001:** `account_id` is required.
- **BR-BA-002:** `country` defaults to `"US"`. International addresses supported with ISO 3166-1 alpha-2 country codes.
- **BR-BA-003:** `is_primary` should have at most one `true` per account (UI enforcement).
- **BR-BA-004:** When a primary BillingAddress exists, bills are sent there instead of the premise address.
- **BR-BA-005:** BillingAddresses are not hard-deleted; remove via DELETE endpoint (soft removal tracked via audit log).

## UI Pages

| Page | Path | Features |
|------|------|----------|
| Customers List | `/customers` | Search bar (name, email, phone) with debounce; stat cards (total, by type, by status); filter by type/status; pagination; Create Customer button |
| Customer Detail | `/customers/:id` | Command center layout: hero header with name, type badge, status; 5 tabs: Overview (inline editable fields), Accounts (linked accounts + Add Account inline form), Premises (premises where customer is owner), Contacts, Attachments; Deactivate button with confirmation dialog |
| Customer Create | `/customers/new` | Form with customer type selector; conditional fields for INDIVIDUAL vs ORGANIZATION; HelpTooltip on type field referencing BR-CU-001 |
| Account Contacts | `/accounts/:id` (Contacts tab) | List contacts with role badges; inline Add Contact form; inline edit per contact; Delete contact with confirmation |
| Account Billing Addresses | `/accounts/:id` (Billing tab) | List billing addresses with primary badge; inline Add Billing Address form; inline edit; remove |

**There is no Bills tab on a customer**, and the absence is deliberate. A `Bill` belongs to an Account, so a customer-level bill list is not a thing this data model has — bills live at `/accounts/:id` → Bills, one click away through the Accounts tab. A sixth tab existed here until 2026-10-22 rendering `lib/mock-billing`: fabricated invoice numbers, premises, commodities and a **Balance due** stat, with nothing on the page saying so. That is worse than a missing screen, because an absent screen reads as absent while that one read as the customer's account. It was removed rather than wired up; the tab count above was `4` throughout its life, so it was never documented here at all.

## Phase Roadmap

- **Phase 1 (Complete):** Customer, Contact, and BillingAddress entities fully defined in schema and Zod validators. Customer → Account → Contact/BillingAddress relationships established.
- **Phase 2 (Built):** Customer CRUD API (GET/POST/PATCH `/api/v1/customers`, GET `/api/v1/customers/:id`). Contact CRUD API (GET/POST/PATCH/DELETE `/api/v1/contacts`). BillingAddress CRUD API (GET/POST/PATCH `/api/v1/billing-addresses`). Customer list page with search and stat cards. Customer detail command center with 4 tabs (Overview, Accounts, Premises, Contacts). Inline editing on all overview fields. Deactivate button with confirmation dialog. Add Account inline form on Accounts tab. Add/edit/delete contacts on Account detail Contacts tab. Add/edit billing addresses on Account detail Billing Addresses tab. SearchableSelect for owner/customer lookups. HelpTooltip on create form fields. Still planned for Phase 2: full-text customer search, landlord/tenant SA relationship, transfer of service workflow.
- **Phase 3+:** Duplicate detection matching rules engine. User-defined required fields on customer file (configurable custom fields). Delinquency status indicator on customer lookup. Communication preferences (opt-in/opt-out per channel). Communication history log per customer.

## Bozeman RFP Coverage

| Req | Requirement | Status |
|-----|-------------|--------|
| 9 | Multiple accounts per property | Covered — multiple ServiceAgreements per Premise |
| 10 | One account across multiple properties | Covered — Account → many ServiceAgreements → many Premises |
| 11 | User-defined required fields in customer file | Gap (Phase 3) |
| 12 | Multiple customer types | Covered — `customer_type` enum (INDIVIDUAL, ORGANIZATION) |
| 13 | Multiple contacts per account with roles | Covered — Contact entity with role enum |
| 14 | Landlord/tenant relationships | Gap (Phase 2) — `owner_id` on Premise exists; SA-level relationship planned |
| 15 | Transfer of service | Planned (Phase 2) |
| 16 | Duplicate customer detection | Gap (Phase 3) |
| 17 | Alternate bill-to addresses | Covered — BillingAddress entity |
| 18 | International billing addresses | Covered — `country` field with ISO 3166-1 alpha-2 |
| 19 | Deposits for certain account types | Covered — on Account entity (see Module 04) |
| 22 | Customer account status values | Covered — `status` enum |
| 24 | Customer search by any data field | Partial — search by name/email/phone planned for Phase 2 full-text search |
