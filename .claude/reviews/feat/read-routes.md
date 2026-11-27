# Review Checklist — feat/read-routes

**Status: HANDOFF RESUME POINT, NOT A COMPLETED REVIEW.** Written 2026-11-26 so
the state of this branch travels to another machine. Every gate below is
unpopulated or carries only evidence recorded by the 2026-11-18 sessions and not
reproduced since. **Nothing in this file is a pass.** Do not read a filled-in
section as a cleared gate — each one says plainly whose run it came from.

**Tier:** 3
**Tier rationale:** Seven migration files in the diff fires the Tier 3 rule
mechanically; the substantive reason is that three of them add database
invariants (a raising trigger and two CHECKs) that refuse writes the application
used to accept, so a deploy changes what existing data and existing code paths
are allowed to do.
**Blast radius:** 113 files changed (+21,789/-296) over 71 commits; 5 areas —
`packages/api` 48, `packages/web` 21, `packages/shared` 14, `docs` 12, `e2e` 7,
plus root scripts and `CLAUDE.md`; user-facing: yes — the read-route list,
detail and entry screens, the printed route sheet, the transfer and move-out
wizards, and a General settings toggle.
**Started:** 2026-11-26 (branch work ran 2026-11-09 → 2026-11-18)

## What is on the branch

Two bodies of work, merged from four parallel worktree streams:

1. **Read routes** (spec 30) — schema and four migrations, twelve endpoints,
   the three screens, the printed sheet, keyboard entry and skips.
2. **Service-agreement invariants and the two workflow wizards** (spec 05,
   commit `703b9da`, 2026-11-18) — `one_live_service_per_premise`,
   `restore_date_order_checks`, `transfer_carries_rate_schedule`, the
   error-handler mapping for raising triggers, and the transfer/move-out fixes.

`feat/read-routes-ui` at **b0dd318** was merged in on 2026-11-26 — a clean
merge, no overlapping files. It carries the fix for a resubmit that could post a
**second `meter_read` per meter** (`submitEntry` partitioned the whole batch
instead of its `PENDING` rows), and the reading band's change from
`min × 0.5 / max × 2` to a median-scaled band. Both are therefore in scope for
the review below, and neither has been run.

The other two streams, `test/read-routes-e2e` 701b820 and `chore/drop-read-seq`
fe25434, hold no commit this branch lacks; they are on origin for their names
only. All four branches are on origin.

## L1 code review (all tiers)
- [x] Dispatched l1-reviewer (2026-11-26, a general-purpose agent with the L1
  brief — the named reviewer agents are not installed on this laptop)
- Findings (each re-verified against the code before acting):
  - Critical: none.
  - Important, all fixed:
    1. Band mixed dial units with multiplied consumption — every ordinary read
       on a multiplier≠1 meter held. `reading-band.ts` now divides by the
       meter's multiplier in SQL. Test: "builds the band in dial units on a
       meter with a multiplier".
    2. A resubmit that posted nothing overwrote `importedCount` with 0 and
       judged status on the corrections alone. The no-post path now takes
       totals from the whole batch. Test: "keeps the sheet's totals when the
       correction posts nothing".
    3. A crash mid-submit lost every skip on the sheet (coded rows SKIPPED
       before their `read_skip` was written; a reclaimed resubmit reads
       PENDING only). Skips are now recorded before posting, each row leaving
       PENDING in the skip's own transaction. **No test** — needs a crash
       injected mid-`processBatch`, which the suite has no hook for.
    4. Reopen accepted a batch still PROCESSING → two `processBatch` runs,
       duplicate reads. Now 409 `ENTRY_NOT_FINISHED`. Test: "refuses to reopen
       a sheet that is still being submitted".
    5. One-live-service trigger did not hold under concurrency. New migration
       `20261127090000_one_live_service_lock` adds an advisory lock. Test:
       "refuses the second of two openings that race at one premise".
    6. Read-route screens used the UTC date as today. Now local
       (`toLocaleDateString("en-CA")`).
  - Minor, **all fixed 2026-11-27** (e4b47bc), each with a test:
    - trigger refused any edit of a pre-existing overlap → an UPDATE that
      keeps or narrows its own dates is let through (`20261127110000`);
      widening still judged.
    - date CHECKs gave "Database error" → 400 `DATE_ORDER_VIOLATION` with a
      sentence, by constraint name (they are CHECKs, not trigger markers).
    - rows/submit ignored `:id` → `assertEntryOnRoute`, 404 on a mismatch.
    - `saveEntryRow` raced submit → batch row locked (f789931).
    - `routeCode` raw in `Content-Disposition` → ASCII fallback plus
      RFC 5987 `filename*`.
    - `::date` on a bound JS Date — **the finding was wrong** (probed
      2026-11-27). The Prisma pg adapter sends a Date as untyped text of its
      UTC wall time, so `::date` is the UTC day in any session zone. The two
      read-route queries' switch to `YYYY-MM-DD` text is harmless and was
      kept, with its comments corrected; the same pattern in
      `ar/statement-snapshot.ts` and `payment-plan/lifecycle.ts` was left as
      it is, and a ledger-posting test now pins the behaviour under a
      Denver session so an adapter change would surface.
- Also fixed from the unit run: `|| true` on the entry screen's empty-field
  guard (806085f) — Enter through a coded row erased its skip reason.

## Smoke test (all tiers) — EVIDENCE REQUIRED
- Boot command (including prerequisites):
  `start_db.bat`, then `pnpm install`,
  `pnpm --filter @utility-cis/shared exec prisma generate`,
  `cd packages/shared && npx prisma migrate deploy`, then `start_dev.bat`
  (web 4000, api 4001) and `pnpm --filter @utility-cis/api dev:worker` — the
  worker is not started by `start_dev.bat`.
  **`prisma generate` is not optional here:** the generated client is gitignored
  and `transferCarriesRateSchedule` is new, so a stale client fails to typecheck
  rather than reporting a missing column.
- User action performed (2026-11-26, new laptop): fresh database via
  `setup_db.bat` (all 49 migrations) + `node seed.js` +
  `scripts/seed-read-route-scenarios.ts`; stack booted with `pnpm dev`, API
  reporting `cis_app` with RLS enforced. The worker was not started; none of
  the five files below needs one.
- Expected observable result: a transfer carries the source agreement's
  rate-schedule assignments onto the new agreement when the General settings
  toggle is on and leaves it unrated when off; a second live agreement at the
  same premise for the same commodity is refused with a 409 naming the
  conflicting agreement; the move-out wizard's premise picker is populated and
  Finish is blocked until a reading is entered for every meter at the chosen
  premise.
- Actual observed result, re-run 2026-11-26 on the merged tree (af3e939):
  - `transfer-service.integration.test.ts` + `read-route-routes.integration.test.ts`
    — 2 files, **50 tests passed**, 109s.
  - `e2e/transfer-of-service.spec.ts` — 2 passed. `e2e/move-out.spec.ts` — 1 passed.
  - `e2e/read-route-entry.spec.ts` — **3 passed, after one assertion fix.** The
    held-row test asserted the pre-b0dd318 wording ("in its recent reads");
    b0dd318 changed the hold to "typically uses about X — its recent reads ran
    A to B" and the e2e spec, built on another stream, was never updated. The
    assertion now pins the new wording including the numbers. That is a merge
    gap, not an app defect — but it is also the first time the e2e spec has
    run against the median band at all.
  - Precondition the spec needs and the base seed does not provide:
    `cd packages/api && npx tsx --env-file=.env scripts/seed-read-route-scenarios.ts`.
- What this does not cover: the transfer 409 for a second live agreement was
  exercised only by the integration suite, not through the UI; nothing here
  re-ran the full unit suites or typecheck.
- [x] Test passed

## Cross-layer contract check (Tier 2+)
- [x] Dispatched cross-layer-auditor (2026-11-26, general-purpose agent)
- Grep 1 — Orphan fields: transfer wizard rendered `account.customer`, which
  the service-agreement list never included → always "(no customer)".
  **Fixed** (`fullInclude` now includes the customer). Reverse orphan: the
  meter-read progress screen ignored `readRouteId`/`routeCode`/`skipReason`.
  **Fixed 2026-11-27** (574ed0b): route filter plus Route and Why-not-read
  columns.
- Grep 2 — Orphan endpoints: all 14 read-route routes registered.
  `PATCH /api/v1/read-routes/:id` had no caller. **Fixed 2026-11-27**: rename
  and retire on the route page.
- Grep 3 — Unhandled events: none.
- Grep 4 — Write-only columns: `read_skip.notes`, `reader_id`,
  `read_route_id` written, never read. **Kept on purpose** — they are what the
  skip was, unrecoverable later, for a skip report or field-visit work order;
  documented as such in spec 30's ReadSkip section.
- Grep 5 — Unread config keys: none; `transfer_carries_rate_schedule` read
  where it takes effect.
- Docs: the architecture doc had no read-route endpoint rows, no field tables
  for ReadRoute/ReadRouteStop/ReadSkip, and said 78 models (83). **Fixed
  2026-11-27**: §4.16a–c, 14 endpoint rows, the progress row's new params, the
  trigger's lock, and both stale counts (83 models; 82 tenant tables, not 61).
- Intentional orphans: `effective_range`.

## Adversarial review (Tier 2+)
- [x] Dispatched adversarial-reviewer (2026-11-26, general-purpose agent)
- Blocking findings: B1 reopen during a running submit (= L1 #4), B2 trigger
  race (= L1 #5). Both **fixed**, with tests.
- Non-blocking, open unless noted:
  1. Save racing Post can leave a typed number as SKIPPED/NOT_ENTERED (= L1
     minor). **Fixed 2026-11-27**: `saveEntryRow` locks the batch row `FOR
     UPDATE` for the whole save, so Post's claim waits for it or the save is
     refused. Test: "a save racing Post's claim waits for it and is refused".
  2. `readMeters` is built from row contents, so a refused register-1 reading
     tells a coded register-2 "the other register was read" — neither read nor
     skip. **Fixed 2026-11-27**: such coded registers are parked
     (`AWAITING_OTHER_REGISTER`) while readings post and settled by row
     status after — SKIPPED if a reading IMPORTED, else ERROR
     `OTHER_REGISTER_REFUSED`, which reopen admits. Test: "a coded register
     whose meter's reading was refused is correctable, not skipped".
  - Found while verifying those, **fixed**: on the entry screen a number typed
    while Correct's reopen was in flight was wiped when it answered (the e2e
    journey lost this race twice). Fields are disabled while a post or reopen
    reloads the rows. Unit test added.
  3. Crash loses skips — **fixed** (= L1 #3). A crash between the
     `meter_read` commit and the row going IMPORTED can no longer re-post:
     the resubmit meets `meter_read_one_original_per_instant` and the row is
     `ERROR` / `READ_ALREADY_POSTED`. **Closed by the index**, no further code.
  4. UTC date — **fixed** (= L1 #6). Future read dates — **fixed 2026-11-27**:
     400 `READ_DATE_IN_FUTURE`, a day's slack for tenants east of UTC.
  5. Billed-period check used the route's cycle — **fixed 2026-11-27**: the
     meter's own, via `windowsByMeter` as `recordSkips` does. Test: "judges the
     billed period on the meter's own cycle, not the route's".
  6. Transfer dropped scheduled rate changes — **fixed 2026-11-27**: those
     starting after the transfer are carried with their own start. Spec 05
     says so. Test: "carries a rate change the source had scheduled".
  7. Typed-but-not-Entered or held numbers lost at Post — **fixed 2026-11-27**:
     the screen blocks Post and names the meters (a server-refused number does
     not block), and reopen now returns NOT_ENTERED rows, with an "Enter the
     rows left out" button. The "nothing to read" load failure is said, not
     swallowed.
- Reviewer's meta-note worth acting on: a unique index on `meter_read` as the
  real backstop rather than more application guards. **Done 2026-11-27**
  (Rao's call): `meter_read_one_original_per_instant` on (utility,
  agreement, meter, register, peak code, read_datetime) NULLS NOT DISTINCT
  WHERE corrects_read_id IS NULL. Not per *day* — the hypertable forces
  `read_datetime` into the key — but every duplicate this branch produced
  repeats the instant. Agreement and peak code are in the key because
  transfer and the interval rollup legitimately write two originals at one
  instant. Import refusal is `READ_ALREADY_POSTED`. Tests: four index cases
  in `meter-read-one-original.integration.test.ts`, plus the double-post
  state through the real entry path.
- The three questions handed to the reviewer, each from a defect this branch
  had already produced once:
  1. Does any path still partition a batch by its contents rather than by row
     status? That shape let a resubmit post a second read per meter, and
     `meter_read` has no unique key on (meter, read date).
  2. Does any check scale a bound from an extreme value, so one confirmed
     outlier disarms it for subsequent reads?
  3. Does any screen's TypeScript interface declare a field its endpoint does
     not send? A mock built from the interface supplies it and the test passes.

## Runbook + rollback (Tier 3)
- Runbook path: **none written.** The deploy steps are the boot command above;
  `migrate deploy`, not `migrate dev` — see `CLAUDE.md`, which explains why
  `migrate dev` would propose reverting the 62 RLS policies, the generated
  columns and the 64 tenant-scoped foreign keys.
- Dry-run evidence (staging): **none. There is no staging environment.** This
  product is in development; the only database is the dev one, which was
  recreated and reseeded on 2026-11-18 (spec 05 records this), so the three new
  migrations were applied there — unconfirmed in this session, because the
  containers were down.
- Rollback command: forward-only is the project's rule, so this is written out
  rather than generated. All three are reversible without data loss:
  ```sql
  DROP TRIGGER IF EXISTS before_one_live_service_per_premise ON service_point;
  DROP FUNCTION IF EXISTS enforce_one_live_service_per_premise();
  ALTER TABLE service_point DROP CONSTRAINT IF EXISTS chk_sp_end_ge_start;
  ALTER TABLE service_point_meter DROP CONSTRAINT IF EXISTS chk_spm_removed_ge_added;
  ALTER TABLE utility_config DROP COLUMN IF EXISTS transfer_carries_rate_schedule;
  ```
  Dropping the column loses each tenant's setting; the other four restore the
  state before the migrations exactly. `_prisma_migrations` rows must be deleted
  to match, or `migrate deploy` will consider them applied.
- [ ] Rollback tested in staging — verification output: **not tested.** Nowhere
  to test it.

## Escape hatches used
- [ ] None (default)
- Skipped steps with written justification:
  - **Every gate** — this branch was committed and pushed on 2026-11-26 to move
    work to another laptop, not to ship. The author asked for the state to be
    recorded, not for the review to be run. The gates remain owed.
  - **Three concerns in one commit** (`703b9da`) — the migrations, the wizards
    and the docs share `schema.prisma`, spec 05 and the architecture doc, so a
    split would have required hunk surgery on code no run had exercised.

## Final verdict
- [ ] All required gates passed for declared tier
- [x] Checklist committed
- [ ] Ready to ship

**Not ready to ship yet — closer.** Smoke test, typecheck, unit suites (api
1261, web 918 with `NODE_OPTIONS=--no-experimental-webstorage` on Node 26),
the four affected integration suites and the three e2e specs all pass after
the fixes above; all three reviews ran and every Important/blocking finding is
fixed. The `meter_read` unique index was added 2026-11-27.

**Integration run, 2026-11-27** (the 32 suites that touch meter reads,
workflows, intervals or the seed, one file at a time, plus the two new
ones): all pass except **`dev-seed.integration.test.ts` — 2 of 4 fail, and
fail identically on a6ede6d with none of the index work** ("expected 61 to
be less than 45", "expected 0 to be greater than 0"), so it predates this
change; likely a date the seed or the test assumes, crossed by today's date.
**Fixed 2026-11-27**: `seed.js` anchored its read series on the calendar
month, which matches the billing window in force only on the 1st–9th; from
R01's bill day on, a run swallowed both unbilled reads (61 days) and left
none. It now anchors on `cycleWindow` (the `computeBillPeriod` rule, shared
with the TOU fixture). dev-seed 4/4 today (the 27th, the failing case), and
the anchor checked for the 1st, 8th, 9th, 10th, 11th, 31st, a year rollover
and February. `reading-progress` (4) and `tou-readiness` (1)
were failing too — their fixtures opened two live agreements at one premise,
which 703b9da's trigger refuses; those suites had not run since. Fixed in
the fixtures, not the trigger.

**Every review finding is now addressed (2026-11-27)** — fixed with a test,
closed by the `meter_read` index, or (the three `read_skip` columns) kept on
purpose and documented. Backend e4b47bc, screens 574ed0b; API unit 1264, web
927, the five affected integration suites, and the three e2e specs green.

**What still stands between this and "ready to ship":**
1. **The Tier 3 runbook/rollback gate** — no runbook beyond the boot steps,
   and the rollback is written but untested, because there is no staging
   environment. That is a fact about the deployment, not something more code
   on this branch can close; it needs a decision on how this product ships.
2. ~~One open product question in spec 05~~ — **decided 2026-11-27**: not
   assigning a rate schedule on create is the stated rule, and an unrated
   agreement that reaches a run's executor is now a FAILED item
   (`NO_ACTIVE_ASSIGNMENTS`), not a skip; the account-level "no agreement in
   the window" has its own `NO_AGREEMENT_IN_WINDOW`.
3. ~~Not run since the last changes: the full integration suite.~~ **Run
   2026-11-27 on 69bd392, one file at a time: 126/126 files, 1612 tests
   passed, 0 failed, 0 skipped** (10:22–11:11).

Signed: Claude Opus 5 (session of 2026-11-26) — as the author of the handoff
record only, not as a reviewer of this branch.
Date: 2026-11-26
