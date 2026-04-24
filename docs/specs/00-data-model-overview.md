# Data Model Overview

**Module:** 00 — Data Model Overview
**Status:** Built (Phase 1 complete, Phase 2 in progress, Phase 3 partial, Phase 4 Service Requests slice B in progress)
**Entities:** All 31

## Overview

This document is the master entity reference for the Utility CIS data model. It describes all 31 entities, their database tables, categories, the phase in which they were built, and their key relationships. Use this as the index when navigating module-level specs.

The system is multi-tenant: every entity is scoped by `utility_id`. Tenant isolation is enforced at the database level via PostgreSQL Row-Level Security (RLS) policies, with the `utility_id` claim from the JWT applied per-request.

## Entity Summary

**31 entities** across 9 categories (RBAC category added in Phase 2; TenantConfig and SuspensionTypeDef added alongside Service Holds v1; CustomFieldSchema added in Custom Fields Phase 1; Notifications and Delinquency categories added in Phase 3; Service Requests category added in Phase 4 slice B):

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
| 9 | Account | `account` | Core | Phase 1 | Belongs to Customer; has many ServiceAgreements, Contacts, BillingAddresses. Extended with `balance`, `last_due_date`, `is_protected` columns for delinquency evaluation. |
| 10 | ServiceAgreement | `service_agreement` | Agreement | Phase 1 | Belongs to Account + Premise + Commodity + RateSchedule + BillingCycle; has many ServiceAgreementMeters, MeterReads |
| 11 | ServiceAgreementMeter | `service_agreement_meter` | Agreement | Phase 1 | Junction: ServiceAgreement ↔ Meter |
| 12 | RateSchedule | `rate_schedule` | Configuration | Phase 1 | Belongs to Commodity; referenced by ServiceAgreement; self-references for versioning |
| 13 | BillingCycle | `billing_cycle` | Configuration | Phase 1 | Referenced by ServiceAgreement |
| 14 | MeterRead | `meter_read` | Operations | Phase 1 | Belongs to Meter + ServiceAgreement + UnitOfMeasure; optionally linked to MeterRegister. `uom_id` frozen at write time from the meter's UOM. Phase 2.5: gains nullable `read_event_id` UUID that groups sibling rows from the same multi-register read event (one row per active register per event). |
| 15 | AuditLog | `audit_log` | System | Phase 1 | Records all entity state changes; references actor by user UUID |
| 16 | TenantTheme | `tenant_theme` | System | Phase 1 | One per utility (unique on utility_id) |
| 17 | UserPreference | `user_preference` | System | Phase 1 | One per user per utility (unique on utility_id + user_id) |
| 18 | Attachment | `attachment` | Operations | Phase 2 | Generic file attachment for any entity (entityType + entityId pattern); RLS enforced |
| 19 | Role | `role` | RBAC | Phase 2 | Per-tenant permission bundle; referenced by CisUser |
| 20 | CisUser | `cis_user` | RBAC | Phase 2 | Admin or portal user; belongs to Role; scoped by utility_id. Nullable `customer_id` FK to Customer — null for staff, set for portal customers. Portal users see only their own accounts/data via customer-scoped API endpoints. |
| 21 | TenantModule | `tenant_module` | RBAC | Phase 2 | Per-tenant module enablement (maps `moduleKey` → enabled) |
| 22 | TenantConfig | `tenant_config` | System | Phase 2 | One per utility (unique on utility_id); holds `require_hold_approval` and an extensible `settings` JSONB bucket carrying `numberFormats` (identifier generation), `branding`, `notifications`, `retention`, and `billing` namespaces (see spec 18). |
| 23 | SuspensionTypeDef | `suspension_type_def` | Reference | Phase 2 | Per-tenant (or global, with `utility_id IS NULL`) reference table for service-hold type codes. Replaces the former `SuspensionType` Prisma enum. RLS policy allows global rows to be visible across all tenants. |
| 24 | CustomFieldSchema | `custom_field_schema` | System | Phase 2 | One row per (utility, entity_type) holding the tenant's custom-field schema as a JSONB FieldDefinition array. Powers the `custom_fields` JSONB column on Customer/Account/Premise/ServiceAgreement/Meter. See spec 20. |
| 25 | NotificationTemplate | `notification_template` | Notifications | Phase 3 | Per-tenant template with channel (EMAIL/SMS/MAIL), Mustache body, variable interpolation, optional event-trigger binding. See spec 13. |
| 26 | Notification | `notification` | Notifications | Phase 3 | Individual notification instance sent from a template; tracks recipient, channel, status (PENDING/SENT/FAILED), and send timestamp. See spec 13. |
| 27 | DelinquencyRule | `delinquency_rule` | Delinquency | Phase 3 | Per-tenant rule with configurable thresholds (days past due, minimum balance), escalation tier, and linked notification template. See spec 11. |
| 28 | DelinquencyAction | `delinquency_action` | Delinquency | Phase 3 | Log of delinquency rule firings per account; records rule, account, action taken, and timestamp. See spec 11. |
| 29 | ServiceRequestTypeDef | `service_request_type_def` | Service Requests | Phase 4 slice B | Per-tenant (or global, with `utility_id IS NULL`) reference table for service-request type codes. Mirrors SuspensionTypeDef — RLS allows globals to be visible across all tenants. 8 globals seeded (LEAK_REPORT, DISCONNECT, RECONNECT, START_SERVICE, STOP_SERVICE, BILLING_DISPUTE, METER_ISSUE, OTHER). See spec 14. |
| 30 | Sla | `sla` | Service Requests | Phase 4 slice B | Per-tenant SLA policy keyed on `(request_type, priority)`; drives `sla_due_at` at SR creation and breach computation at completion. See spec 14. |
| 31 | ServiceRequest | `service_request` | Service Requests | Phase 4 slice B | Core work item. Lifecycle NEW → ASSIGNED → IN_PROGRESS → PENDING_FIELD → COMPLETED / CANCELLED / FAILED. Per-tenant/year `SR-YYYY-NNNNNN` numbering via `service_request_counter` plumbing table. External-system, billing-action, delinquency, and attachments columns reserved but unused this slice. See spec 14. |

## ER Diagram

```
Customer ──────┬──→ Account ──────→ ServiceAgreement ──→ ServiceAgreementMeter ──→ Meter
(person/org)   │   (billing)       (the core unit)      (junction, 1 or many)     (device)
               │       │                  │                                          │
               ├──→ CisUser (portal)      │                                          │
               │   (customerId FK)        │                                          │
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
- **Defense in depth for data integrity.** Zod validators guard the API boundary, Prisma constrains the schema, and PostgreSQL CHECK constraints enforce invariants at the storage layer. A bug in any single layer can't produce data that breaks the others.

## Database Invariants (CHECK constraints)

The following invariants are enforced at the PostgreSQL layer via CHECK constraints. They apply regardless of which service (or ad-hoc SQL session) writes the data. Zod mirrors these at the API boundary with friendlier error messages, but these are the backstop. The full list lives in `packages/shared/prisma/migrations/01_check_constraints/migration.sql` and is applied after RLS by `setup_db.bat`.

**Non-negative / positive numerics**
- `account.deposit_amount >= 0`
- `unit_of_measure.conversion_factor > 0`
- `meter.multiplier > 0`, `meter.dial_count > 0` (when not null)
- `commodity.display_order >= 0`
- `rate_schedule.version >= 1`

**Date ordering**
- `rate_schedule.expiration_date` is null or strictly after `effective_date`
- `service_agreement.end_date` is null or >= `start_date`
- `meter.removal_date` is null or >= `install_date`
- `service_agreement_meter.removed_date` is null or >= `added_date`

**Day-of-month bounds**
- `billing_cycle.read_day_of_month` and `bill_day_of_month` between 1 and 31. The CHECK is the calendar floor; Zod tightens this further to 1–28 at the API boundary (see [07 — Rate Management](./07-rate-management.md#billing-cycle)) to avoid month-end ambiguity. The two bounds are layered intentionally: Zod enforces the business rule, CHECK enforces physical possibility.

**Format checks**
- `customer.email`, `contact.email`, `cis_user.email` match a basic email regex (null allowed where the column is optional)
- `account.language_pref` matches IETF tag shape `^[a-z]{2}-[A-Z]{2}$` (e.g. `en-US`)

**Non-empty business identifiers**
- `account.account_number`, `meter.meter_number`, `service_agreement.agreement_number`, `commodity.code`, `unit_of_measure.code`, `billing_cycle.cycle_code`, `rate_schedule.code` — all must be non-whitespace strings
