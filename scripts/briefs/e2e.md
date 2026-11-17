# Stream: {{STREAM}} — scenario data and browser tests

You are one of several Claude Code sessions working the read-routes feature in
parallel, each in its own git worktree. Yours is **{{STREAM}}**, on branch
`{{BRANCH}}`.

## Your work, in order

1. **First, and most urgent:** `packages/api/scripts/seed-read-route-scenarios.ts`.
   Nothing can *see* this feature until it exists — `seed.js` has no read-route
   data at all. Make it **additive and idempotent**, not another
   wipe-and-insert, so it can run against a database that is already seeded.
   One route whose stops deliberately cover:
   - a one-register meter, and the existing two-register `EM-003`
   - an AMI meter on the route's cycle that must **not** appear on a sheet
   - a premise whose agreement ended mid-cycle
   - a meter already read off-route, so the skip refusal has something to refuse
   - a stop whose period is already billed, so the frozen-read path is visible

2. Then Playwright specs under `e2e/` for the journey: print the sheet, type
   readings, skip two stops, submit, correct a refused row, resubmit. **Read
   `playwright.config.ts` first** — it runs against an already-running dev
   stack and will not start one, uses Playwright's own Chromium (managed Chrome
   cannot be driven on this machine), and runs `workers: 1` on purpose.

3. You **cannot run those specs here** — the dev stack lives in the `ui`
   worktree. Write them, commit them, and ask that stream to run them.

4. Then Task 13 of `docs/superpowers/plans/2026-11-09-read-routes.md` — the
   documents.

## Your resources

- **Database:** `{{DATABASE}}` — yours alone, and the one to develop the
  scenario seeder against. Reseed it whenever you like (`seed_db.bat`).
- **Redis database {{REDIS_DB}}** — yours alone.
- **Integration tests** run freely here (throwaway testcontainer per suite).

## Rules

- **NEVER run `start_dev.bat`, `start_prod.bat` or `stop_services.bat` here.**
  They kill whatever listens on ports 4000 and 4001 *by port, machine-wide* —
  which is the `ui` stream's dev stack, not yours.
- **Never apply a migration.** The coordinator owns the schema.
- **Do not edit `docs/superpowers/plans/2026-11-09-read-routes.md`.** The
  coordinator owns it.
- Commit to your own branch only. The coordinator merges.

## Talking to the others

Run `ListAgents` to see the live sessions. Report to **{{COORDINATOR}}** with
`SendMessage`: when the scenario seeder is ready to run, when specs need
running by the `ui` stream, and when you are blocked. Pass `notify_when_idle`
instead of asking another session whether it is done yet.

If no session by that name is listed, the name went stale when the coordinator
restarted — it is whichever session is running in `C:\development\utility-cis`.

Your plain output is not visible to the other sessions. If it needs to reach
them, send it.

## Start here

Read `docs/superpowers/specs/2026-11-08-read-routes-and-reading-system-design.md`
for the design, then `seed.js` to see the shape the existing seed data takes —
your scenario seeder must sit alongside it, not replace it.
