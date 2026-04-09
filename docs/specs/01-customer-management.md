# Customer Management

**Module:** 01 — Customer Management
**Status:** Built (Phase 1), with Phase 2 enhancements planned
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

Customer endpoints are not yet in the API routes directory — Customer was added to the schema in Phase 1 along with Contact and BillingAddress, but the REST routes for Customer CRUD are planned for Phase 2. Contact and BillingAddress endpoints will be nested under Accounts.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/customers` | List customers (paginated, with search/filter) |
| POST | `/api/v1/customers` | Create a new customer |
| GET | `/api/v1/customers/:id` | Get customer by ID (includes accounts) |
| PATCH | `/api/v1/customers/:id` | Update customer fields |
| GET | `/api/v1/accounts/:id/contacts` | List contacts on an account |
| POST | `/api/v1/accounts/:id/contacts` | Add a contact to an account |
| PATCH | `/api/v1/accounts/:accountId/contacts/:id` | Update a contact |
| DELETE | `/api/v1/accounts/:accountId/contacts/:id` | Remove a contact |
| GET | `/api/v1/accounts/:id/billing-addresses` | List billing addresses for an account |
| POST | `/api/v1/accounts/:id/billing-addresses` | Add a billing address |
| PATCH | `/api/v1/accounts/:accountId/billing-addresses/:id` | Update a billing address |
| DELETE | `/api/v1/accounts/:accountId/billing-addresses/:id` | Remove a billing address |

**Query parameters for `GET /customers`:** `page`, `limit`, `sort`, `order`, `customerType`, `status`, `search`

**Common response shape:** `{ data: [...], meta: { total, page, limit, pages } }`

## Business Rules

### Customer Type Validation

Enforced via Zod schema (`createCustomerSchema`):
- `INDIVIDUAL` requires both `first_name` and `last_name`
- `ORGANIZATION` requires `organization_name`
- Validation error message: `"Individual requires firstName+lastName; Organization requires organizationName"`

### Status

- Default status on creation: `ACTIVE`
- Deactivation sets `status = INACTIVE`; no hard deletes
- A customer with active accounts should not be deactivated (enforcement planned in Phase 2)

### Immutable Fields on Update

`customer_type` cannot be changed after creation (`updateCustomerSchema` omits `customerType`). To change a customer from INDIVIDUAL to ORGANIZATION, a new record must be created.

### Contact Constraints

- `account_id` is required; contacts belong to an account
- `customer_id` is optional; a contact may or may not be a system customer
- Multiple contacts per account are allowed (no limit)
- `is_primary` should have at most one `true` per account (UI enforcement; no DB unique constraint in Phase 1)

### BillingAddress Constraints

- `account_id` is required
- `country` defaults to `"US"`; international addresses supported with ISO 3166-1 alpha-2 country codes
- `is_primary` should have at most one `true` per account per phase

### Landlord/Tenant Relationships

Phase 1 supports `owner_id` on the Premise entity (a Customer who owns the property). The formal landlord/tenant distinction on service agreements — where the owner pays some charges and the tenant pays others — is a Phase 2 feature requiring `owner_account_id` vs `occupant_account_id` on ServiceAgreement.

### Duplicate Detection

Not implemented in Phase 1. Phase 3 will add a matching rules engine that checks for duplicates on name + date_of_birth, email, phone, and drivers_license before creating a new Customer record.

### PII Handling

- SSN and payment card data are never stored in CIS (handled by SaaSLogic)
- `drivers_license`, `tax_id`, and `date_of_birth` are stored for ID verification purposes only
- All reads and writes are tenant-scoped via RLS; no cross-tenant data access is possible

## UI Pages

| Page | Path | Features |
|------|------|----------|
| Customers List | `/customers` | Table with search (name, email, phone), filter by type/status, pagination |
| Customer Detail | `/customers/:id` | Tabs: Overview (fields), Accounts (linked accounts), Contacts |
| Customer Create | `/customers/new` | Form with customer type selector; conditional fields for INDIVIDUAL vs ORGANIZATION |
| Account Contacts | `/accounts/:id` (Contacts tab) | List contacts with roles; add/edit/remove |
| Account Billing Addresses | `/accounts/:id` (Billing tab) | List billing addresses; add/edit/remove |

## Phase Roadmap

- **Phase 1:** Customer, Contact, and BillingAddress entities fully defined in schema and Zod validators. Customer → Account → Contact/BillingAddress relationships established.
- **Phase 2:** Customer CRUD API endpoints deployed. Contact and BillingAddress CRUD endpoints deployed under Account routes. Full-text customer search (name, phone, email). Landlord/tenant relationship on ServiceAgreement. Transfer of service workflow (close/open without data loss).
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
