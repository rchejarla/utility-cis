# Platform Console

**Module:** 25 — Platform Console
**Status:** Shipped. Tenant lifecycle (utilities, operators, modules, roles, suspension) and cluster observability (nodes, workers, queues, jobs) are built; worker control is single-host only — see [24 — Platform Worker Control](24-platform-worker-control.md) for the cluster-wide design.
**Entities:** none of its own. It reads and writes `Utility`, `CisUser`, `UtilityModule`, `Role`, `UserRole`, `AuditLog`, and BullMQ's state in Redis.

## Authority

The design document is the authority for the tenancy model:
[`docs/superpowers/specs/2026-10-17-tenancy-and-platform-admin-design.md`](../superpowers/specs/2026-10-17-tenancy-and-platform-admin-design.md).
It carries the decisions and their rationale — why a tenant has to be a
row before anything can sit above it (D6), why the platform actor's job
is tenant lifecycle (D1), why global reference rows change by migration
and never by a live console (D3), and why the mode is deployment
configuration rather than a runtime toggle (D5).

One of its decisions has since been **reversed by what was built**, and
this file is where that is recorded:

- **D2 said health stays outside the application.** The Cluster section
  is an in-app health surface. The argument for D2 still holds for
  *liveness* — a page served by a broken API cannot report that the API
  is broken, which is what `/health`, probes and alerts are for. What D2
  did not cover is the question an operator actually arrives with: *eight
  queues have 102 jobs in them and nothing is attached — which tenant,
  which job, and why.* A probe cannot answer that, and the alternative
  was Bull Board, which answers it for a stranger rather than for this
  product (no tenant names, no notion of a job that cannot run).
  Liveness is still outside; triage is inside.

**D4 — Bull Board behind the platform actor — is done.** It is still
mounted at `/admin/queues`, off unless `BULL_BOARD_ENABLED`, but its
`preHandler` now requires a real platform-actor row and answers
`PLATFORM_REQUIRED` (403) to everyone else, including a tenant admin
holding every tenant permission. `bull-board-authorization.test.ts` pins
all three cases. It is not a nav target: a separate origin with its own
chrome and no way back makes a fine escape hatch from inside a page and a
poor menu entry, so the Queues page names it instead.

## What the console is

Two sections of the platform shell, answering two different questions.

**Platform** is about tenants: creating one, seeing what it holds, and
taking it out of service. This is D1's set — the operations with no other
home, because a tenant's own System Admin cannot perform them (it holds
every permission a *tenant* can grant, which is not authority over
tenants).

**Cluster** is about the deployment: which API nodes are connected, which
worker processes are running, what is queued behind them, and what has
failed. Nothing here is scoped to a tenant — the opposite, in fact: the
cross-tenant sweeps are precisely the jobs no tenant can see.

### Who may use it

A `CisUser` with a **null `utility_id`** — the platform actor. Every route
in this module declares `{ config: { platform: true } }` instead of a
module and a permission, and the authorization middleware resolves it
against a real row with `utility_id IS NULL` and `is_active`. A tenant's
System Admin is refused. See CLAUDE.md § Multi-tenancy for what that
nullable column costs elsewhere.

The screens mount **no `AuthPermissionProvider`**, deliberately: it
fetches `/api/v1/auth/me`, which answers 403 for a platform token and
then falls back to granting every permission, so any gating it provided
here would be fabricated. The real gate is server-side.

## API

All 21 routes are `{ config: { platform: true } }`. None of them take a
`utility_id` from the token — a platform token has none; the ones that
act on a tenant name it in the path.

### Tenant lifecycle

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/platform/me` | The console's "who am I". Answered from the row, not the token's claims, so a renamed operator sees their new name. `/auth/me` cannot serve it — it reads `request.user`, which a platform request leaves unset. |
| GET | `/api/v1/platform/utilities` | Every tenant, with module / role / user counts |
| GET | `/api/v1/platform/utilities/:id` | One tenant: modules, roles, staff, portal-customer count, plus `readiness` |
| POST | `/api/v1/platform/utilities` | Provision: utility row, 32 modules, six preset roles, optional first admin. `dryRun: true` → **200** and nothing written; a real create → **201** |
| POST | `/api/v1/platform/utilities/:id/suspend` | Set `status = SUSPENDED`. Enforced on every request in the same authorization pass that checks enabled modules, so a token minted before the suspension stops working |
| POST | `/api/v1/platform/utilities/:id/reactivate` | Back to `ACTIVE` |
| GET | `/api/v1/platform/utilities/:id/history` | Only what was done to this tenant **from outside it** — not the tenant's own audit log |
| PATCH | `/api/v1/platform/utilities/:id/modules/:moduleKey` | `{ isEnabled }`. PATCH with the end state rather than enable/disable verbs: one boolean on one row cannot then be applied twice by mistake |

### A tenant's roles, from above it

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/platform/utilities/:id/roles` | List |
| POST | `/api/v1/platform/utilities/:id/roles` | Create (201) |
| PATCH | `/api/v1/platform/utilities/:id/roles/:roleId` | Update |
| DELETE | `/api/v1/platform/utilities/:id/roles/:roleId` | Delete (204) |

The tenant administers its own roles at `/api/v1/roles`, gated on
`settings`. These are the same operations against a utility named in the
path — authority no tenant holds, and what a utility with no working
admin needs, since nothing else can act on it.

**No new business logic.** `role.service.ts` already takes `utilityId` as
its scoping argument and already carries BR-RB-002, BR-RB-003 and the
cache invalidation for every assignee. These routes hand it the id from
the path rather than from the token, so there is one set of rules rather
than two that can drift. `updateRole` filters on `{ id, utilityId }`, so a
role belonging to another utility is **not found** rather than edited.

### The platform's own operators

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/platform/users` | Every operator, with `lastLoginAt` |
| POST | `/api/v1/platform/users` | Appoint one (201) |
| POST | `/api/v1/platform/users/:id/deactivate` | `is_active = false`; the row stays |
| POST | `/api/v1/platform/users/:id/reactivate` | `is_active = true` |

Before these existed, an operator could only be made by SQL or by the
seed — the same gap §1.5 of the design note described for tenants,
applied to the identity that sits above them.

### Cluster

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/platform/queues` | One call, the whole cluster: per-queue counts, DLQ depth, recent failures with tenant names, worker attachment, `paused`, the two concurrency limits with the `effectiveLimit` they resolve to, the connected API nodes, the worker registry, and whether this node may start or stop a worker |
| PUT | `/api/v1/platform/queues/:name/concurrency` | Set `perNode` and/or `cluster`. An omitted field is left alone, `null` clears a limit, 0 is refused — and a cluster limit above what the attached fleet can reach is accepted, since it binds when a node is added. See [27 — Job Scheduling](27-job-scheduling.md) §6 |
| POST | `/api/v1/platform/queues/:name/pause` | Stop the queue taking work. `{ reason }` is required and recorded with the operator and the time; a second pause keeps the first record |
| POST | `/api/v1/platform/queues/:name/resume` | Let it take work again. No body — and it never refuses for want of a pause record |
| GET | `/api/v1/platform/schedulers` | Every armed cron: queue, scheduler id, job name, cadence, timezone, next run, last run, lifetime count, whether it is an orphan, and its queue's workers and pause state — plus `unarmed`, the registered crons no queue has armed. 200 with `reachable: false` when Redis did not answer |
| DELETE | `/api/v1/platform/queues/:name/schedulers/:id` | Remove a cron no build knows about. Refuses an id the running build registers (409 `SCHEDULER_IS_REGISTERED`): worker boot no longer deletes orphans, so this is the only path that could stop a live cron |
| GET | `/api/v1/platform/queues/:name/jobs` | The jobs in one queue and one state. `?state=` (required), `?limit=` (≤100), `?offset=` (≤1000). `name` may be the sentinel `all` |
| POST | `/api/v1/platform/queues/:name/jobs/:id/:action` | `retry`, `promote` or `replay` on one job |
| POST | `/api/v1/platform/workers/start` | `{ queues?: string[] }` — spawn a worker process on **this** node; empty means all eight queues |
| POST | `/api/v1/platform/workers/:id/stop` | Ask that worker to drain. By id, because the registry holds one record per worker and a deployment may have several |

Shapes for all of these are in
[`packages/web/components/cluster/types.ts`](../../packages/web/components/cluster/types.ts),
which is the one place the console's view of the cluster is written down.

**`GET /platform/queues` answers 200 even when Redis did not**, with
`reachable: false` in the body. A 503 would be indistinguishable, on
screen, from "nothing is queued" — which is the one thing an operator
must not conclude by mistake. The same rule governs every `null` in the
response: `workers: null` means "Redis would not list its clients", not
"no workers", and the pages print "unknown" for it rather than zero.

## Business rules in force

- **BR-PC-001 — A tenant is a row, so a write naming one that does not
  exist is refused.** Every `utility_id` is a foreign key to `utility(id)`
  with `ON DELETE RESTRICT`. Provisioning is therefore a prerequisite for
  all tenant-scoped work, not a convenience.
- **BR-PC-002 — Provisioning is idempotent on the id, not the name.**
  `--utility-id <uuid>` with the same name re-runs as a no-op reporting
  zeros. Without an id, the same name twice is refused
  (`UTILITY_NAME_TAKEN`, 409, case-insensitive); a different name for an
  existing id is refused too (`UTILITY_NAME_MISMATCH`) — renaming is its
  own operation. `dryRun` does everything and writes nothing, so both
  refusals land before anyone commits to the run.
- **BR-PC-003 — Suspension deletes nothing.** It sets `Utility.status` and
  is enforced per request. Purge is a separate, deferred capability.
- **BR-PC-004 — Deactivating an operator keeps the row.** The authority is
  the row plus `is_active`; revoking it must not orphan the audit trail
  that names them.
- **BR-PC-005 — The job verbs are a closed set.** `retry`, `promote`,
  `replay`. `pause`, `drain` and `clean` are deliberately absent: each is
  a decision about a *queue* rather than about the job an operator is
  looking at, and `getQueueHealth` already reports `paused` so a queue
  paused from outside is visible.
- **BR-PC-006 — A job that cannot run says so before an operator retries
  it.** `invalidityOf` checks the tenant first (with `ON DELETE RESTRICT`
  everywhere, a job whose tenant is gone cannot write anything, which
  makes the state of its named record beside the point), then the record
  the payload names — a billing run or an import batch. This was written
  after 102 dev jobs turned out to be 80 billing-run jobs naming runs in
  an empty table and 22 import jobs naming a tenant that never existed.
- **BR-PC-007 — Worker control must be asked for in production.**
  `workerControlAllowed()` is `WORKER_CONTROL_ENABLED || NODE_ENV !==
  "production"`, so it is allowed everywhere but production and there it
  must be set explicitly. A worker an API container spawns is a process
  the orchestrator does not manage: not restarted when it dies, not
  drained on a rolling deploy, absent from `kubectl get pods`.

### Audit

Tenant-lifecycle actions write `audit_log` rows with the tenant's
`utility_id` and `source: platform:<actorId>`, which is what
`/utilities/:id/history` reads.

Cluster actions are **logged, not audited** (`component:
"worker-control"`, with the actor, the issuing node and the target).
`audit_log` requires a `utility_id` and a uuid `entity_id`; starting a
worker or promoting a cross-tenant sweep is a fact about a host, not
about a tenant. Making those two columns nullable is the migration that
would close this and the same gap on the cron queues' job verbs.

## UI

Chrome is `components/platform-shell.tsx` — the admin shell with a
different nav. The same `Sidebar`, the same `Topbar`, assembled the same
way; the sidebar takes its sections as a prop so there is one sidebar in
the product rather than one per surface. Two earlier versions hand-built
a header bar and then a side nav, and each drifted from the original it
was imitating within the hour.

Admin chrome is skipped for `/platform/*` (as it is for `/portal/*`,
`/login` and `/dev`).

| Page | Path | Features |
|---|---|---|
| Utilities | `/platform/utilities` | Every tenant with module / role / user counts, status badge, suspend and reactivate behind `ConfirmDialog`. Was `/dev/tenants` behind a non-production fence, because the authority it needed did not exist |
| Provision | `/platform/utilities/new` | Name, optional first admin, optional explicit id. **Preview** runs the same provisioning as a dry run against the same constraints and rolls back, so a name already taken is refused before anyone commits. Hand-composed rather than `EntityFormPage`: that component gates on `canCreate` for a *tenant* permission module, and no second submit button exists in it |
| Utility Detail | `/platform/utilities/:id` | Readiness panel, the 32 modules with per-module toggles, roles (create / edit / delete), staff, portal-customer **count**, and the from-outside history. The list showed counts with nothing behind them — "6 roles" raises the question it cannot answer |
| Operators | `/platform/users` | The platform's own identities, `lastLoginAt`, deactivate and reactivate. Appointing opens in place rather than on its own page: an operator is an address and a name |
| Cluster Overview | `/platform/cluster` | One verdict — unattended queues, paused queues, failures, "nothing is running at all" — and the recent failures with the tenant each belongs to. Nothing else |
| Workers | `/platform/cluster/workers` | A table, one row per node, at every node count: node, worker id, pid, queues, uptime, attachment. Start is node-local (nothing portable starts a process on another machine, and the row says which node the request landed on rather than implying a choice); Stop is offered only where the pid is this node's to signal |
| Queues | `/platform/cluster/queues` | The eight queues, counts only: workers, waiting, active, delayed, failed, DLQ, completed, paused. Each count links to the Jobs page with queue and state in the URL, and the page links out to Bull Board rather than putting it in the nav |
| Schedulers | `/platform/cluster/schedulers` | Every armed cron with its cadence, next run, last run and lifetime count, and one sentence per row saying why it will not fire when it will not — paused queue, no worker, orphan, or overdue, in that precedence. Remove appears only on an orphan. A separate panel names crons nothing armed, which have no row to appear in. See [27 — Job Scheduling](27-job-scheduling.md) §1 |
| Jobs | `/platform/cluster/jobs` | The jobs in one queue and one state, with queue and status as **URL filters** so the page is shareable and the browser's back button replaces a Close control. Queue filter includes **All queues**, which fans out across the eight and merges by "most recently relevant". Columns: queue, tenant, job, run-at, took, result, attempts. Per-job retry / promote / replay, and a plain-English reason where a job cannot run |

Three Cluster pages rather than one because they answer three questions:
is anything wrong, who is doing the work, and what is the work. One page
held all five subjects — the verdict, the nodes, the workers, the queues
and the jobs behind one count — and each thing added made the others
harder to find.

The drill-down took three attempts: a job table nested inside the queue
table (its header row landed among the queue rows and read as though it
described them), then a table directly below it (the only thing tying the
two together was a tinted row that scrolls out of view), and finally a
route, which is how every other list-to-detail in this app works.

### Shared pieces

| File | Holds |
|---|---|
| `components/cluster/types.ts` | The cluster's wire shapes, documented |
| `components/cluster/use-cluster.ts` | One fetch of `GET /platform/queues`, shared by Overview, Workers and Queues |
| `components/cluster/ui.tsx` | `card`, `cellStyle`, `Th`, `CardHead`, `Verb`, `Tenant`, `Clipped`, `DASH`, `plural`, `shortAge`, `isOverdue`, `troubledFirst` |

**Narrow screens.** The Cluster tables are hand-rolled, so they drop
columns with `.col-hide-sm` / `.col-hide-md`, which must be on **both**
the `<th>` and every matching `<td>` or the header and body fall out of
step and every cell after it shifts one column left. The breakpoints are
the layout widths multiplied by `--app-zoom` (1.25): `max-width: 959px`
for a phone, `max-width: 1499px` for a tablet. `zoom` scales what it
renders but does not change what a media query reads, so breakpoints
written for the unzoomed width fire a quarter too late. See the notes in
`app/globals.css` and `lib/use-media-query.ts`, which carries the same two
numbers for the JS side.

## What the console deliberately does not do

- **Edit global reference rows** (design D3). A write to a
  `utility_id = NULL` row changes behaviour for every tenant at once,
  unreviewed, with no rollback. Migration or tenant override, never a
  live console.
- **Pause or resume a queue** (24 § D7). That is a decision about a queue,
  not about a job or a worker.
- **Scale a worker deployment.** Cluster credentials do not belong here.
- **Purge a tenant.** Suspension is reversible and deletes nothing;
  deletion is a separate capability with its own design.
- **Replace probes and alerts.** Liveness stays with `/health`, which is
  unauthenticated by design and returns 200 even when the cache is down.

## Roadmap

| Step | State |
|---|---|
| Tenant lifecycle: provision, inspect, suspend, modules, roles, operators | **Shipped** |
| Cluster reporting: nodes, workers, queues, jobs, invalid-job detection | **Shipped** |
| Worker start / stop, single host | **Shipped**, development-only by default |
| Bull Board re-gated to the platform actor (design D4) | **Shipped** |
| Worker control across nodes (signing, then pub/sub) | Designed — [24](24-platform-worker-control.md) steps 2–4 |
| `TENANCY_MODE` as boot configuration (design D5) | Not built; every deployment is effectively `self_serve` with the platform routes present |
| Nullable `audit_log.utility_id` / `entity_id`, so host-level actions can be audited | Not built |
| Tenant purge | Deferred |

## Related specs

- [19 — RBAC](19-rbac.md) — the permission model these routes sit outside of
- [24 — Platform Worker Control](24-platform-worker-control.md) — the cluster-wide worker lifecycle design and its measured constraints
- [22 — Import Infrastructure](22-import-infrastructure.md) and [09 — Billing](09-billing.md) — the two queues that carry a progress row, and whose jobs the Jobs page names a record for
- [18 — Theme and Configuration](18-theme-and-configuration.md) — `UtilityConfig`, which provisioning seeds
