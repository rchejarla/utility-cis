# Rate Model v2 — Slice 5a: Single-SA Bill Creation + Persistence — Spec

**Date:** 2026-05-05
**Slice of:** Rate Model v2 ([`docs/specs/07b-rate-model-v2-design.md`](../../specs/07b-rate-model-v2-design.md))
**Builds on:** Slice 1 schema (shipped), Slice 3 engine (shipped), Slice 4 loaders (shipped at `a388028`)
**Scope:** On-demand single-SA bill generation. After this slice, an operator can pick a service agreement and a bill period, run the engine, and persist the result as a `Bill` row with line items. Batch run (cycle scheduler) and rebill/corrections are deferred to Slices 5b and 5c.

---

## 1. Goals and non-goals

### Goals

- New persistent entities: `Bill` and `BillLine`. The engine's `RatingResult` lands in these tables verbatim — `BillLine` is one row per `LineItem`, `Bill` carries totals + the source SA + the period.
- Service function `createBillForServiceAgreement(saId, period)` that orchestrates `loadBase → manifest → loadVariables → rate → persist`. Wraps the persist in a single transaction with the audit row.
- HTTP endpoint `POST /api/v1/service-agreements/:id/bills` that calls the service. Body is the period range. Returns the new `Bill` with lines.
- HTTP endpoints to read bills: `GET /api/v1/service-agreements/:id/bills` (list for SA) and `GET /api/v1/bills/:id` (detail with lines).
- Mark consumed `MeterRead` rows with `billedAt` so they aren't re-billed by accident.
- A **Bills** tab on the SA detail page showing the list of generated bills, with a modal/expansion that displays the line-item breakdown (label, kind, amount, source schedule).
- Integration test that boots a real DB, seeds the Bozeman SFR water customer (same as Slice 4 e2e), POSTs a bill request for May 2026, and asserts a `Bill` row of $69.65 with the expected line breakdown.

### Non-goals (deferred)

- **Batch billing** — driving multiple SAs from a `BillingCycle` schedule. Slice 5b.
- **Rebill / corrections** — supersedes pointer on `Bill`, diff against prior bill, automatic re-bill when a `MeterRead` is corrected. Slice 5c.
- **Bill rendering** — PDF / HTML / customer-facing view. The data model is sufficient to render later; templates are out of scope.
- **Payments / AR** — apply payments, statements, dunning. Existing `payments` module handled separately.
- **Bulk prefetch optimization** — the loader-system's `scope: "global"` capability is not exploited yet because the slice only runs one SA at a time. Slice 5b.
- **Auto-WQA computation** — Slice 4 shipped the storage; the seasonal recompute job is still later.
- **Async / queued bill generation** — the endpoint runs synchronously. Single-SA bills are fast (<1s) so the queue infrastructure isn't justified.

---

## 2. Architecture summary

The slice 5a service module lives at `packages/api/src/services/bill.service.ts`. The loader registry is built once per request (cheap — just constructor calls) by a small factory that mirrors what the Slice 4 e2e test already does inline. Engine code is unchanged.

Module structure:

```
packages/api/src/
├── lib/
│   └── rate-engine-registry.ts              # NEW — factory: build VariableRegistry for one SA+period
├── services/
│   └── bill.service.ts                      # NEW — createBillForServiceAgreement, list, get
├── routes/
│   ├── bills.ts                             # NEW — GET /api/v1/bills/:id
│   └── service-agreement-bills.ts           # NEW — POST + GET /api/v1/service-agreements/:id/bills
└── __tests__/integration/
    └── bill-creation.integration.test.ts    # NEW — Bozeman SFR golden case end-to-end

packages/shared/
├── prisma/
│   └── schema.prisma                        # MODIFIED — add Bill, BillLine
└── src/
    ├── events/index.ts                      # MODIFIED — add BILL_CREATED
    └── validators/
        └── bill.ts                          # NEW — createBillSchema, billQuerySchema

packages/web/
├── components/bills/
│   ├── bills-tab.tsx                        # NEW — list + create button
│   └── bill-detail-dialog.tsx               # NEW — line-by-line breakdown
└── app/service-agreements/[id]/page.tsx     # MODIFIED — add "Bills" tab
```

---

## 3. Data model

### `Bill`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `utility_id` | uuid | no | RLS-scoped |
| `service_agreement_id` | uuid | no | FK to `service_agreement(id)` |
| `period_start` | date | no | inclusive |
| `period_end` | date | no | inclusive |
| `subtotal` | decimal(14,4) | no | from `RatingResult.totals.subtotal` |
| `taxes` | decimal(14,4) | no | from `RatingResult.totals.taxes` |
| `credits` | decimal(14,4) | no | from `RatingResult.totals.credits` |
| `total` | decimal(14,4) | no | from `RatingResult.totals.total` |
| `minimum_floor_applied` | boolean | no | from `RatingResult.totals.minimumFloorApplied` |
| `bill_number` | varchar(50) | no | per-tenant sequential, format `BILL-{YYYYMM}-{seq}` |
| `created_at` | timestamptz | no | default `now()` |

Indexes:
- Primary `(id)`
- `(utility_id, service_agreement_id, period_start)` — list per SA
- `(utility_id, period_end)` — utility-wide reporting later
- `unique (utility_id, bill_number)` — bill numbers are unique per tenant

RLS policy: standard `current_setting('app.current_utility_id') = utility_id`.

### `BillLine`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `utility_id` | uuid | no | RLS — denormalized for indexing/RLS check |
| `bill_id` | uuid | no | FK to `bill(id)`, ON DELETE CASCADE |
| `label` | varchar(255) | no | from `LineItem.label` |
| `kind_code` | varchar(50) | no | from `LineItem.kindCode` |
| `amount` | decimal(14,4) | no | from `LineItem.amount` |
| `quantity` | decimal(14,4) | yes | from `LineItem.quantity` if present |
| `source_schedule_id` | uuid | no | FK to `rate_schedule(id)` (RESTRICT — historical reference) |
| `source_component_id` | uuid | no | FK to `rate_component(id)` (RESTRICT) |
| `sort_order` | int | no | preserves engine output order; assigned 100, 200, 300 … by index |

Indexes:
- Primary `(id)`
- `(bill_id, sort_order)` — render lines in order
- `(utility_id, source_component_id)` — "what bills used this component" lookups

RLS policy: standard.

### `ServiceAgreement.bills` relation

Add `bills Bill[]` to ServiceAgreement model (back-relation only, no schema change to SA columns).

### `MeterRead.billedAt` — already exists

Field already on `MeterRead` (`billedAt DateTime?`). The bill service flips it to `now()` for every read consumed by a `MeterLoader.load()` call inside the rating run. Reads with `billedAt IS NOT NULL` should not be billed twice — out of scope for this slice (no double-bill detection yet), but the column is set so a future check is cheap.

---

## 4. Public service API

```ts
// packages/api/src/services/bill.service.ts

export interface CreateBillInput {
  periodStart: Date;     // inclusive
  periodEnd: Date;       // inclusive
}

export interface BillWithLines {
  id: string;
  utilityId: string;
  serviceAgreementId: string;
  periodStart: Date;
  periodEnd: Date;
  subtotal: Decimal;
  taxes: Decimal;
  credits: Decimal;
  total: Decimal;
  minimumFloorApplied: boolean;
  billNumber: string;
  createdAt: Date;
  lines: BillLineRow[];
}

export interface BillLineRow {
  id: string;
  label: string;
  kindCode: string;
  amount: Decimal;
  quantity: Decimal | null;
  sourceScheduleId: string;
  sourceComponentId: string;
  sortOrder: number;
}

// Orchestration: loadBase → manifest → loadVariables → rate → persist
export function createBillForServiceAgreement(
  utilityId: string,
  actorId: string,
  actorName: string,
  saId: string,
  input: CreateBillInput,
): Promise<BillWithLines>;

export function listBillsForServiceAgreement(
  utilityId: string,
  saId: string,
): Promise<Array<Omit<BillWithLines, "lines">>>;

export function getBill(
  utilityId: string,
  id: string,
): Promise<BillWithLines>;
```

Errors surfaced to HTTP:

- `400 INVALID_PERIOD` — `periodEnd < periodStart` or period before SA start.
- `400 NO_ACTIVE_ASSIGNMENTS` — SA has no `SAScheduleAssignment` overlapping the period.
- `409 SCHEDULE_NOT_PUBLISHED` — at least one assigned schedule has `publishedAt IS NULL` (a draft schedule can't bill).

---

## 5. Public HTTP API

### `POST /api/v1/service-agreements/:id/bills`

Permission: `agreements:EDIT` (creating a bill is a billing action — uses EDIT not CREATE because the user already has rights to the SA).

Request:
```json
{
  "periodStart": "2026-05-01",
  "periodEnd":   "2026-05-31"
}
```

Response 201:
```json
{
  "id": "…",
  "billNumber": "BILL-202605-1",
  "periodStart": "2026-05-01",
  "periodEnd":   "2026-05-31",
  "subtotal": "69.65",
  "total":    "69.65",
  ...
  "lines": [
    {
      "label": "Service Charge — 5/8\" meter",
      "kindCode": "service_charge",
      "amount": "22.31",
      "quantity": null,
      "sourceScheduleId": "…",
      "sourceComponentId": "…",
      "sortOrder": 100
    },
    {
      "label": "Single Family — Tier 1",
      "kindCode": "consumption",
      "amount": "12.00",
      "quantity": "5.00",
      ...
    },
    ...
  ]
}
```

### `GET /api/v1/service-agreements/:id/bills`

Permission: `agreements:VIEW`.

Returns array (no pagination yet; an SA accumulates ~12 bills/year so the list is naturally bounded). Lines NOT included — call `GET /bills/:id` for that.

### `GET /api/v1/bills/:id`

Permission: `agreements:VIEW`. Returns the full `BillWithLines`.

---

## 6. Wire-up: registry factory

The Slice 4 e2e test wires up the `VariableRegistry` inline:

```ts
const registry = new VariableRegistry();
registry.register(new AccountLoader(prisma, utilityId, sa.id));
registry.register(new MeterLoader(prisma, utilityId, period));
... (8 loaders total)
```

Slice 5a extracts this into `packages/api/src/lib/rate-engine-registry.ts`:

```ts
export interface RegistryContext {
  utilityId: string;
  saId: string;
  accountId: string;
  premiseId: string;
  period: { startDate: Date; endDate: Date };
}

export function buildRegistry(prisma: PrismaClient, ctx: RegistryContext): VariableRegistry;
```

The 8-loader instantiation lives in this one place. The Slice 4 e2e test stays as-is for now (a follow-up "consolidate" task can switch it over later — out of scope here).

---

## 7. Persistence semantics

- The full pipeline (loadBase, manifest, loadVariables, rate, persist Bill+lines, mark MeterReads, audit) runs in **one Prisma transaction**. If any step fails the transaction rolls back — no half-billed state.
- `Decimal` values from `decimal.js` are converted to Prisma's `Decimal` via `.toFixed(4)` then parsed by Prisma. Money is stored at 4dp throughout.
- `bill_number` is generated inside the transaction by counting existing rows for `(utility_id, period_year_month)` and incrementing. Concurrent same-tenant bill creates would race, but this slice only ships single-SA on-demand creation with a human in the loop, and the unique index prevents duplicates (worst case: a 409 retry).
- `MeterRead.billedAt` is updated for every read that the engine's `MeterLoader` returned non-empty `meter:reads:*` for. We do NOT re-derive which reads were used after the fact — we trust the loader-call-tracking surfaced by `MeterLoader`. (See task notes.)
- The audit row uses `EVENT_TYPES.BILL_CREATED`, `entityType="Bill"`, `entityId=newBill.id`. `beforeState=null`, `afterState=BillWithLines`.

---

## 8. UI: Bills tab on SA detail

Service-agreement detail page (`packages/web/app/service-agreements/[id]/page.tsx`) gets a new tab:

```ts
{ key: "bills", label: `Bills (${sa.bills?.length ?? 0})` }
```

The new tab is a separate file (`packages/web/components/bills/bills-tab.tsx`) and renders:

1. **"Generate Bill" button** at the top — opens a dialog with two `DatePicker`s (period start / end). On confirm: `POST /api/v1/service-agreements/:id/bills`, refresh list.
2. **Bills table**:
    - Bill # | Period | Total | Status | Created | View
    - Status is a derived badge: "Generated" for now (more states coming with rebill/payments).
3. **View** opens `bill-detail-dialog.tsx` — a modal with the line-by-line breakdown grouped by source schedule, totals at the bottom.

The existing **"Billing"** tab (SaaSLogic mock) is left alone — that's Phase 3 SaaSLogic work, separate concern. The new tab is **"Bills"** specifically for v2 rate-engine output. The two coexist.

---

## 9. Test plan

### Unit-ish (vitest, no DB)

- `bill.service.ts` orchestration shape: given a stub of `loadBase`/`manifest`/`loadVariables`/`rate`, the function calls them in order, transforms the `RatingResult` into a `Bill+lines` shape correctly, returns expected output. Stub-based — fast.
- `rate-engine-registry.buildRegistry`: returns a `VariableRegistry` whose `validateKey` accepts every key produced by `engine.manifest()` for the seeded Bozeman SFR fixture. Catches misregistered loaders.

### Integration (testcontainers, full DB + seed)

`bill-creation.integration.test.ts` — adapts the Slice 4 e2e test:

1. Boot Postgres + run v2 seed.
2. Find the Bozeman SFR water SA + meter, set meter size, insert May 2026 read with consumption=12.
3. POST `/api/v1/service-agreements/:id/bills` with `{ periodStart: "2026-05-01", periodEnd: "2026-05-31" }`.
4. Assert response 201, `body.subtotal === "69.65"`, `body.lines.length >= 2`.
5. Assert: a `Bill` row exists in DB with the expected fields.
6. Assert: `BillLine` rows exist matching `lines.length`.
7. Assert: the consumed `MeterRead` now has `billedAt IS NOT NULL`.
8. GET `/api/v1/service-agreements/:id/bills` — returns array of length 1.
9. GET `/api/v1/bills/:id` — returns the bill with lines.
10. Negative: POST with `periodEnd < periodStart` → 400.
11. Negative: POST for a period with no overlapping schedule assignment → 400 NO_ACTIVE_ASSIGNMENTS.
12. Negative: POST for an SA whose schedule has `publishedAt IS NULL` → 409 SCHEDULE_NOT_PUBLISHED.

---

## 10. Open questions (resolved before plan)

1. **Bill number format.** `BILL-{YYYYMM}-{seq}` keyed on the bill's `created_at` month, not period month — easier to predict from a billing run timestamp. Sequence resets monthly per tenant.
2. **Soft delete of Bills?** No. Bills are immutable financial records. Slice 5c's rebill produces a NEW bill that supersedes the old one; the old one stays in place.
3. **Allow billing on a draft (unpublished) schedule?** No — the publish gate exists specifically to prevent ambiguity. A 409 is the right answer.
4. **Surface engine `trace`?** Persist the textual trace (skipReasons, fired flags) in `Bill.engineTrace JSONB`? Decision: **no, defer.** A trace is debug data; if we need it we can re-run the engine against the period (engine is pure). Saves a column.

---

## 11. What lands at the end of this slice

- `Bill` and `BillLine` Prisma models with RLS, indexes, and migration.
- `bill.service.ts` orchestrating engine + persistence in one transaction.
- 3 HTTP endpoints (POST create, GET list per SA, GET detail).
- "Bills" tab on SA detail with create dialog + list table + detail modal.
- Bozeman SFR golden integration test asserting the full-stack round-trip produces $69.65 in the DB.

After this lands, the user can pick a service agreement in the UI, click "Generate Bill", choose a date range, and see a real bill with line items computed by the v2 engine and persisted in the DB.
