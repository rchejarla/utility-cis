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
- [ ] Dispatched l1-reviewer
- Findings:
  - Critical: **not run on this branch.**
  - Important: **not run on this branch.**
  - Minor: **not run on this branch.**
- Resolution: n/a — no reviewer has been dispatched against this diff. Defects
  were found and fixed during the build by the stream sessions themselves
  (recorded in spec 05 and spec 30), which is not the same thing as a review
  pass and must not be counted as one.

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
- User action performed: **nothing in this session.** The containers were down
  when this file was written and no part of the stack was booted.
- Expected observable result: a transfer carries the source agreement's
  rate-schedule assignments onto the new agreement when the General settings
  toggle is on and leaves it unrated when off; a second live agreement at the
  same premise for the same commodity is refused with a 409 naming the
  conflicting agreement; the move-out wizard's premise picker is populated and
  Finish is blocked until a reading is entered for every meter at the chosen
  premise.
- Actual observed result: **none in this session.** Recorded by the 2026-11-18
  sessions and *not reproduced*:
  - `e2e/read-route-entry.spec.ts` — 2 passed, 31.4s.
  - `e2e/transfer-of-service.spec.ts`, `e2e/move-out.spec.ts` — reported as
    driving both wizards against real rows, mutation-checked both ways.
  - `transfer-service.integration.test.ts` — 8 tests against a real database.
  - `read-route-routes.integration.test.ts` — 39 cases.
  Treat all four as claims with a date on them, not as evidence: no session has
  re-run them, and the integration suite is not in CI.
- [ ] Test passed

## Cross-layer contract check (Tier 2+)
- [ ] Dispatched cross-layer-auditor
- Grep 1 — Orphan fields (UI writes → backend reads): **not run.** One is
  already known from the build and fixed: both wizards read a flat `premise`
  field no endpoint sends. A sweep for the same shape elsewhere has not been done.
- Grep 2 — Orphan endpoints (backend declares → frontend calls): **not run.**
  Known precedent on this branch: Task 9 step 4 found twelve read-route
  endpoints that had never been registered in `app.ts`, so every service behind
  them was unreachable. That class of gap has occurred here once already.
- Grep 3 — Unhandled events (emitted → handled): **not run.**
- Grep 4 — Write-only DB columns (written → read): **not run.** One is known and
  deliberate: `service_agreement.effective_range` is maintained by the database
  and read by nothing, since the exclusion constraint it backed was dropped by
  the 2026-10-18 squash. Kept rather than dropped; see `schema.prisma`.
- Grep 5 — Unread config keys (declared → read): **not run.**
  `transfer_carries_rate_schedule` is read in `tenant-config.service.ts` and
  `workflows.service.ts` and written from the General settings tab.
- Orphans requiring fix: **unknown — no audit has been run.**
- Intentional orphans with justification: `effective_range`, as above.

## Adversarial review (Tier 2+)
- [ ] Dispatched adversarial-reviewer
- Blocking findings: **not run.**
- Non-blocking findings: **not run.**
- Reviewer's meta-notes: n/a. Three questions worth handing a reviewer, each
  from a defect this branch has already produced once:
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

**Not ready to ship.** Required before that, in order: boot the stack and run
the five test files that have never been re-run, then the three Tier 3 reviewer
passes. See `docs/specs/05-service-agreement.md` for the one
open product question (`createServiceAgreement` and move-in write no
rate-schedule assignment, and the billing executor files that condition
quietly).

Signed: Claude Opus 5 (session of 2026-11-26) — as the author of the handoff
record only, not as a reviewer of this branch.
Date: 2026-11-26
