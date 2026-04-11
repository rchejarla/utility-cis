# SaaSLogic Billing Integration

**Module:** 21 — SaaSLogic Billing Integration
**Status:** Phase 3 — design complete, implementation pending
**External system:** [SaaSLogic](https://docs.saaslogic.io) — third-party subscription billing platform
**Entities:** new `SaaslogicResource`, `BillingLineItem`, `MeterIntervalRead`, `Invoice`, `SaaslogicCallLog`, `PollCursor`; new columns on `Customer`, `Commodity`, `RateSchedule`, `ServiceAgreement`

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
| `commodity` | `saaslogic_resource_id` | UUID FK | References `saaslogic_resource`. Null means commodity is not metered in SaaSLogic. |
| `rate_schedule` | `saaslogic_plan_id` | VARCHAR | Manually entered by admin. Null means rate is informational only. |
| `service_agreement` | `saaslogic_subscription_id` | VARCHAR | Set when agreement activates and subscription is provisioned. |

### SaaslogicResource

Reference table of reusable metered resources defined on the SaaSLogic side. A single resource (e.g., "electric_kwh") is shared across every meter that measures that commodity.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| code | VARCHAR(64) | CIS-local code, e.g., `electric_kwh` |
| saaslogic_resource_id | VARCHAR | Matching resource identifier in SaaSLogic |
| description | TEXT | |
| created_at / updated_at | TIMESTAMPTZ | |

**Unique:** `(utility_id, code)`, `(utility_id, saaslogic_resource_id)`

### BillingLineItem

A pending-or-sent charge for one agreement for one cycle. Metered consumption and fixed charges both land here before being pushed to SaaSLogic.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| service_agreement_id | UUID FK | |
| billing_cycle_id | UUID FK | |
| period_start | DATE | |
| period_end | DATE | |
| kind | ENUM | `METERED_CONSUMPTION`, `FIXED_CHARGE`, `ONE_TIME_FEE`, `ADJUSTMENT`, `DEPOSIT_APPLIED` |
| commodity_id | UUID FK | Null for non-metered kinds |
| saaslogic_resource_id | VARCHAR | Denormalized from commodity for the push payload |
| quantity | NUMERIC(18,6) | |
| uom | VARCHAR | Display only; SaaSLogic derives unit from resource |
| description | TEXT | Free text shown on invoice |
| source_ref | JSONB | Audit pointer (e.g., `{intervalReadIds: [...]}` or `{rateScheduleId, chargeCode}`) |
| state | ENUM | `PENDING`, `SENT`, `ACKED`, `FAILED` |
| idempotency_key | VARCHAR | `{cycle}:{subscription}:{resource}:{kind}` — unique |
| saaslogic_response | JSONB | Raw response for audit |
| error | TEXT | Populated when state = FAILED |
| created_at / updated_at | TIMESTAMPTZ | |

**Indexes:** `(billing_cycle_id, state)`, `(service_agreement_id, period_start)`, unique on `idempotency_key`.

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
   - Write one `BillingLineItem` with `kind = METERED_CONSUMPTION`
2. For each fixed charge in the rate schedule:
   - Write one `BillingLineItem` with `kind = FIXED_CHARGE`
3. Batch-push all PENDING line items for the agreement via `POST /subscriptions/{id}/resources`
4. Update line item state to `SENT` on 2xx, `FAILED` with error on non-retryable failure
5. Retry FAILED items up to 3 times on a follow-up job run

The idempotency key on each line item guarantees that a retried cycle close does not double-bill.

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
| POST | `/api/v1/billing-cycles/:id/close` | Trigger cycle close + push (idempotent) | `billing:admin` |
| POST | `/api/v1/saaslogic-resources` / CRUD | Admin-manage resource reference table | `admin` |

New permission strings: `billing:read`, `billing:write`, `billing:admin`. Added to the RBAC seed.

## UI pages

- **Settings → Billing** — SaaSLogic connection config (token, base URL), resource reference table management, test-connection button.
- **Rate Schedule edit page** — adds `saaslogicPlanId` input with help text.
- **ServiceAgreement detail page** — new "Billing" section showing subscription ID, link to SaaSLogic, "Issue ad-hoc charge" button, "Manage payment methods" button (redirect).
- **Customer detail page** — new "Bills" tab listing mirrored invoices with hosted-URL link-outs and status badges.
- **Meter detail page** — new "Interval reads" tab with a simple chart of recent intervals and a CSV import button.
- **Billing cycle detail page** — shows line item batch state, counts by state, retry-failed button.

## Security and compliance

- **PCI:** CIS has no cardholder data path. Payment UI is hosted by SaaSLogic behind a redirect. PCI scope is effectively zero.
- **RLS:** all new tables carry `utility_id` and use the standard tenant policy.
- **Secrets:** SaaSLogic API credentials stored per tenant in an encrypted settings table. Never logged. Redacted from `saaslogic_call_log.request_body`.
- **Webhooks (future):** will require HMAC signature verification before any state change.

## Phased rollout

| Sub-phase | Scope | User-visible? |
|---|---|---|
| 3.2 | SaaSLogic client package, auth, call log, resource reference table, rate schedule `saaslogicPlanId` field, lazy customer upsert, subscription provisioning on agreement activate | Admin only |
| 3.3 | Interval read hypertable, ingestion endpoint, basic meter-detail chart | Yes |
| 3.4 | Cycle close, aggregation, usage push, line item state machine, retry job | Admin only |
| 3.5 | Invoice mirror, polling reconciler, Bills tab on customer detail, payment-method redirect button | Yes |
| 3.6 | On-demand invoice UI, ad-hoc charge flow, billing cycle retry-failed UI | Yes |

Each sub-phase is independently shippable and testable against the SaaSLogic sandbox.

## Open items

1. **Webhook catalog** — confirm with SaaSLogic whether webhooks exist. If yes, replace polling with push in a follow-up.
2. **Payment portal URL endpoint** — verify the exact endpoint and whether SSO token passing is required. Current design assumes `GET /subscriptions/url` returns a usable redirect URL.
3. **Resource granularity on usage push** — confirm that `POST /subscriptions/{id}/resources` accepts one usage record per resource per cycle, not per meter per cycle. Design assumes the former.
4. **Tax handling** — confirm SaaSLogic computes tax from plan + customer address, or whether CIS needs to send tax line items separately.
5. **Multi-currency** — out of scope for 3.x. Single currency per tenant, stored in the tenant settings.
