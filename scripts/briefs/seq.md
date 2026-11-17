# Stream: {{STREAM}} — removing read_sequence

You are one of several Claude Code sessions working the read-routes feature in
parallel, each in its own git worktree. Yours is **{{STREAM}}**, on branch
`{{BRANCH}}`.

## Your work, in order

1. Task 12 of `docs/superpowers/plans/2026-11-09-read-routes.md` — remove
   `read_sequence` from the seven sites and from the Prisma model.
2. Write the migration SQL **by hand**. Never run `prisma migrate dev`: it
   compares the database against `schema.prisma`, finds 35 CHECK constraints,
   6 generated columns, 62 RLS policies, a hypertable, an exclusion constraint
   and 64 composite tenant-scoped foreign keys that the schema cannot express,
   and generates a migration *reverting* all of it. It reads as a routine drift
   fix and would silently drop the ledger's invariants.
3. **Do not apply the migration.** Hand the SQL to the coordinator for review
   and application.

## Your resources

- **Database:** `{{DATABASE}}` — yours alone. Reseed it whenever you like
  (`seed_db.bat`). It is already migrated and seeded.
- **Redis database {{REDIS_DB}}** — yours alone, so a worker here cannot take
  another stream's jobs.
- **Integration tests** run freely here. `bootPostgres` starts a throwaway
  testcontainer per suite on a random port, so they touch no shared state.
  They are slow (~24 min for the full suite on an idle machine), so prefer
  single files — `schema-invariants` and the agreement suites are the ones
  your change can break.

## Rules

- **NEVER run `start_dev.bat`, `start_prod.bat` or `stop_services.bat` here.**
  They kill whatever listens on ports 4000 and 4001 *by port, machine-wide* —
  which is the `ui` stream's dev stack, not yours.
- **You cannot run Playwright specs** here, for the same reason.
- **Never apply a migration.** The coordinator owns the schema.
- **Do not edit `docs/superpowers/plans/2026-11-09-read-routes.md`.** The
  coordinator owns it.
- Commit to your own branch only. The coordinator merges.

## Talking to the others

Run `ListAgents` to see the live sessions. Report to **{{COORDINATOR}}** with
`SendMessage`: when the migration SQL is ready, and when you are blocked. Pass
`notify_when_idle` instead of asking another session whether it is done yet.

If no session by that name is listed, the name went stale when the coordinator
restarted — it is whichever session is running in `C:\development\utility-cis`.

Your plain output is not visible to the other sessions. If it needs to reach
them, send it.

## Start here

Read `docs/superpowers/plans/2026-11-09-read-routes.md`, Task 12. Prove the
column is unread before removing it — that is step 1 of the task and it exists
because a column that looks dead sometimes is not.
