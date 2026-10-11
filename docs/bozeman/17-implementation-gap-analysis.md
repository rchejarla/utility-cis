# Implementation Gap Analysis — What the Code Actually Does

**Date:** 2026-10-10
**Method:** Every one of the 202 Bozeman functional requirements checked against the code in `packages/` — Prisma schema (57 models, all enums), 52 API route modules, 66 services, 87 web pages, and the rate engine. Judged on code, not on specs or on the RFP response.
**Why this doc exists:** `00-requirements-master.md` maps all 202 requirements to a `docs/specs/` module spec, and the RFP answers all 202 as **Y** (184) or **Y-WC** (18). Column 6 of `bozeman-functional-reqs.xlsx` now names an owning module for every requirement. None of that means the behavior exists. This doc is the difference.

## 1. Headline

| Verdict | Count | Share |
|---|---|---|
| **Built** — the behavior exists and is exercised by tests | 79 | 39% |
| **Partial** — some of it works; a named piece is missing | 43 | 21% |
| **Absent** — no code implements it | 80 | 40% |

By area:

| Area | Reqs | Built | Partial | Absent |
|---|---|---|---|---|
| Customer / Property File | 41 | 19 | 10 | 12 |
| Solid Waste | 18 | 7 | 5 | 6 |
| Water / Wastewater & Stormwater | 68 | 36 | 15 | 17 |
| Billing | 37 | 10 | 9 | 18 |
| Special Assessments | 15 | 0 | 0 | **15** |
| Service Requests | 23 | 7 | 4 | 12 |

The strongest area is water/wastewater rating and metering — the rate engine has golden tests against Bozeman's own tariffs (`bozeman-water-sfr`, `bozeman-sewer-wqa`, `bozeman-sewer-linked`, `bozeman-stormwater`, `bozeman-solid-waste`). The weakest are Special Assessments (nothing), bill production and payment processing (most of it), and every external-system integration (all of them).

**Two qualifications on the 80, before anyone prices it as build work.** Three of them (#157, #158, #164) are another product's job by design and mean integration, not implementation — see the payment-processing entry in §2. And every gap that reaches outside this process runs on an integration layer that already exists and is running, apptor-connect, so the mechanism is chosen even though our side of it isn't written — see §2's integration-rail subsection. Neither qualification moves a verdict: nothing above counted as absent is built.

## 2. Whole capabilities with no code at all

These are not partial. There is no model, route, service, or page.

### Special Assessments — all 15 requirements (#165–179)
`assessment`, `parcel`, `district`, `installment`, `amortiz` return **zero matches** across `packages/`. No `AssessmentDistrict`, no `ParcelAssessment`, no installment schedule, no payoff calculator, no lien. `docs/bozeman/14-special-assessments.md` designs this in full; none of it is built.

### GIS integration — #1, 2, 3, 7, 25, 42 (and degrades #4, 6, 181)
No `parcel`, `gisParcelId`, `geospatial`, or sync worker anywhere. The only occurrence of "GIS" in the API is a comment at `packages/api/src/imports/handlers/premise.ts:8` saying the premise CSV import is "used for GIS sync re-loads". There is no ESRI client, no sync schedule, no GIS-sourced attribute, and therefore nothing to restrict overrides on or to retain history for.

### Bill production — #130, 131, 133, 136, 137
No PDF generation (`pdfkit`/`puppeteer`/`PDFDocument`: zero hits; the only `pdf` in the codebase is a MIME type in `attachment.service.ts`). No print/mail vendor export. No bill reprint or version tracking. No bill hold. No bill message management. Bills compute and store (`Bill`, `BillSegment`, `BillSegmentLine`) and render in the UI — they are never produced as a document.

### Payment processing — #157, 158, 162, 164 — *partly delegated by design*
No gateway, no tokenization, no card/ACH capture (`stripe|braintree|authorize\.net|tokeniz`: zero hits). `PaymentTender {CARD, ACH, CASH, CHECK, LOCKBOX}` records *how a payment was taken elsewhere*; nothing takes payments. No POS integration, no real-time payment feed, no PCI surface.

**But #157, #158 and #164 are not ours to build.** `docs/specs/21-saaslogic-billing.md:21-33` divides it: CIS is the system of record for what is owed, SaaSLogic owns "card data, hosted payment page, settlement", and the spec states "No card tokenization in CIS. Payment UI stays hosted by SaaSLogic behind a redirect, so PCI scope remains effectively zero." These remain counted as absent because they are absent *here* — that is what this document measures — but closing them means integrating, not implementing, and a roadmap should not price them as build work.

That module's own stated blocker is also **stale**: it says "there is no `Payment` entity, no allocation, and no way to record money received". Payments, allocation, deposits, refunds and disbursements all shipped on 2026-10-09/10. Module 21 is unblocked.

### Payment plans — #147, 148
`PaymentPlan|paymentPlan|payment_plan`: zero hits. The only "payment plan" strings are a label in `validators/delinquency.ts` and UI copy.

### Reporting module — #127 (and blocks #51, 100, 121, 149, 150, 161, 179, 197)
No report builder, saved report, or report definition (`reportBuilder|savedReport|adHocReport|reportDefinition`: zero hits). Nine requirements across five areas ask for reports; eight of them have no delivery mechanism because this doesn't exist.

### External system routing — #189, 190, 191, 192
`ServiceRequestExternalSystem {RAMS, WORK_MANAGEMENT, APPTORFLOW}` exists as an enum. Nothing reads it: `externalSystem` has **zero non-test occurrences** in `packages/api/src`. No dispatch, no status callback, no work-order linking.

### Rebill — #103, 142 (and blocks #133)
Not implemented, and the code says so. `meter-read.service.ts:633` throws *"Cannot delete a frozen (already billed) read. Use the rebill workflow instead."* — pointing at a workflow that does not exist. `schema.prisma:596` and `:652` defer it: "Slice 5c (rebill) will add…", "future Slice 5d (rebill / corrections)". Correcting a read on a billed period currently has no path to a corrected bill.

### Communication preferences and consent — #31, 32, 37
`optOut|optIn|smsConsent|unsubscribe`: zero hits. `communicationPreference|preferredChannel|contactPreference`: zero hits. There is no per-customer channel preference and no SMS consent record, so the portal page for managing preferences (#37) has nothing to manage.

### Bulk / mass communications — #30
`bulkNotification|massNotification|broadcast`: zero hits. Notifications are per-recipient only; there is no segment-targeted send.

### The integration rail — what it changes, and what it doesn't

Every gap above that reaches outside this process — email, SMS, postal mail, object storage, other applications — runs on **apptor-connect** (`c:\development\apptor-connect`), this stack's integration layer, with `apptor-connect-service` as its HTTP surface. Four planes matter here:

| Plane | What it gives us |
|---|---|
| `proxy` — `POST /proxy/v1/{integration}` | Call a vendor without ever holding its credential; the service injects auth and applies timeouts, retries and per-tenant rate limits. |
| `files` — `/files/v1/*` | Read and write S3, Azure Blob, GCS and SFTP. Mint a link with `POST /files/v1/links`, stream the bytes, keep a pointer. |
| `events` — `POST /events/v1/{token}` | Verified, deduplicated inbound webhooks, read by cursor — the return path for statuses we don't poll for. |
| `resolve` — `POST /v1/resolve` | Connection details plus a short-lived token, for callers that must talk to a vendor directly. |

Its ownership hierarchy is `PLATFORM ⊃ TENANT ⊃ CUSTOMER ⊃ SUBJECT`, which maps onto `utility_id` cleanly, and the `mail`, `sendgrid`, `s3`, `azure-blob`, `gcs`, `sftp`, `rest` and `kafka` connectors already exist.

So these gaps are not "we need to choose and build a mechanism" — the mechanism is chosen and running:

| Requirement | What's left on our side |
|---|---|
| #27 email/SMS channels, #132 bill delivery | Call `mail`/`sendgrid` through the proxy. Needs a delivery-status model; `NotificationChannel` also needs a `POSTAL` member it currently lacks. |
| #27 postal mail | A print-and-mail vendor over `sftp` or an object drop. Needs the vendor's file spec. |
| #130 retained bill images | Done by design in `docs/superpowers/specs/2026-10-11-bill-production-design.md` — the files plane, so no storage code here. Resolves the 7-year retention floor as a bucket lifecycle policy rather than something we implement. |
| #131 print-vendor export | A renderer over the bill presentation model, dropped via `sftp`. |
| #189, #190 SR routing to RAMS / work systems | Call them through the proxy. The enum values already exist and are read by nothing. |
| #191 bi-directional status | The events plane is the inbound half; we need a handler and a status mapping. |
| #76 meter-reading system API, #106 meter inventory sync | The `rest` connector plus a scheduled pull; today only file import exists. |

**What this does not change: none of these are built, and no verdict in §1 moves.** A rail is not a feature — every row above still needs our side written, and several need a third party's file format or API before they can be specified at all. The distinction worth carrying into planning is narrower than it looks: these are *integration* work against a layer that exists, not *infrastructure* work. That makes them cheaper to estimate, not done.

One standing consequence: no vendor credential belongs in this codebase. Anything that reaches an external system goes through apptor-connect, which holds the credential and never hands it out.

## 3. Absent — full list by requirement

### Customer / Property File (12)
| # | Requirement | Evidence |
|---|---|---|
| 1 | GIS as authoritative system of record | no GIS integration of any kind |
| 2 | Configurable GIS sync schedules | no sync worker or schedule config |
| 3 | Store GIS identifiers (Parcel ID, Premise ID) | no `parcel` field on `Premise` |
| 7 | Restrict overrides of GIS attributes, audited | no GIS-sourced field marking; generic `premise.write` edits everything |
| 16 | Duplicate customer detection, configurable matching | no `duplicate`/`match` logic in `customer.service.ts` |
| 25 | Retain historical GIS property records | no GIS records to retain |
| 30 | Bulk / mass communications to segments | no broadcast path |
| 31 | Opt-in / opt-out with SMS consent tracking | no consent model |
| 32 | Customer communication preferences | no preference model |
| 37 | Portal: manage communication preferences | depends on #32 |
| 40 | Portal: recurring payment enrollment | no autopay; `autopay` appears only as an example custom-field key |
| 41 | Configurable billing / payment alerts | no alert config; no bill-ready or payment-failed event |

### Solid Waste (6)
| # | Requirement | Evidence |
|---|---|---|
| 42 | SW eligibility and defaults from GIS attributes | no GIS |
| 48 | Configurable RAMS code → charge code mapping | `chargeCode|charge_code|billable`: zero hits in `packages/api/src` |
| 49 | Generate charges from RAMS work orders on completion | no charge generation from events |
| 50 | Reconciliation of RAMS activity vs billed charges | no reconciliation path |
| 51 | Pre-bill exception reports for SW charges | no reporting module |
| 54 | Dispute workflows for SW charges | no dispute entity; "dispute" appears only in UI example text |

### Water / Wastewater & Stormwater (17)
| # | Requirement | Evidence |
|---|---|---|
| 64 | Taxes and franchise fees, configurable | `franchise|salesTax|taxRate`: zero hits |
| 74 | Minimum bills regardless of usage | no minimum-charge component |
| 83 | Ingest and retain raw interval meter data | no interval model — yet `tenant-settings.ts:52` defines `intervalReadRetentionDays` (default 1095) that **nothing reads** |
| 85 | Meter events trigger notifications or billing holds | no notify/hold logic in `meter-event.service.ts` |
| 94 | Flag abnormal reads (no use, excessive use) | `ZERO_USE|HIGH_USE|EXCESSIVE`: zero hits; only `ROLLOVER`, `METER_DEFECT`, `REVERSE_FLOW` are raised |
| 96 | Estimation / substitution rules for missing reads | `ESTIMATED` read type exists; no rule engine to produce one |
| 99 | Configurable leak adjustment processing | `leakAdjust`: zero hits |
| 101 | Aggregate interval reads into billable consumption | depends on #83 |
| 103 | Controlled reprocessing / rebilling of corrected reads | no rebill (§2) |
| 104 | Reconciliation of imported reads vs billed consumption | no reconciliation path |
| 106 | Synchronize meter inventory with meter management system | CSV import only; no system integration |
| 110 | Chain-of-custody history for meters | `custody`: zero hits |
| 119 | Inventory reconciliation between systems | no reconciliation path |
| 121 | Report on asset status, lifecycle, testing due dates | no reporting module, no testing data |
| 122 | Flag meters nearing end of useful life | `usefulLife|endOfLife`: zero hits |
| 123 | Meter location in multi-unit building | `unitDesignation|meterLocation`: zero hits |
| 127 | Configurable reporting module with multi-format export | no reporting module |

### Billing (18)
| # | Requirement | Evidence |
|---|---|---|
| 130 | Generate PDF bills, retain bill images | no PDF renderer |
| 131 | Printed bill generation, third-party print export | no export |
| 133 | Bill reprints and corrected bills with version tracking | `billVersion|reprint`: zero hits |
| 136 | Bill holds | `billHold|holdBilling`: zero hits |
| 137 | Bill message management | `billMessage`: zero hits |
| 138 | Prorate tier thresholds for partial periods | usage proration exists; no tier-threshold proration in `evaluators/pricing.ts` |
| 141 | Reconciliation of water usage vs wastewater billing | no reconciliation report |
| 142 | Rebill when reads are corrected | no rebill (§2) |
| 147 | Payment plans | no model |
| 148 | Payment plan notifications | depends on #147 |
| 149 | Interactive aging dashboard, configurable buckets | an aging *index* exists in AR; no bucket config and no dashboard page |
| 150 | Aging data updated in real time | depends on #149 |
| 153 | Third-party payer / authorized user access | `thirdParty|authorizedUser`: zero hits |
| 156 | Portal: payment history, balances, credits, adjustments | `portal-api.ts` exposes no ledger, balance, or payment data |
| 157 | Multiple payment methods and convenience fees | no gateway |
| 158 | PCI DSS-compliant processing | no payment capture surface |
| 162 | POS integration | zero hits |
| 164 | Real-time payment integration | no gateway |

### Special Assessments (15) — #165–179, all of them
District creation and management, multi-district parcels, activate/deactivate/sunset, parcel-based billing, GIS parcel attribute import, automatic transfer on ownership change, parcel-level overrides, configurable calculation formulas, recurring assessment schedules, separate balance tracking, assessment-specific collections rules, installment/loan assessments with amortization, early payoff with recalculation, assessment audit trail, assessment reporting.

### Service Requests (12)
| # | Requirement | Evidence |
|---|---|---|
| 183 | Scheduled and unscheduled requests | no `scheduledFor`/`scheduledDate` field on `ServiceRequest` |
| 189 | Route SW service requests to RAMS | no dispatch (§2) |
| 190 | Route water service requests to work system | no dispatch (§2) |
| 191 | Bi-directional status updates with external systems | no callback handler |
| 192 | Link multiple requests to a single work order | `workOrder`: zero hits |
| 194 | Identify repeat service requests in a timeframe | `repeatRequest|isRepeat`: zero hits |
| 195 | Dispute handling for request-related charges | no dispute entity |
| 197 | Report on volumes, SLAs, billing outcomes | no reporting module |
| 198 | Internal work orders for door hangers / shut-offs at delinquency | `delinquency.service.ts` creates no service requests; `DELINQUENCY_WORKFLOW` is an unused enum literal |
| 199 | Internal work orders for turn-back-on after payment | same |
| 200 | Generate charges or credits on request completion | `ServiceRequestBillingAction` is stored, never posted to the ledger |
| 202 | Automated customer notifications for service requests | no notify call in `service-request.service.ts` |

## 4. Partial — what works and what's missing

Only the missing half is listed.

**Customer / Property File:** #4 addresses and history exist, no GIS feed · #6 `premise_attribute` drives rates, but attributes aren't GIS-sourced · #14 account holder and premise owner both exist; no explicit landlord/tenant relationship or owner-change workflow · #19 deposits post and refund; "required for certain account types" is not a configurable rule · #24 customer search covers 5 fields (name, org, email, phone) — not "any field", and not custom fields or account number · #26 account history shows bills and AR; not service requests or service changes · #27 `NotificationChannel` is `{EMAIL, SMS}` — **no postal mail** · #28 triggers exist for delinquency and automation; no bill-availability or due-date triggers · #38 register/login/RBAC work; **no password reset** (`reset|forgot|changePassword`: zero hits in `portal-auth.ts`) · #39 verification is hard-coded to account number + email, not configurable.

**Solid Waste:** #47 RAMS events ingest and resolve, but `service-event.service.ts:18` states the charge hand-off is "Phase 3" — nothing posts · #52 container dates exist; not tied to billing start/stop events · #55 overrides are audited generally; no service-level/rate override path · #56 history is per-entity, not a consolidated SW view · #59 `ServiceEventBillingAction {CREDIT_ISSUED, CHARGE_ISSUED}` is recorded, never posted.

**Water / Wastewater:** #63 rate components and service classes carry surcharges; no regulatory-fee construct by service and class · #71 WQA is configurable; no exception flagging for distorting reads · #76 file imports work; no secure API integration with a reading system · #78 cycle scheduling works; **no read route grouping** · #93 exceptions are raised from hard-coded rules, thresholds are not configurable · #97 import errors are captured; reprocessing is manual · #98 reverse flow is flagged, no handling rules · #100 exceptions page exists; no zero-consumption or year-over-year comparison · #108 on-demand inventory import only, nothing scheduled · #109 meter registry is solid; no endpoint/radio entity · #112 multi-register is real (`MeterRegister`); master/sub-meter exists only as a `meter:role` custom field used in rate predicates, with no structural parent/child or aggregation · #113 meter *role* (irrigation, sub-meter) rides on custom fields; `MeterType` is technology (AMR/AMI/MANUAL/SMART) — no temporary or construction meter type · #115 `MeterStatus` has `REMOVED`/`PENDING_INSTALL`; no warehouse location tracking · #118 `DEFECTIVE` covers failure; no testing or certification records · #120 import errors queue; inventory-specific errors don't.

**Billing:** #132 `Account.paperlessBilling` exists and imports; no e-bill delivery to enroll into · #140 rate schedules version and publish; no validation pass of billed charges against adopted rates · #144 ad hoc fees apply to one account; not to all customers or subsets · #146 `WRITE_OFF` entries and reason codes exist; no approval workflow · #154 allocation works off a fixed `DEBIT_ALLOCATION_ORDER` constant — not tenant-configurable · #159 real-time and API posting work; no lockbox/kiosk batch import · #160 internal receipts list exists; no customer-facing confirmation by email or SMS · #161 `reconciliation.service.ts` computes; no daily/period-end report output · #163 reversals are manual; no automatic ACH-return or chargeback handling.

**Service Requests:** #180 CSR and API intake work; the portal has no SR page · #181 requests link to premises; premises aren't GIS parcels · #186 assignment is to users; no work groups (`workGroup|crew`: zero hits) · #193 statuses cover completed/cancelled/failed; **no no-access status**.

## 5. Things that look built but aren't

Worth knowing before anyone reads the schema as a feature list:

1. **`intervalReadRetentionDays`** (`tenant-settings.ts:52`, default 1095) — a retention policy for data the system never stores. Nothing reads this key.
2. **`ServiceRequestSource.DELINQUENCY_WORKFLOW`** — an enum value with no producer. The delinquency service creates no service requests.
3. **`ServiceRequestExternalSystem`** and **`ServiceRequestBillingAction`** — both stored on the row, neither acted on.
4. **`ServiceEventBillingAction`** — the service's own doc comment says the hand-off to post charges is "Phase 3".
5. **The rebill error message** — tells operators to "use the rebill workflow instead" of deleting a billed read. There is no rebill workflow.
6. **`PaymentTender`** — reads like payment processing; it is a record of how money was taken somewhere else.

## 6. Stale statuses in this folder's index

`README.md` status columns predate the AR and rating work and now understate what exists:

- **`bz/12` Corrections & Reversals** says "zero financial entities exist… `Account.balance` is never written by any code path". `LedgerEntry`, `LedgerApplication`, and `LedgerReasonDef` now exist with posting, allocation, adjustment, fee, deposit, refund, reversal, and reconciliation services, 12 integration suites, and a receipts and disbursements UI.
- **`bz/16` Wastewater Billing & WQA** says "no WQA infrastructure; no irrigation-meter flag; no historical-usage aggregation". `WqaValue` exists, WQA and winter-averaging are implemented in the rate engine with golden tests, and irrigation deduction works through a `net`/`subtract` transform with `meter:role` predicates.
- **`bz/05` Customer Portal** says "bills are mock". Portal bill and invoice pages now read real data; what's actually missing there is payments, preferences, and AR history.

Correcting these is worth doing before the statuses get quoted into the RFP response.

## 7. What this analysis does not cover

- Non-functional requirements (performance, availability, security posture) — not in the 202.
- Quality of what is built. "Built" means the behavior exists and tests exercise it, not that it is sufficient for Bozeman's volumes or edge cases.
- The 18 **Y-WC** answers are not treated differently here; a conditional answer still appears as a commitment in column 5.
