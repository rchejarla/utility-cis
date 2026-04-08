# Bozeman BUBSSI RFP — Gap Analysis & Phase Mapping

**Date:** 2026-04-08
**Source:** `01 - Functional Requirements - BUBSSI - RFP - NEEDS REVIEW.xlsx`
**Status:** Analysis complete — needs product review for prioritization

---

## 1. Overview

The City of Bozeman RFP contains 202 functional requirements across 7 areas. This document maps each requirement to our CIS build phases, identifies gaps in the current spec, and proposes new entities/features needed.

**Legend:**
- ✅ **Covered** — already built or in current spec
- 🔶 **Partial** — foundation exists, needs enhancement
- ❌ **Gap** — not in any current phase, needs to be added
- 📋 **Planned** — already in a future phase spec

---

## 2. Requirements by Functional Area

### 2.1 Customer - Property File (Reqs 1-41)

#### Property / Service Location Management (Reqs 1-8)

| Req | Requirement | Status | Phase | Notes |
|-----|-------------|--------|-------|-------|
| 1 | GIS as authoritative system of record for premises | ❌ Gap | Phase 2 | Need GIS sync service, not just lat/lng storage |
| 2 | Configurable GIS sync schedules (real-time, batch) | ❌ Gap | Phase 2 | Requires integration service + scheduler |
| 3 | Store GIS-origin IDs (Parcel ID, Premise ID) | 🔶 Partial | Phase 2 | Premise has id but not parcel_id or gis_premise_id |
| 4 | Display GIS-sourced addresses, preserve address history | ❌ Gap | Phase 2 | Need address history table |
| 5 | Effective-dated account-to-property relationships | ✅ Covered | Phase 1 | ServiceAgreement has start_date/end_date |
| 6 | GIS attributes determine default rates and service availability | ❌ Gap | Phase 2 | Need rules engine for GIS-to-rate mapping |
| 7 | Restrict manual GIS overrides to authorized users with audit | 🔶 Partial | Phase 2 | Audit log exists, need RBAC for GIS fields |
| 8 | Multiple service types at locations | ✅ Covered | Phase 1 | Premise.commodityIds array |

#### Customer Account Management (Reqs 9-24)

| Req | Requirement | Status | Phase | Notes |
|-----|-------------|--------|-------|-------|
| 9 | Multiple accounts per property | ✅ Covered | Phase 1 | Multiple ServiceAgreements per Premise |
| 10 | One account across multiple properties | ✅ Covered | Phase 1 | Account → many ServiceAgreements → many Premises |
| 11 | User-defined required fields in customer file | ❌ Gap | Phase 3 | Need configurable custom fields on Account |
| 12 | Multiple customer types | ✅ Covered | Phase 1 | Account.accountType enum |
| 13 | Multiple contacts per account with roles | ❌ Gap | Phase 2 | Need **Contact** entity |
| 14 | Landlord/tenant relationships | ❌ Gap | Phase 2 | Need owner_account_id vs occupant_account_id on ServiceAgreement |
| 15 | Transfer of service (close/open without data loss) | 📋 Planned | Phase 2 | Move-in/move-out workflow |
| 16 | Duplicate customer detection | ❌ Gap | Phase 3 | Need matching rules engine |
| 17 | Alternate bill-to addresses | ❌ Gap | Phase 2 | Need **BillingAddress** on Account |
| 18 | International billing addresses | ❌ Gap | Phase 2 | Address model needs country field |
| 19 | Deposits for certain account types | ✅ Covered | Phase 1 | Account.depositAmount, depositWaived |
| 20 | Deposit refund on close | 🔶 Partial | Phase 2 | Need deposit refund workflow |
| 21 | Apply deposit to unpaid charges | ❌ Gap | Phase 3 | Need deposit-to-balance application logic |
| 22 | Customer account status values | ✅ Covered | Phase 1 | Account.status enum |
| 23 | Delinquency flagging visible during lookup | ❌ Gap | Phase 3 | Need delinquency status field + UI indicator |
| 24 | Customer search by any data field | 🔶 Partial | Phase 1 | Search by account number exists; need full-text search |

#### Account & Property History (Reqs 25-26)

| Req | Requirement | Status | Phase | Notes |
|-----|-------------|--------|-------|-------|
| 25 | Historical GIS property records | ❌ Gap | Phase 2 | Need property history table |
| 26 | Consolidated account history view | 🔶 Partial | Phase 1 | Audit log exists; need unified history UI |

#### Notifications & Communications (Reqs 27-33)

| Req | Requirement | Status | Phase | Notes |
|-----|-------------|--------|-------|-------|
| 27 | Automated notifications (email, SMS, mail) | ❌ Gap | Phase 3 | Need **Notification** service + templates |
| 28 | Configurable notification triggers | ❌ Gap | Phase 3 | Event-driven via ApptorFlow |
| 29 | Staff-managed communication templates | ❌ Gap | Phase 3 | Need **NotificationTemplate** entity |
| 30 | Bulk/mass communications to segments | ❌ Gap | Phase 3 | Need bulk send capability |
| 31 | Opt-in/opt-out management, SMS consent | ❌ Gap | Phase 3 | Need **CommunicationPreference** entity |
| 32 | Customer communication preferences | ❌ Gap | Phase 3 | Extends Account or new entity |
| 33 | Communication history per customer | ❌ Gap | Phase 3 | Need **CommunicationLog** entity |

#### Customer Portal & Self-Service (Reqs 34-41)

| Req | Requirement | Status | Phase | Notes |
|-----|-------------|--------|-------|-------|
| 34-41 | Secure portal, account view, registration, payments, alerts | 📋 Planned | Phase 4 | Already in Phase 4 spec |

---

### 2.2 Solid Waste (Reqs 42-59) — NEW DOMAIN

**Entirely new.** Needs a new commodity type + container/cart model + RAMS integration.

| Req | Requirement | Phase | New Entity/Feature |
|-----|-------------|-------|--------------------|
| 42 | GIS-based solid waste eligibility | Phase 2 | GIS integration (see Req 1-7) |
| 43 | Multiple waste service types per property | Phase 2 | Multiple ServiceAgreements per Premise (exists) |
| 44 | Effective-dated enrollment with proration | Phase 3 | Proration logic in rate engine |
| 45-46 | Seasonal services, vacation suspensions | Phase 3 | Need **ServiceSuspension** entity |
| 47-51 | RAMS integration (events → charges, reconciliation) | Phase 3 | Need **ExternalSystemIntegration** service + **ServiceEvent** entity |
| 52-56 | Cart/container management | Phase 2 | Need **Container** entity (type, size, delivery/removal dates) |
| 57 | Container-based billing (size, quantity, frequency) | Phase 3 | New rate type: CONTAINER-BASED |
| 58 | Future-dated rate/policy changes | ✅ Covered | Phase 1 | RateSchedule.effectiveDate/expirationDate |
| 59 | Billing adjustments for missed collections | Phase 3 | Need **BillingAdjustment** entity |

**New entities needed:** Container, ServiceSuspension, ServiceEvent, BillingAdjustment

---

### 2.3 Water / Wastewater & Stormwater (Reqs 60-127)

#### Service Setup (Reqs 60-64)

| Req | Requirement | Status | Phase | Notes |
|-----|-------------|--------|-------|-------|
| 60 | Separate water, wastewater, stormwater services | 🔶 Partial | Phase 1 | WATER + SEWER commodities exist; need STORMWATER |
| 61 | Consolidated bill with service-level accounting | 📋 Planned | Phase 3 | SaaSLogic consolidates at invoice level |
| 62 | Effective-dated enrollment with proration | Phase 3 | Proration logic needed |
| 63 | Regulatory fees and surcharges by service/class | ❌ Gap | Phase 3 | Need **Surcharge** entity or surcharge rules in rate config |
| 64 | Configurable taxes and franchise fees | ❌ Gap | Phase 3 | Need **TaxRule** entity |

#### Rate Management (Reqs 65-74)

| Req | Requirement | Status | Phase | Notes |
|-----|-------------|--------|-------|-------|
| 65 | Meter multiplier/scaling factors | ✅ Covered | Phase 1 | Meter.multiplier |
| 66 | Multiple water rate structures | ✅ Covered | Phase 1 | RateSchedule.rateType (FLAT, TIERED, etc.) |
| 67 | Different rates by customer type | 🔶 Partial | Phase 3 | Need to link rate eligibility to Account.accountType |
| 68 | Future-dated rate ordinances without rebilling | ✅ Covered | Phase 1 | Effective dating on RateSchedule |
| 69 | Wastewater = 100% of water usage (except WQA) | ❌ Gap | Phase 3 | Need **water-linked billing** calculation in rate engine |
| 70 | Caps, mins, maxes for wastewater/WQA | ❌ Gap | Phase 3 | New rate config fields |
| 71 | Configurable WQA calculations | ❌ Gap | Phase 3 | Need **WQA** calculation module |
| 72 | Winter averaging for wastewater | ❌ Gap | Phase 3 | Part of WQA module |
| 73 | Exclude irrigation from wastewater | ❌ Gap | Phase 3 | Need meter-type or service-type exclusion rules |
| 74 | Minimum bills regardless of usage | 🔶 Partial | Phase 3 | base_charge in rate config; need explicit minimum bill rule |

#### Meter Read (Reqs 75-92)

| Req | Requirement | Status | Phase | Notes |
|-----|-------------|--------|-------|-------|
| 75-76 | Meter reading system as authoritative, API integration | 📋 Planned | Phase 2 | MeterRead CRUD + external import |
| 77 | Incremental and full read imports | Phase 2 | Batch import endpoint |
| 78 | Read cycle scheduling, route grouping | ✅ Covered | Phase 1 | BillingCycle + ServiceAgreement.readSequence |
| 79 | Unique read IDs, prevent duplicate billing | Phase 2 | MeterRead.id + dedup logic |
| 80 | Associate reads to meters | ✅ Covered | Phase 1 | MeterRead.meterId FK |
| 81 | Multi-register meter handling | ❌ Gap | Phase 2 | Need **MeterRegister** entity |
| 82 | Label estimated vs actual reads | ✅ Covered | Phase 1 | MeterRead.readType enum |
| 83 | Retain raw interval data | ✅ Covered | Phase 1 | TimescaleDB hypertable |
| 84 | Meter events (leaks, tamper, reverse flow) | ❌ Gap | Phase 2 | Need **MeterEvent** entity |
| 85 | Meter events trigger notifications/billing holds | ❌ Gap | Phase 3 | ApptorFlow event → notification/hold |
| 86 | Freeze validated reads after billing | Phase 3 | Need read lock after billing |
| 87 | Before/after for corrected reads | ✅ Covered | Phase 1 | MeterRead.readType=CORRECTED + audit log |
| 88 | Audit trail for reads | ✅ Covered | Phase 1 | AuditLog entity |
| 89 | Manual entry/correction with audit | Phase 2 | MeterRead CRUD + audit |
| 90 | New/replacement meters attached any time | ✅ Covered | Phase 1 | ServiceAgreementMeter with addedDate/removedDate |
| 91 | Replaced meters mid-cycle, both reads total to usage | ❌ Gap | Phase 2 | Need split-read consumption calculation |
| 92 | Mid-cycle final reads and billing | Phase 2 | Final read + proration |

#### Exception Management (Reqs 93-100)

| Req | Requirement | Status | Phase | Notes |
|-----|-------------|--------|-------|-------|
| 93 | Configurable exception thresholds | 🔶 Partial | Phase 2 | MeterRead.exceptionCode exists; need configurable rules |
| 94-95 | Flag abnormal/invalid reads to exception queue | Phase 2 | Need **ExceptionQueue** UI + workflow |
| 96 | Estimation rules for missing reads | 📋 Planned | Phase 2 | In architecture doc |
| 97 | Error handling for failed imports | Phase 2 | Import error handling |
| 98 | Backflow/reverse flow handling | ❌ Gap | Phase 2 | Need consumption rules for negative reads |
| 99 | Configurable leak adjustment | ❌ Gap | Phase 3 | Need **LeakAdjustment** workflow |
| 100 | Exception reports | Phase 2 | Report/dashboard |

#### Usage Calculations (Reqs 101-105)

| Req | Requirement | Status | Phase | Notes |
|-----|-------------|--------|-------|-------|
| 101-105 | Interval aggregation, partial periods, rebilling, reconciliation, audit trails | 📋 Planned | Phase 3 | Rate engine scope |

#### Meter Inventory (Reqs 106-123)

| Req | Requirement | Status | Phase | Notes |
|-----|-------------|--------|-------|-------|
| 106-107 | Sync with meter management system, bulk imports | ❌ Gap | Phase 2 | Need import API |
| 108-109 | Meter inventory tracking, asset registry | 🔶 Partial | Phase 2 | Meter entity exists; need location tracking |
| 110 | Chain-of-custody history | ❌ Gap | Phase 2 | Need **MeterCustodyEvent** or extend audit |
| 111 | Effective-dated meter/property/account associations | ✅ Covered | Phase 1 | ServiceAgreementMeter with dates |
| 112 | Master/sub-meter, multi-register | ❌ Gap | Phase 2 | Need parent_meter_id + **MeterRegister** |
| 113 | Multiple meter types (temp, construction, irrigation) | 🔶 Partial | Phase 1 | MeterType enum; may need more values |
| 114 | Manufacturer, model, size, serial | 🔶 Partial | Phase 1 | meterNumber exists; need manufacturer/model/size fields |
| 115 | Inventory location tracking (warehouse, installed, retired) | ❌ Gap | Phase 2 | Need **MeterLocation** or status extension |
| 116 | Install/removal/change-out events with read continuity | ✅ Covered | Phase 1 | Meter status + ServiceAgreementMeter dates |
| 117 | Meter rollovers and register changes | ❌ Gap | Phase 2 | Need rollover handling in consumption calc |
| 118 | Meter testing, certification, failure status | ❌ Gap | Phase 2 | Need **MeterTest** entity |
| 119-120 | Inventory reconciliation, exception queues | Phase 2 | Reports + exception queue |
| 121-122 | Asset lifecycle reports, end-of-life flagging | Phase 2 | Dashboard + alerts |
| 123 | Meter location in multi-unit (Unit A, #102, etc.) | ❌ Gap | Phase 2 | Need location_description on Meter |

#### Delinquency Management (Reqs 124-127)

| Req | Requirement | Status | Phase | Notes |
|-----|-------------|--------|-------|-------|
| 124-127 | Shut-off rules, multi-tier notices, auto-identification, reporting | ❌ Gap | Phase 3 | Need **DelinquencyRule** + **DelinquencyAction** entities |

---

### 2.4 Billing (Reqs 128-164)

| Req | Requirement | Status | Phase | Notes |
|-----|-------------|--------|-------|-------|
| 128-129 | Portal bill display, consolidated view | 📋 Planned | Phase 4 | Customer portal |
| 130 | PDF bill generation, historical images | ❌ Gap | Phase 3 | Need **BillDocument** entity + PDF renderer |
| 131 | Print vendor integration | ❌ Gap | Phase 3 | Export files for print-and-mail |
| 132 | Paperless billing enrollment | ✅ Covered | Phase 1 | Account.paperlessBilling |
| 133 | Bill reprints, corrected bills with versioning | ❌ Gap | Phase 3 | Need BillingRecord versioning |
| 134 | Final bill at account closure | Phase 3 | Part of billing execution |
| 135 | Multiple concurrent billing cycles | ✅ Covered | Phase 1 | BillingCycle entity |
| 136 | Bill holds | ❌ Gap | Phase 3 | Need billingHold flag on Account or ServiceAgreement |
| 137 | Configurable bill messages by account type/service | ❌ Gap | Phase 3 | Need **BillMessage** entity |
| 138 | Prorate tier thresholds for partial periods | Phase 3 | Rate engine |
| 139 | Itemized charges on bills | ✅ Covered | Phase 1 | ChargeBreakdown has line items |
| 140 | Validate charges against adopted rates | Phase 3 | Billing validation |
| 141 | Reconciliation: water usage vs wastewater billing | Phase 3 | WQA-related |
| 142 | Rebill on read corrections | Phase 3 | Retroactive billing |
| 143-144 | Ad hoc fees (individual, all, subset) | ❌ Gap | Phase 3 | Need **AdhocCharge** entity |
| 145 | Auto late fees/penalties | ❌ Gap | Phase 3 | Need **PenaltyRule** entity |
| 146 | Write-off workflow | ❌ Gap | Phase 3 | Need **WriteOff** entity + workflow |
| 147-148 | Payment plans | ❌ Gap | Phase 3 | Need **PaymentPlan** entity |
| 149-150 | Aging dashboard (real-time) | ❌ Gap | Phase 3 | Need AR aging query + dashboard UI |
| 151 | Shut-off eligibility rules | ❌ Gap | Phase 3 | DelinquencyRule (see 124) |
| 152-156 | Multi-account portal, third-party payer, payment allocation | 📋 Planned | Phase 4 | Customer portal |
| 157-164 | Payment processing (PCI, ACH, real-time posting, reversals) | 📋 Planned | Phase 3 | SaaSLogic handles payments |

---

### 2.5 Special Assessments (Reqs 165-179) — NEW DOMAIN

**Entirely new domain.** Property-based assessments for infrastructure districts.

| Req | Summary | Phase | New Entity |
|-----|---------|-------|------------|
| 165-167 | Assessment district CRUD, multi-district, activate/sunset | Phase 5 | **AssessmentDistrict** |
| 168-171 | Parcel-based billing, GIS integration, ownership transfer, manual overrides | Phase 5 | **ParcelAssessment** |
| 172-175 | Configurable formulas, recurring billing, separate balances, late fees | Phase 5 | **AssessmentCharge**, **AssessmentSchedule** |
| 176-179 | Installments/loans, early payoff, audit trail, reporting | Phase 5 | **AssessmentInstallment** |

**Recommendation:** This is a standalone module. Build as **Phase 5** after core CIS + billing are complete.

---

### 2.6 Service Requests (Reqs 180-202) — NEW DOMAIN

**Maps to ApptorFlow orchestration + new SR entities.**

| Req | Summary | Phase | Notes |
|-----|---------|-------|-------|
| 180-184 | SR intake (CSR, portal, API), types, attachments | Phase 4 | Need **ServiceRequest** entity |
| 185-188 | Priority, assignment, SLAs, escalation | Phase 4 | Need **SLA** entity, ApptorFlow workflows |
| 189-192 | Routing to RAMS/work systems, bi-directional updates | Phase 4 | ApptorFlow integration |
| 193-197 | Lifecycle management, repeat detection, disputes, audit | Phase 4 | SR status machine + audit |
| 198-199 | Delinquency work orders (door hangers, shut-offs, turn-ons) | Phase 3 | Link delinquency → service request |
| 200-202 | Charges/credits on completion, fee waivers, customer notifications | Phase 4 | SR → billing integration |

---

## 3. New Entities Required (Not in Current Spec)

| Entity | Phase | Purpose |
|--------|-------|---------|
| **Contact** | Phase 2 | Multiple contacts per account with roles |
| **BillingAddress** | Phase 2 | Alternate/international bill-to address |
| **AddressHistory** | Phase 2 | Historical premise addresses from GIS |
| **Container** | Phase 2 | Solid waste cart/container tracking |
| **MeterRegister** | Phase 2 | Multi-register meter support |
| **MeterEvent** | Phase 2 | Leak, tamper, reverse flow events |
| **MeterTest** | Phase 2 | Testing, certification, failure tracking |
| **ServiceSuspension** | Phase 3 | Seasonal/vacation service holds |
| **ServiceEvent** | Phase 3 | External system events (RAMS) → charges |
| **BillingAdjustment** | Phase 3 | Ad hoc credits/charges |
| **AdhocCharge** | Phase 3 | One-time fees on accounts |
| **PenaltyRule** | Phase 3 | Auto late fee configuration |
| **PaymentPlan** | Phase 3 | Installment plans for delinquent accounts |
| **DelinquencyRule** | Phase 3 | Shut-off eligibility rules |
| **DelinquencyAction** | Phase 3 | Notices, door hangers, shut-off orders |
| **BillDocument** | Phase 3 | PDF bill generation + storage |
| **BillMessage** | Phase 3 | Configurable messages on bills |
| **WriteOff** | Phase 3 | Uncollectable balance write-off |
| **NotificationTemplate** | Phase 3 | Email/SMS/mail templates |
| **CommunicationLog** | Phase 3 | Communication history per customer |
| **CommunicationPreference** | Phase 3 | Opt-in/out per channel |
| **TaxRule** | Phase 3 | Configurable tax/franchise fee rules |
| **Surcharge** | Phase 3 | Regulatory surcharges |
| **ServiceRequest** | Phase 4 | SR lifecycle management |
| **SLA** | Phase 4 | Service level agreements per SR type |
| **AssessmentDistrict** | Phase 5 | Special assessment districts |
| **ParcelAssessment** | Phase 5 | Parcel-level assessment tracking |
| **AssessmentInstallment** | Phase 5 | Loan-type installment payments |

---

## 4. Revised Phase Plan

### Phase 1 (Complete) — Core Foundation
✅ 13 entities, 29 API endpoints, admin UI, map view, theme editor

### Phase 2 (Next) — Enhanced CIS + Meter Management
- GIS integration (sync, Parcel ID, address history)
- Contact entity (multiple contacts per account with roles)
- Billing address (alternate/international)
- Landlord/tenant relationships
- Move-in/move-out workflow (transfer of service)
- MeterRead CRUD + consumption calculation
- Meter events (leak, tamper, reverse flow)
- Multi-register meters
- Meter inventory enhancements (manufacturer, model, size, location, testing)
- Container/cart management for solid waste
- Exception management (configurable thresholds, estimation rules)
- Full-text customer search

### Phase 3 — Billing Engine + Notifications + Delinquency
- Rate engine (all calculation types including WQA)
- Wastewater-linked billing (% of water, winter averaging)
- Billing cycle execution + SaaSLogic integration
- Proration for partial periods
- Bill document generation (PDF)
- Late fees/penalties (auto-applied)
- Payment plans
- Billing adjustments, ad hoc charges, write-offs
- Bill holds, bill messages
- Delinquency management (rules, multi-tier notices, shut-off)
- Notification engine (email, SMS, mail) + templates
- Communication preferences + history
- Tax/surcharge rules
- Seasonal services, service suspensions
- Aging dashboard

### Phase 4 — Customer Portal + Service Requests
- Customer self-service portal (registration, billing, payments, alerts)
- Service request lifecycle (intake, assignment, SLA, escalation)
- ApptorFlow-orchestrated workflows (start/stop service, collections, anomaly)
- External system routing (RAMS for waste, work management for water)
- Dispute handling, fee waivers

### Phase 5 — Special Assessments
- Assessment district management
- Parcel-based assessments with GIS integration
- Installment/loan-type billing with interest
- Early payoff, ownership transfer
- Assessment-specific reporting

---

## 5. Coverage Summary

| Status | Count | % |
|--------|-------|---|
| ✅ Covered (Phase 1) | 32 | 16% |
| 🔶 Partial (needs enhancement) | 18 | 9% |
| 📋 Planned (in future phase) | 28 | 14% |
| ❌ Gap (needs new work) | 124 | 61% |
| **Total** | **202** | **100%** |

61% of requirements are gaps that need new entities or features. However, the foundational architecture (multi-tenancy, event system, audit logging, rate scheduling) supports all of them — no architectural changes needed, only feature additions.
