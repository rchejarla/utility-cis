# Data Model Overview

**Module:** 00 — Data Model Overview
**Status:** Built (Phase 1 complete, Phase 2 in progress)
**Entities:** All 18

## Overview

This document is the master entity reference for the Utility CIS data model. It describes all 18 entities, their database tables, categories, the phase in which they were built, and their key relationships. Use this as the index when navigating module-level specs.

The system is multi-tenant: every entity is scoped by `utility_id`. Tenant isolation is enforced at the database level via PostgreSQL Row-Level Security (RLS) policies, with the `utility_id` claim from the JWT applied per-request.

## Entity Summary

**18 entities** across 5 categories:

| # | Entity | Table | Category | Phase Built | Key Relationships |
|---|--------|-------|----------|-------------|-------------------|
| 1 | Customer | `customer` | Customer | Phase 1 | Has many Accounts, Contacts, owns Premises |
| 2 | Contact | `contact` | Customer | Phase 1 | Belongs to Account; optionally linked to Customer |
| 3 | BillingAddress | `billing_address` | Customer | Phase 1 | Belongs to Account |
| 4 | Commodity | `commodity` | Reference | Phase 1 | Has many UnitOfMeasure, Meters, ServiceAgreements, RateSchedules |
| 5 | UnitOfMeasure | `unit_of_measure` | Reference | Phase 1 | Belongs to Commodity; referenced by Meter, MeterRegister |
| 6 | Premise | `premise` | Core | Phase 1 | Has many Meters, ServiceAgreements; optionally owned by Customer |
| 7 | Meter | `meter` | Core | Phase 1 | Belongs to Premise + Commodity + UOM; has many Registers, Reads, ServiceAgreementMeters |
| 8 | MeterRegister | `meter_register` | Core | Phase 1 | Belongs to Meter; referenced by MeterRead |
| 9 | Account | `account` | Core | Phase 1 | Belongs to Customer; has many ServiceAgreements, Contacts, BillingAddresses |
| 10 | ServiceAgreement | `service_agreement` | Agreement | Phase 1 | Belongs to Account + Premise + Commodity + RateSchedule + BillingCycle; has many ServiceAgreementMeters, MeterReads |
| 11 | ServiceAgreementMeter | `service_agreement_meter` | Agreement | Phase 1 | Junction: ServiceAgreement ↔ Meter |
| 12 | RateSchedule | `rate_schedule` | Configuration | Phase 1 | Belongs to Commodity; referenced by ServiceAgreement; self-references for versioning |
| 13 | BillingCycle | `billing_cycle` | Configuration | Phase 1 | Referenced by ServiceAgreement |
| 14 | MeterRead | `meter_read` | Operations | Phase 1 | Belongs to Meter + ServiceAgreement; optionally linked to MeterRegister |
| 15 | AuditLog | `audit_log` | System | Phase 1 | Records all entity state changes; references actor by user UUID |
| 16 | TenantTheme | `tenant_theme` | System | Phase 1 | One per utility (unique on utility_id) |
| 17 | UserPreference | `user_preference` | System | Phase 1 | One per user per utility (unique on utility_id + user_id) |
| 18 | Attachment | `attachment` | Operations | Phase 2 | Generic file attachment for any entity (entityType + entityId pattern); RLS enforced |

## ER Diagram

```
Customer ──────┬──→ Account ──────→ ServiceAgreement ──→ ServiceAgreementMeter ──→ Meter
(person/org)   │   (billing)       (the core unit)      (junction, 1 or many)     (device)
               │       │                  │                                          │
               │       ├──→ Contact       ├──→ Premise ←────────────────────────────┘
               │       └──→ BillingAddress│   (location)                    (belongs to)
               │                          │
               └──→ Premise (as owner)    ├──→ Commodity ←──→ UnitOfMeasure
                                          ├──→ RateSchedule
                                          └──→ BillingCycle

Meter ──→ MeterRegister (1 or many channels)
MeterRead ──→ Meter + MeterRegister (optional) + ServiceAgreement
```

## Module Specs

| Module | File | Entities Covered |
|--------|------|-----------------|
| [01 — Customer Management](./01-customer-management.md) | `01-customer-management.md` | Customer, Contact, BillingAddress |
| [02 — Premise Management](./02-premise-management.md) | `02-premise-management.md` | Premise |
| [03 — Meter Management](./03-meter-management.md) | `03-meter-management.md` | Meter, MeterRegister |
| [04 — Account Management](./04-account-management.md) | `04-account-management.md` | Account |
| [05 — Service Agreements](./05-service-agreement.md) | `05-service-agreement.md` | ServiceAgreement, ServiceAgreementMeter |
| [06 — Commodities & Units of Measure](./06-commodity-and-uom.md) | `06-commodity-and-uom.md` | Commodity, UnitOfMeasure |
| [07 — Rate Management](./07-rate-management.md) | `07-rate-management.md` | RateSchedule, BillingCycle |
| [08 — Meter Reads & Operations](./08-meter-reads.md) | `08-meter-reads.md` | MeterRead |
| [09 — System & Audit](./09-system-audit.md) | `09-system-audit.md` | AuditLog, TenantTheme, UserPreference |
| [17 — Reporting and Audit](./17-reporting-and-audit.md) | `17-reporting-and-audit.md` | Attachment |

## Multi-Tenancy Model

Every table has a `utility_id UUID NOT NULL` column. RLS policies are enabled on all entity tables:

```sql
ALTER TABLE premise ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON premise
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
```

The API validates `utility_id` as a UUID before interpolation and sets the RLS context per-request via `SET app.current_utility_id`. Defense in depth: all `GET /:id` queries also include `utility_id` in the `WHERE` clause.

## Design Principles

- **Soft deletes only.** No hard deletes. Entities move to status `INACTIVE`, `CLOSED`, `REMOVED`, or `CONDEMNED`.
- **CIS owns utility domain; SaaSLogic owns money.** The integration boundary is a structured billing instruction.
- **Configurable, not customizable.** All tenant-specific variation is driven by data (commodities, rate schedules, billing cycles), not code branches.
- **Event-driven audit.** All state changes emit internal domain events that write to `audit_log` with before/after state.
