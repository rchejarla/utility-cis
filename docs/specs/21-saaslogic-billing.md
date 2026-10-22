# SaaSLogic Payment Collection

**Module:** 21 — SaaSLogic Payment Collection
**Status:** Design — scope reduced 2026-10-09, transport settled 2026-10-21 (see Decision and Transport below). **Unblocked:** this spec said until 2026-10-21 that it waited on payment recording in module 23; that shipped on 2026-10-09/10. Implementation pending on the open items below, which need SaaSLogic sandbox access rather than more CIS work.
**External system:** [SaaSLogic](https://docs.saaslogic.io) — used here as a payment rail only, reached through apptor-connect
**Entities:** new columns on `Customer` and `Bill`. `SaaslogicCallLog` and `PollCursor` are **dropped** — see Transport.

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

## Transport — 2026-10-21

**SaaSLogic is reached through apptor-connect, not by a client of our own.** It is one vendor on the same rail as everything else that leaves this process (see CLAUDE.md § Integrations):

| Direction | Plane | What we write |
|---|---|---|
| Register an amount, provision a payer, fetch the hosted-page URL | `proxy` — `POST /proxy/v1/{integration}` | Request and response types, and the bill-keyed idempotency value. Nothing about auth, retries, backoff or rate limits. |
| Learn a payment settled | `events` — `POST /events/v1/{token}` | A handler and a status mapping, read by cursor. |

This replaces the client package the prior design asked for — "typed REST client, bearer-token auth, retry with backoff, idempotency keys, call-log emission". Four of those five are the proxy plane's job, and the fifth (an idempotency key anchored on the `Bill`) is one column, already specified below. A second integration mechanism alongside the rail would mean a second credential store, a second retry policy and a second audit trail, to reach one vendor.

Three consequences, each of which deletes something this spec previously asked for:

- **`SaaslogicCallLog` is dropped.** The proxy plane records the call; a parallel log in our database is a second copy of the same facts, free to disagree with it, with its own 90-day trim job to write and run.
- **`PollCursor` is dropped.** It existed because the prior design "found no webhook catalog in the public docs". The events plane is the inbound half and is verified and deduplicated already; if SaaSLogic cannot call out at all, the fallback is a scheduled pull through the `proxy` plane, whose watermark is one row in the existing settings namespace rather than an entity.
- **`billingIntegrationSettings` no longer describes this module.** `saaslogicBaseUrl`, `sandbox` and `pollMinutes` (schema at `packages/shared/src/validators/tenant-settings.ts:58`, UI at `/settings/billing`) each presuppose CIS dialling the vendor itself. Under the rail the operator's question is *which integration name collects payments*, exactly as bill storage already works — one name selects the instance, sandbox included. **Those three fields, their route and their page are still live and now contradict this spec**; changing them is a code task, not a doc one, and is not done.

**What would overturn this.** If SaaSLogic's hosted payment page requires a session our proxy cannot carry on the customer's behalf, the answer is the `resolve` plane — connection details plus a short-lived token — and still not a stored credential. The redirect itself is unaffected either way: that is the customer's browser talking to SaaSLogic, not this process, so no credential of ours is in it.

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

Three more were dropped on 2026-10-21 for a different reason — not because the pricing premise fell, but because the integration rail already does them: the `@utility-cis/saaslogic` client package, `SaaslogicCallLog`, and the per-tenant encrypted credential store. See Transport above.

`MeterIntervalRead` from the prior design is **not** dropped — interval reads are independently valuable to the native rate engine (`quantity-source` already resolves consumption). It is not a SaaSLogic concern, so it belongs with meter reading in module 08 rather than here.

## Prerequisite — satisfied 2026-10-21

This module could not be built first, and for three slices it was genuinely blocked: the billing chain reached the ledger and stopped, so there was nothing for a payment result to call into. **That is no longer true.** Module 23 slices 2–4c shipped on 2026-10-09/10, and the loop closes:

```
rate() -> BillSegment -> Bill -> LedgerEntry -> Account.balance
                                      ^
            POST /accounts/:id/payments -+  (allocated oldest-first by LedgerApplication)
```

Money received is recorded as a signed `LedgerEntry` and allocated against open charges, with reversal for NSF, refunds, fees, waivers and write-offs alongside it (`packages/api/src/routes/ar.ts`). There is deliberately **no `Payment` entity** — the earlier text here demanded one, which is why this section read as blocked long after it wasn't: a payment is a ledger entry, and the spec was waiting for a noun that the AR design had decided against.

So what remains is this module itself, and it is now a thin adapter: register an amount over the proxy plane, receive a result over the events plane, call the posting that already exists. The open items below are the only thing holding it, and every one of them is a question for SaaSLogic rather than work in CIS.

## Data model

### Retained from the prior design

- **`customer.saaslogic_customer_id`** — VARCHAR, null until first charge. Set by lazy upsert.

### Dropped 2026-10-21

- **`SaaslogicCallLog`** — the proxy plane is the outbound audit trail. See Transport.
- **`PollCursor`** — the events plane is the return path. See Transport.

### New

- **`bill.saaslogic_charge_id`** — VARCHAR, null until the Bill is registered for collection. The idempotency anchor: registering the same Bill twice must not create two payable charges.

Payment records themselves are **not** defined here — they belong to module 23, because CIS owns the ledger and payments may also arrive by cash, check or lockbox, which never touch SaaSLogic.

## Security and compliance

- **PCI:** no cardholder data path in CIS. Hosted payment page behind a redirect. Scope effectively zero.
- **RLS:** new tables and columns carry `utility_id` and use the standard tenant policy. Note the caveat in module 19 — the policies do not currently enforce, because the application role bypasses RLS.
- **Secrets:** **no SaaSLogic credential is stored in CIS at all** — apptor-connect holds it and never hands it out. This reverses the prior line here, which specified per-tenant encrypted credential storage and redaction from `saaslogic_call_log.request_body`; there is neither a credential nor that table to redact. The comment at `packages/shared/src/validators/tenant-settings.ts:22-24` still promises "a separate entity" for encrypted API-key storage and is wrong as of 2026-10-21.
- **Webhooks:** signature verification is the events plane's, not ours — it delivers verified, deduplicated events read by cursor. What we verify is that the event names a bill and an amount we recognise before anything posts.

## Open items

Unverified; needs SaaSLogic sandbox access or partner contact:

1. **How to register a one-off payable amount.** The prior design assumed subscriptions and `POST /invoices/on-demand`. With no subscription, confirm the right primitive for "charge this customer this amount, here is my reference."
2. **Payment result delivery.** Whether SaaSLogic can call out at all. The prior design found no webhook catalog in the public docs. If it can, the events plane receives it; if it cannot, a scheduled pull through the proxy plane does — either way no `PollCursor`, and the question is now about the vendor rather than about our mechanism.
3. **Hosted payment page URL.** The prior design assumed `GET /subscriptions/url`. Without subscriptions, confirm the equivalent.
4. **Partial payments and refunds.** Does SaaSLogic report partial settlement? CIS's AR design needs to know before it decides how to apply payments.
5. **Processing fees.** Who absorbs them, and does CIS need to record them as a separate AR line.
6. **ACH vs card.** Whether both are available, and whether settlement timing differs enough to need a pending state in CIS.
7. **Multi-currency** — out of scope. Single currency per tenant, from tenant settings.
