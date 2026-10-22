# Implementation Gap Analysis — What the Code Actually Does

**Date:** 2026-10-10
**Revised:** 2026-10-11 — bill production slice 1 shipped. #130 and #137 move from absent to **built** (API, UI and tests); #133 from absent to **partial**. The staff UI landed the same day as the API; the portal download did not, and the reason is recorded below.
**Revised:** 2026-10-15 — #138 closed (tier-threshold proration, opt-in per tariff). The batch billing run shipped as API, worker and tests with **no UI**, which closes nothing on its own: see the bill production entry in §2 and item 7 of §5.
**Revised:** 2026-10-16 — the billing run's screens shipped, so a cycle can now be billed and reviewed by an operator rather than by a terminal. Nothing in the 202 moves on it: the run is infrastructure every billing requirement assumed, not a requirement of its own. What remains is unattended scheduling.
**Revised:** 2026-10-21 — re-verified every zero-hit claim below against current code; all still zero. Three changes, none of them new work: **#74 was never absent** (minimum bills are a rate-engine component with golden coverage — see §3); **#138's closure on 10-15 was never carried into the counts**, so the headline understated what is built by two; and a mock-data finding that this document had the wrong way round is now item 8 of §5. The five days since 10-16 went to tenancy, the platform console and UI fixes — infrastructure, so nothing else in the 202 moves.
**Method:** Every one of the 202 Bozeman functional requirements checked against the code in `packages/` — Prisma schema (57 models, all enums), 52 API route modules, 66 services, 87 web pages, and the rate engine. Judged on code, not on specs or on the RFP response.
**Why this doc exists:** `00-requirements-master.md` maps all 202 requirements to a `docs/specs/` module spec, and the RFP answers all 202 as **Y** (184) or **Y-WC** (18). Column 6 of `bozeman-functional-reqs.xlsx` now names an owning module for every requirement. None of that means the behavior exists. This doc is the difference.

## 1. Headline

| Verdict | Count | Share |
|---|---|---|
| **Built** — the behavior exists and is exercised by tests | 83 | 41% |
| **Partial** — some of it works; a named piece is missing | 44 | 22% |
| **Absent** — no code implements it | 75 | 37% |

By area:

| Area | Reqs | Built | Partial | Absent |
|---|---|---|---|---|
| Customer / Property File | 41 | 19 | 10 | 12 |
| Solid Waste | 18 | 7 | 5 | 6 |
| Water / Wastewater & Stormwater | 68 | 37 | 15 | 16 |
| Billing | 37 | 13 | 10 | 14 |
| Special Assessments | 15 | 0 | 0 | **15** |
| Service Requests | 23 | 7 | 4 | 12 |

The 2026-10-21 pass moved two: **#138** (closed 10-15, counted here for the first time) and **#74** (never absent). Both are Billing-and-rating requirements the rate engine already satisfied, which is the shape of error to expect from a document that reads code rather than running it — a component kind in a declarative grammar does not announce itself to a grep for the requirement's wording.

The strongest area is water/wastewater rating and metering — the rate engine has golden tests against Bozeman's own tariffs (`bozeman-water-sfr`, `bozeman-sewer-wqa`, `bozeman-sewer-linked`, `bozeman-stormwater`, `bozeman-solid-waste`). The weakest are Special Assessments (nothing), payment processing (most of it), and every external-system integration (all of them). Bill production was in that list until 2026-10-11; rendering, bill messages, the staff screens and bulk runs now exist, leaving delivery, print export, bill holds and rebill. The mock bill screens that were in this list came off it on 2026-10-22 (§5 item 8).

**Two qualifications on the 75, before anyone prices it as build work.** Three of them (#157, #158, #164) are another product's job by design and mean integration, not implementation — see the payment-processing entry in §2. And every gap that reaches outside this process runs on an integration layer that already exists and is running, apptor-connect, so the mechanism is chosen even though our side of it isn't written — see §2's integration-rail subsection. Neither qualification moves a verdict: nothing above counted as absent is built.

## 2. Whole capabilities with no code at all

These are not partial. There is no model, route, service, or page.

### Special Assessments — all 15 requirements (#165–179)
`assessment`, `parcel`, `district`, `installment`, `amortiz` return **zero matches** across `packages/`. No `AssessmentDistrict`, no `ParcelAssessment`, no installment schedule, no payoff calculator, no lien. `docs/bozeman/14-special-assessments.md` designs this in full; none of it is built.

### GIS integration — #1, 2, 3, 7, 25, 42 (and degrades #4, 6, 181)
No `parcel`, `gisParcelId`, `geospatial`, or sync worker anywhere. The only occurrence of "GIS" in the API is a comment at `packages/api/src/imports/handlers/premise.ts:8` saying the premise CSV import is "used for GIS sync re-loads". There is no ESRI client, no sync schedule, no GIS-sourced attribute, and therefore nothing to restrict overrides on or to retain history for.

### Bill production — #130, 131, 133, 136, 137 — *partly closed 2026-10-11*
**Closed:** #130 and #137. A posted `Bill` renders to a stored PDF — `@react-pdf/renderer` against a resolved `BillPresentation`, byte-stable output, bytes in the tenant's own object store through apptor-connect's files plane, a `BillDocument` pointer row holding no URL. Staff generate, download and Regenerate from the bills list and from an account's AR tab. Bill messages are targeted by account type and commodity, resolved at `bill_date`, and managed at Settings → Bill Messages; issuer identity and bill storage at Settings → Bill Production.

**Correction, 2026-10-17: half of #137 never worked.** Targeting a message by account type answered 404 for every account type that exists, because the create check required the target to *belong to* the tenant and `account_type_def` ships its five rows globally (`utility_id = NULL`). The picker offered five options and the save refused all five, for six days, while this document recorded #137 as closed. Fixed by asking whether the tenant may target the row rather than whether it owns it; refusing another tenant's row is still enforced, and commodity targeting was never affected because commodities are tenant-owned. Found by checking an unrelated question about tenancy modes, not by a test — the suite covered the print side of targeting and not the save side.

**Now partial:** #133. A bill can be printed again on demand and reproduces byte-identically, including the messages it originally carried. Version tracking is still absent and is *deliberately* not part of reprinting — a reprint produces identical bytes, so there is no version to record. It belongs with corrected issuance, which still blocks on rebill (below).

**Added 2026-10-14, after a bill was read in anger:** the bill prints payments. A bill paid against before its `bill_date` now carries a *Payments and credits received* block itemising each applied credit with its date, an *Amount due* distinct from *Total billed*, and a remittance stub that asks for what is left rather than the full charge. It had none of that — a part-paid bill said nothing of the payment and printed `Credits $0.00`, which is the rate engine's credits for the period and reads to a payer as their money counted at nothing. That row is now labelled `Credits this period` and hidden when zero. Still not built: previous balance and balance forward, so a customer sees nothing here of older open charges on other bills.

**Added 2026-10-15/16 — bills can now be produced in bulk.** `billing_run` and `billing_run_item` exist with RLS, a `billing-runs` queue and worker, per-account transactions, resume by status filter, cancel, and a boot sweep; seven endpoints start a run against a preview, read it, list its exceptions, post it and cancel it. Until this there was no way to bill a cycle at all — `Generate Bill` on one account's Bills tab was the only path. `/billing-runs` and `/billing-runs/:id` landed the day after the API, so the review step the design exists for — work the failures, then post — now has somewhere to happen: failures open first, skipped accounts sit in their own tab because "no read yet" is ordinary rather than work, and Post names the count and the amount before raising anything. Two related changes landed with it: a service period is now resolved read to read per agreement rather than taken from the cycle's calendar, which is what makes a run over manually-read accounts defensible; and run-created bills are deliberately not auto-posted, unlike the per-account path, so a finished run has moved no money until somebody says so. **What is still missing is the trigger:** a person starts every run (see item 7 of §5).

**Still absent:** #131 (no print/mail vendor export; `document_type` is a VARCHAR so adding `PRINT_EXPORT` needs no migration) and #136 (no bill hold). Delivery of any kind is unbuilt — `BillDocument` carries no delivery columns, so #132 is untouched. #131 also asks for *City-defined bill formats* and there is still only one hardcoded template — the payments block above went into it directly, which is the right place for now and the wrong place once the City wants its own layout.

**The portal download was the one piece still unreachable, and slice 1 shipped without it by decision. Closed 2026-10-22.** `GET /portal/api/bills/:id/document` had been live and tested all along — including that another customer's bill answers 404 exactly as a non-existent one does — but every portal bill surface rendered `mockCustomerBills`, so there were no real bill ids there to download. `GET /portal/api/accounts/:accountId/bills` now supplies them and the list offers the PDF through the shared `BillPdfButton` on its `surface="portal"` setting, which fetches only: generating is `accounts:EDIT`, which no portal token holds, so a fetch-then-generate fallback would have shown the customer an authorization error for a bill that is legitimately theirs. The `GET /portal/api/bills` this entry asked for was never the right shape — bills hang off an account, and the portal iterates the accounts it already exposes.

**And it is not only the portal (found 2026-10-21).** Two *staff* screens render the same invented data: `/customers/[id]` → Bills tab and `/service-agreements/[id]` → Billing tab. See item 8 of §5 — this document had the claim backwards in both directions, and the staff half was never recorded at all.

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
| #157, #158, #164 payment processing | **SaaSLogic over the proxy plane, decided 2026-10-21** (`docs/specs/21-saaslogic-billing.md` § Transport). Needs our request/response types, a bill-keyed idempotency column, and an events-plane handler feeding AR posting. No client package, no credential, no call log: the spec's own `SaaslogicCallLog` and `PollCursor` were dropped on that decision. #158 (PCI) closes by never touching card data rather than by work here. |

**What this does not change: none of these are built, and no verdict in §1 moves.** A rail is not a feature — every row above still needs our side written, and several need a third party's file format or API before they can be specified at all. The distinction worth carrying into planning is narrower than it looks: these are *integration* work against a layer that exists, not *infrastructure* work. That makes them cheaper to estimate, not done.

One standing consequence: no vendor credential belongs in this codebase. Anything that reaches an external system goes through apptor-connect, which holds the credential and never hands it out. **That rule now lives in CLAUDE.md § Integrations and in the architecture doc §3.6** — it is a standing constraint on every future integration, not a finding about Bozeman's requirements, and it was stated here first only because this is where the integration gaps were counted.

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

### Water / Wastewater & Stormwater (16)
| # | Requirement | Evidence |
|---|---|---|
| 64 | Taxes and franchise fees, configurable | `franchise|salesTax|taxRate`: zero hits |
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

> **Left this list: #74 — minimum bills — which was never absent.** Corrected 2026-10-21. `minimum_bill` is a rate-component kind: `rate.ts:50` defers it out of the main pass, `topo-sort.ts:113` orders every one of them last, and `pricing.ts:128` throws if one is ever priced directly. Exercised by the `bozeman-water-sfr` golden test, the ordering and property suites, and two integration suites. The original pass searched for a minimum-*charge* construct; the grammar spells it `minimum_bill`.

### Billing (14)
| # | Requirement | Evidence |
|---|---|---|
| 131 | Printed bill generation, third-party print export | no export |
| 136 | Bill holds | `billHold|holdBilling`: zero hits |
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

> **Left this list:** #130 and #137 on 2026-10-11 (built) and #133 (partial) — see the bill production entry in §2. **#138** on 2026-10-15: a `tiered` pricing may declare `standard_days` and `evaluators/pricing.ts` scales each `to` by the days billed; opt-in, so published schedules price unchanged until revised. The #138 closure was recorded in the revision header that day but never subtracted from this section's count or from §1 — corrected 2026-10-21.

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
7. **A scheduled billing run** — the run itself is now built end to end, screens included, but nothing *triggers* it: a person starts every run. The cron machinery is right there (five scheduled jobs run today, declared in `SCHEDULER_REGISTRY`), which is what makes this easy to read as done. Posting stays manual by design, so the gap is unattended *starting*, not unattended money.

8. **Three bill screens render invented data, two of them staff screens** (found 2026-10-21). `mockCustomerBills` and `mockAgreementBilling` in `web/lib/mock-billing.ts` are rendered by:

   | Screen | Component |
   |---|---|
   | `/customers/[id]` → Bills tab | `CustomerBillsTab` |
   | `/service-agreements/[id]` → Billing tab | `AgreementBillingTab` |
   | `/portal/bills` | `CustomerBillsTab` (same component) |

   A CSR opening a customer's Bills tab sees fabricated invoices, invoice numbers and a **Balance due** stat, with nothing on the page saying so. That is worse than a gap: an absent screen is read as absent, and this one is read as the customer's account.

   `customer-bills-tab.tsx:86` says it "will be replaced with a real API call when Phase 3 ships the invoice mirror table described in docs/specs/21-saaslogic-billing.md". **That table was dropped** — architecture §8 lists "the authoritative `Invoice` mirror" among the SaaSLogic items cancelled on 2026-10-09, because CIS now does its own rating. So the component is waiting on something nobody is going to build, while its real source (`Bill`, `BillSegment`, `LedgerEntry`) has existed since 2026-10-09 and is already rendered correctly by `/bills` and the account AR tab.

   **This document had it backwards in both directions**, which is the reason it is written up here rather than quietly fixed: §2 said only the portal was mock, and §6 said the portal pages had been fixed. Neither was true, and no requirement verdict changes — #156 and the portal items were already absent or partial. What changes is that two screens counted as working are showing fiction.

   **Closed 2026-10-22. The cost estimate written here on 10-21 was wrong, and wrongly shaped.** It proposed adding a `customerId` filter to `GET /api/v1/bills` and wiring all three screens to it. A `Bill` belongs to an Account, so there is no customer-level bill list in this data model to filter for — the estimate would have built one and then duplicated the account Bills tab that already worked. What the three screens actually needed were three different things:

   | Screen | What it needed | Done |
   |---|---|---|
   | `/customers/[id]` → Bills tab | **Deletion.** Bills are account-level; the customer page already has an Accounts tab, and `/accounts/[id]` → Bills is real. | Tab removed |
   | `/service-agreements/[id]` → Billing tab | **The right noun.** An agreement has `BillSegment`s, not bills, and `GET /api/v1/service-agreements/:id/bill-segments` already existed. The mock showed a SaaSLogic *subscription* — dropped 2026-10-09 — a hardcoded "Synced" pill, and an estimated charge nothing computes. | Rewritten against the real endpoint, plus `next-service-period`; 5 tests |
   | `/portal/bills`, `/portal/dashboard`, `/portal/invoices/[id]` | **One new endpoint.** `GET /portal/api/accounts/:accountId/bills`, because the staff route has no ownership check to borrow. The dashboard's figure now comes from `Account.balance` via `amountDue`. `/portal/invoices/[id]` was deleted: the customer-facing bill document is the PDF, and `/portal/api/bills/:id/document` already served it. | Endpoint + 5 integration tests; `BillsList` + 6 tests |

   `web/lib/mock-billing.ts` is deleted, and with it the invented premises, commodities, lifetime-paid figure and on-time rate — three of which had no source in this data model at all. `/portal/usage` also stopped telling customers that cost data was waiting on "the billing integration with SaaSLogic", which was wrong twice over.

## 6. Stale statuses in this folder's index

`README.md` status columns predate the AR and rating work and now understate what exists:

- **`bz/12` Corrections & Reversals** says "zero financial entities exist… `Account.balance` is never written by any code path". `LedgerEntry`, `LedgerApplication`, and `LedgerReasonDef` now exist with posting, allocation, adjustment, fee, deposit, refund, reversal, and reconciliation services, 12 integration suites, and a receipts and disbursements UI.
- **`bz/16` Wastewater Billing & WQA** says "no WQA infrastructure; no irrigation-meter flag; no historical-usage aggregation". `WqaValue` exists, WQA and winter-averaging are implemented in the rate engine with golden tests, and irrigation deduction works through a `net`/`subtract` transform with `meter:role` predicates.
- **`bz/05` Customer Portal** said "bills are mock". **That status was right and this document's first correction of it was wrong** — and on 2026-10-22 it stopped being true: the portal reads real bills through `GET /portal/api/accounts/:accountId/bills`, the dashboard's amount due comes from `Account.balance`, and `mock-billing.ts` is deleted (§5 item 8). What is still missing in the portal is **payments, communication preferences and AR history**, so the row needs rewriting rather than ticking. The history is worth keeping: a status that was accurate got "corrected" into a wrong one, and the wrong one is the thing that should not have been quoted anywhere.

Correcting these is worth doing before the statuses get quoted into the RFP response.

## 7. What this analysis does not cover

- Non-functional requirements (performance, availability, security posture) — not in the 202.
- Quality of what is built. "Built" means the behavior exists and tests exercise it, not that it is sufficient for Bozeman's volumes or edge cases.
- The 18 **Y-WC** answers are not treated differently here; a conditional answer still appears as a commitment in column 5.
