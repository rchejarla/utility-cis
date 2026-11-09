# Read Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A utility can define ordered meter-reading routes, print a sheet, type the day's readings back in with skip reasons, and see per-route progress — and a read arriving from anywhere can say which route it came from.

**Architecture:** Three small tables (`read_route`, `read_route_stop`, `read_skip`) plus a nullable `meter_read.route_id`. A route is an ordered list of premises; `origin` (`LOCAL`/`EXTERNAL`) says whether we or a vendor owns the itinerary. One shared predicate (`readableRowsForPremises`) expands a premise into the registers a reader must read, and the sheet, the entry screen and per-route progress all call it so their counts cannot disagree. Entry stages rows in the existing `ImportBatch`/`ImportRow` tables and commits through the existing `meter_read` import handler.

**Tech Stack:** Fastify + TypeScript (API), Next.js 15 + React 19 (web), Prisma + PostgreSQL 16/TimescaleDB with RLS, Zod validators shared across both, `@react-pdf/renderer` for the sheet, vitest (two configs).

**Spec:** `docs/superpowers/specs/2026-11-08-read-routes-and-reading-system-design.md`

## Global Constraints

- **Never run `prisma migrate dev`.** Write migration SQL by hand; apply with `migrate deploy`. (CLAUDE.md)
- **Every key between two tenant-scoped tables is composite:** `(utility_id, <fk>) -> parent (utility_id, id)`. Single-column keys fail `schema-invariants.integration.test.ts`.
- **Every new table:** `ENABLE` + `FORCE ROW LEVEL SECURITY`, a `tenant_isolation` policy on `utility_id = current_setting('app.current_utility_id')::uuid`, and a declaration in `schema-invariants.integration.test.ts`.
- **`utility_id` is a FK to `utility(id)` `ON DELETE RESTRICT`** and is NOT NULL on every table in this plan.
- **No new RBAC module.** Everything is `meter_reads`: `VIEW` to read, `CREATE` to enter, `EDIT` to maintain routes.
- **`await` inside `runAsTenant`.** Returning a lazy `PrismaPromise` out of the scope executes it after the scope exits.
- **One window, always `computeBillPeriod`** — never a locally derived span. `BillingCycle.read_day_of_month` is a day, not a range.
- **AMI meters never appear on a sheet or in a route's expected count.** `MANUAL` and `AMR` only.
- **No new scheduler.** Anything added would have to default to disabled and would resolve nothing until enabled.
- **Tests must not enqueue into the dev Redis.** Integration tests that hit a route which enqueues mock `enqueueSafely`.
- **The inbound vendor API (`POST /api/v1/imports/meter-read`) is NOT in this plan.** It is gated on a machine credential that does not exist (spec §9).

## Review Focus

Five failure modes the spec implies but no task's happy path exercises. Each has a test added to the task that owns the code.

1. **A vendor's route code collides with a `LOCAL` route code.** The importer would upsert into the hand-maintained route and start writing external reads onto an itinerary we own. Expected: the import rejects the row rather than adopting the route — Task 5.
2. **A route is submitted twice.** Double-submit, or a retried request, would write a second `meter_read` per stop and double next period's consumption. Expected: the second submit is a no-op reporting the first batch — Task 9.
3. **A skip is recorded for a meter that already has a read in the window.** Expected: refused; a skip is the absence of a read and cannot coexist with one — Task 6.
4. **The same premise is added to one route twice.** Expected: refused by a unique constraint; a reader cannot visit one address at two sequence numbers — Task 3.
5. **Entry against a period whose reads are already billed.** Expected: the row is rejected with the existing frozen-read behaviour, not silently written behind a bill — Task 9.

---

## File Structure

**Created**
- `packages/shared/prisma/migrations/20261109090000_read_routes/migration.sql` — the three tables, `meter_read.route_id`, CHECKs, partial indexes, RLS.
- `packages/shared/src/validators/read-route.ts` — Zod for routes, stops, entry rows, skips; the wire types both ends derive from.
- `packages/api/src/services/read-route.service.ts` — route and stop maintenance.
- `packages/api/src/services/read-route/readable-rows.ts` — the §5.12 predicate, alone, because three callers must share it.
- `packages/api/src/services/read-route/route-sheet.ts` — the printable sheet's data and its PDF.
- `packages/api/src/services/read-route-entry.service.ts` — open a batch, save a row, submit.
- `packages/api/src/services/read-skip.service.ts` — record and resolve skips.
- `packages/api/src/routes/read-routes.ts` — all HTTP for the above.
- `packages/web/app/read-routes/page.tsx`, `[id]/page.tsx`, `[id]/entry/page.tsx` — list, detail with stops, entry.
- `docs/specs/30-read-routes.md` — the spec this design becomes.

**Modified**
- `packages/shared/prisma/schema.prisma` — three models, one column.
- `packages/api/src/imports/handlers/meter-read.ts` — `routeCode` canonical field.
- `packages/api/src/services/meter-read.service.ts` — resolve skips when a read lands.
- `packages/api/src/services/reading-progress.service.ts` — `readRouteId` filter, origin branch, `skipReason` per row.
- `packages/api/src/app.ts` — register `readRouteRoutes`.
- `packages/api/src/__tests__/integration/schema-invariants.integration.test.ts` — declare the new tables.
- Seven `read_sequence` sites (Task 12).
- `docs/specs/05-service-agreement.md`, `docs/specs/08-meter-reading.md`, `CLAUDE.md`, `docs/bozeman/02-mobile-and-responsive-ui.md`.

---

## Task 1: The tables, the column, and the invariants

**Files:**
- Create: `packages/shared/prisma/migrations/20261109090000_read_routes/migration.sql`
- Modify: `packages/shared/prisma/schema.prisma`
- Test: `packages/api/src/__tests__/integration/read-route-schema.integration.test.ts`
- Modify: `packages/api/src/__tests__/integration/schema-invariants.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `read_route` (`id`, `utility_id`, `code` varchar(50), `name` varchar(255), `billing_cycle_id`, `origin` varchar(20), `active` boolean default true, `created_at`, `updated_at`), `read_route_stop` (`id`, `utility_id`, `read_route_id`, `premise_id`, `sequence` int, `created_at`), `read_skip` (`id`, `utility_id`, `meter_id`, `read_route_id` nullable, `read_date` date, `skip_reason` varchar(50), `notes` text nullable, `reader_id` uuid nullable, `resolved_at` timestamptz nullable, `created_at`), and `meter_read.route_id` uuid nullable. Prisma models `ReadRoute`, `ReadRouteStop`, `ReadSkip`; `MeterRead.routeId`.

- [ ] **Step 1: Write the failing test**

```ts
// read-route-schema.integration.test.ts — boots a container via bootPostgres
describe("read route schema", () => {
  it("forces RLS on all three tables", async () => { /* pg_class.relforcerowsecurity for each */ });
  it("refuses an origin outside LOCAL and EXTERNAL", async () => {
    await expect(insertRoute({ origin: "SOMETHING" })).rejects.toThrow(/read_route_origin_known/);
  });
  it("refuses a skip_reason outside the seven", async () => {
    await expect(insertSkip({ skipReason: "RAINING" })).rejects.toThrow(/read_skip_reason_known/);
  });
  it("refuses a second stop at the same sequence on one route", async () => { /* unique violation */ });
  it("refuses a route whose billing cycle belongs to another tenant", async () => { /* composite FK */ });
  it("refuses a second open skip for one meter on one date", async () => { /* partial unique */ });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @utility-cis/api test:integration src/__tests__/integration/read-route-schema.integration.test.ts`
Expected: FAIL — relation "read_route" does not exist.

- [ ] **Step 3: Write the migration SQL**

Follow `20261106140000_meter_data_exception/migration.sql` as the shape: a header comment stating what the table is and why, the table, composite tenant-scoped FKs, CHECKs, indexes, RLS, `COMMENT ON TABLE`. Specifics this plan pins:

- `read_route`: unique `(utility_id, code)`. FK `(utility_id, billing_cycle_id) -> billing_cycle (utility_id, id)` `ON DELETE RESTRICT`. CHECK `origin IN ('LOCAL','EXTERNAL')`.
- `read_route_stop`: FKs to `read_route` (`ON DELETE CASCADE`) and `premise` (`ON DELETE RESTRICT`). Unique `(utility_id, read_route_id, sequence)` **and** unique `(utility_id, read_route_id, premise_id)` — review-focus item 4. Index `(utility_id, read_route_id, sequence)`.
- `read_skip`: FK to `meter` `ON DELETE CASCADE` (a skip is a note about a meter, like `meter_data_exception`), FK to `read_route` `ON DELETE SET NULL`. CHECK `skip_reason IN ('LOCKED_GATE','DOG','BURIED','UNREADABLE','OBSTRUCTED','APPEARS_VACANT','NO_METER_FOUND')`. Partial unique `(utility_id, meter_id, read_date) WHERE resolved_at IS NULL`. Index `(utility_id, read_route_id, read_date)`.
- `meter_read`: `ADD COLUMN "route_id" UUID`, composite FK to `read_route` `ON DELETE SET NULL`, index `(utility_id, route_id)`. No backfill. **No unique constraint** — the hypertable requires `read_datetime` in every one.

- [ ] **Step 4: Add the three models and `MeterRead.routeId` to `schema.prisma`**

Declare `billingCycleId`, `readRouteId`, `premiseId`, `meterId` and `routeId` as **bare scalars with explicit relations only where Prisma permits them**; the composite keys stay in SQL. Copy the doc-comment convention from `MeterDataException`, including the note that the key is composite in the migration.

- [ ] **Step 5: Declare the tables in `schema-invariants.integration.test.ts`**

Add all three to the policied-table list, and to the tenant-scoped-FK expectations. Do **not** add them to the nullable-`utility_id` allowlist.

- [ ] **Step 6: Apply and regenerate**

Run: `cd packages/shared && npx prisma migrate deploy && pnpm --filter @utility-cis/shared exec prisma generate`
Expected: one migration applied, client regenerated.

- [ ] **Step 7: Run both tests to verify they pass**

Run: `pnpm --filter @utility-cis/api test:integration src/__tests__/integration/read-route-schema.integration.test.ts src/__tests__/integration/schema-invariants.integration.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/prisma packages/api/src/__tests__/integration
git commit -m "feat(read-routes): three tables, meter_read.route_id, and the invariants that pin them"
```

---

## Task 2: Route maintenance

**Files:**
- Create: `packages/shared/src/validators/read-route.ts`
- Create: `packages/api/src/services/read-route.service.ts`
- Test: `packages/api/src/__tests__/services/read-route.service.test.ts`

**Interfaces:**
- Consumes: Task 1's models.
- Produces:
  - `createReadRoute(utilityId, actor: { id: string; name: string }, input: ReadRouteInput): Promise<ReadRoute>`
  - `listReadRoutes(utilityId, query: ReadRouteQuery): Promise<{ data: ReadRouteSummary[]; meta: Paged }>`
  - `updateReadRoute(utilityId, actor, id: string, input: Partial<ReadRouteInput>): Promise<ReadRoute>`
  - `upsertExternalRoute(tx: ImportTx, utilityId: string, code: string, billingCycleId: string): Promise<string>` — returns the route id; Task 5 consumes this.
  - Zod: `readRouteInputSchema` (`code`, `name`, `billingCycleId`, `origin` defaulting `"LOCAL"`, `active`), `readRouteSchema`, `readRouteSummarySchema` (adds `stopCount`, `cycleCode`), `READ_ROUTE_ORIGINS = ["LOCAL","EXTERNAL"] as const`.

- [ ] **Step 1: Write the failing tests**

```ts
it("creates a LOCAL route by default", async () => { /* origin === "LOCAL" */ });
it("refuses a duplicate code on the same tenant", async () => {
  await expect(createReadRoute(/* same code */)).rejects.toMatchObject({ statusCode: 409, code: "ROUTE_CODE_TAKEN" });
});
it("refuses a billing cycle that is not this tenant's", async () => {
  await expect(createReadRoute(/* other tenant's cycle */)).rejects.toMatchObject({ statusCode: 404, code: "CYCLE_NOT_FOUND" });
});
it("upsertExternalRoute creates a route with no stops and origin EXTERNAL", async () => { /* origin, stopCount 0 */ });
it("upsertExternalRoute returns the existing id on a second call", async () => { /* same id */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @utility-cis/api test src/__tests__/services/read-route.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the validators and the five functions**

`upsertExternalRoute` must be callable inside an import row's transaction, so it takes `tx` rather than using the module-level client. Audit rows through `writeAuditRow` with `entityType: "ReadRoute"`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @utility-cis/api test src/__tests__/services/read-route.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/read-route.ts packages/api/src/services/read-route.service.ts packages/api/src/__tests__/services/read-route.service.test.ts
git commit -m "feat(read-routes): route maintenance, and a vendor code that becomes a route row"
```

---

## Task 3: Stops, in order

**Files:**
- Modify: `packages/api/src/services/read-route.service.ts`
- Modify: `packages/shared/src/validators/read-route.ts`
- Test: `packages/api/src/__tests__/integration/read-route-stops.integration.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - `addStop(utilityId, actor, routeId: string, input: { premiseId: string; afterSequence?: number }): Promise<ReadRouteStop>`
  - `removeStop(utilityId, actor, routeId: string, stopId: string): Promise<void>`
  - `listStops(utilityId, routeId: string): Promise<ReadRouteStop[]>` — ordered by `sequence`.
  - `listUnsequencedPremises(utilityId, routeId: string, query: Paged): Promise<{ data: PremiseSummary[]; meta: Paged }>`

- [ ] **Step 1: Write the failing tests**

```ts
it("appends a stop at the end when no position is given", async () => { /* sequence gaps of 100 */ });
it("inserts between two stops without renumbering them", async () => {
  // after seq 100 with 200 next → the new stop sits strictly between, and
  // the neighbours' sequences are unchanged.
});
it("refuses the same premise twice on one route", async () => {
  await expect(addStop(/* same premise */)).rejects.toMatchObject({ statusCode: 409, code: "PREMISE_ALREADY_ON_ROUTE" });
});
it("refuses a stop on an EXTERNAL route", async () => {
  await expect(addStop(/* external */)).rejects.toMatchObject({ statusCode: 400, code: "ROUTE_IS_EXTERNAL" });
});
it("lists premises in this tenant that are on no route", async () => { /* the unsequenced tray */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @utility-cis/api test:integration src/__tests__/integration/read-route-stops.integration.test.ts`
Expected: FAIL — `addStop` is not a function.

- [ ] **Step 3: Implement the four functions**

Sequences are **gapped integers, step 100**, appended as `max + 100`; an insert between `a` and `b` takes `floor((a + b) / 2)` and raises `SEQUENCE_FULL` (409) when no integer fits, which a caller resolves by resequencing the route. This is the §8 builder's-call made: it keeps an insert to one row written.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @utility-cis/api test:integration src/__tests__/integration/read-route-stops.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/read-route.service.ts packages/shared/src/validators/read-route.ts packages/api/src/__tests__/integration/read-route-stops.integration.test.ts
git commit -m "feat(read-routes): stops in order, inserted without renumbering the street"
```

---

## Task 4: The one predicate — which rows a stop produces

**Files:**
- Create: `packages/api/src/services/read-route/readable-rows.ts`
- Test: `packages/api/src/__tests__/integration/readable-rows.integration.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `readableRowsForPremises(utilityId: string, premiseIds: string[], onDate: Date): Promise<ReadableRow[]>` where `ReadableRow = { premiseId: string; meterId: string; meterNumber: string; registerId: string | null; registerNumber: string | null; serviceAgreementId: string; accountNumber: string; uomId: string }`. Tasks 7, 8 and 9 all call this and none re-derives it.

- [ ] **Step 1: Write the failing tests**

```ts
it("includes a MANUAL meter with an open assignment", async () => { /* one row */ });
it("includes an AMR meter", async () => { /* one row */ });
it("excludes an AMI meter, which nobody visits", async () => { /* no rows */ });
it("excludes a meter that is not ACTIVE", async () => { /* DEFECTIVE, PENDING_INSTALL */ });
it("excludes a meter whose assignment was removed before the date", async () => { /* no rows */ });
it("reaches the meter through the service point, so an agreement always resolves", async () => {
  // A meter whose Meter.premise_id is this premise but which has no open
  // ServicePointMeter must NOT appear — it would fail at submit with
  // METER_NOT_ASSIGNED, and the route posts as a whole.
});
it("returns one row per active register on a multi-register meter", async () => { /* two rows, distinct registerId */ });
it("returns one row with a null registerId for a single-register meter", async () => { /* one row */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @utility-cis/api test:integration src/__tests__/integration/readable-rows.integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `readableRowsForPremises`**

Query from `servicePointMeter` so the agreement is on the path, filtering `removedDate` open at `onDate`, `servicePoint.premiseId in premiseIds`, `meter.meterType in ("MANUAL","AMR")`, `meter.status = "ACTIVE"`. Expand to registers from the meter's active registers; a meter with none yields a single row with `registerId: null`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @utility-cis/api test:integration src/__tests__/integration/readable-rows.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/read-route packages/api/src/__tests__/integration/readable-rows.integration.test.ts
git commit -m "feat(read-routes): one predicate for which rows a stop produces"
```

---

## Task 5: A route code on an imported read

**Files:**
- Modify: `packages/api/src/imports/handlers/meter-read.ts`
- Test: `packages/api/src/__tests__/integration/meter-read-import-route.integration.test.ts`

**Interfaces:**
- Consumes: Task 2's `upsertExternalRoute`.
- Produces: an optional `routeCode` canonical field on the `meter_read` import kind; `meter_read.route_id` populated.

- [ ] **Step 1: Write the failing tests**

```ts
it("writes route_id for a known route code", async () => { /* matches the LOCAL route? no — see below */ });
it("creates an EXTERNAL route for a code nobody has seen", async () => { /* origin EXTERNAL, stopCount 0 */ });
it("reuses that route on the next import of the same code", async () => { /* one route row, two reads */ });
it("leaves route_id null when the file has no route column", async () => { /* null */ });
it("rejects a row whose route code names a LOCAL route", async () => {
  // Review focus 1. A vendor file must not write reads onto an itinerary
  // we maintain — it would look like our own route had been read.
  expect(row).toMatchObject({ ok: false, code: "ROUTE_IS_LOCAL" });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @utility-cis/api test:integration src/__tests__/integration/meter-read-import-route.integration.test.ts`
Expected: FAIL — no `routeCode` field.

- [ ] **Step 3: Add the canonical field and the resolution**

Canonical field `routeCode`, `required: false`, aliases `["^route$","^routecode$","^book$","^routeid$"]`, example `"W-04"`, description naming it as the vendor's route or book code. Resolve in `prepareBatch` (one lookup per distinct code, not per row): existing `EXTERNAL` → its id; existing `LOCAL` → mark the code rejected so `processRow` returns `ROUTE_IS_LOCAL`; unknown → `upsertExternalRoute` with the cycle of the row's account.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @utility-cis/api test:integration src/__tests__/integration/meter-read-import-route.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/imports/handlers/meter-read.ts packages/api/src/__tests__/integration/meter-read-import-route.integration.test.ts
git commit -m "feat(read-routes): an imported read carries the route it came off"
```

---

## Task 6: Skips, and their resolution

**Files:**
- Create: `packages/api/src/services/read-skip.service.ts`
- Modify: `packages/api/src/services/meter-read.service.ts`
- Modify: `packages/shared/src/validators/read-route.ts`
- Test: `packages/api/src/__tests__/integration/read-skip.integration.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 4.
- Produces:
  - `recordSkips(tx, utilityId, actor, input: { routeId: string | null; readDate: Date; meterIds: string[]; skipReason: SkipReason; notes?: string; readerId?: string }): Promise<number>`
  - `resolveSkipsForRead(tx, utilityId, meterId: string, readDate: Date): Promise<number>` — called from the read-create path.
  - Zod: `SKIP_REASONS` (the seven, exact strings from Task 1's CHECK), `skipReasonSchema`.

- [ ] **Step 1: Write the failing tests**

```ts
it("writes one skip per unread meter at the stop", async () => { /* a two-meter premise → 2 rows, one reason */ });
it("refuses a skip for a meter that already has a read in the window", async () => {
  // Review focus 3.
  await expect(recordSkips(/* meter read yesterday, same window */))
    .rejects.toMatchObject({ statusCode: 409, code: "METER_ALREADY_READ" });
});
it("resolves the skip when a read for that meter lands in the same window", async () => { /* resolved_at set */ });
it("leaves the other meters at the premise unresolved", async () => {
  // The front meter was read, the one round the back was not.
});
it("leaves a skip in a different window alone", async () => { /* still null */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @utility-cis/api test:integration src/__tests__/integration/read-skip.integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement both functions, and call the resolver**

`resolveSkipsForRead` is called inside `createMeterRead`'s transaction and inside the import handler's `processRow`, both of which already have a `tx`. The window comes from `computeBillPeriod` on the meter's account cycle — never a locally derived span.

- [ ] **Step 4: Run to verify they pass, and that nothing else moved**

Run: `pnpm --filter @utility-cis/api test src/__tests__/services/meter-read.service.test.ts && pnpm --filter @utility-cis/api test:integration src/__tests__/integration/read-skip.integration.test.ts`
Expected: PASS both. Report any pre-existing failure by name.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/read-skip.service.ts packages/api/src/services/meter-read.service.ts packages/shared/src/validators/read-route.ts packages/api/src/__tests__/integration/read-skip.integration.test.ts
git commit -m "feat(read-routes): a stop that produced no number says why, and heals when it is read"
```

---

## Task 7: Progress, per route

**Files:**
- Modify: `packages/api/src/services/reading-progress.service.ts`
- Modify: `packages/shared/src/validators/meter-read.ts:244-352`
- Test: `packages/api/src/__tests__/integration/reading-progress.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 6.
- Produces: `MeterReadingProgressQuery` gains optional `readRouteId`; `OutstandingRead` gains `routeCode: string | null` and `skipReason: string | null`. `getReadingProgress`'s signature is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to the existing file, which already boots a container and whose fixtures this reuses:

```ts
it("counts only the stops on the named LOCAL route", async () => { /* expected scoped to stops */ });
it("ignores the account's cycle when the route names stops", async () => {
  // §5.1: the sheet prints every stop, so the count must match the sheet.
});
it("expects, for an EXTERNAL route, the meters its last reads carried", async () => {
  // §5.4: membership is learned.
});
it("reports received-only for an EXTERNAL route with no prior reads", async () => { /* expected 0 */ });
it("names the skip reason on an outstanding row", async () => { /* skipReason: "LOCKED_GATE" */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @utility-cis/api test:integration src/__tests__/integration/reading-progress.integration.test.ts`
Expected: FAIL — `readRouteId` is not accepted.

- [ ] **Step 3: Implement the branch**

One branch on `origin`, producing the expected meter set — `readableRowsForPremises` over the route's stops for `LOCAL`, and for `EXTERNAL` the meters whose most recent `meter_read` carried this `route_id`. Everything downstream of that set is shared with the existing cycle-wide path. Keep `agreementInWindow` as the window filter; do not copy it.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @utility-cis/api test:integration src/__tests__/integration/reading-progress.integration.test.ts src/__tests__/integration/response-contracts.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/reading-progress.service.ts packages/shared/src/validators/meter-read.ts packages/api/src/__tests__/integration/reading-progress.integration.test.ts
git commit -m "feat(read-routes): progress a reading week can be worked from"
```

---

## Task 8: The printed sheet

**Files:**
- Create: `packages/api/src/services/read-route/route-sheet.ts`
- Test: `packages/api/src/__tests__/services/route-sheet.test.ts`

**Interfaces:**
- Consumes: Task 4.
- Produces:
  - `buildRouteSheet(utilityId: string, routeId: string, onDate: Date): Promise<RouteSheet>` where `RouteSheet = { routeCode: string; routeName: string; cycleCode: string; readsDueOn: string; stops: SheetStop[] }` and `SheetStop = { sequence: number; address: string; accountNumber: string; meterNumber: string; registerNumber: string | null; lastReading: string | null; lastReadDate: string | null }`
  - `renderRouteSheetPdf(sheet: RouteSheet): Promise<Buffer>`

- [ ] **Step 1: Write the failing tests**

```ts
it("orders stops by sequence, not by address", async () => { /* sequence order */ });
it("prints the cycle's read day as a due date, not a five-day span", async () => {
  expect(sheet.readsDueOn).toBe("2026-01-15"); // read_day_of_month, resolved
});
it("prints every stop on the route even when an account is on another cycle", async () => { /* §5.1 */ });
it("refuses to build a sheet for an EXTERNAL route", async () => {
  await expect(buildRouteSheet(/* external */)).rejects.toMatchObject({ statusCode: 400, code: "ROUTE_IS_EXTERNAL" });
});
it("renders a PDF", async () => { expect((await renderRouteSheetPdf(sheet)).subarray(0, 4).toString()).toBe("%PDF"); });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @utility-cis/api test src/__tests__/services/route-sheet.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement both functions**

Reuse `@react-pdf/renderer`'s `renderToBuffer`, as `bill-generation/generate-bill-pdf.ts` does — no new dependency. The sheet is **not persisted**: no `putObject`, no storage key. The seven skip codes print as a footer legend; take the labels from `SKIP_REASONS` so the sheet and the entry screen cannot drift.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @utility-cis/api test src/__tests__/services/route-sheet.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/read-route/route-sheet.ts packages/api/src/__tests__/services/route-sheet.test.ts
git commit -m "feat(read-routes): a sheet a reader can carry"
```

---

## Task 9: Entry — staged, then posted as a whole

**Files:**
- Create: `packages/api/src/services/read-route-entry.service.ts`
- Create: `packages/api/src/routes/read-routes.ts`
- Modify: `packages/api/src/app.ts`
- Test: `packages/api/src/__tests__/integration/read-route-entry.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 4, 6, 8.
- Produces:
  - `openEntry(utilityId, actor, routeId: string, readDate: Date): Promise<{ batchId: string; rows: EntryRow[] }>` — idempotent: an open batch for that `(route, date)` is returned rather than a second one created.
  - `saveEntryRow(utilityId, actor, batchId: string, input: { meterId: string; registerId: string | null; reading?: number; skipReason?: SkipReason; notes?: string }): Promise<EntryRow>`
  - `submitEntry(utilityId, actor, batchId: string): Promise<{ batchId: string; status: string; importedCount: number; errorCount: number; skipsRecorded: number }>`
  - HTTP: `GET /api/v1/read-routes`, `POST /api/v1/read-routes`, `GET/PATCH /api/v1/read-routes/:id`, `GET/POST /api/v1/read-routes/:id/stops`, `DELETE /api/v1/read-routes/:id/stops/:stopId`, `GET /api/v1/read-routes/:id/unsequenced`, `GET /api/v1/read-routes/:id/sheet` (PDF), `POST /api/v1/read-routes/:id/entry`, `PATCH /api/v1/read-routes/:id/entry/:batchId/rows`, `POST /api/v1/read-routes/:id/entry/:batchId/submit`, `GET /api/v1/read-routes/:id/progress`.

- [ ] **Step 1: Write the failing tests**

```ts
it("opens one batch per route per date, with a row per readable register", async () => {
  // entityKind "meter_read", source "API", fileName null, status PENDING.
});
it("returns the same batch when entry is reopened", async () => { /* same batchId */ });
it("saves a reading as a PENDING import row without writing a meter_read", async () => {
  expect(await countReads()).toBe(0);
});
it("posts every row on submit", async () => { /* meter_read rows carry route_id */ });
it("records a skip instead of a read for a coded row", async () => { /* read_skip written, no meter_read */ });
it("is a no-op on a second submit", async () => {
  // Review focus 2.
  const again = await submitEntry(/* same batch */);
  expect(again).toMatchObject({ batchId: first.batchId, importedCount: 0 });
  expect(await countReads()).toBe(before);
});
it("rejects a row whose period is already billed", async () => {
  // Review focus 5 — the existing frozen-read behaviour, surfaced per row.
  expect(result.errorCount).toBe(1);
});
it("refuses entry on an EXTERNAL route", async () => { /* 400 ROUTE_IS_EXTERNAL */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @utility-cis/api test:integration src/__tests__/integration/read-route-entry.integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

`openEntry` creates an `ImportBatch` with `entityKind: "meter_read"`, `source: "API"`, `fileName: null`, and one `ImportRow` per `readableRowsForPremises` row with `rawData` holding the canonical field names the handler already parses (`meterNumber`, `readDatetime`, `reading`, `routeCode`) — so submit needs no new handler. `saveEntryRow` updates that row's `rawData`. `submitEntry` calls `processBatch({ batchId, utilityId, actorId, actorName })` for the reading rows, and `recordSkips` for the coded ones, then marks the coded rows `SKIPPED`. Idempotency is the batch's own status: a batch not in `PENDING` returns its stored counts.

- [ ] **Step 4: Implement the routes and register them**

All under `{ config: { module: "meter_reads", permission: ... } }` — `VIEW` for the two GETs and the sheet, `CREATE` for entry and submit, `EDIT` for routes and stops. Register `readRouteRoutes` in `app.ts` beside `meterReadRoutes`. Mock `enqueueSafely` in the test file.

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @utility-cis/api test:integration src/__tests__/integration/read-route-entry.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/services/read-route-entry.service.ts packages/api/src/routes/read-routes.ts packages/api/src/app.ts packages/api/src/__tests__/integration/read-route-entry.integration.test.ts
git commit -m "feat(read-routes): type the sheet in, post the route as a whole"
```

---

## Task 10: Routes and stops on screen

**Files:**
- Create: `packages/web/app/read-routes/page.tsx`, `packages/web/app/read-routes/[id]/page.tsx`
- Test: `packages/web/app/read-routes/__tests__/page.test.tsx`, `packages/web/app/read-routes/__tests__/detail.test.tsx`

**Interfaces:**
- Consumes: Task 9's HTTP surface; Zod types from `@utility-cis/shared`.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing tests**

```ts
it("lists routes with their cycle and stop count", async () => {});
it("marks an EXTERNAL route as vendor-owned and offers no sheet", async () => {});
it("shows stops in sequence order", async () => {});
it("flags stops whose account is on a different cycle as a data-quality list", async () => {});
it("offers premises that are on no route", async () => {});
```

Use `test-support/select-loaded-option.ts` for any `<select>` seeded from a fetch — waiting for the control rather than the option is the race that produced three CI-only failures on 2026-11-08.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @utility-cis/web test app/read-routes`
Expected: FAIL — cannot find the module.

- [ ] **Step 3: Build both pages**

Follow the existing list/detail shape (`app/meter-reads/page.tsx` for the list chrome, filter strip and pagination). Derive every type from the shared Zod schemas; declare no local response interfaces.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @utility-cis/web test app/read-routes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/read-routes
git commit -m "feat(read-routes): routes and their stops on screen"
```

---

## Task 11: The entry screen

**Files:**
- Create: `packages/web/app/read-routes/[id]/entry/page.tsx`
- Test: `packages/web/app/read-routes/__tests__/entry.test.tsx`

**Interfaces:**
- Consumes: Task 9's entry endpoints.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing tests**

```ts
it("lists the stops in sequence with the last reading beside each", async () => {});
it("moves to the next row on Enter and saves the one left behind", async () => {});
it("holds the row when the reading is outside the meter's own history", async () => {
  // Provisional local band (spec §5.7); deleted when Req 93 lands.
});
it("lets a confirmed outlier through", async () => {});
it("moves past a stop with a skip reason and no number", async () => {});
it("shows progress as entered-of-total", async () => {});
it("submits once and reports what posted", async () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @utility-cis/web test app/read-routes/__tests__/entry.test.tsx`
Expected: FAIL — cannot find the module.

- [ ] **Step 3: Build the screen**

Keyboard first: one focusable numeric input per row, `Enter` saves and advances, the skip reason reachable without the mouse. The outlier band comes from the row's own trailing reads supplied by `openEntry`; mark it in a comment as the provisional rule Req 93 replaces, so it is findable when that lands.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @utility-cis/web test app/read-routes/__tests__/entry.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/app/read-routes/[id]/entry packages/web/app/read-routes/__tests__/entry.test.tsx
git commit -m "feat(read-routes): the screen is the sheet, with the checks paper cannot do"
```

---

## Task 12: `read_sequence` goes

**Files:**
- Modify: `packages/api/src/imports/handlers/service-agreement.ts`, `packages/shared/src/validators/service-agreement.ts`, `packages/web/app/service-agreements/[id]/page.tsx`, `packages/api/src/services/service-agreement.service.ts`, `packages/shared/src/lib/custom-fields.ts:561`, `packages/api/src/services/workflows.service.ts:152`, `packages/api/src/__tests__/integration/service-agreement-import.integration.test.ts`
- Create: `packages/shared/prisma/migrations/20261109091000_read_sequence_removed/migration.sql`
- Modify: `packages/shared/prisma/schema.prisma`

**Interfaces:**
- Consumes: nothing.
- Produces: `ServiceAgreement.readSequence` no longer exists.

- [ ] **Step 1: Prove the column is unread**

Run: `grep -rn "readSequence\|read_sequence" packages/ | grep -v node_modules`
Expected: exactly the seven sites above plus `schema.prisma` and the baseline migration. **If anything else appears, stop and report it** — a reader would mean the column is not write-only and this task is wrong.

- [ ] **Step 2: Remove the seven sites and the model field**

- [ ] **Step 3: Write the migration**

`ALTER TABLE "service_agreement" DROP COLUMN "read_sequence";` with a header comment naming spec 30 and recording that route order now lives in `read_route_stop.sequence`.

- [ ] **Step 4: Apply, regenerate, and run the suites that touch agreements**

Run: `cd packages/shared && npx prisma migrate deploy && pnpm --filter @utility-cis/shared exec prisma generate`
Then: `pnpm --filter @utility-cis/api test && pnpm --filter @utility-cis/api test:integration src/__tests__/integration/service-agreement-import.integration.test.ts && pnpm --filter @utility-cis/web test app/service-agreements`
Expected: PASS. Typecheck is the real gate here — `pnpm --filter @utility-cis/api build` must be clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(read-routes): drop read_sequence, which looked like ordering and was not"
```

---

## Task 13: The documents

**Files:**
- Create: `docs/specs/30-read-routes.md`
- Modify: `docs/specs/05-service-agreement.md`, `docs/specs/08-meter-reading.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything built above — the spec describes what exists, not what was planned.
- Produces: nothing.

- [ ] **Step 1: Write `docs/specs/30-read-routes.md`**

Follow the house shape (entities, API endpoints, business rules, UI pages, requirement mapping, phase roadmap). It is the design document rewritten as what is true, with the four open items carried forward: the provisional column aliases, the provisional outlier band, the gated inbound API, and the field client that Task 0 of a later plan builds.

- [ ] **Step 2: Correct spec 08**

Line 429's Req 78 row becomes a pointer to spec 30. Add `route_id` to the `meter_read` field table, and `read_skip` beside the exception model. Remove the `ServiceAgreement.read_sequence (Phase 1)` claim.

- [ ] **Step 3: Correct spec 05**

Remove `read_sequence` from the entity and field tables; note that read order lives in spec 30.

- [ ] **Step 4: Add the index line to `CLAUDE.md`**

`├── 30-read-routes.md — Read routes, the printed sheet, keyboard entry, skips` in the spec list, between 29 and the closing line.

- [ ] **Step 5: Commit**

```bash
git add docs CLAUDE.md
git commit -m "docs(specs): spec 30, and the two specs that described read_sequence"
```

---

## Self-Review

**Spec coverage.** §5.1 → Tasks 1–3; §5.2 → Tasks 1, 5, 9; §5.3 → Tasks 1, 6; §5.4 → Tasks 2, 5, 7; §5.5 file half → Task 5, API half excluded by scope; §5.6 → Task 8; §5.7 → Tasks 9, 11; §5.8 → Task 12; §5.9 → Task 7; §5.10 → Task 9 step 4; §5.11 → Tasks 6, 7, 8; §5.12 → Task 4; §6.2 → Task 13 (and `bozeman/02` is already amended). §7's Req 78 → Task 13. **Gap found and closed:** §8's unsequenced-premise tray had no task; it is Task 3's `listUnsequencedPremises` and Task 10's fifth test.

**Review Focus coverage.** Item 1 → Task 5 test 5. Item 2 → Task 9 test 6. Item 3 → Task 6 test 2. Item 4 → Task 1 test 4 and Task 3 test 3. Item 5 → Task 9 test 7.

**Type consistency.** `readableRowsForPremises` returns `ReadableRow`, consumed under that name in Tasks 7, 8 and 9. `SKIP_REASONS` is declared once in Task 6 and consumed by Tasks 8 and 11. `upsertExternalRoute` takes `tx` first in both its definition (Task 2) and its call (Task 5). `origin` is the column name throughout; no task says `routeOrigin`.

**Proportion.** 13 tasks over a ~700-line spec, with signatures and test names rather than bodies. The only prescribed algorithm is Task 3's gapped-integer sequencing, which the signature does not determine.
