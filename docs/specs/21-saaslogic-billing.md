# SaaSLogic Billing Integration

**Module:** 21 — SaaSLogic Billing Integration
**Status:** Phase 3 — design complete, implementation pending
**External system:** [SaaSLogic](https://docs.saaslogic.io) — third-party subscription billing platform
**Entities:** new `BillingLineItem`, `MeterIntervalRead`, `Invoice`, `SaaslogicCallLog`, `PollCursor`; new columns on `Customer`, `Commodity`, `UnitOfMeasure`, `RateSchedule`, `ServiceAgreement`

## Overview

CIS does not calculate charges, rate usage, or produce invoice PDFs. Those are SaaSLogic's job. CIS is the **system of record for meters, premises, agreements, and interval reads**, and the **integration shell** that feeds SaaSLogic the data it needs and surfaces the results back to end users.

The integration has four responsibilities:

1. **Mirror customers and subscriptions** — lazily provision a SaaSLogic customer and subscription when a ServiceAgreement activates.
2. **Aggregate and push usage** — collect interval meter reads, roll them up per billing cycle, and post usage records against the subscription's resources.
3. **Mirror invoices** — poll SaaSLogic for finalized invoices and display the hosted invoice link in the CIS UI.
4. **Proxy payment method management** — redirect customers to SaaSLogic's hosted portal for card-on-file management. CIS never holds card data.

No card tokenization happens in CIS. No webhook receiver ships in the initial phase (polling only). No plan catalog is managed from CIS — admins enter SaaSLogic plan IDs manually on each RateSchedule.

## External API contract

SaaSLogic base URL (sandbox): `https://api-sandbox.saaslogic.io/v1`. Production URL is configured per tenant.

**Auth:** `POST /saaslogic/token` returns a bearer token. The CIS client caches it until expiry and refreshes on 401.

**Endpoints used by CIS:**

| Endpoint | Purpose |
|---|---|
| `POST /customers` | Create SaaSLogic customer when first needed |
| `PUT /customers/{id}` | Push customer field updates |
| `POST /subscriptions` | Provision subscription on agreement activate |
| `GET /subscriptions/{id}` | Verify subscription state |
| `POST /subscriptions/{id}/resources` | Report usage for a billing cycle |
| `GET /subscriptions/{id}/resources/{resourceId}` | Read current cycle usage for reconciliation |
| `GET /products/{productId}/plans` | Reference: list plans (for admin UI lookup helper) |
| `GET /invoices?updated_since=...` | Poll for invoice state changes |
| `GET /invoices/{id}` | Fetch full invoice detail |
| `POST /invoices/on-demand` | Issue ad-hoc charge |
| `GET /subscriptions/url` | Get hosted portal URL for payment-method management |

**Endpoints deliberately NOT used:** vendors, vendor bills, states/countries (we have our own), permissions/menus/features (SaaSLogic product RBAC is irrelevant to CIS).

**Webhook support:** not visible in public API docs. Phase 3 ships with a polling reconciler. If webhooks become available, a `POST /api/v1/webhooks/saaslogic` receiver and a `saaslogic_webhook_event` idempotency table can be added without schema changes elsewhere.

## Data model

### New columns on existing entities

| Entity | Column | Type | Notes |
|---|---|---|---|
| `customer` | `saaslogic_customer_id` | VARCHAR | Null until first subscription. Set by lazy upsert. |
| `commodity` | `saaslogic_resource_id` | VARCHAR | Matching resource identifier in SaaSLogic. Null means commodity is not metered in SaaSLogic. |
| `unit_of_measure` | `saaslogic_uom_id` | VARCHAR | Matching UOM identifier in SaaSLogic (the `uomId` field on usage records). Required for any UOM used by a commodity that is pushed to SaaSLogic. |
| `rate_schedule` | `saaslogic_plan_id` | VARCHAR | Manually entered by admin. Null means rate is informational only. |
| `service_agreement` | `saaslogic_subscription_id` | VARCHAR | Set when agreement activates and subscription is provisioned. |

### BillingLineItem

One row per (agreement, commodity) per push event. Mirrors a single entry in the `usageDetails[]` array of a `POST /subscriptions/{subscriptionId}/resources` call. Multiple rows with the same `service_agreement_id` and `usage_date` are pushed together in a single POST — the array the user sends is built by grouping by agreement.

All the SaaSLogic-side IDs (`subscriptionId`, `resourceId`, `uomId`) are **resolved at push time** from the normalized FKs below. They are not duplicated into dedicated columns because those mappings already live on their canonical entities (`service_agreement.saaslogic_subscription_id`, `commodity.saaslogic_resource_id`, `unit_of_measure.saaslogic_uom_id`). The exact resolved payload IS preserved on the row, but only inside the frozen `request_payload` JSONB — see below.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| service_agreement_id | UUID FK | Subscription resolved at push time from `service_agreement.saaslogic_subscription_id` |
| commodity_id | UUID FK | `saaslogic_resource_id` resolved at push time from `commodity.saaslogic_resource_id` |
| uom_id | UUID FK | `saaslogic_uom_id` resolved at push time from `unit_of_measure.saaslogic_uom_id` |
| value | NUMERIC(18,6) | Quantity sent in the push (aggregated from interval reads or direct from a `MeterRead` delta) |
| usage_date | TIMESTAMPTZ | The `usageDate` on the POST body |
| reporting_type | VARCHAR(16) | Default `Replace` — see idempotency note below |
| billing_cycle_id | UUID FK | Which CIS cycle this row belongs to |
| source_ref | JSONB | Audit pointer back into CIS (e.g. `{intervalReadIds: [...]}` or `{meterReadId: '...'}`) |
| push_status | ENUM | `PENDING`, `PUSHED`, `FAILED`. Per-call status — there is no separate "sent vs acked" state because the push call is synchronous from CIS's perspective. |
| request_payload | JSONB | **Frozen snapshot** of the exact JSON sent to SaaSLogic at push time, with resolved `subscriptionId`, `resourceId`, `uomId`, and `value`. This is the audit record of "what did we tell SaaSLogic" and survives any later re-mapping of commodity / UOM IDs. |
| push_response | JSONB | SaaSLogic's response body. Pending confirmation of its shape. |
| pushed_at | TIMESTAMPTZ | When the push succeeded |
| error | TEXT | Populated when `push_status = FAILED` |
| created_at / updated_at | TIMESTAMPTZ | |

**Unique constraint:** `(service_agreement_id, commodity_id, usage_date)` — one row per commodity per push event per agreement. Retries update the existing row instead of creating new ones.

**Indexes:** `(billing_cycle_id, push_status)`, `(service_agreement_id, usage_date DESC)`.

#### Idempotency — `reportingType: "Replace"`

SaaSLogic's `POST /subscriptions/{id}/resources` accepts a `reportingType` field on the request body. The two observed values so far are `Add` (cumulative — appends to whatever total is already reported for that period) and `Replace` (overwrites the prior value for the same `(subscriptionId, resourceId, usageDate)` tuple).

CIS uses **`Replace`** as the default because it makes retries safe:

- If a POST succeeded on SaaSLogic's side but the CIS process crashed before marking `push_status = PUSHED`, the retry sets the same value with `Replace` and no double-count occurs.
- If a meter read is corrected after the cycle closed, CIS re-aggregates the line item and re-POSTs with the same `usage_date`. SaaSLogic overwrites the prior value. No separate reversal or credit memo flow is needed.

**Assumption to confirm:** that `Replace` is in fact a supported `reportingType` value. Once we have SaaSLogic sandbox access this needs a live test — if `Replace` is rejected, we fall back to `Add` plus CIS-side client-tracked idempotency on `(service_agreement_id, commodity_id, usage_date)`, accepting that a crash between success and status write is a small double-count risk.

### MeterIntervalRead

High-frequency meter reads. Stored as a TimescaleDB hypertable partitioned by `ts`.

| Field | Type | Notes |
|---|---|---|
| meter_id | UUID FK | Composite PK with ts |
| ts | TIMESTAMPTZ | |
| value | NUMERIC(18,6) | Interval consumption (delta), not register reading |
| quality | ENUM | `ACTUAL`, `ESTIMATED`, `SUBSTITUTED`, `MISSING` |
| source | VARCHAR | Ingest origin — `ami`, `manual`, `import`, etc. |
| utility_id | UUID | Tenant scope (required for RLS on hypertables) |
| created_at | TIMESTAMPTZ | |

**Hypertable:** `create_hypertable('meter_interval_read', 'ts', chunk_time_interval => interval '7 days')`
**Retention:** configurable per tenant, default 3 years.

The existing `MeterRead` entity stays as the low-frequency register-reading model used for cycle-close reads and manual entry. Interval is a separate, higher-volume stream. Cycle aggregation reads from interval when available and falls back to `MeterRead` delta.

### Invoice

Local mirror of SaaSLogic invoices. Populated by the polling reconciler.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| service_agreement_id | UUID FK | |
| billing_cycle_id | UUID FK | Null for on-demand |
| saaslogic_invoice_id | VARCHAR | Unique within tenant |
| invoice_number | VARCHAR | As assigned by SaaSLogic |
| status | ENUM | `DRAFT`, `APPROVED`, `SENT`, `PAID`, `PARTIALLY_PAID`, `OVERDUE`, `CANCELLED` |
| issued_at | TIMESTAMPTZ | |
| due_at | TIMESTAMPTZ | |
| currency | VARCHAR(3) | |
| subtotal | NUMERIC(14,2) | |
| tax | NUMERIC(14,2) | |
| total | NUMERIC(14,2) | |
| amount_paid | NUMERIC(14,2) | |
| hosted_url | TEXT | Link for end-user display |
| pdf_url | TEXT | Optional direct PDF |
| last_synced_at | TIMESTAMPTZ | Updated every poll |
| raw | JSONB | Full SaaSLogic payload for debugging |

**Unique:** `(utility_id, saaslogic_invoice_id)`
**Indexes:** `(service_agreement_id, issued_at DESC)`, `(status, due_at)`

### SaaslogicCallLog

Outbound API audit trail. Every mutating call to SaaSLogic lands here for debugging and compliance.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| utility_id | UUID | |
| method | VARCHAR | |
| path | VARCHAR | |
| request_body | JSONB | Sanitized |
| status_code | INT | |
| response_body | JSONB | Truncated to 64KB |
| duration_ms | INT | |
| idempotency_key | VARCHAR | When present |
| error | TEXT | |
| created_at | TIMESTAMPTZ | |

**Retention:** 90 days, trimmed by a nightly job.

### PollCursor

Tracks the `updated_since` watermark for each polling job, per tenant.

| Field | Type | Notes |
|---|---|---|
| utility_id | UUID | |
| job_name | VARCHAR | e.g., `invoice_reconciler` |
| last_seen_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**PK:** `(utility_id, job_name)`

## Services and jobs

### `@utility-cis/saaslogic` package

A new workspace package holding the typed API client. Responsibilities:

- Token fetch, cache, and refresh
- Retry with exponential backoff on 5xx and network errors (max 5 attempts)
- Idempotency key on every mutating call
- Structured logging into `saaslogic_call_log` via a callback so the package stays DB-agnostic
- Typed request/response models generated from OpenAPI if available, hand-written otherwise

### Customer lazy upsert

Not a background job — called inline from subscription provisioning. Pseudocode:

```
async function ensureSaaslogicCustomer(customerId) {
  const c = await prisma.customer.findUnique({where: {id: customerId}});
  if (c.saaslogicCustomerId) return c.saaslogicCustomerId;
  const created = await saaslogic.customers.create({...});
  await prisma.customer.update({where: {id: customerId}, data: {saaslogicCustomerId: created.id}});
  return created.id;
}
```

A separate lightweight hook on customer update pushes changed fields to SaaSLogic only when `saaslogicCustomerId` is already set.

### Subscription provisioning

Triggered when a ServiceAgreement transitions to ACTIVE.

1. Resolve `rateSchedule.saaslogicPlanId`. If null, fail with "Rate schedule not configured for billing."
2. `ensureSaaslogicCustomer(agreement.customerId)`
3. `POST /subscriptions` with `{customerId, planId, startDate}` and idempotency key `agreement:{id}:provision`
4. Store returned `subscriptionId` on the agreement
5. Log to `saaslogic_call_log`

Retries are safe because of the idempotency key.

### Interval ingestion endpoint

`POST /api/v1/meters/{id}/interval-reads` — batch insert into `meter_interval_read`. Accepts CSV or JSON. No authentication changes; uses the standard RBAC `meters:write` permission. Validates `utility_id` matches the meter's tenant.

### Billing cycle close — aggregation and push

Runs when a `BillingCycle` reaches its close date. For each ACTIVE agreement in the cycle:

1. For each commodity served by the agreement's meters:
   - Sum `meter_interval_read.value` in `[period_start, period_end)`
   - Fall back to `(end_reading - start_reading) * multiplier` from `MeterRead` if interval data is missing
   - Upsert a `BillingLineItem` row keyed on `(service_agreement_id, commodity_id, usage_date)` with `value` set to the aggregated quantity and `push_status = PENDING`. `usage_date` is a stable value tied to the cycle's close date (e.g. `period_end 23:59:59`) so retries target the same row.
2. Build one POST body per agreement: `{ usageDate, reportingType: "Replace", usageDetails: [...] }`. The `usageDetails` array is built by resolving each `BillingLineItem` row:
   - `resourceId` ← `commodity.saaslogic_resource_id`
   - `uomId` ← `unit_of_measure.saaslogic_uom_id`
   - `value` ← `billing_line_item.value`
3. POST to `/subscriptions/{subscriptionId}/resources` where `subscriptionId` comes from `service_agreement.saaslogic_subscription_id`.
4. On 2xx: mark every row included in the payload as `PUSHED`, record `pushed_at`, and freeze the exact request JSON into `request_payload`.
5. On non-2xx: mark every row included in the payload as `FAILED`, record the response body into `push_response`, and capture the error text.
6. Retry FAILED rows on a follow-up job run. Because `reportingType: "Replace"` overwrites at SaaSLogic's side, retries are idempotent — a retry after a partial failure is safe even if the first call actually reached SaaSLogic.

The push call is all-or-nothing per agreement: the `usageDetails` array is a single SaaSLogic call, so every row in that array shares the same outcome. A failure is therefore one agreement, not one line item. This matches how the operator UI reports failures in the "Close history" tab.

**Fixed charges and one-time fees.** The v1 cycle-close job pushes only metered consumption. Fixed charges (base fees, connection fees, monthly service charges) are assumed to live in the SaaSLogic plan configuration and are priced there automatically — CIS does not send them. If a use case emerges for sending fixed charges as line items, the natural path is `POST /invoices/on-demand` rather than the metered `/resources` endpoint, and would be a separate flow.

### Invoice reconciler (polling)

Runs every 5 minutes per tenant:

1. Read `poll_cursor` for `invoice_reconciler`
2. `GET /invoices?updated_since={cursor}` with pagination
3. Upsert each into `invoice` table keyed on `saaslogic_invoice_id`
4. Advance cursor to max `updated_at` seen
5. If any invoice transitioned to PAID, emit an internal event (for future dunning / notification hooks)

### Ad-hoc charge

UI action on agreement detail page → `POST /invoices/on-demand` → mirror row inserted immediately from the response. No wait for polling.

### Payment method redirect

UI button on agreement detail → backend calls `GET /subscriptions/url` (or equivalent hosted-portal URL endpoint) → responds with `{redirectUrl}` → web app navigates the browser. No local state.

## API surface (new CIS endpoints)

| Method | Path | Purpose | Permission |
|---|---|---|---|
| POST | `/api/v1/meters/:id/interval-reads` | Bulk interval read ingest | `meters:write` |
| GET | `/api/v1/service-agreements/:id/invoices` | List mirrored invoices for an agreement | `billing:read` |
| GET | `/api/v1/invoices/:id` | Invoice detail (local mirror) | `billing:read` |
| POST | `/api/v1/service-agreements/:id/ad-hoc-charge` | Create on-demand invoice in SaaSLogic | `billing:write` |
| GET | `/api/v1/service-agreements/:id/payment-portal-url` | Fetch hosted portal redirect URL | `billing:read` |
| POST | `/api/v1/billing-cycles/:id/close` | Trigger cycle close + push (idempotent via `Replace`) | `billing:admin` |

New permission strings: `billing:read`, `billing:write`, `billing:admin`. Added to the RBAC seed.

## UI pages

- **Settings → Billing** — SaaSLogic connection config (token, base URL, sandbox toggle, polling interval). Commodity and UOM mapping to SaaSLogic IDs happens on the Commodity and UOM admin pages, not here.
- **Commodity edit page** — adds `saaslogicResourceId` input with help text.
- **Unit of measure edit page** — adds `saaslogicUomId` input with help text.
- **Rate Schedule edit page** — adds `saaslogicPlanId` input with help text.
- **ServiceAgreement detail page** — "Billing" tab showing subscription ID, last push timestamp, current cycle snapshot, recent invoices. "Manage payment methods" button redirects to SaaSLogic hosted portal.
- **Customer detail page** — "Bills" tab listing mirrored invoices with hosted-URL link-outs and status badges.
- **Meter detail page** — "Interval reads" tab with a simple chart of recent intervals and a CSV import button.
- **Billing cycle detail page** — Overview tab with schedule + counts, Close history tab with prior cycle-close runs and per-run failure summaries. Failures are grouped by root cause (missing plan ID, missing resource mapping, etc.) so operators fix config once and re-run, rather than retrying rows individually.

## Security and compliance

- **PCI:** CIS has no cardholder data path. Payment UI is hosted by SaaSLogic behind a redirect. PCI scope is effectively zero.
- **RLS:** all new tables carry `utility_id` and use the standard tenant policy.
- **Secrets:** SaaSLogic API credentials stored per tenant in an encrypted settings table. Never logged. Redacted from `saaslogic_call_log.request_body`.
- **Webhooks (future):** will require HMAC signature verification before any state change.

## Phased rollout

| Sub-phase | Scope | User-visible? |
|---|---|---|
| 3.2 | SaaSLogic client package, auth, call log, `commodity.saaslogic_resource_id` + `unit_of_measure.saaslogic_uom_id` + `rate_schedule.saaslogic_plan_id` admin fields, lazy customer upsert, subscription provisioning on agreement activate | Admin only |
| 3.3 | Interval read hypertable, ingestion endpoint, basic meter-detail chart | Yes |
| 3.4 | Cycle close — aggregation, `BillingLineItem` upsert, usage push with `reportingType: "Replace"`, retry job | Admin only |
| 3.5 | Invoice mirror, polling reconciler, Bills tab on customer detail, payment-method redirect button | Yes |
| 3.6 | On-demand invoice UI, ad-hoc charge flow, billing cycle Close history tab with grouped failures | Yes |

Each sub-phase is independently shippable and testable against the SaaSLogic sandbox.

## Open items

Pending confirmation via SaaSLogic sandbox access or partner contact:

1. **`reportingType: "Replace"` is a supported value.** This is the assumed idempotency mechanism for cycle close and retry safety. Must be verified with a live call. If rejected, fall back to `Add` + CIS-side state gating on `(service_agreement_id, commodity_id, usage_date)` uniqueness.
2. **Response body shape for `POST /subscriptions/{id}/resources`.** Needed to know what to store in `BillingLineItem.push_response` and to surface useful error detail in the UI. Expected to include at minimum `{success: bool}` or an error object on failure; exact field names unknown.
3. **Error structure on 4xx/5xx.** Structured codes vs free-text. If structured, CIS can group failures by code in the Close history view; if free-text, CIS has to regex-match common patterns or just display the raw string.
4. **Webhook catalog** — confirm whether webhooks exist. If yes, replace polling with push in a follow-up. Design works either way.
5. **Payment portal URL endpoint** — verify the exact endpoint and whether SSO token passing is required. Current design assumes `GET /subscriptions/url` returns a usable redirect URL.
6. **Tax handling** — confirm SaaSLogic computes tax from plan + customer address, or whether CIS needs to send tax separately. Current design assumes SaaSLogic owns tax.
7. **Multi-currency** — out of scope for 3.x. Single currency per tenant, stored in the tenant settings.
