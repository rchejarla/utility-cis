# Stream: {{STREAM}} — the screens

You are one of several Claude Code sessions working the read-routes feature in
parallel, each in its own git worktree. Yours is **{{STREAM}}**, on branch
`{{BRANCH}}`.

## Your work, in order

1. Task 10 of `docs/superpowers/plans/2026-11-09-read-routes.md` — the route
   list and route detail pages.
2. Then Task 11 — the entry screen.
3. Task 11 needs an HTTP endpoint for `reopenEntryForCorrections`
   (`packages/api/src/services/read-route-entry.service.ts`). It exists and is
   exported but nothing routes to it. Add the route.

## Your resources

- **Database:** `{{DATABASE}}` — yours alone. Reseed it whenever you like
  (`seed_db.bat`). It is already migrated and seeded.
- **Redis database {{REDIS_DB}}** — yours alone, so a worker here cannot take
  another stream's jobs.
- **Integration tests** run freely here. `bootPostgres` starts a throwaway
  testcontainer per suite on a random port, so they touch no shared state.
  They are slow (~24 min for the full suite on an idle machine), so prefer
  single files.

## Rules

- **You own the dev stack**, on web 4000 and api 4001. `start_dev.bat` runs
  here and nowhere else. If a screen is blank, check the API serving it is
  yours and not another stream's.
- **You run the Playwright specs** (`pnpm e2e`), because they need a running
  stack and you are the only one with one. The `e2e` stream writes them and
  will ask you to run them.
- The app does **not** use ports 3000/3001 — another application on this
  machine serves those, and `stop_services.bat` kills by port.
- **Never apply a migration.** The coordinator owns the schema. Write the SQL,
  say it is ready, wait.
- **Never run `prisma migrate dev`** against this schema, in any worktree, for
  any reason. See CLAUDE.md.
- **Do not edit `docs/superpowers/plans/2026-11-09-read-routes.md`.** The
  coordinator owns it. Conflicts in the shared plan defeat the point of having
  one.
- Commit to your own branch only. The coordinator merges.

## Talking to the others

Run `ListAgents` to see the live sessions. Report to {{COORDINATOR}} with
`SendMessage`: when you finish a task, when you need a migration applied, and
when you are blocked. Pass `notify_when_idle` instead of asking another session
whether it is done yet.

Your plain output is not visible to the other sessions. If it needs to reach
them, send it.

## Start here

Read `docs/superpowers/plans/2026-11-09-read-routes.md` for the plan, and
`docs/superpowers/specs/2026-11-08-read-routes-and-reading-system-design.md`
for the design behind it. Tasks 1–9 are already committed on
`feat/read-routes`. Then begin item 1 above.
