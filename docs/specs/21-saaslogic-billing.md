# SaaSLogic Payment Collection

**Module:** 21 — SaaSLogic Payment Collection
**Status:** Design — scope reduced 2026-10-09 (see Decision below). Implementation pending; blocked on payment recording in module 23 (the ledger and posting have shipped).
**External system:** [SaaSLogic](https://docs.saaslogic.io) — used here as a payment rail only
**Entities:** new columns on `Customer` and `Bill`; `SaaslogicCallLog`, `PollCursor` retained from the prior design

## Decision — 2026-10-09

**CIS calculates everything. SaaSLogic only collects the amount.**

This reverses the original scope of this module, which had SaaSLogic acting as the rating and invoicing engine with CIS feeding it usage. Five slices of Rate Model v2 built native rating in CIS instead, so the premise no longer held.

| Concern | Owner |
|---|---|
| Rating, tiers, minimums, WQA, linked commodities | **CIS** — `lib/rate-engine` |
| Taxes and surcharges | **CIS** — rate components with `kindCode` `tax` / `credit` |
| Per-agreement charge detail | **CIS** — `BillSegment` + `BillSegmentLine` |
| Customer-facing bill and its total | **CIS** — `Bill` |
| Amount receivable, payments applied, balance | **CIS** — ledger and posting shipped (module 23 slice 1); payment recording and allocation outstanding (module 23 slices 2–3) |
| Card data, hosted payment page, settlement | **SaaSLogic** |

CIS is the system of record for what is owed. SaaSLogic is told an amount and reports back whether it was paid.

## Scope

Three responsibilities, down from four:

1. **Mirror the payer** — lazily provision a SaaSLogic customer the first time an Account needs to be charged.
2. **Present an amount due** — when a CIS `Bill` is issued, register its total with SaaSLogic so the customer has something payable.
3. **Capture the result** — learn that a payment succeeded, and hand that fact to CIS's AR posting so `Account.balance` moves.

No card tokenization in CIS. Payment UI stays hosted by SaaSLogic behind a redirect, so PCI scope remains effectively zero.

## What this module no longer does

The prior design is superseded. Removed, with reasons:

| Dropped | Why |
|---|---|
| Usage aggregation and `POST /subscriptions/{id}/resources` push | CIS rates natively; there is no reason to send consumption to a pricing engine we no longer use for pricing. |
| `BillingLineItem` entity | Superseded by `BillSegmentLine`, which is the real charge detail and is already shipped. |
| `commodity.saaslogic_resource_id`, `unit_of_measure.saaslogic_uom_id` | Only existed to map CIS units onto SaaSLogic's metering model. |
| `rate_schedule.saaslogic_plan_id` | Rates are not configured in SaaSLogic. There is no plan to point at. |
| `service_agreement.saaslogic_subscription_id` | Subscriptions exist to price recurring service. A payment rail needs a payer and an amount, not a subscription. |
| `reportingType: "Replace"` idempotency scheme | Was the retry-safety mechanism for usage push. Payment registration needs its own idempotency, keyed on the CIS `Bill`. |
| `Invoice` mirror as the authoritative document | CIS's `Bill` is the authoritative document. Any SaaSLogic-side record is a payment artifact, not the bill. |
| Tax owned by SaaSLogic | The rate engine already emits tax lines. Sending untaxed amounts to be taxed elsewhere would double-own the calculation. |
| Plan catalog lookups, `GET /products/{id}/plans` | Nothing to look up. |

`MeterIntervalRead` from the prior design is **not** dropped — interval reads are independently valuable to the native rate engine (`quantity-source` already resolves consumption). It is not a SaaSLogic concern, so it belongs with meter reading in module 08 rather than here.

## Prerequisite — payment recording does not exist yet

This module cannot be built first. The billing chain now reaches the ledger, but stops short of payments:

```
rate() -> BillSegment -> Bill -> LedgerEntry -> Account.balance
```

AR posting writes `Account.balance` inside the same transaction that creates the receivable, so delinquency sweeps real balances rather than seeded ones. What still blocks this module is the rest of the loop: there is no `Payment` entity, no allocation, and no way to record money received. Those arrive in the AR slices that follow.

So the order is:

1. **Module 23 — Accounts Receivable (ledger shipped; payments outstanding).** Still needed: a `Payment` entity, recording of money received, and allocation of payments against open ledger entries. The posting rule and the choice of a materialized `Account.balance` are already settled (see module 23 and the AR design doc). Payment plans and the collections workflow follow, in module 10.
2. **This module.** Once CIS can record a payment, SaaSLogic becomes a thin adapter: register an amount, receive a result, call AR posting.

Building the adapter before payments can be recorded would mean inventing AR semantics inside an integration, which is the wrong place for them.

## Data model

### Retained from the prior design

- **`customer.saaslogic_customer_id`** — VARCHAR, null until first charge. Set by lazy upsert.
- **`SaaslogicCallLog`** — outbound API audit trail; every mutating call. 90-day retention, nightly trim. Request bodies sanitized, credentials never logged.
- **`PollCursor`** — `(utility_id, job_name)` watermark for polling payment status, if webhooks remain unavailable.

### New

- **`bill.saaslogic_charge_id`** — VARCHAR, null until the Bill is registered for collection. The idempotency anchor: registering the same Bill twice must not create two payable charges.

Payment records themselves are **not** defined here — they belong to module 23, because CIS owns the ledger and payments may also arrive by cash, check or lockbox, which never touch SaaSLogic.

## Security and compliance

- **PCI:** no cardholder data path in CIS. Hosted payment page behind a redirect. Scope effectively zero.
- **RLS:** new tables and columns carry `utility_id` and use the standard tenant policy. Note the caveat in module 19 — the policies do not currently enforce, because the application role bypasses RLS.
- **Secrets:** SaaSLogic credentials stored per tenant, encrypted, never logged, redacted from `saaslogic_call_log.request_body`.
- **Webhooks (future):** HMAC signature verification required before any state change.

## Open items

Unverified; needs SaaSLogic sandbox access or partner contact:

1. **How to register a one-off payable amount.** The prior design assumed subscriptions and `POST /invoices/on-demand`. With no subscription, confirm the right primitive for "charge this customer this amount, here is my reference."
2. **Payment result delivery.** Webhook or polling. The prior design found no webhook catalog in the public docs; polling via `PollCursor` is the fallback.
3. **Hosted payment page URL.** The prior design assumed `GET /subscriptions/url`. Without subscriptions, confirm the equivalent.
4. **Partial payments and refunds.** Does SaaSLogic report partial settlement? CIS's AR design needs to know before it decides how to apply payments.
5. **Processing fees.** Who absorbs them, and does CIS need to record them as a separate AR line.
6. **ACH vs card.** Whether both are available, and whether settlement timing differs enough to need a pending state in CIS.
7. **Multi-currency** — out of scope. Single currency per tenant, from tenant settings.
