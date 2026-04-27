# Bozeman BUBSSI RFP — Master Requirements Cross-Reference

**Source:** `01_Functional_Requirements_Expeed.xlsx` (snapshot from `bozeman-proposal/` on 2026-04-26)  
**Total requirements:** 202 (all answered Y or Y-WC)  
**Purpose:** Single working list mapping every Bozeman Req # to (a) the `bozeman/` proposal-response doc that frames it for the City, (b) the `docs/specs/` module spec that owns the engineering scope, and (c) any `docs/superpowers/plans/` implementation plan written. Use this to find what's drafted vs. what still needs work, and which doc to update when scope shifts.

**Conventions:**
- `bz/NN` -> `docs/bozeman/NN-*.md` (RFP proposal-response)
- `sp/NN` -> `docs/specs/NN-*.md` (long-lived module functional spec)
- `plan/<date>` -> `docs/superpowers/plans/<date>-*.md` (implementation plan)

## 1. Summary

**Coverage by document:**

| Metric | Count |
|---|---|
| Total requirements | 202 |
| Answered **Y** (binding, OOTB / config) | 192 |
| Answered **Y-WC** (Yes with conditions) | 10 |
| Mapped to a `bz/` proposal-response doc | 87 |
| Mapped to a `sp/` module spec | 202 |
| Mapped to an implementation plan | 1 |

**Phase distribution** (per Expeed's RFP response):

- Phase **1**: 202 reqs

**By functional area:**

- Water / Wastewater & Stormwater: **68** reqs
- Customer - Property File: **41** reqs
- Billing: **37** reqs
- Service Requests: **23** reqs
- Solid Waste: **18** reqs
- Special Assessments: **15** reqs

**`bz/` doc usage** (which proposal-response docs cover the most reqs):

| Doc | Title | Reqs covered |
|---|---|---|
| `bz/13` | Workflow, Approvals & Action Queue | 21 |
| `bz/14` | Special Assessments | 19 |
| `bz/15` | GIS-Driven Defaults & Effective-Dating | 19 |
| `bz/05` | Customer Portal | 17 |
| `bz/07` | Data Validation | 8 |
| `bz/12` | Corrections & Reversals | 5 |
| `bz/01` | Audit & Tamper-Evidence | 4 |
| `bz/09` | Bulk Upload & Data Ingestion | 3 |
| `bz/08` | Data Retention, Archival & Purge | 2 |
| `bz/06` | Custom Fields | 1 |
| `bz/11` | Notes & Comments | 1 |

## 2. Requirements with no `bz/` proposal-response doc (115)

These requirements are covered by their module spec but have no separate proposal-response doc in `docs/bozeman/`. That's appropriate when the requirement is straightforward module behavior (e.g., "System shall support multiple service types per property") that doesn't need a paragraph-length RFP commitment frame. Promote any of these to a `bz/` doc if the proposal narrative needs more detail than the module spec provides.

| Req # | Area / Process | Story | Spec |
|---|---|---|---|
| 8 | Customer - Property File / Property / Service Location Management | System shall support multiple service types at locations (e.g., water and solid waste, solid waste... | [sp/02](../specs/02-premise-management.md) |
| 16 | Customer - Property File / Customer Account Management | System shall support duplicate customer detection using configurable matching criteria. | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) |
| 17 | Customer - Property File / Customer Account Management | System supports alternate bill to addresses that differ from the service address | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) |
| 18 | Customer - Property File / Customer Account Management | System supports international billing addresses | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) |
| 19 | Customer - Property File / Customer Account Management | The system requires deposits for certain account types (e.g., renters are required to provide a... | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) |
| 20 | Customer - Property File / Customer Account Management | System shall support refunds of deposits when account is closed in good standing | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) |
| 21 | Customer - Property File / Customer Account Management | System shall support applying deposit to unpaid charges | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) |
| 22 | Customer - Property File / Customer Account Management | System shall support customer account status values (e.g., active, inactive, pending start, final... | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) |
| 23 | Customer - Property File / Customer Account Management | System flags customers with delinquent accounts and make delinquency status visible during account... | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) |
| 24 | Customer - Property File / Customer Account Management |  | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) |
| 32 | Customer - Property File / Notifications & Customer Communications Management | System shall support customer communication preferences (e.g. mail, email, phone, sms) and... | [sp/13](../specs/13-notifications.md) |
| 43 | Solid Waste / Service Set‑Up | System shall support multiple solid waste service types per property, each billed independently. | [sp/12](../specs/12-solid-waste.md) |
| 44 | Solid Waste / Service Set‑Up | System shall support effective-dated enrollment and proration for solid waste services. | [sp/12](../specs/12-solid-waste.md) |
| 45 | Solid Waste / Service Set‑Up | System shall support seasonal services and temporary service suspensions, including by service type... | [sp/12](../specs/12-solid-waste.md) |
| 46 | Solid Waste / Service Set‑Up | System shall support temporary service holds or vacation suspensions with automatic billing... | [sp/12](../specs/12-solid-waste.md) |
| 48 | Solid Waste / Route System Integration | System shall provide configurable mapping between RAMS service codes and billing charge codes. | [sp/12](../specs/12-solid-waste.md) |
| 49 | Solid Waste / Route System Integration | System shall generate charges from RAMS work orders based on completion status. | [sp/12](../specs/12-solid-waste.md) |
| 50 | Solid Waste / Route System Integration | System shall provide reconciliation between RAMS service activity and billed charges. | [sp/12](../specs/12-solid-waste.md) |
| 51 | Solid Waste / Route System Integration | The system shall generate pre-bill exception reports for solid waste charges to enable staff review... | [sp/12](../specs/12-solid-waste.md) |
| 52 | Solid Waste / Account / Cart Management | System shall support container delivery or removal effective-date tracking tied to billing... | [sp/12](../specs/12-solid-waste.md) |
| 53 | Solid Waste / Account / Cart Management | System shall support multiple containers of varying types and sizes per property. | [sp/12](../specs/12-solid-waste.md) |
| 54 | Solid Waste / Account / Cart Management | System shall support dispute workflows for solid waste charges. | [sp/12](../specs/12-solid-waste.md) |
| 55 | Solid Waste / Account / Cart Management | System shall allow authorized service-level and rate overrides with audit tracking. | [sp/12](../specs/12-solid-waste.md) |
| 56 | Solid Waste / Account / Cart Management | System shall present a consolidated solid waste service and charge history for inquiry. | [sp/12](../specs/12-solid-waste.md) |
| 57 | Solid Waste / Rate Management & Fees | System shall support container-based billing models including size, quantity, and frequency. | [sp/07](../specs/07-rate-management.md) [sp/12](../specs/12-solid-waste.md) |
| 58 | Solid Waste / Rate Management & Fees | System shall support future-dated solid waste rate and policy changes. | [sp/07](../specs/07-rate-management.md) [sp/12](../specs/12-solid-waste.md) |
| 59 | Solid Waste / Rate Management & Fees | System shall support billing adjustments or credits for missed collections or service failures. | [sp/07](../specs/07-rate-management.md) [sp/12](../specs/12-solid-waste.md) |
| 60 | Water / Wastewater & Stormwater / Service Setup Attributes | System shall support separate water and wastewater services per property, including storm water... | [sp/02](../specs/02-premise-management.md) [sp/05](../specs/05-service-agreement.md) [sp/06](../specs/06-commodity-and-uom.md) |
| 61 | Water / Wastewater & Stormwater / Service Setup Attributes | System shall support multiple services on a single consolidated bill while maintaining... | [sp/09](../specs/09-billing.md) |
| 62 | Water / Wastewater & Stormwater / Service Setup Attributes | System shall support effective-dated enrollment and proration for water services. | [sp/09](../specs/09-billing.md) |
| 63 | Water / Wastewater & Stormwater / Service Setup Attributes | System shall apply regulatory fees and surcharges by service and class. | [sp/03](../specs/03-meter-management.md) |
| 68 | Water / Wastewater & Stormwater / Rate Management | System shall support future-dated rate ordinances without rebilling prior periods (i.e., if new... | [sp/07](../specs/07-rate-management.md) |
| 69 | Water / Wastewater & Stormwater / Rate Management | System shall calculate wastewater charges as a 100% of water usage, except for WQA (Winter Quarter... | [sp/07](../specs/07-rate-management.md) |
| 70 | Water / Wastewater & Stormwater / Rate Management | System shall support caps, minimums, and maximums for wastewater billing, including WQA | [sp/07](../specs/07-rate-management.md) |
| 71 | Water / Wastewater & Stormwater / Rate Management | System supports configurable (e.g., the quarter is five months, daily calculations, etc.) WQA... | [sp/07](../specs/07-rate-management.md) |
| 72 | Water / Wastewater & Stormwater / Rate Management | System shall support winter averaging for wastewater billing, based on City configuration and/or... | [sp/07](../specs/07-rate-management.md) |
| 73 | Water / Wastewater & Stormwater / Rate Management | System supports exclusion of irrigation or non-sewer usage from wastewater calculations. | [sp/07](../specs/07-rate-management.md) |
| 74 | Water / Wastewater & Stormwater / Rate Management | System shall support minimum bills regardless of usage. | [sp/07](../specs/07-rate-management.md) |
| 75 | Water / Wastewater & Stormwater / Meter Read | System shall treat the meter reading system as the authoritative source for meter reads and events. | [sp/08](../specs/08-meter-reading.md) |
| 76 | Water / Wastewater & Stormwater / Meter Read | System shall integrate with the meter reading system via secure APIs or file-based interfaces. | [sp/08](../specs/08-meter-reading.md) |
| 77 | Water / Wastewater & Stormwater / Meter Read | System shall support both incremental and full meter read imports. | [sp/08](../specs/08-meter-reading.md) |
| 78 | Water / Wastewater & Stormwater / Meter Read | System shall support meter read cycle scheduling and read route grouping. | [sp/08](../specs/08-meter-reading.md) |
| 79 | Water / Wastewater & Stormwater / Meter Read | System shall store unique read identifiers and prevent duplicate billing of reads. | [sp/08](../specs/08-meter-reading.md) |
| 80 | Water / Wastewater & Stormwater / Meter Read | System shall associate meter reads to meters | [sp/08](../specs/08-meter-reading.md) |
| 83 | Water / Wastewater & Stormwater / Meter Read | System shall ingest and retain raw interval meter read data. | [sp/08](../specs/08-meter-reading.md) |
| 84 | Water / Wastewater & Stormwater / Meter Read | System shall ingest meter events such as leaks, tamper, or reverse flow. | [sp/08](../specs/08-meter-reading.md) |
| 85 | Water / Wastewater & Stormwater / Meter Read | System shall allow meter events to trigger notifications or billing holds. | [sp/08](../specs/08-meter-reading.md) |
| 86 | Water / Wastewater & Stormwater / Meter Read | System shall support freezing of validated reads once billing is finalized. | [sp/08](../specs/08-meter-reading.md) |
| 87 | Water / Wastewater & Stormwater / Meter Read | System shall retain before-and-after values for corrected reads. | [sp/08](../specs/08-meter-reading.md) |
| 88 | Water / Wastewater & Stormwater / Meter Read | System shall maintain a complete audit trail of meter reads and edits. | [sp/08](../specs/08-meter-reading.md) |
| 89 | Water / Wastewater & Stormwater / Meter Read | System shall allow manual entry or correction of reads with audit tracking. | [sp/08](../specs/08-meter-reading.md) |
| 90 | Water / Wastewater & Stormwater / Meter Read | System shall support new / replacement meters entered and attached to accounts at any time during... | [sp/08](../specs/08-meter-reading.md) |
| 91 | Water / Wastewater & Stormwater / Meter Read | System shall support replaced meters mid-cycle and have both reads total to monthly usage | [sp/08](../specs/08-meter-reading.md) |
| 92 | Water / Wastewater & Stormwater / Meter Read | System shall support mid-cycle final reads and billing (e.g., customer moves and closes account... | [sp/08](../specs/08-meter-reading.md) |
| 101 | Water / Wastewater & Stormwater / Usage Calculations | System shall aggregate interval reads into billable consumption using configurable rules. | [sp/07](../specs/07-rate-management.md) [sp/08](../specs/08-meter-reading.md) [sp/09](../specs/09-billing.md) |
| 102 | Water / Wastewater & Stormwater / Usage Calculations | System shall calculate usage for partial billing periods accurately. | [sp/07](../specs/07-rate-management.md) [sp/08](../specs/08-meter-reading.md) [sp/09](../specs/09-billing.md) |
| 103 | Water / Wastewater & Stormwater / Usage Calculations | System shall support controlled reprocessing and rebilling of corrected reads. | [sp/07](../specs/07-rate-management.md) [sp/08](../specs/08-meter-reading.md) [sp/09](../specs/09-billing.md) |
| 104 | Water / Wastewater & Stormwater / Usage Calculations | System shall provide reconciliation between imported reads and billed consumption. | [sp/07](../specs/07-rate-management.md) [sp/08](../specs/08-meter-reading.md) [sp/09](../specs/09-billing.md) |
| 105 | Water / Wastewater & Stormwater / Usage Calculations | System shall maintain detailed calculation audit trails. | [sp/07](../specs/07-rate-management.md) [sp/08](../specs/08-meter-reading.md) [sp/09](../specs/09-billing.md) |
| 106 | Water / Wastewater & Stormwater / Meter Inventory | System shall synchronize meter and endpoint inventory with the meter management system. | [sp/03](../specs/03-meter-management.md) |
| 108 | Water / Wastewater & Stormwater / Meter Inventory | System shall support scheduled and on-demand meter inventory | [sp/03](../specs/03-meter-management.md) |
| 109 | Water / Wastewater & Stormwater / Meter Inventory | System shall maintain a comprehensive meter and endpoint asset registry. | [sp/03](../specs/03-meter-management.md) |
| 110 | Water / Wastewater & Stormwater / Meter Inventory | System shall maintain chain-of-custody history for meters. | [sp/03](../specs/03-meter-management.md) |
| 111 | Water / Wastewater & Stormwater / Meter Inventory | System shall support effective-dated meter, property, and account associations. | [sp/03](../specs/03-meter-management.md) |
| 112 | Water / Wastewater & Stormwater / Meter Inventory | System shall support master/sub-meter and multi-register configurations. | [sp/03](../specs/03-meter-management.md) |
| 113 | Water / Wastewater & Stormwater / Meter Inventory | System shall support multiple meter types (e.g., temporary, construction, irrigation, etc.) | [sp/03](../specs/03-meter-management.md) |
| 114 | Water / Wastewater & Stormwater / Meter Inventory | System shall support tracking of meter manufacturer, model, size, and serial number. | [sp/03](../specs/03-meter-management.md) |
| 115 | Water / Wastewater & Stormwater / Meter Inventory | System shall support meter inventory location tracking (e.g., warehouse, installed, retired). | [sp/03](../specs/03-meter-management.md) |
| 116 | Water / Wastewater & Stormwater / Meter Inventory | System shall track install, removal, and change-out events with read continuity. | [sp/03](../specs/03-meter-management.md) |
| 117 | Water / Wastewater & Stormwater / Meter Inventory | System shall handle meter rollovers and register configuration changes. | [sp/03](../specs/03-meter-management.md) |
| 118 | Water / Wastewater & Stormwater / Meter Inventory | System shall track meter testing, certification, and failure status. | [sp/03](../specs/03-meter-management.md) |
| 119 | Water / Wastewater & Stormwater / Meter Inventory | System shall support inventory reconciliation between systems. | [sp/03](../specs/03-meter-management.md) |
| 120 | Water / Wastewater & Stormwater / Meter Inventory | System shall route inventory errors to exception queues. | [sp/03](../specs/03-meter-management.md) |
| 121 | Water / Wastewater & Stormwater / Meter Inventory | System shall report on asset status, lifecycle events, and testing due dates. | [sp/03](../specs/03-meter-management.md) |
| 122 | Water / Wastewater & Stormwater / Meter Inventory | System shall flag meters that are nearing end of useful life | [sp/03](../specs/03-meter-management.md) |
| 123 | Water / Wastewater & Stormwater / Meter Inventory | System shall designate meter location in muli-unit building (i.e., Unit A, Unit #102, mechanical... | [sp/03](../specs/03-meter-management.md) |
| 131 | Billing / Bill Cycle Management | System shall support printed bill generation, including export files for third-party print-and-mail... | [sp/09](../specs/09-billing.md) |
| 132 | Billing / Bill Cycle Management | System shall support customer enrollment in paperless billing (e-bill) preferences. | [sp/09](../specs/09-billing.md) |
| 133 | Billing / Bill Cycle Management | System shall support bill reprints and corrected bill issuance with version tracking. | [sp/09](../specs/09-billing.md) |
| 134 | Billing / Bill Cycle Management | System shall support final bill generation at account closure independent of billing cycle. | [sp/09](../specs/09-billing.md) |
| 135 | Billing / Bill Cycle Management | System shall support multiple concurrent billing cycles. | [sp/09](../specs/09-billing.md) |
| 136 | Billing / Bill Cycle Management | System shall support bill holds for individual accounts or events. | [sp/09](../specs/09-billing.md) |
| 137 | Billing / Bill Cycle Management | System shall support bill message management, allowing configurable messages to appear on bills by... | [sp/09](../specs/09-billing.md) |
| 138 | Billing / Bill Calculation | System shall prorate tier thresholds for partial billing periods. | [sp/09](../specs/09-billing.md) [sp/21](../specs/21-saaslogic-billing.md) |
| 139 | Billing / Bill Calculation | System shall itemize charges and calculations on customer bills. | [sp/09](../specs/09-billing.md) [sp/21](../specs/21-saaslogic-billing.md) |
| 140 | Billing / Bill Calculation | System shall validate billed charges against adopted rates. | [sp/09](../specs/09-billing.md) [sp/21](../specs/21-saaslogic-billing.md) |
| 141 | Billing / Bill Calculation | System shall provide reconciliation between water usage and wastewater billing. | [sp/09](../specs/09-billing.md) [sp/21](../specs/21-saaslogic-billing.md) |
| 147 | Billing / Delinquencies & Aging | System shall support establishment of payment  plans for customers | [sp/11](../specs/11-delinquency.md) |
| 148 | Billing / Delinquencies & Aging | System shall support customer notification when payment plans are established, modified, or... | [sp/11](../specs/11-delinquency.md) |
| 149 | Billing / Delinquencies & Aging | System shall provide an interactive aging dashboard that displays real-time account receivable... | [sp/11](../specs/11-delinquency.md) |
| 154 | Billing / Payment Allocation & Multi‑Account Support | System shall support configurable payment allocation rules across multiple services, balances, and... | [sp/10](../specs/10-payments-and-collections.md) |
| 155 | Billing / Payment Allocation & Multi‑Account Support | System shall support partial payments, overpayments, and advance (pre-pay) balances, with clear... | [sp/10](../specs/10-payments-and-collections.md) |
| 156 | Billing / Payment Allocation & Multi‑Account Support | The portal shall allow customers to view payment history, balances, credits, and adjustments by... | [sp/10](../specs/10-payments-and-collections.md) |
| 157 | Billing / Payment Processing | System shall support acceptance of multiple payment methods, including credit cards, debit cards,... | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) |
| 158 | Billing / Payment Processing | System shall support PCI DSS-compliant payment processing and ensure that sensitive payment... | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) |
| 159 | Billing / Payment Processing | System shall support both real-time payment posting (e.g., online payments) and batch payment... | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) |
| 160 | Billing / Payment Processing | System shall provide payment confirmations and receipts via the portal and optional email or SMS... | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) |
| 161 | Billing / Payment Processing | System shall provide daily and period-end reconciliation reports comparing payments received,... | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) |
| 162 | Billing / Payment Processing | System shall support integration with enterprise POS system, if implemented by City | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) |
| 163 | Billing / Payment Processing | System shall support automatic payment reversal handling (e.g., ACH returns, chargebacks) with... | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) |
| 164 | Billing / Payment Processing | The systems shall support real time integration with payment system so payments are reflected in... | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) |
| 181 | Service Requests / Service Request Intake & Definition | System shall associate service requests to GIS properties. | [sp/14](../specs/14-service-requests.md) |
| 182 | Service Requests / Service Request Intake & Definition | System shall support configurable service request types and subtypes. | [sp/14](../specs/14-service-requests.md) |
| 183 | Service Requests / Service Request Intake & Definition | System shall support scheduled and unscheduled service requests. | [sp/14](../specs/14-service-requests.md) |
| 184 | Service Requests / Service Request Intake & Definition | System shall support attachments such as photos or notes for service requests. | [sp/14](../specs/14-service-requests.md) |
| 185 | Service Requests / Prioritization, Assignment & SLA Management | System shall support priority or severity levels for service requests. | [sp/14](../specs/14-service-requests.md) |
| 186 | Service Requests / Prioritization, Assignment & SLA Management | System shall support assignment of service requests to specific users or work groups. | [sp/14](../specs/14-service-requests.md) |
| 193 | Service Requests / Service Execution & Lifecycle Management | System shall distinguish completed, canceled, incomplete, and no-access requests. | [sp/14](../specs/14-service-requests.md) |
| 194 | Service Requests / Service Execution & Lifecycle Management | System shall identify repeat service requests within a defined timeframe. | [sp/14](../specs/14-service-requests.md) |
| 195 | Service Requests / Service Execution & Lifecycle Management | System shall support dispute handling for service-request-related charges. | [sp/14](../specs/14-service-requests.md) |
| 196 | Service Requests / Service Execution & Lifecycle Management | System shall maintain a full audit trail for service requests. | [sp/14](../specs/14-service-requests.md) |
| 197 | Service Requests / Service Execution & Lifecycle Management | System shall report on request volumes, SLAs, and billing outcomes. | [sp/14](../specs/14-service-requests.md) |
| 198 | Service Requests / Delinquency Work Orders | System shall create internal service requests / work orders for door hangers or shut offs when ... | [sp/11](../specs/11-delinquency.md) [sp/14](../specs/14-service-requests.md) |
| 199 | Service Requests / Delinquency Work Orders | System shall create internal service requests / work orders for turning back on after shut offs are... | [sp/11](../specs/11-delinquency.md) [sp/14](../specs/14-service-requests.md) |
| 200 | Service Requests / Billing, Disputes & Customer Communications | System shall generate charges or credits upon service request completion. | [sp/10](../specs/10-payments-and-collections.md) [sp/14](../specs/14-service-requests.md) |

## 3. Full requirements list (grouped by area / process)

### Customer - Property File - Property / Service Location Management
*Reqs 1-8 (8 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **1** | System shall treat the City's GIS system as the authoritative system of record for all property-, parcel-, and premise-related... | Y-WC | 1 | [bz/14](./14-special-assessments.md) | [sp/02](../specs/02-premise-management.md) | - |
| **2** | System shall support configurable synchronization schedules with GIS, including near-real-time, scheduled batch (e.g. daily), and... | Y | 1 | [bz/14](./14-special-assessments.md) | [sp/02](../specs/02-premise-management.md) | - |
| **3** | System shall store and persist GIS-origin unique identifiers such as Parcel ID and Premise ID. | Y | 1 | [bz/14](./14-special-assessments.md) | [sp/02](../specs/02-premise-management.md) | - |
| **4** | System shall consume and display GIS-sourced service addresses while preserving address history. | Y | 1 | [bz/14](./14-special-assessments.md) | [sp/02](../specs/02-premise-management.md) | - |
| **5** | System shall support effective-dated account-to-property relationships. | Y | 1 | [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/05](../specs/05-service-agreement.md) | [plan/2026-04-26](../superpowers/plans/2026-04-26-effective-dating-constraints.md) |
| **6** | System shall use GIS attributes to determine default rates and service availability. | Y | 1 | [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/07](../specs/07-rate-management.md) | - |
| **7** | System shall restrict manual overrides of GIS-sourced attributes to authorized users with audit logging. | Y | 1 | [bz/01](./01-audit-and-tamper-evidence.md) [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/02](../specs/02-premise-management.md) | - |
| **8** | System shall support multiple service types at locations (e.g., water and solid waste, solid waste only, etc.) | Y | 1 | - | [sp/02](../specs/02-premise-management.md) | - |

### Customer - Property File - Customer Account Management
*Reqs 9-24 (16 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **9** | System shall support multiple customer accounts associated to a single GIS property. | Y | 1 | [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) [sp/05](../specs/05-service-agreement.md) | - |
| **10** | System shall support a single customer account associated with multiple GIS properties. | Y | 1 | [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) [sp/05](../specs/05-service-agreement.md) | - |
| **11** | System shall allow user-defined required fields in the customer file | Y | 1 | [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) [sp/05](../specs/05-service-agreement.md) | - |
| **12** | System shall support multiple customer types (e.g., residential, commercial, multi-family, government, etc.) | Y | 1 | [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) [sp/05](../specs/05-service-agreement.md) | - |
| **13** | System shall support multiple contacts per customer account, with configurable roles (e.g., primary, billing contact, authorized... | Y | 1 | [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) [sp/05](../specs/05-service-agreement.md) | - |
| **14** | System shall support landlord / tenant relationships (i.e., the billing account holder may be different form the property owner) | Y | 1 | [bz/05](./05-customer-portal.md) | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) | - |
| **15** | System shall support transfer of service where one account is closed and another opened without loss of data on customer history | Y | 1 | [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/05](../specs/05-service-agreement.md) | - |
| **16** | System shall support duplicate customer detection using configurable matching criteria. | Y | 1 | - | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) | - |
| **17** | System supports alternate bill to addresses that differ from the service address | Y | 1 | - | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) | - |
| **18** | System supports international billing addresses | Y | 1 | - | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) | - |
| **19** | The system requires deposits for certain account types (e.g., renters are required to provide a deposit for trash service) | Y | 1 | - | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) | - |
| **20** | System shall support refunds of deposits when account is closed in good standing | Y | 1 | - | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) | - |
| **21** | System shall support applying deposit to unpaid charges | Y | 1 | - | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) | - |
| **22** | System shall support customer account status values (e.g., active, inactive, pending start, final billed). | Y | 1 | - | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) | - |
| **23** | System flags customers with delinquent accounts and make delinquency status visible during account lookup and service set up. | Y | 1 | - | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) | - |
| **24** |  | Y | 1 | - | [sp/01](../specs/01-customer-management.md) [sp/04](../specs/04-account-management.md) | - |

### Customer - Property File - Account & Property History Management
*Reqs 25-26 (2 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **25** | System shall retain historical GIS property records for audit and inquiry purposes. | Y | 1 | [bz/01](./01-audit-and-tamper-evidence.md) [bz/08](./08-data-retention-archival-purge.md) [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/17](../specs/17-reporting-and-audit.md) | - |
| **26** | System shall maintain a consolidated account history view including billing, payments, service requests, and service changes. | Y | 1 | [bz/01](./01-audit-and-tamper-evidence.md) [bz/08](./08-data-retention-archival-purge.md) | [sp/17](../specs/17-reporting-and-audit.md) | - |

### Customer - Property File - Notifications & Customer Communications Management
*Reqs 27-33 (7 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **27** | System shall support automated customer notifications delivered via email, SMS/text message, and postal mail, with channel... | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/13](../specs/13-notifications.md) | - |
| **28** | System shall support configurable notification triggers based on account or property events, such as bill availability, upcoming... | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/13](../specs/13-notifications.md) | - |
| **29** | System shall allow staff to create, edit, and manage standardized communication templates, including configurable subject lines,... | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/13](../specs/13-notifications.md) | - |
| **30** | System shall support bulk or mass communications to defined customer segments (e.g., by service type, billing cycle, geographic... | Y | 1 | [bz/01](./01-audit-and-tamper-evidence.md) [bz/13](./13-workflow-approvals-action-queue.md) | [sp/13](../specs/13-notifications.md) | - |
| **31** | System shall support opt-in and opt-out management for electronic communications, including SMS consent tracking, in accordance... | Y | 1 | [bz/05](./05-customer-portal.md) [bz/13](./13-workflow-approvals-action-queue.md) | [sp/13](../specs/13-notifications.md) | - |
| **32** | System shall support customer communication preferences (e.g. mail, email, phone, sms) and opt-in/opt-out tracking. | Y | 1 | - | [sp/13](../specs/13-notifications.md) | - |
| **33** | System shall maintain a complete communication history viewable at the customer and account level, including message type,... | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/13](../specs/13-notifications.md) | - |

### Customer - Property File - Customer Portal & Self-Service
*Reqs 34-41 (8 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **34** | System shall provide a secure web-based customer portal. | Y | 1 | [bz/05](./05-customer-portal.md) | [sp/15](../specs/15-customer-portal.md) | - |
| **35** | System shall allow customers to view account and property information. | Y | 1 | [bz/05](./05-customer-portal.md) | [sp/15](../specs/15-customer-portal.md) | - |
| **36** | System allows customers to update contact information (e.g., phone number or email) | Y | 1 | [bz/05](./05-customer-portal.md) | [sp/15](../specs/15-customer-portal.md) | - |
| **37** | System shall allow customers to manage communication preferences. | Y | 1 | [bz/05](./05-customer-portal.md) [bz/13](./13-workflow-approvals-action-queue.md) | [sp/15](../specs/15-customer-portal.md) | - |
| **38** | System shall provide a secure customer self-service portal supporting account registration, authentication, password management,... | Y | 1 | [bz/05](./05-customer-portal.md) | [sp/15](../specs/15-customer-portal.md) | - |
| **39** | The portal shall support configurable identity verification during account registration (e.g., account number, service address,... | Y | 1 | [bz/05](./05-customer-portal.md) | [sp/15](../specs/15-customer-portal.md) | - |
| **40** | The portal shall support recurring payment enrollment, with configurable schedules, funding sources, and customer notifications | Y | 1 | [bz/05](./05-customer-portal.md) | [sp/10](../specs/10-payments-and-collections.md) [sp/15](../specs/15-customer-portal.md) | - |
| **41** | The portal shall support configurable billing and payment alerts (e.g., bill ready, due soon, past due, payment failed) via... | Y | 1 | [bz/05](./05-customer-portal.md) [bz/13](./13-workflow-approvals-action-queue.md) | [sp/13](../specs/13-notifications.md) [sp/15](../specs/15-customer-portal.md) | - |

### Solid Waste - Service Set‑Up
*Reqs 42-46 (5 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **42** | System shall determine solid waste service eligibility and defaults using GIS attributes. | Y | 1 | [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/12](../specs/12-solid-waste.md) | - |
| **43** | System shall support multiple solid waste service types per property, each billed independently. | Y | 1 | - | [sp/12](../specs/12-solid-waste.md) | - |
| **44** | System shall support effective-dated enrollment and proration for solid waste services. | Y | 1 | - | [sp/12](../specs/12-solid-waste.md) | - |
| **45** | System shall support seasonal services and temporary service suspensions, including by service type (e.g., trash service may be... | Y | 1 | - | [sp/12](../specs/12-solid-waste.md) | - |
| **46** | System shall support temporary service holds or vacation suspensions with automatic billing suspension and restart. | Y | 1 | - | [sp/12](../specs/12-solid-waste.md) | - |

### Solid Waste - Route System Integration
*Reqs 47-51 (5 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **47** | System shall ingest ad hoc solid waste service events from RAMS and convert them to billable charges (e.g., excessive trash, bulk... | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/12](../specs/12-solid-waste.md) | - |
| **48** | System shall provide configurable mapping between RAMS service codes and billing charge codes. | Y | 1 | - | [sp/12](../specs/12-solid-waste.md) | - |
| **49** | System shall generate charges from RAMS work orders based on completion status. | Y | 1 | - | [sp/12](../specs/12-solid-waste.md) | - |
| **50** | System shall provide reconciliation between RAMS service activity and billed charges. | Y | 1 | - | [sp/12](../specs/12-solid-waste.md) | - |
| **51** | The system shall generate pre-bill exception reports for solid waste charges to enable staff review and correct if necessary... | Y | 1 | - | [sp/12](../specs/12-solid-waste.md) | - |

### Solid Waste - Account / Cart Management
*Reqs 52-56 (5 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **52** | System shall support container delivery or removal effective-date tracking tied to billing start/stop events. | Y | 1 | - | [sp/12](../specs/12-solid-waste.md) | - |
| **53** | System shall support multiple containers of varying types and sizes per property. | Y | 1 | - | [sp/12](../specs/12-solid-waste.md) | - |
| **54** | System shall support dispute workflows for solid waste charges. | Y | 1 | - | [sp/12](../specs/12-solid-waste.md) | - |
| **55** | System shall allow authorized service-level and rate overrides with audit tracking. | Y | 1 | - | [sp/12](../specs/12-solid-waste.md) | - |
| **56** | System shall present a consolidated solid waste service and charge history for inquiry. | Y | 1 | - | [sp/12](../specs/12-solid-waste.md) | - |

### Solid Waste - Rate Management & Fees
*Reqs 57-59 (3 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **57** | System shall support container-based billing models including size, quantity, and frequency. | Y | 1 | - | [sp/07](../specs/07-rate-management.md) [sp/12](../specs/12-solid-waste.md) | - |
| **58** | System shall support future-dated solid waste rate and policy changes. | Y | 1 | - | [sp/07](../specs/07-rate-management.md) [sp/12](../specs/12-solid-waste.md) | - |
| **59** | System shall support billing adjustments or credits for missed collections or service failures. | Y | 1 | - | [sp/07](../specs/07-rate-management.md) [sp/12](../specs/12-solid-waste.md) | - |

### Water / Wastewater & Stormwater - Service Setup Attributes
*Reqs 60-64 (5 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **60** | System shall support separate water and wastewater services per property, including storm water services. | Y | 1 | - | [sp/02](../specs/02-premise-management.md) [sp/05](../specs/05-service-agreement.md) [sp/06](../specs/06-commodity-and-uom.md) | - |
| **61** | System shall support multiple services on a single consolidated bill while maintaining service-level accounting. | Y | 1 | - | [sp/09](../specs/09-billing.md) | - |
| **62** | System shall support effective-dated enrollment and proration for water services. | Y | 1 | - | [sp/09](../specs/09-billing.md) | - |
| **63** | System shall apply regulatory fees and surcharges by service and class. | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **64** | System shall apply taxes and franchise fees using configurable rules. | Y | 1 | [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/05](../specs/05-service-agreement.md) | - |

### Water / Wastewater & Stormwater - Rate Management
*Reqs 65-74 (10 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **65** | System shall support meter multiplier or scaling factors used in consumption calculations. | Y | 1 | [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/07](../specs/07-rate-management.md) | - |
| **66** | System shall support multiple water rate structures, including fixed, tiered, flat, and seasonal. | Y | 1 | [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/07](../specs/07-rate-management.md) | - |
| **67** | System shall support different water rate structures by customer type (e.g., commercial, residential, etc.). | Y | 1 | [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/07](../specs/07-rate-management.md) | - |
| **68** | System shall support future-dated rate ordinances without rebilling prior periods (i.e., if new rate ordinance goes into effect... | Y | 1 | - | [sp/07](../specs/07-rate-management.md) | - |
| **69** | System shall calculate wastewater charges as a 100% of water usage, except for WQA (Winter Quarter Average) | Y | 1 | - | [sp/07](../specs/07-rate-management.md) | - |
| **70** | System shall support caps, minimums, and maximums for wastewater billing, including WQA | Y | 1 | - | [sp/07](../specs/07-rate-management.md) | - |
| **71** | System supports configurable (e.g., the quarter is five months, daily calculations, etc.) WQA calculations, including flagging... | Y | 1 | - | [sp/07](../specs/07-rate-management.md) | - |
| **72** | System shall support winter averaging for wastewater billing, based on City configuration and/or policy, including non-rounded... | Y | 1 | - | [sp/07](../specs/07-rate-management.md) | - |
| **73** | System supports exclusion of irrigation or non-sewer usage from wastewater calculations. | Y | 1 | - | [sp/07](../specs/07-rate-management.md) | - |
| **74** | System shall support minimum bills regardless of usage. | Y | 1 | - | [sp/07](../specs/07-rate-management.md) | - |

### Water / Wastewater & Stormwater - Meter Read
*Reqs 75-92 (18 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **75** | System shall treat the meter reading system as the authoritative source for meter reads and events. | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **76** | System shall integrate with the meter reading system via secure APIs or file-based interfaces. | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **77** | System shall support both incremental and full meter read imports. | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **78** | System shall support meter read cycle scheduling and read route grouping. | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **79** | System shall store unique read identifiers and prevent duplicate billing of reads. | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **80** | System shall associate meter reads to meters | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **81** | System shall support multi-register meter read handling. | Y | 1 | [bz/09](./09-bulk-upload-and-data-ingestion.md) | [sp/08](../specs/08-meter-reading.md) | - |
| **82** | System shall clearly label estimated versus actual reads. | Y | 1 | [bz/09](./09-bulk-upload-and-data-ingestion.md) | [sp/08](../specs/08-meter-reading.md) | - |
| **83** | System shall ingest and retain raw interval meter read data. | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **84** | System shall ingest meter events such as leaks, tamper, or reverse flow. | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **85** | System shall allow meter events to trigger notifications or billing holds. | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **86** | System shall support freezing of validated reads once billing is finalized. | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **87** | System shall retain before-and-after values for corrected reads. | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **88** | System shall maintain a complete audit trail of meter reads and edits. | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **89** | System shall allow manual entry or correction of reads with audit tracking. | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **90** | System shall support new / replacement meters entered and attached to accounts at any time during the reading/billing cycle | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **91** | System shall support replaced meters mid-cycle and have both reads total to monthly usage | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |
| **92** | System shall support mid-cycle final reads and billing (e.g., customer moves and closes account during the billing cycle) | Y | 1 | - | [sp/08](../specs/08-meter-reading.md) | - |

### Water / Wastewater & Stormwater - Exception Management
*Reqs 93-100 (8 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **93** | System shall validate reads using configurable exception thresholds. | Y | 1 | [bz/07](./07-data-validation.md) | [sp/08](../specs/08-meter-reading.md) | - |
| **94** | System shall flag and route abnormal reads (e.g., no use, excessive use, etc.) to exception review prior to billing. | Y | 1 | [bz/07](./07-data-validation.md) | [sp/08](../specs/08-meter-reading.md) | - |
| **95** | System shall flag and route invalid reads to exception review prior to billing. | Y | 1 | [bz/07](./07-data-validation.md) | [sp/08](../specs/08-meter-reading.md) | - |
| **96** | System shall support estimation and substitution rules when reads are missing or invalid. | Y | 1 | [bz/07](./07-data-validation.md) | [sp/08](../specs/08-meter-reading.md) | - |
| **97** | System shall provide error handling and reprocessing for failed read imports. | Y | 1 | [bz/07](./07-data-validation.md) | [sp/08](../specs/08-meter-reading.md) | - |
| **98** | System shall support backflow or reverse flow consumption handling rules. | Y | 1 | [bz/07](./07-data-validation.md) | [sp/08](../specs/08-meter-reading.md) | - |
| **99** | System shall support configurable leak adjustment processing. | Y | 1 | [bz/07](./07-data-validation.md) | [sp/08](../specs/08-meter-reading.md) | - |
| **100** | System provides exception reports for staff to review (e.g., leaks, zero consumption, significant changes from prior year, etc.) | Y | 1 | [bz/07](./07-data-validation.md) | [sp/08](../specs/08-meter-reading.md) | - |

### Water / Wastewater & Stormwater - Usage Calculations
*Reqs 101-105 (5 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **101** | System shall aggregate interval reads into billable consumption using configurable rules. | Y | 1 | - | [sp/07](../specs/07-rate-management.md) [sp/08](../specs/08-meter-reading.md) [sp/09](../specs/09-billing.md) | - |
| **102** | System shall calculate usage for partial billing periods accurately. | Y | 1 | - | [sp/07](../specs/07-rate-management.md) [sp/08](../specs/08-meter-reading.md) [sp/09](../specs/09-billing.md) | - |
| **103** | System shall support controlled reprocessing and rebilling of corrected reads. | Y | 1 | - | [sp/07](../specs/07-rate-management.md) [sp/08](../specs/08-meter-reading.md) [sp/09](../specs/09-billing.md) | - |
| **104** | System shall provide reconciliation between imported reads and billed consumption. | Y | 1 | - | [sp/07](../specs/07-rate-management.md) [sp/08](../specs/08-meter-reading.md) [sp/09](../specs/09-billing.md) | - |
| **105** | System shall maintain detailed calculation audit trails. | Y | 1 | - | [sp/07](../specs/07-rate-management.md) [sp/08](../specs/08-meter-reading.md) [sp/09](../specs/09-billing.md) | - |

### Water / Wastewater & Stormwater - Meter Inventory
*Reqs 106-123 (18 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **106** | System shall synchronize meter and endpoint inventory with the meter management system. | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **107** | System shall support bulk meter inventory imports and updates from external systems. | Y | 1 | [bz/09](./09-bulk-upload-and-data-ingestion.md) | [sp/03](../specs/03-meter-management.md) | - |
| **108** | System shall support scheduled and on-demand meter inventory | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **109** | System shall maintain a comprehensive meter and endpoint asset registry. | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **110** | System shall maintain chain-of-custody history for meters. | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **111** | System shall support effective-dated meter, property, and account associations. | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **112** | System shall support master/sub-meter and multi-register configurations. | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **113** | System shall support multiple meter types (e.g., temporary, construction, irrigation, etc.) | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **114** | System shall support tracking of meter manufacturer, model, size, and serial number. | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **115** | System shall support meter inventory location tracking (e.g., warehouse, installed, retired). | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **116** | System shall track install, removal, and change-out events with read continuity. | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **117** | System shall handle meter rollovers and register configuration changes. | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **118** | System shall track meter testing, certification, and failure status. | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **119** | System shall support inventory reconciliation between systems. | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **120** | System shall route inventory errors to exception queues. | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **121** | System shall report on asset status, lifecycle events, and testing due dates. | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **122** | System shall flag meters that are nearing end of useful life | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |
| **123** | System shall designate meter location in muli-unit building (i.e., Unit A, Unit #102, mechanical room, etc.) | Y | 1 | - | [sp/03](../specs/03-meter-management.md) | - |

### Water / Wastewater & Stormwater - Delinquency Management
*Reqs 124-126 (3 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **124** | System shall allow authorized users to configure rules that determine eligibility for water shut off (e.g., past due amount, days... | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/11](../specs/11-delinquency.md) | - |
| **125** | System shall support multiple notice levels (e.g., courtesy notice, past due notice, shut off warning, final shut off notice,... | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/11](../specs/11-delinquency.md) [sp/13](../specs/13-notifications.md) | - |
| **126** | System shall automatically identify accounts meeting the defined criteria for each notice tier and for water shut off eligibility... | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/11](../specs/11-delinquency.md) | - |

### Water / Wastewater & Stormwater - General
*Reqs 127-127 (1 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **127** | The system shall include a configurable reporting module to create, modify, and save custom and ad hoc reports. Users must be... | Y | 1 | [bz/06](./06-custom-fields.md) | [sp/17](../specs/17-reporting-and-audit.md) | - |

### Billing - Bill Cycle Management
*Reqs 128-137 (10 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **128** | The portal shall display current and historical utility bills, including itemized charges, quantities, rates, and billing periods | Y | 1 | [bz/05](./05-customer-portal.md) | [sp/09](../specs/09-billing.md) [sp/15](../specs/15-customer-portal.md) | - |
| **129** | The portal shall support consolidated bill viewing for customers with multiple services (e.g., water, wastewater, solid waste) | Y | 1 | [bz/05](./05-customer-portal.md) | [sp/09](../specs/09-billing.md) [sp/15](../specs/15-customer-portal.md) | - |
| **130** | System shall generate PDF or equivalent bill documents and retain historical bill images for customer access and City records... | Y | 1 | [bz/05](./05-customer-portal.md) | [sp/09](../specs/09-billing.md) [sp/15](../specs/15-customer-portal.md) | - |
| **131** | System shall support printed bill generation, including export files for third-party print-and-mail vendors and City-defined bill... | Y | 1 | - | [sp/09](../specs/09-billing.md) | - |
| **132** | System shall support customer enrollment in paperless billing (e-bill) preferences. | Y | 1 | - | [sp/09](../specs/09-billing.md) | - |
| **133** | System shall support bill reprints and corrected bill issuance with version tracking. | Y | 1 | - | [sp/09](../specs/09-billing.md) | - |
| **134** | System shall support final bill generation at account closure independent of billing cycle. | Y | 1 | - | [sp/09](../specs/09-billing.md) | - |
| **135** | System shall support multiple concurrent billing cycles. | Y | 1 | - | [sp/09](../specs/09-billing.md) | - |
| **136** | System shall support bill holds for individual accounts or events. | Y | 1 | - | [sp/09](../specs/09-billing.md) | - |
| **137** | System shall support bill message management, allowing configurable messages to appear on bills by account type, service, or... | Y | 1 | - | [sp/09](../specs/09-billing.md) | - |

### Billing - Bill Calculation
*Reqs 138-141 (4 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **138** | System shall prorate tier thresholds for partial billing periods. | Y | 1 | - | [sp/09](../specs/09-billing.md) [sp/21](../specs/21-saaslogic-billing.md) | - |
| **139** | System shall itemize charges and calculations on customer bills. | Y | 1 | - | [sp/09](../specs/09-billing.md) [sp/21](../specs/21-saaslogic-billing.md) | - |
| **140** | System shall validate billed charges against adopted rates. | Y | 1 | - | [sp/09](../specs/09-billing.md) [sp/21](../specs/21-saaslogic-billing.md) | - |
| **141** | System shall provide reconciliation between water usage and wastewater billing. | Y | 1 | - | [sp/09](../specs/09-billing.md) [sp/21](../specs/21-saaslogic-billing.md) | - |

### Billing - Billing Adjustments
*Reqs 142-144 (3 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **142** | System shall rebill water and wastewater charges when reads are corrected. | Y | 1 | [bz/12](./12-corrections-and-reversals.md) | [sp/09](../specs/09-billing.md) | - |
| **143** | System shall support ad hoc or special fees to be added to account | Y | 1 | [bz/12](./12-corrections-and-reversals.md) | [sp/10](../specs/10-payments-and-collections.md) | - |
| **144** | Ad hoc or special fees can be added to individual accounts, all customers, or customer subsets | Y | 1 | [bz/12](./12-corrections-and-reversals.md) | [sp/10](../specs/10-payments-and-collections.md) | - |

### Billing - Delinquencies & Aging
*Reqs 145-151 (7 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **145** | System shall automatically apply user-defined late fees/penalties when applicable | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/11](../specs/11-delinquency.md) | - |
| **146** | System shall provide account write-off workflow for uncollectable bills | Y | 1 | [bz/12](./12-corrections-and-reversals.md) | [sp/10](../specs/10-payments-and-collections.md) | - |
| **147** | System shall support establishment of payment  plans for customers | Y | 1 | - | [sp/11](../specs/11-delinquency.md) | - |
| **148** | System shall support customer notification when payment plans are established, modified, or defaulted. | Y | 1 | - | [sp/11](../specs/11-delinquency.md) | - |
| **149** | System shall provide an interactive aging dashboard that displays real-time account receivable balances segmented by configurable... | Y | 1 | - | [sp/11](../specs/11-delinquency.md) | - |
| **150** | The aging dashboard shall display data updated in real time or near-real time, reflecting all posted payments, adjustments,... | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/11](../specs/11-delinquency.md) | - |
| **151** | System shall allow authorized users to configure rules that determine eligibility for water shut off (e.g., past due amount, days... | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/11](../specs/11-delinquency.md) | - |

### Billing - Payment Allocation & Multi‑Account Support
*Reqs 152-156 (5 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **152** | The portal shall allow customers to view and manage multiple utility accounts or properties under a single login | Y | 1 | [bz/05](./05-customer-portal.md) | [sp/15](../specs/15-customer-portal.md) | - |
| **153** | System shall support third-party payer or authorized user access to accounts. | Y | 1 | [bz/05](./05-customer-portal.md) | [sp/15](../specs/15-customer-portal.md) | - |
| **154** | System shall support configurable payment allocation rules across multiple services, balances, and aging buckets | Y | 1 | - | [sp/10](../specs/10-payments-and-collections.md) | - |
| **155** | System shall support partial payments, overpayments, and advance (pre-pay) balances, with clear application rules and customer... | Y | 1 | - | [sp/10](../specs/10-payments-and-collections.md) | - |
| **156** | The portal shall allow customers to view payment history, balances, credits, and adjustments by account and service | Y | 1 | - | [sp/10](../specs/10-payments-and-collections.md) | - |

### Billing - Payment Processing
*Reqs 157-164 (8 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **157** | System shall support acceptance of multiple payment methods, including credit cards, debit cards, ACH/eCheck, etc., as well as... | Y | 1 | - | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) | - |
| **158** | System shall support PCI DSS-compliant payment processing and ensure that sensitive payment information is not stored in the... | Y | 1 | - | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) | - |
| **159** | System shall support both real-time payment posting (e.g., online payments) and batch payment imports (e.g., lockbox, kiosk,... | Y | 1 | - | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) | - |
| **160** | System shall provide payment confirmations and receipts via the portal and optional email or SMS notifications | Y | 1 | - | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) | - |
| **161** | System shall provide daily and period-end reconciliation reports comparing payments received, posted amounts, fees, and deposits | Y | 1 | - | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) | - |
| **162** | System shall support integration with enterprise POS system, if implemented by City | Y | 1 | - | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) | - |
| **163** | System shall support automatic payment reversal handling (e.g., ACH returns, chargebacks) with automatic balance adjustments. | Y | 1 | - | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) | - |
| **164** | The systems shall support real time integration with payment system so payments are reflected in accounts as soon as payments are... | Y | 1 | - | [sp/10](../specs/10-payments-and-collections.md) [sp/21](../specs/21-saaslogic-billing.md) | - |

### Special Assessments - Assessment & District Configuration
*Reqs 165-167 (3 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **165** | System shall support the creation and management of Special Assessment Districts. | Y-WC | 1 | [bz/14](./14-special-assessments.md) | [sp/16](../specs/16-special-assessments.md) | - |
| **166** | System shall support multiple active special assessment districts simultaneously, including parcels that may belong to more than... | Y-WC | 1 | [bz/14](./14-special-assessments.md) | [sp/16](../specs/16-special-assessments.md) | - |
| **167** | System shall allow staff to activate, deactivate, or sunset special assessment districts without impacting historical billing,... | Y-WC | 1 | [bz/14](./14-special-assessments.md) | [sp/16](../specs/16-special-assessments.md) | - |

### Special Assessments - Parcel Integration & Attribute Management
*Reqs 168-171 (4 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **168** | System shall support property-based billing, where special assessments are associated with a parcel or service location rather... | Y | 1 | [bz/14](./14-special-assessments.md) [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/16](../specs/16-special-assessments.md) | - |
| **169** | System shall integrate with the City's enterprise GIS and/or external parcel systems to import and reference parcel attributes... | Y-WC | 1 | [bz/14](./14-special-assessments.md) [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/16](../specs/16-special-assessments.md) | - |
| **170** | System shall automatically transfer special assessment obligations to the new property owner when ownership changes, without... | Y-WC | 1 | [bz/14](./14-special-assessments.md) [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/16](../specs/16-special-assessments.md) | - |
| **171** | System shall allow manual overrides or adjustments to assessment charges at the parcel level, subject to role-based security and... | Y | 1 | [bz/14](./14-special-assessments.md) [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | [sp/16](../specs/16-special-assessments.md) | - |

### Special Assessments - Assessment Calculation & Billing
*Reqs 172-175 (4 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **172** | System shall allow special assessment calculations to be based on configurable formulas, including flat rates, attribute-based... | Y-WC | 1 | [bz/14](./14-special-assessments.md) | [sp/16](../specs/16-special-assessments.md) | - |
| **173** | System shall support recurring assessment charges billed on configurable schedules, including annual and semi-annual billing... | Y | 1 | [bz/14](./14-special-assessments.md) | [sp/16](../specs/16-special-assessments.md) | - |
| **174** | System shall track and display outstanding assessment balances separately from utility charges. | Y | 1 | [bz/14](./14-special-assessments.md) | [sp/16](../specs/16-special-assessments.md) | - |
| **175** | System shall support billing and collections rules specific to special assessments, including late fees or penalties where... | Y | 1 | [bz/14](./14-special-assessments.md) | [sp/16](../specs/16-special-assessments.md) | - |

### Special Assessments - Installments, Payments & Balance Management
*Reqs 176-179 (4 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **176** | System shall support installment-based or loan-type assessments, including principal, interest (if applicable), term length, and... | Y-WC | 1 | [bz/14](./14-special-assessments.md) | [sp/16](../specs/16-special-assessments.md) | - |
| **177** | System shall allow early payoff or full prepayment of special assessment balances at any time, with automatic recalculation of... | Y | 1 | [bz/05](./05-customer-portal.md) [bz/14](./14-special-assessments.md) | [sp/15](../specs/15-customer-portal.md) [sp/16](../specs/16-special-assessments.md) | - |
| **178** | System shall maintain a complete audit trail of special assessment setup, calculation changes, payments, payoffs, transfers, and... | Y-WC | 1 | [bz/14](./14-special-assessments.md) | [sp/16](../specs/16-special-assessments.md) | - |
| **179** | System shall provide reporting and inquiry capabilities for special assessments, including district summaries, parcel-level... | Y-WC | 1 | [bz/14](./14-special-assessments.md) | [sp/16](../specs/16-special-assessments.md) | - |

### Service Requests - Service Request Intake & Definition
*Reqs 180-184 (5 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **180** | System shall support service request intake via CSR, portal, and API. | Y | 1 | [bz/05](./05-customer-portal.md) | [sp/14](../specs/14-service-requests.md) | - |
| **181** | System shall associate service requests to GIS properties. | Y | 1 | - | [sp/14](../specs/14-service-requests.md) | - |
| **182** | System shall support configurable service request types and subtypes. | Y | 1 | - | [sp/14](../specs/14-service-requests.md) | - |
| **183** | System shall support scheduled and unscheduled service requests. | Y | 1 | - | [sp/14](../specs/14-service-requests.md) | - |
| **184** | System shall support attachments such as photos or notes for service requests. | Y | 1 | - | [sp/14](../specs/14-service-requests.md) | - |

### Service Requests - Prioritization, Assignment & SLA Management
*Reqs 185-188 (4 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **185** | System shall support priority or severity levels for service requests. | Y | 1 | - | [sp/14](../specs/14-service-requests.md) | - |
| **186** | System shall support assignment of service requests to specific users or work groups. | Y | 1 | - | [sp/14](../specs/14-service-requests.md) | - |
| **187** | System shall support SLAs by service request type. | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/14](../specs/14-service-requests.md) | - |
| **188** | System shall support escalation workflows when SLA thresholds are exceeded. | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/14](../specs/14-service-requests.md) | - |

### Service Requests - Work Order Routing & External System Integration
*Reqs 189-192 (4 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **189** | System shall route solid waste service requests to RAMS. | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/14](../specs/14-service-requests.md) | - |
| **190** | System shall route water service requests to the appropriate work system. | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/14](../specs/14-service-requests.md) | - |
| **191** | System shall support bi-directional status updates with external systems. | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/14](../specs/14-service-requests.md) | - |
| **192** | System shall support linking multiple service requests to a single work order when appropriate. | Y | 1 | [bz/13](./13-workflow-approvals-action-queue.md) | [sp/14](../specs/14-service-requests.md) | - |

### Service Requests - Service Execution & Lifecycle Management
*Reqs 193-197 (5 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **193** | System shall distinguish completed, canceled, incomplete, and no-access requests. | Y | 1 | - | [sp/14](../specs/14-service-requests.md) | - |
| **194** | System shall identify repeat service requests within a defined timeframe. | Y | 1 | - | [sp/14](../specs/14-service-requests.md) | - |
| **195** | System shall support dispute handling for service-request-related charges. | Y | 1 | - | [sp/14](../specs/14-service-requests.md) | - |
| **196** | System shall maintain a full audit trail for service requests. | Y | 1 | - | [sp/14](../specs/14-service-requests.md) | - |
| **197** | System shall report on request volumes, SLAs, and billing outcomes. | Y | 1 | - | [sp/14](../specs/14-service-requests.md) | - |

### Service Requests - Delinquency Work Orders
*Reqs 198-199 (2 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **198** | System shall create internal service requests / work orders for door hangers or shut offs when  delinquency threshold met, either... | Y | 1 | - | [sp/11](../specs/11-delinquency.md) [sp/14](../specs/14-service-requests.md) | - |
| **199** | System shall create internal service requests / work orders for turning back on after shut offs are paid | Y | 1 | - | [sp/11](../specs/11-delinquency.md) [sp/14](../specs/14-service-requests.md) | - |

### Service Requests - Billing, Disputes & Customer Communications
*Reqs 200-202 (3 requirements)*

| # | Req | Resp | Phase | bz/ | sp/ | plan/ |
|---|---|---|---|---|---|---|
| **200** | System shall generate charges or credits upon service request completion. | Y | 1 | - | [sp/10](../specs/10-payments-and-collections.md) [sp/14](../specs/14-service-requests.md) | - |
| **201** | System shall support authorized fee waivers with audit controls. | Y | 1 | [bz/12](./12-corrections-and-reversals.md) | [sp/10](../specs/10-payments-and-collections.md) [sp/14](../specs/14-service-requests.md) | - |
| **202** | System shall support automated customer notifications for service requests. | Y | 1 | [bz/11](./11-notes-and-comments.md) | [sp/14](../specs/14-service-requests.md) | - |

## 4. Appendix - full requirement text

Most requirement stories were truncated in the tables above for readability. Below is the full text of each requirement plus the response comment from the spreadsheet.

### Req 1 - Customer - Property File / Property / Service Location Management

**Story:** System shall treat the City's GIS system as the authoritative system of record for all property-, parcel-, and premise-related data, including service location identifiers, addresses, parcel boundaries, and geospatial attributes

**Response comment:** GIS integration is on Saaslogic's roadmap and will be delivered during this implementation per Attachment V.4.5 Challenge 1. Apptorflow (the integration platform) is in production today; the bi-directional sync with the City's ESRI GIS will be built during this implementation, with sync schedule, field mappings, and conflict-resolution rules tailored to Bozeman during Phase 2.

**Response:** Y-WC | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/02](../specs/02-premise-management.md) | plan = -

---

### Req 2 - Customer - Property File / Property / Service Location Management

**Story:** System shall support configurable synchronization schedules with GIS, including near-real-time, scheduled batch (e.g. daily), and on-demand updates

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/02](../specs/02-premise-management.md) | plan = -

---

### Req 3 - Customer - Property File / Property / Service Location Management

**Story:** System shall store and persist GIS-origin unique identifiers such as Parcel ID and Premise ID.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/02](../specs/02-premise-management.md) | plan = -

---

### Req 4 - Customer - Property File / Property / Service Location Management

**Story:** System shall consume and display GIS-sourced service addresses while preserving address history.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/02](../specs/02-premise-management.md) | plan = -

---

### Req 5 - Customer - Property File / Property / Service Location Management

**Story:** System shall support effective-dated account-to-property relationships.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/05](../specs/05-service-agreement.md) | plan = [plan/2026-04-26](../superpowers/plans/2026-04-26-effective-dating-constraints.md)

---

### Req 6 - Customer - Property File / Property / Service Location Management

**Story:** System shall use GIS attributes to determine default rates and service availability.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/07](../specs/07-rate-management.md) | plan = -

---

### Req 7 - Customer - Property File / Property / Service Location Management

**Story:** System shall restrict manual overrides of GIS-sourced attributes to authorized users with audit logging.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/01](./01-audit-and-tamper-evidence.md), [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/02](../specs/02-premise-management.md) | plan = -

---

### Req 8 - Customer - Property File / Property / Service Location Management

**Story:** System shall support multiple service types at locations (e.g., water and solid waste, solid waste only, etc.)

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = - | sp = [sp/02](../specs/02-premise-management.md) | plan = -

---

### Req 9 - Customer - Property File / Customer Account Management

**Story:** System shall support multiple customer accounts associated to a single GIS property.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md), [sp/05](../specs/05-service-agreement.md) | plan = -

---

### Req 10 - Customer - Property File / Customer Account Management

**Story:** System shall support a single customer account associated with multiple GIS properties.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md), [sp/05](../specs/05-service-agreement.md) | plan = -

---

### Req 11 - Customer - Property File / Customer Account Management

**Story:** System shall allow user-defined required fields in the customer file

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md), [sp/05](../specs/05-service-agreement.md) | plan = -

---

### Req 12 - Customer - Property File / Customer Account Management

**Story:** System shall support multiple customer types (e.g., residential, commercial, multi-family, government, etc.)

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md), [sp/05](../specs/05-service-agreement.md) | plan = -

---

### Req 13 - Customer - Property File / Customer Account Management

**Story:** System shall support multiple contacts per customer account, with configurable roles (e.g., primary, billing contact, authorized representative).

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md), [sp/05](../specs/05-service-agreement.md) | plan = -

---

### Req 14 - Customer - Property File / Customer Account Management

**Story:** System shall support landlord / tenant relationships (i.e., the billing account holder may be different form the property owner)

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md) | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md) | plan = -

---

### Req 15 - Customer - Property File / Customer Account Management

**Story:** System shall support transfer of service where one account is closed and another opened without loss of data on customer history

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/05](../specs/05-service-agreement.md) | plan = -

---

### Req 16 - Customer - Property File / Customer Account Management

**Story:** System shall support duplicate customer detection using configurable matching criteria.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = - | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md) | plan = -

---

### Req 17 - Customer - Property File / Customer Account Management

**Story:** System supports alternate bill to addresses that differ from the service address

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = - | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md) | plan = -

---

### Req 18 - Customer - Property File / Customer Account Management

**Story:** System supports international billing addresses

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = - | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md) | plan = -

---

### Req 19 - Customer - Property File / Customer Account Management

**Story:** The system requires deposits for certain account types (e.g., renters are required to provide a deposit for trash service)

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = - | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md) | plan = -

---

### Req 20 - Customer - Property File / Customer Account Management

**Story:** System shall support refunds of deposits when account is closed in good standing

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = - | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md) | plan = -

---

### Req 21 - Customer - Property File / Customer Account Management

**Story:** System shall support applying deposit to unpaid charges

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = - | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md) | plan = -

---

### Req 22 - Customer - Property File / Customer Account Management

**Story:** System shall support customer account status values (e.g., active, inactive, pending start, final billed).

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = - | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md) | plan = -

---

### Req 23 - Customer - Property File / Customer Account Management

**Story:** System flags customers with delinquent accounts and make delinquency status visible during account lookup and service set up.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = - | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md) | plan = -

---

### Req 24 - Customer - Property File / Customer Account Management

**Story:** 

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = - | sp = [sp/01](../specs/01-customer-management.md), [sp/04](../specs/04-account-management.md) | plan = -

---

### Req 25 - Customer - Property File / Account & Property History Management

**Story:** System shall retain historical GIS property records for audit and inquiry purposes.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/01](./01-audit-and-tamper-evidence.md), [bz/08](./08-data-retention-archival-purge.md), [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/17](../specs/17-reporting-and-audit.md) | plan = -

---

### Req 26 - Customer - Property File / Account & Property History Management

**Story:** System shall maintain a consolidated account history view including billing, payments, service requests, and service changes.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/01](./01-audit-and-tamper-evidence.md), [bz/08](./08-data-retention-archival-purge.md) | sp = [sp/17](../specs/17-reporting-and-audit.md) | plan = -

---

### Req 27 - Customer - Property File / Notifications & Customer Communications Management

**Story:** System shall support automated customer notifications delivered via email, SMS/text message, and postal mail, with channel availability configurable by notification type.

**Response comment:** Saaslogic Utilities supports automated multi-channel notifications (email, SMS, postal mail) with per-customer channel preferences. The provider integrations (e.g., SendGrid for email, Twilio for SMS, file export to a print vendor for postal mail) will be built via Apptorflow during this implementation. Available at go-live; channel-specific provisioning configured during Phase 2.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/13](../specs/13-notifications.md) | plan = -

---

### Req 28 - Customer - Property File / Notifications & Customer Communications Management

**Story:** System shall support configurable notification triggers based on account or property events, such as bill availability, upcoming due dates, delinquency milestones, account status changes, or informational alerts.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/13](../specs/13-notifications.md) | plan = -

---

### Req 29 - Customer - Property File / Notifications & Customer Communications Management

**Story:** System shall allow staff to create, edit, and manage standardized communication templates, including configurable subject lines, message bodies, and dynamic data fields (e.g., customer name, account number, due date).

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/13](../specs/13-notifications.md) | plan = -

---

### Req 30 - Customer - Property File / Notifications & Customer Communications Management

**Story:** System shall support bulk or mass communications to defined customer segments (e.g., by service type, billing cycle, geographic area, or customer class) for informational or emergency notifications.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/01](./01-audit-and-tamper-evidence.md), [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/13](../specs/13-notifications.md) | plan = -

---

### Req 31 - Customer - Property File / Notifications & Customer Communications Management

**Story:** System shall support opt-in and opt-out management for electronic communications, including SMS consent tracking, in accordance with applicable regulations and City policy.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md), [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/13](../specs/13-notifications.md) | plan = -

---

### Req 32 - Customer - Property File / Notifications & Customer Communications Management

**Story:** System shall support customer communication preferences (e.g. mail, email, phone, sms) and opt-in/opt-out tracking.

**Response comment:** Customer communication preferences and opt-in/opt-out tracking are supported in Saaslogic Utilities with TCPA-compliant consent capture. Available at go-live.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = - | sp = [sp/13](../specs/13-notifications.md) | plan = -

---

### Req 33 - Customer - Property File / Notifications & Customer Communications Management

**Story:** System shall maintain a complete communication history viewable at the customer and account level, including message type, delivery channel, delivery timestamp, and delivery status (sent, failed, queued).

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/13](../specs/13-notifications.md) | plan = -

---

### Req 34 - Customer - Property File / Customer Portal & Self-Service

**Story:** System shall provide a secure web-based customer portal.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md) | sp = [sp/15](../specs/15-customer-portal.md) | plan = -

---

### Req 35 - Customer - Property File / Customer Portal & Self-Service

**Story:** System shall allow customers to view account and property information.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md) | sp = [sp/15](../specs/15-customer-portal.md) | plan = -

---

### Req 36 - Customer - Property File / Customer Portal & Self-Service

**Story:** System allows customers to update contact information (e.g., phone number or email)

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md) | sp = [sp/15](../specs/15-customer-portal.md) | plan = -

---

### Req 37 - Customer - Property File / Customer Portal & Self-Service

**Story:** System shall allow customers to manage communication preferences.

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md), [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/15](../specs/15-customer-portal.md) | plan = -

---

### Req 38 - Customer - Property File / Customer Portal & Self-Service

**Story:** System shall provide a secure customer self-service portal supporting account registration, authentication, password management, and role-based access

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md) | sp = [sp/15](../specs/15-customer-portal.md) | plan = -

---

### Req 39 - Customer - Property File / Customer Portal & Self-Service

**Story:** The portal shall support configurable identity verification during account registration (e.g., account number, service address, or other City-defined criteria)

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md) | sp = [sp/15](../specs/15-customer-portal.md) | plan = -

---

### Req 40 - Customer - Property File / Customer Portal & Self-Service

**Story:** The portal shall support recurring payment enrollment, with configurable schedules, funding sources, and customer notifications

**Response comment:** AutoPay / recurring payment enrollment via SaaSLogic Billing Integration. Available in Saaslogic Utilities at go-live.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md) | sp = [sp/10](../specs/10-payments-and-collections.md), [sp/15](../specs/15-customer-portal.md) | plan = -

---

### Req 41 - Customer - Property File / Customer Portal & Self-Service

**Story:** The portal shall support configurable billing and payment alerts (e.g., bill ready, due soon, past due, payment failed) via portal, SMS, or email

**Response comment:** Available in Saaslogic Utilities (M01-M03 Customer/Premise/Account). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M01-M03 Customer/Premise/Account | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md), [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/13](../specs/13-notifications.md), [sp/15](../specs/15-customer-portal.md) | plan = -

---

### Req 42 - Solid Waste / Service Set‑Up

**Story:** System shall determine solid waste service eligibility and defaults using GIS attributes.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 43 - Solid Waste / Service Set‑Up

**Story:** System shall support multiple solid waste service types per property, each billed independently.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 44 - Solid Waste / Service Set‑Up

**Story:** System shall support effective-dated enrollment and proration for solid waste services.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 45 - Solid Waste / Service Set‑Up

**Story:** System shall support seasonal services and temporary service suspensions, including by service type (e.g., trash service may be year round but organics are only seasonal).

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 46 - Solid Waste / Service Set‑Up

**Story:** System shall support temporary service holds or vacation suspensions with automatic billing suspension and restart.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 47 - Solid Waste / Route System Integration

**Story:** System shall ingest ad hoc solid waste service events from RAMS and convert them to billable charges (e.g., excessive trash, bulk items, etc.)

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 48 - Solid Waste / Route System Integration

**Story:** System shall provide configurable mapping between RAMS service codes and billing charge codes.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 49 - Solid Waste / Route System Integration

**Story:** System shall generate charges from RAMS work orders based on completion status.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 50 - Solid Waste / Route System Integration

**Story:** System shall provide reconciliation between RAMS service activity and billed charges.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 51 - Solid Waste / Route System Integration

**Story:** The system shall generate pre-bill exception reports for solid waste charges to enable staff review and correct if necessary prior to bill issuance

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 52 - Solid Waste / Account / Cart Management

**Story:** System shall support container delivery or removal effective-date tracking tied to billing start/stop events.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 53 - Solid Waste / Account / Cart Management

**Story:** System shall support multiple containers of varying types and sizes per property.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 54 - Solid Waste / Account / Cart Management

**Story:** System shall support dispute workflows for solid waste charges.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 55 - Solid Waste / Account / Cart Management

**Story:** System shall allow authorized service-level and rate overrides with audit tracking.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 56 - Solid Waste / Account / Cart Management

**Story:** System shall present a consolidated solid waste service and charge history for inquiry.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 57 - Solid Waste / Rate Management & Fees

**Story:** System shall support container-based billing models including size, quantity, and frequency.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md), [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 58 - Solid Waste / Rate Management & Fees

**Story:** System shall support future-dated solid waste rate and policy changes.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md), [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 59 - Solid Waste / Rate Management & Fees

**Story:** System shall support billing adjustments or credits for missed collections or service failures.

**Response comment:** Available in Saaslogic Utilities (M07 Solid Waste). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M07 Solid Waste | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md), [sp/12](../specs/12-solid-waste.md) | plan = -

---

### Req 60 - Water / Wastewater & Stormwater / Service Setup Attributes

**Story:** System shall support separate water and wastewater services per property, including storm water services.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/02](../specs/02-premise-management.md), [sp/05](../specs/05-service-agreement.md), [sp/06](../specs/06-commodity-and-uom.md) | plan = -

---

### Req 61 - Water / Wastewater & Stormwater / Service Setup Attributes

**Story:** System shall support multiple services on a single consolidated bill while maintaining service-level accounting.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/09](../specs/09-billing.md) | plan = -

---

### Req 62 - Water / Wastewater & Stormwater / Service Setup Attributes

**Story:** System shall support effective-dated enrollment and proration for water services.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/09](../specs/09-billing.md) | plan = -

---

### Req 63 - Water / Wastewater & Stormwater / Service Setup Attributes

**Story:** System shall apply regulatory fees and surcharges by service and class.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 64 - Water / Wastewater & Stormwater / Service Setup Attributes

**Story:** System shall apply taxes and franchise fees using configurable rules.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/05](../specs/05-service-agreement.md) | plan = -

---

### Req 65 - Water / Wastewater & Stormwater / Rate Management

**Story:** System shall support meter multiplier or scaling factors used in consumption calculations.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/07](../specs/07-rate-management.md) | plan = -

---

### Req 66 - Water / Wastewater & Stormwater / Rate Management

**Story:** System shall support multiple water rate structures, including fixed, tiered, flat, and seasonal.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/07](../specs/07-rate-management.md) | plan = -

---

### Req 67 - Water / Wastewater & Stormwater / Rate Management

**Story:** System shall support different water rate structures by customer type (e.g., commercial, residential, etc.).

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/07](../specs/07-rate-management.md) | plan = -

---

### Req 68 - Water / Wastewater & Stormwater / Rate Management

**Story:** System shall support future-dated rate ordinances without rebilling prior periods (i.e., if new rate ordinance goes into effect for the bills due September 15, users can update the rate table in advance and system will not calculate bills at new rate until effective period)

**Response comment:** Future-dated rate ordinances with effective-date versioning are supported in Saaslogic Utilities. New rate ordinances configured ahead of time activate automatically without rebilling prior periods. Available at go-live.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md) | plan = -

---

### Req 69 - Water / Wastewater & Stormwater / Rate Management

**Story:** System shall calculate wastewater charges as a 100% of water usage, except for WQA (Winter Quarter Average)

**Response comment:** Wastewater calculation as a percentage of water usage with Winter Quarter Average (WQA) is supported in Saaslogic Utilities. Available at go-live; specific WQA window length and computation rules configured to Bozeman during Phase 2.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md) | plan = -

---

### Req 70 - Water / Wastewater & Stormwater / Rate Management

**Story:** System shall support caps, minimums, and maximums for wastewater billing, including WQA

**Response comment:** Wastewater caps, minimums, and maximums (including WQA caps) are supported in Saaslogic Utilities. Available at go-live; specific Bozeman cap formulas configured during Phase 2.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md) | plan = -

---

### Req 71 - Water / Wastewater & Stormwater / Rate Management

**Story:** System supports configurable (e.g., the quarter is five months, daily calculations, etc.) WQA calculations, including flagging exceptions that would distort calculations

**Response comment:** Configurable WQA calculations including quarter window definition (e.g., five months) and daily calculations are supported in Saaslogic Utilities. Available at go-live; specific Bozeman configuration during Phase 2.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md) | plan = -

---

### Req 72 - Water / Wastewater & Stormwater / Rate Management

**Story:** System shall support winter averaging for wastewater billing, based on City configuration and/or policy, including non-rounded numbers

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md) | plan = -

---

### Req 73 - Water / Wastewater & Stormwater / Rate Management

**Story:** System supports exclusion of irrigation or non-sewer usage from wastewater calculations.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md) | plan = -

---

### Req 74 - Water / Wastewater & Stormwater / Rate Management

**Story:** System shall support minimum bills regardless of usage.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md) | plan = -

---

### Req 75 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall treat the meter reading system as the authoritative source for meter reads and events.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 76 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall integrate with the meter reading system via secure APIs or file-based interfaces.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 77 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall support both incremental and full meter read imports.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 78 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall support meter read cycle scheduling and read route grouping.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 79 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall store unique read identifiers and prevent duplicate billing of reads.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 80 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall associate meter reads to meters

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 81 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall support multi-register meter read handling.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/09](./09-bulk-upload-and-data-ingestion.md) | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 82 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall clearly label estimated versus actual reads.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/09](./09-bulk-upload-and-data-ingestion.md) | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 83 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall ingest and retain raw interval meter read data.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 84 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall ingest meter events such as leaks, tamper, or reverse flow.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 85 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall allow meter events to trigger notifications or billing holds.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 86 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall support freezing of validated reads once billing is finalized.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 87 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall retain before-and-after values for corrected reads.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 88 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall maintain a complete audit trail of meter reads and edits.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 89 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall allow manual entry or correction of reads with audit tracking.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 90 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall support new / replacement meters entered and attached to accounts at any time during the reading/billing cycle

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 91 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall support replaced meters mid-cycle and have both reads total to monthly usage

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 92 - Water / Wastewater & Stormwater / Meter Read

**Story:** System shall support mid-cycle final reads and billing (e.g., customer moves and closes account during the billing cycle)

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 93 - Water / Wastewater & Stormwater / Exception Management

**Story:** System shall validate reads using configurable exception thresholds.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/07](./07-data-validation.md) | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 94 - Water / Wastewater & Stormwater / Exception Management

**Story:** System shall flag and route abnormal reads (e.g., no use, excessive use, etc.) to exception review prior to billing.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/07](./07-data-validation.md) | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 95 - Water / Wastewater & Stormwater / Exception Management

**Story:** System shall flag and route invalid reads to exception review prior to billing.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/07](./07-data-validation.md) | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 96 - Water / Wastewater & Stormwater / Exception Management

**Story:** System shall support estimation and substitution rules when reads are missing or invalid.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/07](./07-data-validation.md) | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 97 - Water / Wastewater & Stormwater / Exception Management

**Story:** System shall provide error handling and reprocessing for failed read imports.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/07](./07-data-validation.md) | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 98 - Water / Wastewater & Stormwater / Exception Management

**Story:** System shall support backflow or reverse flow consumption handling rules.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/07](./07-data-validation.md) | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 99 - Water / Wastewater & Stormwater / Exception Management

**Story:** System shall support configurable leak adjustment processing.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/07](./07-data-validation.md) | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 100 - Water / Wastewater & Stormwater / Exception Management

**Story:** System provides exception reports for staff to review (e.g., leaks, zero consumption, significant changes from prior year, etc.)

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/07](./07-data-validation.md) | sp = [sp/08](../specs/08-meter-reading.md) | plan = -

---

### Req 101 - Water / Wastewater & Stormwater / Usage Calculations

**Story:** System shall aggregate interval reads into billable consumption using configurable rules.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md), [sp/08](../specs/08-meter-reading.md), [sp/09](../specs/09-billing.md) | plan = -

---

### Req 102 - Water / Wastewater & Stormwater / Usage Calculations

**Story:** System shall calculate usage for partial billing periods accurately.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md), [sp/08](../specs/08-meter-reading.md), [sp/09](../specs/09-billing.md) | plan = -

---

### Req 103 - Water / Wastewater & Stormwater / Usage Calculations

**Story:** System shall support controlled reprocessing and rebilling of corrected reads.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md), [sp/08](../specs/08-meter-reading.md), [sp/09](../specs/09-billing.md) | plan = -

---

### Req 104 - Water / Wastewater & Stormwater / Usage Calculations

**Story:** System shall provide reconciliation between imported reads and billed consumption.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md), [sp/08](../specs/08-meter-reading.md), [sp/09](../specs/09-billing.md) | plan = -

---

### Req 105 - Water / Wastewater & Stormwater / Usage Calculations

**Story:** System shall maintain detailed calculation audit trails.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/07](../specs/07-rate-management.md), [sp/08](../specs/08-meter-reading.md), [sp/09](../specs/09-billing.md) | plan = -

---

### Req 106 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall synchronize meter and endpoint inventory with the meter management system.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 107 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall support bulk meter inventory imports and updates from external systems.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/09](./09-bulk-upload-and-data-ingestion.md) | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 108 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall support scheduled and on-demand meter inventory

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 109 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall maintain a comprehensive meter and endpoint asset registry.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 110 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall maintain chain-of-custody history for meters.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 111 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall support effective-dated meter, property, and account associations.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 112 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall support master/sub-meter and multi-register configurations.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 113 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall support multiple meter types (e.g., temporary, construction, irrigation, etc.)

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 114 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall support tracking of meter manufacturer, model, size, and serial number.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 115 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall support meter inventory location tracking (e.g., warehouse, installed, retired).

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 116 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall track install, removal, and change-out events with read continuity.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 117 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall handle meter rollovers and register configuration changes.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 118 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall track meter testing, certification, and failure status.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 119 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall support inventory reconciliation between systems.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 120 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall route inventory errors to exception queues.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 121 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall report on asset status, lifecycle events, and testing due dates.

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 122 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall flag meters that are nearing end of useful life

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 123 - Water / Wastewater & Stormwater / Meter Inventory

**Story:** System shall designate meter location in muli-unit building (i.e., Unit A, Unit #102, mechanical room, etc.)

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = - | sp = [sp/03](../specs/03-meter-management.md) | plan = -

---

### Req 124 - Water / Wastewater & Stormwater / Delinquency Management

**Story:** System shall allow authorized users to configure rules that determine eligibility for water shut off (e.g., past due amount, days delinquent, etc.)

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/11](../specs/11-delinquency.md) | plan = -

---

### Req 125 - Water / Wastewater & Stormwater / Delinquency Management

**Story:** System shall support multiple notice levels (e.g., courtesy notice, past due notice, shut off warning, final shut off notice, etc.) with configurable trigger thresholds

**Response comment:** Multi-tier delinquency notices with configurable cadence (courtesy, past-due, shut-off warning, final shut-off) are supported in Saaslogic Utilities Delinquency module. Available at go-live; specific Bozeman policy ladder configured during Phase 2.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/11](../specs/11-delinquency.md), [sp/13](../specs/13-notifications.md) | plan = -

---

### Req 126 - Water / Wastewater & Stormwater / Delinquency Management

**Story:** System shall automatically identify accounts meeting the defined criteria for each notice tier and for water shut off eligibility and present them to staff in a review queue before notices or work orders are generated

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/11](../specs/11-delinquency.md) | plan = -

---

### Req 127 - Water / Wastewater & Stormwater / General

**Story:** The system shall include a configurable reporting module to create, modify, and save custom and ad hoc reports. Users must be able to select data fields, define filters and parameters, group and sort results, and export reports in multiple formats (e.g., PDF, Excel, CSV)

**Response comment:** Available in Saaslogic Utilities (Saaslogic Utilities). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** Saaslogic Utilities | **Phase:** 1

**Coverage:** bz = [bz/06](./06-custom-fields.md) | sp = [sp/17](../specs/17-reporting-and-audit.md) | plan = -

---

### Req 128 - Billing / Bill Cycle Management

**Story:** The portal shall display current and historical utility bills, including itemized charges, quantities, rates, and billing periods

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md) | sp = [sp/09](../specs/09-billing.md), [sp/15](../specs/15-customer-portal.md) | plan = -

---

### Req 129 - Billing / Bill Cycle Management

**Story:** The portal shall support consolidated bill viewing for customers with multiple services (e.g., water, wastewater, solid waste)

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md) | sp = [sp/09](../specs/09-billing.md), [sp/15](../specs/15-customer-portal.md) | plan = -

---

### Req 130 - Billing / Bill Cycle Management

**Story:** System shall generate PDF or equivalent bill documents and retain historical bill images for customer access and City records retention

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md) | sp = [sp/09](../specs/09-billing.md), [sp/15](../specs/15-customer-portal.md) | plan = -

---

### Req 131 - Billing / Bill Cycle Management

**Story:** System shall support printed bill generation, including export files for third-party print-and-mail vendors and City-defined bill formats

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/09](../specs/09-billing.md) | plan = -

---

### Req 132 - Billing / Bill Cycle Management

**Story:** System shall support customer enrollment in paperless billing (e-bill) preferences.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/09](../specs/09-billing.md) | plan = -

---

### Req 133 - Billing / Bill Cycle Management

**Story:** System shall support bill reprints and corrected bill issuance with version tracking.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/09](../specs/09-billing.md) | plan = -

---

### Req 134 - Billing / Bill Cycle Management

**Story:** System shall support final bill generation at account closure independent of billing cycle.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/09](../specs/09-billing.md) | plan = -

---

### Req 135 - Billing / Bill Cycle Management

**Story:** System shall support multiple concurrent billing cycles.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/09](../specs/09-billing.md) | plan = -

---

### Req 136 - Billing / Bill Cycle Management

**Story:** System shall support bill holds for individual accounts or events.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/09](../specs/09-billing.md) | plan = -

---

### Req 137 - Billing / Bill Cycle Management

**Story:** System shall support bill message management, allowing configurable messages to appear on bills by account type, service, or billing event.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/09](../specs/09-billing.md) | plan = -

---

### Req 138 - Billing / Bill Calculation

**Story:** System shall prorate tier thresholds for partial billing periods.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/09](../specs/09-billing.md), [sp/21](../specs/21-saaslogic-billing.md) | plan = -

---

### Req 139 - Billing / Bill Calculation

**Story:** System shall itemize charges and calculations on customer bills.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/09](../specs/09-billing.md), [sp/21](../specs/21-saaslogic-billing.md) | plan = -

---

### Req 140 - Billing / Bill Calculation

**Story:** System shall validate billed charges against adopted rates.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/09](../specs/09-billing.md), [sp/21](../specs/21-saaslogic-billing.md) | plan = -

---

### Req 141 - Billing / Bill Calculation

**Story:** System shall provide reconciliation between water usage and wastewater billing.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/09](../specs/09-billing.md), [sp/21](../specs/21-saaslogic-billing.md) | plan = -

---

### Req 142 - Billing / Billing Adjustments

**Story:** System shall rebill water and wastewater charges when reads are corrected.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = [bz/12](./12-corrections-and-reversals.md) | sp = [sp/09](../specs/09-billing.md) | plan = -

---

### Req 143 - Billing / Billing Adjustments

**Story:** System shall support ad hoc or special fees to be added to account

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = [bz/12](./12-corrections-and-reversals.md) | sp = [sp/10](../specs/10-payments-and-collections.md) | plan = -

---

### Req 144 - Billing / Billing Adjustments

**Story:** Ad hoc or special fees can be added to individual accounts, all customers, or customer subsets

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = [bz/12](./12-corrections-and-reversals.md) | sp = [sp/10](../specs/10-payments-and-collections.md) | plan = -

---

### Req 145 - Billing / Delinquencies & Aging

**Story:** System shall automatically apply user-defined late fees/penalties when applicable

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/11](../specs/11-delinquency.md) | plan = -

---

### Req 146 - Billing / Delinquencies & Aging

**Story:** System shall provide account write-off workflow for uncollectable bills

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = [bz/12](./12-corrections-and-reversals.md) | sp = [sp/10](../specs/10-payments-and-collections.md) | plan = -

---

### Req 147 - Billing / Delinquencies & Aging

**Story:** System shall support establishment of payment  plans for customers

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/11](../specs/11-delinquency.md) | plan = -

---

### Req 148 - Billing / Delinquencies & Aging

**Story:** System shall support customer notification when payment plans are established, modified, or defaulted.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/11](../specs/11-delinquency.md) | plan = -

---

### Req 149 - Billing / Delinquencies & Aging

**Story:** System shall provide an interactive aging dashboard that displays real-time account receivable balances segmented by configurable aging buckets

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/11](../specs/11-delinquency.md) | plan = -

---

### Req 150 - Billing / Delinquencies & Aging

**Story:** The aging dashboard shall display data updated in real time or near-real time, reflecting all posted payments, adjustments, billings, credits, and service-level changes

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/11](../specs/11-delinquency.md) | plan = -

---

### Req 151 - Billing / Delinquencies & Aging

**Story:** System shall allow authorized users to configure rules that determine eligibility for water shut off (e.g., past due amount, days delinquent, etc.)

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/11](../specs/11-delinquency.md) | plan = -

---

### Req 152 - Billing / Payment Allocation & Multi‑Account Support

**Story:** The portal shall allow customers to view and manage multiple utility accounts or properties under a single login

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md) | sp = [sp/15](../specs/15-customer-portal.md) | plan = -

---

### Req 153 - Billing / Payment Allocation & Multi‑Account Support

**Story:** System shall support third-party payer or authorized user access to accounts.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md) | sp = [sp/15](../specs/15-customer-portal.md) | plan = -

---

### Req 154 - Billing / Payment Allocation & Multi‑Account Support

**Story:** System shall support configurable payment allocation rules across multiple services, balances, and aging buckets

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/10](../specs/10-payments-and-collections.md) | plan = -

---

### Req 155 - Billing / Payment Allocation & Multi‑Account Support

**Story:** System shall support partial payments, overpayments, and advance (pre-pay) balances, with clear application rules and customer visibility

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/10](../specs/10-payments-and-collections.md) | plan = -

---

### Req 156 - Billing / Payment Allocation & Multi‑Account Support

**Story:** The portal shall allow customers to view payment history, balances, credits, and adjustments by account and service

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/10](../specs/10-payments-and-collections.md) | plan = -

---

### Req 157 - Billing / Payment Processing

**Story:** System shall support acceptance of multiple payment methods, including credit cards, debit cards, ACH/eCheck, etc., as well as any associated payment service or convenience fees

**Response comment:** Multiple payment methods (credit, debit, ACH/eCheck) supported with configurable convenience-fee handling (pass-through or absorbed). Available in Saaslogic Utilities at go-live.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/10](../specs/10-payments-and-collections.md), [sp/21](../specs/21-saaslogic-billing.md) | plan = -

---

### Req 158 - Billing / Payment Processing

**Story:** System shall support PCI DSS-compliant payment processing and ensure that sensitive payment information is not stored in the billing system unless explicitly permitted

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/10](../specs/10-payments-and-collections.md), [sp/21](../specs/21-saaslogic-billing.md) | plan = -

---

### Req 159 - Billing / Payment Processing

**Story:** System shall support both real-time payment posting (e.g., online payments) and batch payment imports (e.g., lockbox, kiosk, agency payments)

**Response comment:** Both real-time payment posting (online, AutoPay, OTC) and batch payment imports (lockbox, kiosk, agency) are supported in Saaslogic Utilities. Available at go-live; specific lockbox/agency file formats configured during Phase 2.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/10](../specs/10-payments-and-collections.md), [sp/21](../specs/21-saaslogic-billing.md) | plan = -

---

### Req 160 - Billing / Payment Processing

**Story:** System shall provide payment confirmations and receipts via the portal and optional email or SMS notifications

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/10](../specs/10-payments-and-collections.md), [sp/21](../specs/21-saaslogic-billing.md) | plan = -

---

### Req 161 - Billing / Payment Processing

**Story:** System shall provide daily and period-end reconciliation reports comparing payments received, posted amounts, fees, and deposits

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/10](../specs/10-payments-and-collections.md), [sp/21](../specs/21-saaslogic-billing.md) | plan = -

---

### Req 162 - Billing / Payment Processing

**Story:** System shall support integration with enterprise POS system, if implemented by City

**Response comment:** Optional POS system integration when/if the City implements POS. The integration will be built via Apptorflow during this implementation; specific POS vendor and event format confirmed in Phase 2 if the City selects a POS.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/10](../specs/10-payments-and-collections.md), [sp/21](../specs/21-saaslogic-billing.md) | plan = -

---

### Req 163 - Billing / Payment Processing

**Story:** System shall support automatic payment reversal handling (e.g., ACH returns, chargebacks) with automatic balance adjustments.

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/10](../specs/10-payments-and-collections.md), [sp/21](../specs/21-saaslogic-billing.md) | plan = -

---

### Req 164 - Billing / Payment Processing

**Story:** The systems shall support real time integration with payment system so payments are reflected in accounts as soon as payments are made against accounts

**Response comment:** Available in Saaslogic Utilities (M09 Billing Engine). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M09 Billing Engine | **Phase:** 1

**Coverage:** bz = - | sp = [sp/10](../specs/10-payments-and-collections.md), [sp/21](../specs/21-saaslogic-billing.md) | plan = -

---

### Req 165 - Special Assessments / Assessment & District Configuration

**Story:** System shall support the creation and management of Special Assessment Districts.

**Response comment:** Special Assessments capability is on Saaslogic's roadmap and will be delivered during this implementation. District configuration UI and underlying data model will be built and configured for Bozeman during Phase 2-3.

**Response:** Y-WC | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 166 - Special Assessments / Assessment & District Configuration

**Story:** System shall support multiple active special assessment districts simultaneously, including parcels that may belong to more than one district.

**Response comment:** Special Assessments capability is on Saaslogic's roadmap. Multi-district support - including parcels belonging to multiple districts - is part of the planned data model and will be delivered during this implementation.

**Response:** Y-WC | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 167 - Special Assessments / Assessment & District Configuration

**Story:** System shall allow staff to activate, deactivate, or sunset special assessment districts without impacting historical billing, payment, or reporting data.

**Response comment:** Special Assessments lifecycle management (activate / deactivate / sunset with historical preservation) is on Saaslogic's roadmap and will be delivered during this implementation.

**Response:** Y-WC | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 168 - Special Assessments / Parcel Integration & Attribute Management

**Story:** System shall support property-based billing, where special assessments are associated with a parcel or service location rather than an individual customer account.

**Response comment:** Available in Saaslogic Utilities (M16 Special Assessments). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md), [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 169 - Special Assessments / Parcel Integration & Attribute Management

**Story:** System shall integrate with the City's enterprise GIS and/or external parcel systems to import and reference parcel attributes used in assessment calculations, such as square footage, frontage, lot size, or other configurable attributes.

**Response comment:** Special Assessments parcel integration uses the same GIS integration referenced in Req #1 and Attachment V.4.5 Challenge 1. Parcel attributes drive assessment calculations; will be configured during Phase 2.

**Response:** Y-WC | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md), [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 170 - Special Assessments / Parcel Integration & Attribute Management

**Story:** System shall automatically transfer special assessment obligations to the new property owner when ownership changes, without manual reassignment of the assessment.

**Response comment:** Special Assessments ownership-transfer logic is on Saaslogic's roadmap. Automated transfer on parcel ownership change - detected via the GIS integration - will be delivered during this implementation per Attachment V.4.5 Challenge 4.

**Response:** Y-WC | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md), [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 171 - Special Assessments / Parcel Integration & Attribute Management

**Story:** System shall allow manual overrides or adjustments to assessment charges at the parcel level, subject to role-based security and audit logging.

**Response comment:** Available in Saaslogic Utilities (M16 Special Assessments). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md), [bz/15](./15-gis-driven-defaults-and-effective-dating.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 172 - Special Assessments / Assessment Calculation & Billing

**Story:** System shall allow special assessment calculations to be based on configurable formulas, including flat rates, attribute-based rates (e.g., per square foot, per linear foot), or hybrid calculation models.

**Response comment:** Special Assessments calculation engine - supporting flat-rate, attribute-based (per linear foot, per square foot, per ERU), and formula-based assessments - is on Saaslogic's roadmap and will be delivered during this implementation.

**Response:** Y-WC | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 173 - Special Assessments / Assessment Calculation & Billing

**Story:** System shall support recurring assessment charges billed on configurable schedules, including annual and semi-annual billing cycles.

**Response comment:** Available in Saaslogic Utilities (M16 Special Assessments). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 174 - Special Assessments / Assessment Calculation & Billing

**Story:** System shall track and display outstanding assessment balances separately from utility charges.

**Response comment:** Available in Saaslogic Utilities (M16 Special Assessments). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 175 - Special Assessments / Assessment Calculation & Billing

**Story:** System shall support billing and collections rules specific to special assessments, including late fees or penalties where permitted by City policy.

**Response comment:** Available in Saaslogic Utilities (M16 Special Assessments). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 176 - Special Assessments / Installments, Payments & Balance Management

**Story:** System shall support installment-based or loan-type assessments, including principal, interest (if applicable), term length, and amortization schedules.

**Response comment:** Special Assessments installment / loan-type assessments (principal, interest, term, amortization) are on Saaslogic's roadmap and will be delivered during this implementation.

**Response:** Y-WC | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 177 - Special Assessments / Installments, Payments & Balance Management

**Story:** System shall allow early payoff or full prepayment of special assessment balances at any time, with automatic recalculation of remaining balances and interest, if applicable.

**Response comment:** Available in Saaslogic Utilities (M16 Special Assessments). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md), [bz/14](./14-special-assessments.md) | sp = [sp/15](../specs/15-customer-portal.md), [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 178 - Special Assessments / Installments, Payments & Balance Management

**Story:** System shall maintain a complete audit trail of special assessment setup, calculation changes, payments, payoffs, transfers, and adjustments.

**Response comment:** Special Assessments audit trail is on Saaslogic's roadmap. Immutable audit logging is already built into the core Saaslogic platform; the audit trail for Special Assessments specifically will be delivered alongside the Special Assessments module during this implementation.

**Response:** Y-WC | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 179 - Special Assessments / Installments, Payments & Balance Management

**Story:** System shall provide reporting and inquiry capabilities for special assessments, including district summaries, parcel-level balances, payment histories, and payoff reports.

**Response comment:** Special Assessments reporting and inquiry capability is on Saaslogic's roadmap and will be delivered during this implementation. Standard reports (district summaries, parcel-level balances, payment history, payoff quotes) included; ad-hoc reporting via the platform's standard reporting engine.

**Response:** Y-WC | **Module:** M16 Special Assessments | **Phase:** 1

**Coverage:** bz = [bz/14](./14-special-assessments.md) | sp = [sp/16](../specs/16-special-assessments.md) | plan = -

---

### Req 180 - Service Requests / Service Request Intake & Definition

**Story:** System shall support service request intake via CSR, portal, and API.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = [bz/05](./05-customer-portal.md) | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 181 - Service Requests / Service Request Intake & Definition

**Story:** System shall associate service requests to GIS properties.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 182 - Service Requests / Service Request Intake & Definition

**Story:** System shall support configurable service request types and subtypes.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 183 - Service Requests / Service Request Intake & Definition

**Story:** System shall support scheduled and unscheduled service requests.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 184 - Service Requests / Service Request Intake & Definition

**Story:** System shall support attachments such as photos or notes for service requests.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 185 - Service Requests / Prioritization, Assignment & SLA Management

**Story:** System shall support priority or severity levels for service requests.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 186 - Service Requests / Prioritization, Assignment & SLA Management

**Story:** System shall support assignment of service requests to specific users or work groups.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 187 - Service Requests / Prioritization, Assignment & SLA Management

**Story:** System shall support SLAs by service request type.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 188 - Service Requests / Prioritization, Assignment & SLA Management

**Story:** System shall support escalation workflows when SLA thresholds are exceeded.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 189 - Service Requests / Work Order Routing & External System Integration

**Story:** System shall route solid waste service requests to RAMS.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 190 - Service Requests / Work Order Routing & External System Integration

**Story:** System shall route water service requests to the appropriate work system.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 191 - Service Requests / Work Order Routing & External System Integration

**Story:** System shall support bi-directional status updates with external systems.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 192 - Service Requests / Work Order Routing & External System Integration

**Story:** System shall support linking multiple service requests to a single work order when appropriate.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = [bz/13](./13-workflow-approvals-action-queue.md) | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 193 - Service Requests / Service Execution & Lifecycle Management

**Story:** System shall distinguish completed, canceled, incomplete, and no-access requests.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 194 - Service Requests / Service Execution & Lifecycle Management

**Story:** System shall identify repeat service requests within a defined timeframe.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 195 - Service Requests / Service Execution & Lifecycle Management

**Story:** System shall support dispute handling for service-request-related charges.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 196 - Service Requests / Service Execution & Lifecycle Management

**Story:** System shall maintain a full audit trail for service requests.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 197 - Service Requests / Service Execution & Lifecycle Management

**Story:** System shall report on request volumes, SLAs, and billing outcomes.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 198 - Service Requests / Delinquency Work Orders

**Story:** System shall create internal service requests / work orders for door hangers or shut offs when  delinquency threshold met, either automatically or after approval from billing

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/11](../specs/11-delinquency.md), [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 199 - Service Requests / Delinquency Work Orders

**Story:** System shall create internal service requests / work orders for turning back on after shut offs are paid

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/11](../specs/11-delinquency.md), [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 200 - Service Requests / Billing, Disputes & Customer Communications

**Story:** System shall generate charges or credits upon service request completion.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = - | sp = [sp/10](../specs/10-payments-and-collections.md), [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 201 - Service Requests / Billing, Disputes & Customer Communications

**Story:** System shall support authorized fee waivers with audit controls.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = [bz/12](./12-corrections-and-reversals.md) | sp = [sp/10](../specs/10-payments-and-collections.md), [sp/14](../specs/14-service-requests.md) | plan = -

---

### Req 202 - Service Requests / Billing, Disputes & Customer Communications

**Story:** System shall support automated customer notifications for service requests.

**Response comment:** Available in Saaslogic Utilities (M14 Service Requests). Implemented via product configuration; no custom development required. Confirmed for delivery by August 2026 demo.

**Response:** Y | **Module:** M14 Service Requests | **Phase:** 1

**Coverage:** bz = [bz/11](./11-notes-and-comments.md) | sp = [sp/14](../specs/14-service-requests.md) | plan = -

---
