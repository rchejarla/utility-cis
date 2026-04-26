# Effective-Dating Constraints — Implementation Plan (Slice 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Add `btree_gist` exclusion constraints to `service_agreement` and `service_agreement_meter` to prevent overlapping ranges, add CHECK constraints for date ordering, add a cascading `closeServiceAgreement` helper that closes child meter assignments atomically, ship two point-in-time SQL helpers (`responsible_account_at`, `meter_assignment_at`) with REST endpoints + history-timeline UI components on premise + meter detail pages, and tighten the lifecycle workflows so generic PATCH cannot drift entities into inconsistent state.

**Spec:** [`docs/bozeman/15-gis-driven-defaults-and-effective-dating.md`](../../bozeman/15-gis-driven-defaults-and-effective-dating.md) — read §3.1 (FR-EFF-001..006), §3.2 (FR-EFF-010..014), and §3.3 (FR-EFF-020..022) first. The exclusion-constraint pattern is load-bearing.

**Slice 1 covers tasks 0-7** (database constraints + cascade helper + lifecycle workflow tightening + point-in-time helpers + history timeline). **Slice 2 (deferred):** `ServiceTerritory` entity + migration. **Slice 3 + 4 (deferred):** default rates and service availability. **Slice 5 (deferred):** GIS override controls. **Slice 6 (deferred):** attribute-driven rate rules per FR-EFF-046.

This slice has **no dependencies on docs 01/13/14** — pure database-and-service-layer work that closes a real correctness bug in production today (overlapping active SAs are silently allowed).

**Tech additions:** `btree_gist` Postgres extension. No new npm dependencies; the existing audit framework is reused as-is.

---

## File Structure

### Created

| Path | Responsibility |
|---|---|
| `packages/shared/prisma/migrations/<TS>_btree_gist_extension/migration.sql` | Hand-written migration enabling `btree_gist`. Empty Prisma migration; SQL only. |
| `packages/shared/prisma/migrations/<TS>_sa_effective_range_exclusion/migration.sql` | `effective_range tstzrange GENERATED` column on `service_agreement` + exclusion constraint scoped to `(utility_id, account_id, premise_id, commodity_id)` where `status IN ('PENDING', 'ACTIVE')`. |
| `packages/shared/prisma/migrations/<TS>_sam_effective_range_exclusion/migration.sql` | Same pattern on `service_agreement_meter` scoped to `(utility_id, meter_id)` where `removed_date IS NULL OR removed_date >= now()::date`. |
| `packages/shared/prisma/migrations/<TS>_sa_lifecycle_invariants/migration.sql` | CHECK: `end_date IS NULL OR end_date >= start_date` on both tables. Trigger `before_update_sa_lifecycle` enforcing the FR-EFF-003 rule that `status = FINAL/CLOSED` requires `end_date IS NOT NULL`. |
| `packages/shared/prisma/migrations/<TS>_point_in_time_helpers/migration.sql` | `responsible_account_at(p_premise_id uuid, p_commodity_id uuid, p_as_of_date date)` and `meter_assignment_at(p_meter_id uuid, p_as_of_date date)` SQL functions. |
| `packages/api/src/services/effective-dating.service.ts` | `closeServiceAgreement(saId, endDate, status, reason, actor)` cascade helper; `removeMeterFromAgreement(saId, meterId, removedDate, reason, actor)`; `swapMeter(saId, oldMeterId, newMeterId, swapDate, reason, actor)`. |
| `packages/api/src/routes/effective-dating-queries.ts` | Two REST endpoints: `GET /api/v1/premises/:id/responsible-account?commodity=<id>&as_of=<date>` and `GET /api/v1/meters/:id/assignment?as_of=<date>`. |
| `packages/api/src/__tests__/services/effective-dating.service.test.ts` | Unit tests: cascade close, race-tolerant edge cases, error messages on overlap, `swapMeter` happy path + concurrent rejection. |
| `packages/api/src/__tests__/integration/sa-overlap-exclusion.test.ts` | Testcontainers Postgres + concurrent worker pool: creates 50 SAs in parallel for the same `(account, premise, commodity)`; asserts exactly one survives, others receive a structured 409 response. |
| `packages/api/src/__tests__/integration/sam-overlap-exclusion.test.ts` | Same pattern on `service_agreement_meter`. |
| `packages/api/src/__tests__/integration/lifecycle-cascade.test.ts` | Closing an SA with N open meter assignments closes all of them in the same transaction; partial failures roll back; audit rows emitted for both SA + each meter assignment. |
| `packages/api/src/__tests__/integration/point-in-time-helpers.test.ts` | Fixture: 3 SAs and 4 meter assignments across 5 dates; asserts query results for each date match expected actor. Includes RLS check (other tenant returns null). |
| `packages/web/components/effective-dating/HistoryTimeline.tsx` | Generic horizontal-timeline component rendering date-range blocks. Used by both premise and meter detail pages. |
| `packages/web/app/(admin)/premises/[id]/history/page.tsx` | Premise detail "History" tab listing all SAs for the premise as date-range blocks. |
| `packages/web/app/(admin)/meters/[id]/history/page.tsx` | Meter detail "History" tab listing all SA assignments. |

### Modified

| Path | Change |
|---|---|
| `packages/shared/prisma/schema.prisma` | Add `effective_range Unsupported("tstzrange")?` declarations on `ServiceAgreement` and `ServiceAgreementMeter` so Prisma knows the columns exist; comment them as managed-by-migration. (`tstzrange` isn't natively supported by Prisma; the column is read-only at the application layer — application code uses `start_date`/`end_date` directly.) |
| `packages/api/src/services/service-agreement.service.ts` | (a) `updateServiceAgreement` rejects writes to `startDate`, `endDate`, `status` with a clear deprecation message pointing to dedicated endpoints. (b) Existing `addMeterToAgreement` is updated so its meter-uniqueness check is removed (the new exclusion constraint replaces it; pre-check stays for friendly error message before commit). |
| `packages/api/src/services/workflows.service.ts` | Refactor `transferService` and `moveOut` to call `closeServiceAgreement(...)`. `moveIn` adds a pre-check that no active SA already covers the same `(account, premise, commodity)` — friendly error before the constraint catches it at commit. |
| `packages/api/src/routes/service-agreements.ts` | (a) PATCH body schema rejects `startDate`/`endDate`/`status` with 422 + deprecation message. (b) New transitional endpoints: `POST /api/v1/service-agreements/:id/close` (calls `closeServiceAgreement`), `POST /api/v1/service-agreements/:id/meters/:meterId/remove` (calls `removeMeterFromAgreement`), `POST /api/v1/service-agreements/:id/meters/swap` (calls `swapMeter`). |
| `packages/shared/src/validators/service-agreement.ts` | Update `updateServiceAgreementSchema` (the PATCH input) to omit lifecycle fields. Add Zod schemas for the new transitional endpoints. |
| `packages/web/app/(admin)/premises/[id]/page.tsx` | Add "History" tab navigation (loads the timeline page on click). |
| `packages/web/app/(admin)/meters/[id]/page.tsx` | Same. |

---

## Task 0: `btree_gist` extension migration

**Goal:** Enable the `btree_gist` Postgres extension as a prerequisite for the exclusion constraints. Foundational; no behavior change.

**Files:**
- Create: `packages/shared/prisma/migrations/<TS>_btree_gist_extension/migration.sql`

**Steps:**
- [ ] Create a hand-written Prisma migration containing only `CREATE EXTENSION IF NOT EXISTS btree_gist;`. Idempotent.
- [ ] Update `packages/shared/prisma/migrations/migration_lock.toml` if needed (no change expected).

**Verification:**
- [ ] `pnpm --filter @utility-cis/shared exec prisma migrate dev` runs cleanly against a fresh database.
- [ ] `psql -c "\dx btree_gist"` shows the extension installed.

---

## Task 1: `ServiceAgreement` exclusion constraint

**Goal:** Add the generated `effective_range` column and exclusion constraint per FR-EFF-001 + FR-EFF-002. Prevent overlapping active SAs for the same `(account, premise, commodity)` at the database layer.

**Files:**
- Create: `packages/shared/prisma/migrations/<TS>_sa_effective_range_exclusion/migration.sql`
- Modify: `packages/shared/prisma/schema.prisma` (add `effective_range Unsupported("tstzrange")?` to ServiceAgreement, marked read-only)

**Steps:**
- [ ] Migration adds: `ALTER TABLE service_agreement ADD COLUMN effective_range tstzrange GENERATED ALWAYS AS (tstzrange(start_date::timestamptz, COALESCE(end_date, 'infinity'::timestamptz)::timestamptz, '[)')) STORED;`
- [ ] Migration adds the partial exclusion constraint:
  ```sql
  ALTER TABLE service_agreement
    ADD CONSTRAINT no_overlapping_active_sa EXCLUDE USING gist (
      utility_id WITH =,
      account_id WITH =,
      premise_id WITH =,
      commodity_id WITH =,
      effective_range WITH &&
    ) WHERE (status IN ('PENDING', 'ACTIVE'));
  ```
- [ ] Migration adds: `ALTER TABLE service_agreement ADD CONSTRAINT chk_sa_end_ge_start CHECK (end_date IS NULL OR end_date >= start_date);`
- [ ] Update `schema.prisma` to document the column without breaking type generation.

**Verification:**
- [ ] Prisma migration applies cleanly.
- [ ] Manual SQL test: insert two ACTIVE rows with overlapping ranges — second insert raises `exclusion_violation` (Postgres SQLSTATE 23P01).
- [ ] Manual SQL test: insert a row with `end_date < start_date` — raises `check_violation` (23514).
- [ ] Existing tests in `service-agreement.service.test.ts` continue to pass.

---

## Task 2: `ServiceAgreementMeter` exclusion constraint

**Goal:** Same pattern on the meter junction. Prevent a single physical meter from being on two open assignments at once. Per FR-EFF-010 + FR-EFF-011.

**Files:**
- Create: `packages/shared/prisma/migrations/<TS>_sam_effective_range_exclusion/migration.sql`
- Modify: `packages/shared/prisma/schema.prisma` (add `effective_range` to ServiceAgreementMeter)

**Steps:**
- [ ] Migration adds the generated `effective_range` column on `service_agreement_meter` using `added_date` and `removed_date` (mirror of Task 1).
- [ ] Migration adds the exclusion constraint scoped on `(utility_id, meter_id)`:
  ```sql
  ALTER TABLE service_agreement_meter
    ADD CONSTRAINT no_double_assigned_meter EXCLUDE USING gist (
      utility_id WITH =,
      meter_id WITH =,
      effective_range WITH &&
    ) WHERE (removed_date IS NULL OR removed_date >= now()::date);
  ```
- [ ] Migration adds: `ALTER TABLE service_agreement_meter ADD CONSTRAINT chk_sam_removed_ge_added CHECK (removed_date IS NULL OR removed_date >= added_date);`

**Verification:**
- [ ] Migration applies cleanly.
- [ ] Manual SQL test: assign meter M to SA-A starting 2024-01-01 with no removed_date; assign same meter to SA-B starting 2025-01-01 — second assignment raises `exclusion_violation`.
- [ ] Historical assignment overlap test: SA-A meter M with `removed_date = 2023-12-31`; new assignment of M to SA-B starting 2024-01-01 — succeeds (overlap with closed-in-the-past row is allowed by the WHERE clause).

---

## Task 3: Lifecycle invariants trigger

**Goal:** Enforce FR-EFF-003 — setting status to `FINAL`/`CLOSED` requires `end_date IS NOT NULL`; setting `end_date` while status is still `PENDING`/`ACTIVE` is rejected unless the same statement also moves status to a terminal state.

**Files:**
- Create: `packages/shared/prisma/migrations/<TS>_sa_lifecycle_invariants/migration.sql`

**Steps:**
- [ ] Migration creates trigger function `enforce_sa_lifecycle_invariants` that:
  - On INSERT: if `status IN ('FINAL', 'CLOSED')` then `end_date` MUST be non-null.
  - On UPDATE: if new `status` is `FINAL`/`CLOSED`, new `end_date` MUST be non-null.
  - On UPDATE: if old `status IN ('PENDING', 'ACTIVE')` AND new `end_date IS NOT NULL` AND new `status` is still `PENDING`/`ACTIVE`, raise an exception (use the close endpoint instead).
- [ ] Migration attaches the trigger as `BEFORE INSERT OR UPDATE` on `service_agreement`.

**Verification:**
- [ ] Manual SQL test: UPDATE setting `status = 'FINAL'` without setting `end_date` — raises a custom error message (`SA_LIFECYCLE_INVARIANT_VIOLATION`).
- [ ] Manual SQL test: UPDATE setting `end_date` to a past date with `status = 'ACTIVE'` — raises an error pointing to the close endpoint.
- [ ] Manual SQL test: UPDATE setting both `end_date` and `status = 'FINAL'` together — succeeds.

---

## Task 4: `closeServiceAgreement` cascade helper

**Goal:** A single transactional service helper that closes an SA AND all its open meter assignments atomically. Replaces the silent-orphan bug in today's `transferService`. Per FR-EFF-004.

**Files:**
- Create: `packages/api/src/services/effective-dating.service.ts`
- Modify: `packages/api/src/services/workflows.service.ts` (refactor `transferService`, `moveOut`)
- Create: `packages/api/src/__tests__/services/effective-dating.service.test.ts`
- Create: `packages/api/src/__tests__/integration/lifecycle-cascade.test.ts`

**Steps:**
- [ ] Implement `closeServiceAgreement(prisma, { saId, endDate, status, reason, actor })`:
  - Wrap in `prisma.$transaction`.
  - Read the SA (lock row); reject if already in terminal state (idempotent: same close re-applied is no-op, different terminal status is an error).
  - UPDATE the SA with `endDate`, `status`, plus existing `auditUpdate` wrapper.
  - UPDATE every `service_agreement_meter` where `service_agreement_id = saId AND removed_date IS NULL` setting `removed_date = endDate`. Emit one audit row per SAM update via `auditUpdate`.
  - Return the updated SA + count of meter assignments closed.
- [ ] Refactor `transferService`: replace the inline `prisma.serviceAgreement.update({ ..., status: "FINAL", endDate: transferDate })` with a call to `closeServiceAgreement`. The cascade naturally handles the meter assignments.
- [ ] Refactor `moveOut` (if it exists): call `closeServiceAgreement` rather than direct UPDATE.
- [ ] Add unit tests covering: happy path, idempotent re-close, double-terminal-status conflict, transactional rollback when one of N SAM updates fails (simulated via a test mock).
- [ ] Add integration test: create an SA with 3 meter assignments; call `closeServiceAgreement`; assert all 4 rows updated; assert 4 audit rows; simulate one meter-update failure and assert the SA stays in original state.

**Verification:**
- [ ] Unit tests pass.
- [ ] Integration test passes.
- [ ] `transferService` end-to-end test (existing): still passes; the meter assignments now have `removed_date` populated where before they were silently orphaned.

---

## Task 5: Tighten generic PATCH + add transitional endpoints

**Goal:** Lifecycle field changes go through dedicated endpoints, not generic PATCH. Per FR-EFF-006.

**Files:**
- Modify: `packages/api/src/services/service-agreement.service.ts` (reject lifecycle fields in `updateServiceAgreement`)
- Modify: `packages/shared/src/validators/service-agreement.ts` (PATCH input schema omits lifecycle fields)
- Modify: `packages/api/src/routes/service-agreements.ts` (add transitional endpoints)
- Create: `packages/api/src/__tests__/integration/lifecycle-endpoints.test.ts`

**Steps:**
- [ ] Update `updateServiceAgreementSchema` to omit `startDate`, `endDate`, `status`. Other fields (`notes`, `customFields`, etc.) remain editable.
- [ ] Update `updateServiceAgreement` to fail-fast if any caller passes those fields (defense-in-depth — the Zod validation catches it but a service-layer assertion provides a cleaner error path for legacy callers).
- [ ] Add `POST /api/v1/service-agreements/:id/close` route — accepts `{ endDate, status, reason }`, calls `closeServiceAgreement`, requires `service-agreements.close` permission (new). Default-grant to existing `service-agreements.write` role.
- [ ] Add `POST /api/v1/service-agreements/:id/meters/:meterId/remove` route — accepts `{ removedDate, reason }`, calls `removeMeterFromAgreement`. New permission `service-agreements.remove-meter`.
- [ ] Add `POST /api/v1/service-agreements/:id/meters/swap` route — accepts `{ oldMeterId, newMeterId, swapDate, reason }`, calls `swapMeter`. New permission `service-agreements.swap-meter`.
- [ ] Update API integration tests: existing PATCH tests that set lifecycle fields move to the new endpoints; tests that PATCH only non-lifecycle fields stay on the generic PATCH.
- [ ] Document the deprecation in `docs/specs/05-service-agreement.md` API section.

**Verification:**
- [ ] PATCH with `endDate` set returns 422 with the deprecation message.
- [ ] All three new endpoints work end-to-end.
- [ ] Existing `transferService` and `moveOut` HTTP flows unchanged.

---

## Task 6: `removeMeterFromAgreement` and `swapMeter` helpers

**Goal:** Discrete helpers for the two meter-assignment lifecycle transitions. Per FR-EFF-013 + FR-EFF-014. Both transactional.

**Files:**
- Modify: `packages/api/src/services/effective-dating.service.ts` (add the two helpers)

**Steps:**
- [ ] Implement `removeMeterFromAgreement(prisma, { saId, meterId, removedDate, reason, actor })`:
  - Read SAM row; reject if already removed.
  - UPDATE setting `removed_date = removedDate`.
  - Emit `auditUpdate` row.
  - Return the updated row.
- [ ] Implement `swapMeter(prisma, { saId, oldMeterId, newMeterId, swapDate, reason, actor })`:
  - Wrap in `prisma.$transaction`.
  - Pre-check: oldMeterId is currently assigned to the SA with `removed_date IS NULL`. newMeterId is not on any other open SAM (the constraint will catch but the pre-check gives a friendly error).
  - UPDATE the old SAM setting `removed_date = swapDate`.
  - INSERT new SAM with `added_date = swapDate`, `meterId = newMeterId`, same `service_agreement_id` and `is_primary` as the old.
  - Emit two audit rows.
- [ ] Unit tests for both helpers covering happy paths and error cases.

**Verification:**
- [ ] Unit tests pass.
- [ ] Integration test: swap meter on an active SA; assert old SAM has `removed_date`, new SAM exists, both audit rows emitted, exclusion constraint not violated.
- [ ] Integration test: attempt to swap to a meter that's already on another active SA — second commit fails with structured error.

---

## Task 7: Point-in-time SQL helpers + REST endpoints + UI history timeline

**Goal:** Answer "who owned service to premise X on date Y?" and "which SA was meter M on at date Y?" via fast SQL functions, exposed through the API and rendered on premise + meter detail pages. Per FR-EFF-020..022.

**Files:**
- Create: `packages/shared/prisma/migrations/<TS>_point_in_time_helpers/migration.sql`
- Create: `packages/api/src/routes/effective-dating-queries.ts`
- Create: `packages/api/src/__tests__/integration/point-in-time-helpers.test.ts`
- Create: `packages/web/components/effective-dating/HistoryTimeline.tsx`
- Create: `packages/web/app/(admin)/premises/[id]/history/page.tsx`
- Create: `packages/web/app/(admin)/meters/[id]/history/page.tsx`
- Modify: `packages/web/app/(admin)/premises/[id]/page.tsx` (add History tab nav)
- Modify: `packages/web/app/(admin)/meters/[id]/page.tsx` (add History tab nav)

**Steps:**
- [ ] Migration creates `responsible_account_at(p_premise_id, p_commodity_id, p_as_of_date)` per the spec body in §3.3 of doc 15. Marked `STABLE SECURITY INVOKER`.
- [ ] Migration creates `meter_assignment_at(p_meter_id, p_as_of_date)` returning `(service_agreement_id, account_id, premise_id)`.
- [ ] Both functions filter by `current_setting('app.current_utility_id')::uuid` so RLS-equivalent tenant scoping applies even from server-side calls.
- [ ] REST: `GET /api/v1/premises/:id/responsible-account?commodity=<id>&as_of=<date>` — calls the SQL helper; returns `{ accountId, accountNumber, asOfDate }` or 404 if no row matches.
- [ ] REST: `GET /api/v1/meters/:id/assignment?as_of=<date>` — returns `{ serviceAgreementId, agreementNumber, accountId, premiseId, asOfDate }` or 404.
- [ ] Both endpoints require `premise.read` and `meter.read` respectively.
- [ ] Integration test: fixture data with multiple SAs and SAMs; assert correct row returned for each test date; assert RLS via second tenant returns null.
- [ ] React component `HistoryTimeline.tsx`: receives `events: Array<{ id, label, startDate, endDate, status, link }>`, renders horizontal blocks with `react-day-picker` or a custom SVG layout (no new dependency — use Tailwind grid). Each block clickable.
- [ ] Premise history page: queries `service_agreement` for the premise (server component), renders one timeline per commodity.
- [ ] Meter history page: queries `service_agreement_meter` joined with SA + premise, renders one timeline.
- [ ] Add "History" tab nav links on existing premise and meter detail pages.

**Verification:**
- [ ] SQL helpers benchmarked against fixture: ≤50ms p99 with proper indexes (verify EXPLAIN).
- [ ] REST endpoints return correct results across the fixture timeline.
- [ ] UI timeline renders correctly at desktop (1280px), tablet (768px), and mobile (375px) widths per [02-mobile-and-responsive-ui.md](../../bozeman/02-mobile-and-responsive-ui.md) Tier 2.
- [ ] Clicking a block navigates to the SA detail page.

---

## Task 8: Documentation update

**Goal:** Update specs that describe SA + SAM behavior so the new constraints + endpoints are documented.

**Files:**
- Modify: `docs/specs/05-service-agreement.md` — note the exclusion constraints, the deprecated PATCH fields, the new transitional endpoints, the cascade behavior on close.
- Modify: `docs/specs/03-meter-management.md` — note the exclusion constraint on `service_agreement_meter`.

**Steps:**
- [ ] Update spec 05 §API endpoints to reflect new endpoints + deprecated PATCH fields.
- [ ] Update spec 05 §Business rules to call out the cascade-close behavior + invariants.
- [ ] Update spec 03 §API endpoints if any meter-listing query changes (none expected, but verify the meter detail still resolves through the same route).
- [ ] Add a "Migration notes" subsection to spec 05 calling out: pre-existing data may have orphaned `service_agreement_meter` rows where the parent SA is FINAL/CLOSED but the SAM has `removed_date IS NULL`. Document the one-time cleanup script (Task 9 candidate or a release-readiness checklist item).

**Verification:**
- [ ] Specs match the implemented behavior.
- [ ] No broken cross-references.

---

## Notes for the executing agent

1. The exclusion constraints catch races at COMMIT time. The application layer's pre-checks (overlap detection in `createServiceAgreement`, meter pre-check in `addMeterToAgreement`) stay because they produce friendlier error messages — but they're best-effort, not authoritative. The constraints are the source of truth.

2. The `effective_range` generated columns are read by Postgres' planner via the GIST index but are NOT read by application code. Service code uses `start_date`/`end_date` directly. Don't expose `effective_range` in API responses.

3. The cascade-close in Task 4 is intentionally NOT optional. There's no flag to "close SA but keep meter assignments open" — that's the bug we're fixing. If a caller wants different removed_dates for individual meters, they call `removeMeterFromAgreement` for each one BEFORE calling `closeServiceAgreement`; the cascade then becomes a no-op on those pre-closed rows (idempotent).

4. RLS on the new SQL helpers (Task 7): `STABLE SECURITY INVOKER` means they execute with the caller's permissions and read `current_setting('app.current_utility_id')` from the session. The Fastify request handler already sets that variable per request; no additional plumbing needed.

5. There is no production-data migration in this slice. Pre-existing orphaned `service_agreement_meter` rows (parent SA closed, child SAM still open) will continue to exist until a separate cleanup is run. Document this in spec 05 §Migration notes and add a follow-up task for a future slice. The new constraints don't reject the existing data — they only block new violations.

6. Skill: superpowers:test-driven-development applies. Each task above can be done test-first.
