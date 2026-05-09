# Rate Model v2 — Slice 5b: Account-level Bill aggregation — Spec

**Date:** 2026-05-08
**Slice of:** Rate Model v2 ([`docs/specs/07b-rate-model-v2-design.md`](../../specs/07b-rate-model-v2-design.md))
**Builds on:** Slice 5a (single-SA `BillSegment` creation, shipped + renamed at `3c2fdfb`)
**Scope:** Per-Account Bill aggregation. After this slice, an admin can generate one customer-facing `Bill` per Account per cycle period that aggregates that Account's `BillSegment`s. Batch run across all Accounts in a cycle is deferred to a renumbered Slice 5c.

---

## 0. Slice numbering note

This slice supersedes the original outline of "Slice 5b — batch billing run." The original slice plan was:

- Old 5b: Batch billing run
- Old 5c: Rebill / corrections

After the design conversation captured below, the order is now:

- **5b — Account-level Bill aggregation (this slice).** Per-account on-demand generation; no batch.
- **5c — Batch run.** Loops the 5b flow over a `BillCycle`'s Accounts on its bill day.
- **5d — Rebill / corrections.** What was originally 5c.

The reordering is justified in §1.2 below.

---

## 1. Goals and non-goals

### 1.1 Goals

This slice ships in two sub-slices that ship as two separate commits/PRs:

**Slice 5b.1 — Schema refactor (no functional change).**

- Drop `billing_cycle.read_day_of_month` (column collected today, consumed by zero code paths — verified).
- Move `billing_cycle_id` from `service_agreement` to `account`. Per-Account 1→1 cycle relationship, in line with industry convention (Oracle CC&B `CI_ACCT.BILL_CYC_CD`, SAP IS-U Contract Account FKKVKP).
- Update validators, services, UI forms, seed, integration test setup blocks to match.

**Slice 5b.2 — `Bill` entity + per-Account Generate flow.**

- New persistent entity `Bill` keyed on `(utility_id, account_id, period_start, period_end)`.
- Add nullable FK `bill_segment.bill_id` linking each segment to at most one Bill.
- Service function `generateBillForAccount(accountId, asOfDate?)` that picks unbilled segments in the period, sums totals, persists Bill, attaches segments — all in one transaction with audit.
- HTTP endpoints `POST /api/v1/accounts/:id/bills`, `GET /api/v1/accounts/:id/bills`, `GET /api/v1/bills/:id`.
- "Bills" tab on the Account detail page with a Generate button (auto-derived period, override allowed) and a per-SA segment-grouped detail modal.
- Integration test covering the Bozeman SFR golden case + 5 edge cases.

### 1.2 Non-goals (deferred)

- **Batch run across a cycle's Accounts** — Slice 5c (renumbered).
- **Rebill / corrections** — Slice 5d (was 5c).
- **`MeterRoute` entity for route-level read scheduling** — separate future slice. Designed-around in 5b: the bill engine consumes existing `MeterRead` rows, no code path in 5b assumes read scheduling lives on `BillCycle`.
- **`BillingCycle → BillCycle` rename** — considered, dropped. Synonym swap with no real benefit; cost of touching every reference for cosmetic Oracle-vocabulary alignment doesn't earn its keep. Entity stays `BillingCycle`. (Earlier session draft included this rename — discarded after CLAUDE.md cost-benefit check.)
- **Tenant-configurable billing model (`ACCOUNT` vs `PORTION`)** — considered, dropped. Speculative scaffolding for a customer that doesn't exist. Future migration to add `MeterRoute` (a different concept than full SAP-style portion-driven billing) is the better escape hatch — same customer-facing model, different read operations.
- **Bill rendering (PDF / HTML / email).**
- **Payment apply / AR balance on Bill** — Bills carry charges only; payments stay in the existing payments module.
- **Bill status enum (DRAFT / ISSUED / VOID).** None in 5b. Bill exists = issued. Add a status column when a real workflow needs it (bill rendering + email delivery is the natural moment).
- **Auto-generate missing segments before aggregating.** If an SA has no current-period segment, it's simply not on the Bill. Slice 5c (batch run) is the natural place for "for each SA: ensureSegment" orchestration; building it inline in 5b duplicates 5c.
- **`BIMONTHLY` / `QUARTERLY` cycle frequencies.** Engine throws `UNSUPPORTED_FREQUENCY` if encountered. Add when a customer needs it.
- **Tenant-configurable `dueDate` offset.** Hardcoded `statement_date + 30 days` for 5b. Flagged follow-up.

### 1.3 Why 5b first, batch (old 5b) second

Building batch first means building two hard things at once: aggregation logic AND run-level concerns (failure handling, idempotency, partial completion across accounts). Building per-account first lets us nail aggregation (the harder of the two — many edge cases around cycle alignment, partial periods, idempotency, multi-SA accounts) against a verifiable single-account surface, then loop it in 5c. The batch loop is mechanical once the per-account flow is correct.

---

## 2. Decisions and rationale

The conversation that produced this spec covered several architectural choices with non-obvious trade-offs. They're recorded here so the rationale survives the conversation:

| Decision | Choice | Why not the alternative |
|---|---|---|
| Bill grain | Per Account, per period | Per-SA = what we already have (BillSegment from 5a). Customers experience one bill per cycle, not N. |
| Cycle placement | On Account | On SA = current schema; doesn't match how customers experience billing or how Oracle CC&B / SAP IS-U model it. Moves up one level in the existing hierarchy — same shape of refactor as the ServicePoint move did for premise. |
| Read schedule | Decouple from BillCycle, defer to future `MeterRoute` | Conflating read schedule and bill schedule on one entity (status quo) is the v1 simplification. Industry split: bill schedule on Account (Oracle), read schedule on Installation/Portion (SAP). Future `MeterRoute` on `ServicePoint` is the clean form. |
| Read schedule today | Drop `read_day_of_month` from `BillingCycle` | Field is collected, consumed by no code. Carrying it implies behavior that doesn't exist. |
| Tenant config flag for billing model | No | Speculative scaffolding. Single billing model (account-level), accommodate route reading via future MeterRoute. |
| Statement vs Bill naming | `Bill` | We renamed `Bill → BillSegment` in the previous session specifically to free up `Bill` for this entity. Calling it `Statement` would contradict that. `Statement` reserved for a future "statement of account" (charges + payments + balance forward) if/when that emerges. |
| Bill-Segment link shape | FK column `bill_segment.bill_id` (nullable) | Join table = many-to-many, but the real cardinality is at-most-one. FK encodes the invariant structurally and simplifies all three load-bearing queries. |
| Period derivation | Auto-derive from `BillCycle.billDayOfMonth + frequency`, admin override allowed | Pure user-pick (5a's pattern) ignores the cycle — defeating the point of moving cycle to Account. Pull-based ("bill what's left") works for cleanup but not for the natural "bill May" mental model. |
| `BillingCycle → BillCycle` rename | No | Synonym swap, no real fix. Cost of touching every reference > vague Oracle alignment. |
| Auto-generate missing segments inline | No | That's 5c's job. Keeps 5b focused on aggregation. |
| Empty Bills | Disallowed | `NO_SEGMENTS_TO_BILL` at API. Avoids ambiguous zero-total Bills cluttering the AR view. |

---

## 3. Slice 5b.1 — Schema refactor

### 3.1 Migration

Single migration file. Path convention `packages/shared/prisma/migrations/<YYYYMMDDHHMMSS>_account_owns_billing_cycle/migration.sql`; the timestamp prefix is filled in when the migration is generated. Steps in order:

```sql
-- 1. Drop read_day_of_month from BillingCycle (no consumers).
ALTER TABLE billing_cycle DROP CONSTRAINT IF EXISTS billing_cycle_read_day_of_month_check;
ALTER TABLE billing_cycle DROP COLUMN read_day_of_month;

-- 2. Add nullable cycle FK to Account.
ALTER TABLE account ADD COLUMN billing_cycle_id UUID;

-- 3. Backfill from SA. Each Account inherits one of its SAs' cycles.
--    Dev DB invariant: all SAs under one Account share a cycle today, so any
--    pick is correct. The COALESCE/LIMIT 1 is defensive if real prod data
--    ever exhibits drift.
UPDATE account
   SET billing_cycle_id = (
     SELECT sa.billing_cycle_id
       FROM service_agreement sa
      WHERE sa.account_id = account.id
      LIMIT 1
   );

-- 4. NOT NULL + FK.
ALTER TABLE account ALTER COLUMN billing_cycle_id SET NOT NULL;
ALTER TABLE account
  ADD CONSTRAINT account_billing_cycle_fkey
  FOREIGN KEY (billing_cycle_id) REFERENCES billing_cycle(id) ON DELETE RESTRICT;
CREATE INDEX account_billing_cycle_idx ON account(utility_id, billing_cycle_id);

-- 5. Drop SA's cycle column.
ALTER TABLE service_agreement DROP CONSTRAINT IF EXISTS service_agreement_billing_cycle_id_fkey;
DROP INDEX IF EXISTS service_agreement_billing_cycle_idx;
ALTER TABLE service_agreement DROP COLUMN billing_cycle_id;
```

### 3.2 Code touchpoints

- `packages/shared/prisma/schema.prisma`: drop `BillingCycle.readDayOfMonth`; drop `ServiceAgreement.billingCycleId` and the `billingCycle` relation; add `Account.billingCycleId` + `billingCycle` relation; update `BillingCycle.serviceAgreements` back-relation to `accounts`.
- `packages/shared/src/validators/billing-cycle.ts`: drop `readDayOfMonth` from create/update schemas.
- `packages/shared/src/validators/service-agreement.ts`: drop `billingCycleId`.
- `packages/shared/src/validators/account.ts`: add `billingCycleId` (required on create).
- `packages/api/src/services/service-agreement.service.ts`: stop projecting cycle.
- `packages/api/src/services/account.service.ts`: include cycle on get/list responses.
- `packages/api/src/services/billing-cycle.service.ts`: no behavior change; drop `readDayOfMonth` from validator-derived types.
- `packages/api/src/lib/rate-engine-loaders/`: any loader that read `sa.billingCycle` now reads `sa.account.billingCycle` (one extra include in the loadBase query — verify).
- `packages/web/app/billing-cycles/{page,new/page,[id]/page}.tsx`: drop `readDayOfMonth` form field, list column, detail row.
- `packages/web/app/service-agreements/`: drop cycle picker from create/edit; list view drops cycle column or projects via account.
- `packages/web/app/accounts/`: add cycle picker to create/edit; list/detail show cycle.
- `packages/shared/prisma/seed.ts`: assign cycle per Account, not per SA.
- Integration test setup blocks (5 files) — drop `readDayOfMonth` from `BillingCycle` create payloads, move `billingCycleId` from SA create to Account create.

### 3.3 5b.1 verification

`pnpm exec tsc --noEmit` across `shared`/`api`/`web`. Full vitest run + integration tests. No new tests authored — the existing suite is the regression net.

---

## 4. Slice 5b.2 — `Bill` entity

### 4.1 `Bill` model

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `utility_id` | uuid | no | RLS-scoped |
| `account_id` | uuid | no | FK → `account(id)`, `onDelete: Restrict` |
| `bill_cycle_id` | uuid | no | FK → `billing_cycle(id)`. Materialized at issue for historical traceability — survives later cycle switches on the Account. |
| `period_start` | date | no | inclusive |
| `period_end` | date | no | inclusive |
| `bill_date` | date | no | When issued; typically `= period_end`. Materialized for invariance. |
| `due_date` | date | no | `bill_date + 30 days` for 5b (hardcoded; flagged follow-up). |
| `subtotal` | decimal(14,4) | no | Sum of attached `BillSegment.subtotal`. |
| `taxes` | decimal(14,4) | no | Sum. |
| `credits` | decimal(14,4) | no | Sum. |
| `total` | decimal(14,4) | no | Sum. |
| `bill_number` | varchar(50) | no | Per-tenant sequential, format `BILL-YYYYMM-N`. Same allocator pattern as `nextSegmentNumber` from 5a. |
| `created_at` | timestamptz | no | |

**Constraints / indexes:**

- `@@unique([utilityId, billNumber])`
- `@@index([utilityId, accountId, periodEnd])` — drives the per-Account Bills tab query.
- `@@index([utilityId, dueDate])` — for future delinquency queries (cheap to add now).
- RLS policy `tenant_isolation` (matches codebase convention).

### 4.2 BillSegment ↔ Bill linking

Add nullable column on existing `bill_segment`:

```
bill_id  UUID  NULL  REFERENCES bill(id) ON DELETE RESTRICT
```

Plus index `@@index([utilityId, billId])`.

- `null` = segment exists but is not yet attached (5a default state for any segment created standalone).
- non-null = segment is on that Bill. At most one Bill per segment, enforced by the column being singular (not a join table).

`Bill.segments BillSegment[]` back-relation added to schema.

### 4.3 Period derivation

`computeBillPeriod(account: { billCycle, createdAt }, asOfDate: Date) → { periodStart: Date; periodEnd: Date }`

For `frequency = MONTHLY`, `billDayOfMonth = D`, `asOfDate = today`:

- `periodEnd = the most recent date ≤ asOfDate that lands on day D` (today if today is day D, otherwise the prior month's day D).
- `periodStart = (one month prior to periodEnd) + 1 day`. E.g., billDay=15, asOfDate=2026-05-15 → periodEnd=2026-05-15, periodStart=2026-04-16.
- `periodStart = max(periodStart, account.createdAt)` to handle accounts created mid-period.

For `frequency = BIMONTHLY` or `QUARTERLY`: throw `UNSUPPORTED_FREQUENCY` (501). Add when a customer needs it.

`asOfDate` defaults to `new Date()` server-side if the route receives a null body or no `asOfDate` field.

### 4.4 Service contract

`packages/api/src/services/bill.service.ts` (new file — name freed by the 5a refactor):

```ts
export interface GenerateBillInput { asOfDate?: Date }

export interface BillSegmentRow { /* mirrors 5a BillSegmentSummary */ }

export interface BillSummary {
  id, utilityId, accountId, billCycleId,
  periodStart, periodEnd, billDate, dueDate,
  subtotal, taxes, credits, total,
  billNumber, createdAt,
}

export interface BillWithSegments extends BillSummary {
  segments: BillSegmentRow[];   // Each segment includes its lines for drill-down.
}

generateBillForAccount(
  utilityId, actorId, actorName, accountId, input
): Promise<BillWithSegments>;

listBillsForAccount(utilityId, accountId): Promise<BillSummary[]>;

getBill(utilityId, id): Promise<BillWithSegments>;
```

`generateBillForAccount` flow (single transaction, wrapped in `auditCreate` with `EVENT_TYPES.BILL_CREATED`):

1. Load `Account` + its `BillCycle`. Throw `ACCOUNT_NOT_FOUND` (404) if missing.
2. `computeBillPeriod(account, input.asOfDate ?? new Date())` → `{periodStart, periodEnd}`.
3. **Idempotency check:** any `Bill` exists for `(account_id, period overlapping [periodStart, periodEnd])`? If yes → throw `BILL_ALREADY_EXISTS_FOR_PERIOD` (409) with the existing Bill's id in the error response.
4. Find unbilled segments:
   ```sql
   SELECT bs.* FROM bill_segment bs
     JOIN service_agreement sa ON sa.id = bs.service_agreement_id
   WHERE bs.utility_id = ? AND sa.account_id = ?
     AND bs.bill_id IS NULL
     AND bs.period_end BETWEEN ? AND ?
   ORDER BY bs.period_end, bs.id
   ```
5. If zero rows → throw `NO_SEGMENTS_TO_BILL` (400).
6. Sum subtotals/taxes/credits/total at `decimal(14,4)`.
7. Allocate `bill_number` via `nextBillNumber(tx, utilityId, now)`.
8. Insert `Bill` row.
9. Update segments: `UPDATE bill_segment SET bill_id = ? WHERE id IN (?)` within tx.
10. `assembleBillWithSegments(tx, utilityId, bill.id)` and return.

Bill-number race: tx + unique constraint catches; second writer gets 23505 → 409 `BILL_NUMBER_CONFLICT` from route layer. Same shape as 5a segment-number race.

### 4.5 API contract

| Method | Path | Module | Permission |
|---|---|---|---|
| POST | `/api/v1/accounts/:id/bills` | `accounts` | `EDIT` |
| GET  | `/api/v1/accounts/:id/bills` | `accounts` | `VIEW` |
| GET  | `/api/v1/bills/:id`           | `accounts` | `VIEW` |

POST body: `{ asOfDate?: string }` (optional ISO date). Response 201 with `BillWithSegments`.

GET account/bills: `BillSummary[]` ordered `period_end DESC`.

GET bill: `BillWithSegments`.

`/api/v1/bills/:id` was the BillSegment route in 5a, renamed to `/api/v1/bill-segments/:id` in the 5a→5b1 sequence. This slice claims `/api/v1/bills/:id` for the Bill resource.

### 4.6 UI

New tab "Bills" on Account detail page (`packages/web/app/accounts/[id]/page.tsx`).

Components in `packages/web/components/bills/`:

- `bills-tab.tsx` — list of Bills (bill #, period, total, due date, created); "Generate Bill" button (EDIT permission); "View" link per row. Empty state mirrors `BillSegmentsTab`'s pattern.
- `bill-detail-dialog.tsx` — modal showing Bill header (number, period, dates, totals) and per-SA segment grouping. Each segment shows its line items inline (label, kind, quantity, amount). Reuses the rendering shape from `BillSegmentDetailDialog`.

Generate Bill dialog: a single date input pre-filled to today (admin can override per Option 2). Calling Generate POSTs and refreshes the list.

UI string conventions: tab is "Bills" (plural); button "Generate Bill"; column headers "Bill #" / "Period" / "Total" / "Due" / "Created". Mirrors the BillSegments tab but at account scope.

### 4.7 Aggregation rules + edge cases

| Case | Behavior |
|---|---|
| Zero matching segments | `NO_SEGMENTS_TO_BILL` (400) — empty Bills never created. |
| Multiple SAs, only some have segments | Bill aggregates whatever exists. Operator's responsibility to ensure all expected segments exist (5c will automate). |
| Old un-billed segment (prior period) | Excluded by date filter. Operator can issue a back-dated Bill via `asOfDate` override. |
| Closed SAs with final segments | Treated like any other segment; included if `periodEnd` in window. |
| Closed Accounts | Allowed — final bills, write-offs need this. No status check. |
| Partial-period account | `periodStart = max(computed, account.createdAt)`. |
| Idempotency (Generate twice) | Pre-check for existing overlapping Bill → 409 `BILL_ALREADY_EXISTS_FOR_PERIOD` with existing id. |
| Concurrent Generate (two admins) | First wins; second 23505 → 409 `BILL_NUMBER_CONFLICT`. |
| Cycle change mid-period | `computeBillPeriod` always reads current `Account.billCycle`. The `bill_cycle_id` materialized on the Bill row is whatever was current at issue. Segments before/after cycle switch still picked up by date filter. |
| Multi-cycle aggregation | Cannot happen post-5b.1 — cycle is on Account, all SAs share it. |
| Decimal precision | Sum at `decimal(14,4)`, matches segment precision. |

### 4.8 Audit

Each `generateBillForAccount` produces one `audit_log` row via `auditCreate`. Event type `BILL_CREATED` (added to `EVENT_TYPES`: `BILL_CREATED: "bill.created"`). `BillSegment.bill_id` updates ride inside the same transaction; no separate per-segment audit rows (the Bill creation is the load-bearing event).

---

## 5. Tests

### 5.1 5b.1 (refactor)

No new tests authored. All existing integration tests + typecheck pass after the refactor. Test setup blocks across ~5 integration tests have `readDayOfMonth` removed and `billingCycleId` moved from SA-create to Account-create. If anything broke, the existing suite catches it.

### 5.2 5b.2 (feature)

New file: `packages/api/src/__tests__/integration/bill-creation.integration.test.ts` (the name was freed when the 5a test was renamed to `bill-segment-creation.integration.test.ts`).

Setup pattern mirrors the 5a golden test: testcontainer, seed, Bozeman SFR account.

Six cases:

1. **Golden case — single-SA Bill aggregation.** Seed creates a `BillSegment` for the Bozeman SFR water SA at $69.65 (reuse the 5a fixture). POST `/accounts/:id/bills` with `asOfDate=2026-05-15`. Assert: 201, Bill row total=$69.65, segment's `bill_id` populated, audit row written.
2. **Multi-SA aggregation.** Test setup adds a second SA + segment to the same Account (synthetic — water $69.65 + sewer $30 = $99.65). Generate Bill. Assert: total $99.65, both segments linked.
3. **Period auto-derivation.** `asOfDate=2026-05-15`, account on cycle billDay=15 monthly. Assert: `period_start=2026-04-16`, `period_end=2026-05-15`.
4. **`NO_SEGMENTS_TO_BILL`.** Generate against an Account whose segments are all already billed. Assert: 400, `error.code = NO_SEGMENTS_TO_BILL`.
5. **`BILL_ALREADY_EXISTS_FOR_PERIOD`.** Generate twice with the same `asOfDate`. Assert: second call 409, `error.code = BILL_ALREADY_EXISTS_FOR_PERIOD`, response includes existing Bill's id.
6. **Partial-period account.** Account created `2026-05-08`. Generate with `asOfDate=2026-05-15`. Assert: `period_start=2026-05-08`, not `2026-04-16`.

### 5.3 Migration verification

The testcontainer runs `prisma migrate deploy` from scratch in `beforeAll`, so both the Slice 5a migrations AND the 5b.1 migration AND the 5b.2 migration apply in sequence. A broken migration fails every integration test fast.

### 5.4 What's deliberately not tested

- BIMONTHLY/QUARTERLY frequency — engine throws `UNSUPPORTED_FREQUENCY`; testing the throw is testing a guard, not a feature.
- UI render correctness — manual verification in the same walkthrough as Slice 5a's pending UI walkthrough.
- Concurrent race on bill_number — relying on Postgres unique-constraint semantics, same code shape as 5a.
- Cross-tenant RLS — covered by general RLS suite, not Bill-specific.

---

## 6. File-by-file change inventory

### 6.1 5b.1 (refactor)

```
packages/shared/prisma/migrations/<YYYYMMDDHHMMSS>_account_owns_billing_cycle/migration.sql  NEW
packages/shared/prisma/schema.prisma                                                   MOD
packages/shared/src/validators/billing-cycle.ts                                        MOD
packages/shared/src/validators/service-agreement.ts                                    MOD
packages/shared/src/validators/account.ts                                              MOD
packages/shared/prisma/seed.ts                                                         MOD
packages/api/src/services/service-agreement.service.ts                                 MOD
packages/api/src/services/account.service.ts                                           MOD
packages/api/src/services/billing-cycle.service.ts                                     MOD
packages/api/src/lib/rate-engine-loaders/                                              MOD (any loader reading sa.billingCycle)
packages/web/app/billing-cycles/{page,new/page,[id]/page}.tsx                          MOD
packages/web/app/service-agreements/                                                   MOD (drop cycle from create/edit/list)
packages/web/app/accounts/                                                             MOD (add cycle to create/edit/list)
packages/api/src/__tests__/integration/*.integration.test.ts                           MOD (5 setup blocks)
```

### 6.2 5b.2 (Bill feature)

```
packages/shared/prisma/migrations/<YYYYMMDDHHMMSS>_add_bill/migration.sql              NEW
packages/shared/prisma/schema.prisma                                                   MOD (add Bill model + bill_id on BillSegment)
packages/shared/src/events/index.ts                                                    MOD (add BILL_CREATED)
packages/shared/src/validators/bill.ts                                                 NEW (generateBillSchema)
packages/shared/src/validators/index.ts                                                MOD (export bill)
packages/api/src/services/bill.service.ts                                              NEW
packages/api/src/routes/account-bills.ts                                               NEW
packages/api/src/routes/bills.ts                                                       NEW
packages/api/src/app.ts                                                                MOD (register routes)
packages/api/src/__tests__/integration/bill-creation.integration.test.ts               NEW (6 cases)
packages/web/components/bills/bills-tab.tsx                                            NEW
packages/web/components/bills/bill-detail-dialog.tsx                                   NEW
packages/web/app/accounts/[id]/page.tsx                                                MOD (add Bills tab)
```

### 6.3 Doc updates (after both sub-slices land)

- `docs/specs/04-account-management.md` — add `billing_cycle_id` to Account schema reference.
- `docs/specs/05-service-agreement.md` — drop `billing_cycle_id` from SA reference.
- `docs/specs/07-rate-management.md` — drop `read_day_of_month` from BillingCycle.
- `docs/specs/00-data-model-overview.md` — add `Bill` row.

`docs/specs/09-billing.md` (Phase 3 SaaSLogic stub describing a planned `BillingRecord`) is intentionally left untouched; it's a different planned design and not in this slice's scope.

---

## 7. Open follow-ups (not blocking 5b)

1. **`MeterRoute` entity + `ServicePoint.routeId`** — drives route-level read scheduling. Cleanly accommodates SAP-portion-style operations without taking on portion-driven billing.
2. **Tenant-configurable `dueDate` offset** — replace the hardcoded 30 days.
3. **`Bill.status` enum** — when bill rendering and email delivery land.
4. **`BIMONTHLY` / `QUARTERLY` frequency support** — add to `computeBillPeriod`.
5. **Slice 5c — batch run** — loops `generateBillForAccount` over a `BillingCycle`'s Accounts on its bill day. Will likely need scheduler infrastructure (BullMQ already used elsewhere in the codebase per recent commits).
6. **Slice 5d — rebill / corrections** — was original 5c.
