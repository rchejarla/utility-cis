# 27 — Job Scheduling

**Status:** proposed, 2026-10-30. Nothing in this spec is built.

**Audience:** whoever builds scheduler visibility and the billing
dispatcher. Read [24 — Platform Worker Control](24-platform-worker-control.md)
and [09 — Billing](09-billing.md) §"Why posting is still a button"
first; this spec takes the next step past both and amends
[25 — Platform Console](25-platform-console.md).

**Why now:** a billing cycle declares the day it bills and nothing acts
on it. Somebody opens a screen on the bill day and presses a button, per
cycle, every month, for every tenant. That is the one job in the system
with no clock behind it, and it is the most consequential one.

---

## The problem

Five schedulers run today. They are registered in `worker.ts`, their
patterns are literals in the worker modules, and they are reconciled
against Redis on every worker boot so a removed cron stops firing.

| Queue | Pattern | Tenant control |
|---|---|---|
| `notification-send` | `*/10 * * * * *` | `notificationSendEnabled`, quiet hours |
| `sla-breach-sweep` | `*/5 * * * *` | `slaBreachSweepEnabled` |
| `suspension-transitions` | `0 * * * *` | `suspensionEnabled` |
| `delinquency-dispatch` | `0 * * * *` | `delinquencyEnabled`, `delinquencyRunHourLocal` |
| `audit-retention` | `0 4 * * *` | none (platform housekeeping) |

### What fires a cron

There is no scheduler service. **The worker process is the clock**, and
every requirement below assumes this mechanism:

1. `worker.ts` calls `upsertJobScheduler(id, { pattern, tz })` at boot,
   for each queue in its `activeQueues`. That writes a scheduler record
   into Redis and arms the next occurrence as a delayed job.
2. A worker attached to that queue promotes the delayed job when it
   comes due, runs it, and the next occurrence is armed from it.
3. `reconcileSchedulers` deletes any scheduler whose id is not in
   `SCHEDULER_REGISTRY`, so a cron removed in code stops firing.

Three consequences, each load-bearing somewhere in this spec:

- **No worker, no clock.** Registration happens only in `worker.ts`. On
  a deployment where the worker never starts, the crons are not merely
  un-run — they were never armed. A worker started with `WORKER_QUEUES`
  naming a subset registers only that subset's crons, and nothing
  reports the schedulers that no node armed.
- **No backfill.** One overdue occurrence fires on recovery, not one per
  missed interval. Right for a sweep; wrong for a job that must happen
  on a particular hour, which is why SCH-BILL-7 exists.
- **No leader is needed.** `upsertJobScheduler` is idempotent on the id,
  so every node converges on one record and one job per occurrence.
  Three workers give one hourly sweep, not three.

**The cron is global; the tenant row decides whether and when it acts.**
`delinquency-dispatch` wakes hourly, reads every tenant's config and
enqueues only for tenants whose local hour matches. `/settings/automation`
names each cadence in words and says so: *"Cadence is fixed at the
platform level — these toggles control whether the job does any work for
your utility."*

Three gaps follow from that, and they are not equally urgent:

1. **Nothing shows a scheduler's pattern, next run or last run.**
   `/platform/cluster/queues` reports counts and worker attachment;
   *Delayed* is the armed cron rather than a problem, which is as close
   as the console gets. Bull Board would answer it, but it is off by
   default (`BULL_BOARD_ENABLED`) and is a third-party UI behind the
   platform gate.
2. **Nothing can pause a sweep, or change how much of it runs at once.**
   The levers are killing the worker or restarting it with
   `WORKER_QUEUES` set to a subset. Spec 24 §D7 rules queue pause out of
   *worker* control — "a decision about a queue, not a worker" — while
   noting `getQueueHealth` already reports `paused`. The reporting half
   exists and nothing can set it. `paused` and `concurrency` are adjacent
   fields of the same `bull:<queue>:meta` hash, and neither is writable
   from anywhere in the product.
3. **Billing has no scheduler at all.** `billing-runs` jobs are enqueued
   from three HTTP routes: start, post, resume. `BillingCycle` carries
   `billDayOfMonth`, `readDayOfMonth`, `frequency` and `active` — every
   fact needed to know a cycle is due — and `billDayOfMonth` is read
   only to derive the period of a run already under way.

## Scope

**In:** a scheduler view on the platform console; pause and resume per
queue; the two concurrency limits per queue; a billing dispatcher that
starts runs on each cycle's own bill day; the tenant settings and the one
schema change those need.

**Out, each its own spec or already decided:** editing cron patterns
(§4 — deferred, with the two candidates named); automatic *posting* and
the circuit-breaker (09-billing has decided its shape and it is not this
spec's to re-argue); cluster-wide worker commands (24, steps 2–3);
scheduling anything that is not a billing run.

Requirements are numbered for traceability. **Must** is required for the
slice that contains it; **Should** is required before the capability is
sold as complete.

---

## 1. Seeing the schedulers

- **SCH-VIEW-1 (Must).** `GET /api/v1/platform/schedulers` returns every
  registered scheduler: queue, scheduler id, cron pattern, timezone,
  next run, last run and whether the queue is paused. Platform actor
  only (`{ config: { platform: true } }`), like every other route under
  `/platform`.
- **SCH-VIEW-2 (Must).** It reads `queue.getJobSchedulers()` rather than
  a second copy of the patterns. `reconcileSchedulers` already calls it
  on every worker boot, so the registry in Redis is the one that decides
  what fires — a view built from the source literals would describe a
  deploy rather than a running cluster, and would agree with it only
  until someone changed a pattern and did not restart every node.
- **SCH-VIEW-3 (Must).** A scheduler registered in Redis whose id is not
  in `SCHEDULER_REGISTRY` is shown as an **orphan**, with the note that the
  next worker boot will delete it. That is the one state where Redis and
  the code disagree, and it is worth seeing rather than inferring from a
  log line.
- **SCH-VIEW-4 (Must).** A scheduler whose queue has **no worker
  attached** is called out. The ordinary state of a dev stack is eight
  queues filling up with nothing attached, and the page that reports a
  healthy set of counts beside zero workers is the one that taught us
  the distinction matters.
- **SCH-VIEW-5 (Should).** The page at `/platform/cluster/schedulers`,
  in the Cluster section beside Queues, Workers and Jobs. It answers
  "what is meant to run, and when", where Queues answers "what is
  waiting".
- **SCH-VIEW-6 (Should).** Each row links to that queue's jobs,
  pre-filtered, so "the sweep is due in four minutes" and "here is what
  it did last time" are one click apart.

## 2. Pausing and resuming

- **SCH-PAUSE-1 (Must).** `POST /api/v1/platform/queues/:name/pause` and
  `.../resume`, platform actor only, calling BullMQ's `Queue.pause()` /
  `Queue.resume()`.
- **SCH-PAUSE-2 (Must).** This needs no part of spec 24's command path.
  A pause is a key in Redis that every worker on every node already
  honours; it is not a message to a process. That is the same fact §D7
  used to rule it out of *worker* control, read the other way: it is
  buildable now, and worker control is not its prerequisite.
- **SCH-PAUSE-3 (Must).** Pausing stops new jobs being taken. In-flight
  jobs finish, and the cron keeps firing — the jobs pile up as *waiting*
  and run when the queue resumes. The UI says this in those words,
  because "pause" reads as "nothing will happen" and what actually
  happens is "everything will happen later, at once".
- **SCH-PAUSE-4 (Must).** A paused queue is visible wherever its counts
  are, not only on the page that paused it. `getQueueHealth` already
  carries `paused`.
- **SCH-PAUSE-5 (Should).** A pause records who paused it, when and why
  (a required short reason). A queue found paused on a Monday with no
  record of why is worse than one nobody could pause.
- **SCH-PAUSE-6 (Should).** `notification-send` paused for longer than
  its quiet-hours window is surfaced on `/platform/cluster`, since
  nothing else reports mail that is queued rather than late.

## 3. The billing dispatcher

The shape is `delinquency-dispatch`, which is the pattern this codebase
already uses for "fire often, decide per tenant": one hourly cron, one
cross-tenant read, one per-tenant job with a deterministic id.

- **SCH-BILL-1 (Must).** A new `billing-dispatch` queue, `all-tenants`
  in `QUEUE_TENANCY`, on `0 * * * *`. Each fire reads every active
  `BillingCycle` of every tenant with billing automation enabled and
  enqueues onto the existing `billing-runs` queue.
- **SCH-BILL-2 (Must).** A cycle is due when the **tenant-local date**
  is its `billDayOfMonth` and the local hour matches the tenant's
  billing run hour. Local, via the tenant's `timezone`, exactly as
  `localHour` decides the delinquency hour — a bill dated a day early
  because the server is in UTC is a bill with the wrong period on it.
- **SCH-BILL-3 (Must).** A month shorter than the configured day bills
  on its **last day** (a cycle set to 31 bills on 30 November), the same
  clamp the plan schedule uses. The alternative is a cycle that silently
  skips four months a year.
- **SCH-BILL-4 (Must).** Idempotency is the database's, not the
  dispatcher's. `billing_run` already holds
  `@@unique([utilityId, billingCycleId, windowEnd])` — "one run per
  cycle per window; a second attempt is a 409 naming the first, not a
  second set of bills". The dispatcher treats that conflict as *already
  done* and logs it at debug. Nothing about double-firing, restarts or
  two nodes can produce two sets of bills, and no new guard should be
  written as if it could.
- **SCH-BILL-5 (Must).** **Reads first.** A cycle whose
  `readDayOfMonth` has passed with reads still missing is **not
  dispatched**; it is recorded as a named exception the tenant can see.
  The field exists for this reason: billing before the reads land
  produces a bill for zero usage and then a double one next period. A
  scheduled run must refuse where a human would have noticed.
- **SCH-BILL-6 (Must).** **It generates; it does not post.** Posting is
  governed by `autoPostBills`, which is already per tenant with a
  per-account override, and 09-billing has already decided what
  automatic posting needs (rules, a circuit-breaker). A dispatcher that
  posted would silently become that feature without any of its brakes.
- **SCH-BILL-7 (Must).** **A missed tick runs late, within its own
  window; it never silently skips.** BullMQ repeatables do not backfill,
  so a worker that was down at 03:00 on the bill day would otherwise
  skip the month. The dispatcher re-checks a due cycle until a run
  exists for that window or the window closes, mirroring
  `delinquency-dispatch`'s missed-tick recovery. A window that closes
  with no run is an exception, not silence.
- **SCH-BILL-8 (Must).** `AutomationConfig` gains `billingEnabled`
  (default **false**) and `billingRunHourLocal`, beside the delinquency
  pair, and both appear in the Schedulers card on
  `/settings/automation`. Default off: a tenant that has been billing by
  hand must not discover automation by finding bills it did not ask for.
- **SCH-BILL-9 (Must).** `billing_run.created_by` is non-nullable and a
  scheduled run has no user principal. It becomes **nullable**, with the
  audit convention the sweeps already use — `actorId: null`, a named
  `actorName` ("Billing dispatcher") and a `source` of
  `scheduler:billing-dispatch`, the shape the suspension sweep writes. The
  boot sweep reads `run.createdBy` to resume a run and must take the
  same path. *(Schema change: `00-data-model-overview.md`, `09-billing.md`
  and the master design doc are updated with it.)*
- **SCH-BILL-10 (Must).** The run's own screens say it was scheduled —
  a run nobody started, with a blank "created by", reads as a defect.
- **SCH-BILL-11 (Should).** The tenant is told when a due cycle did not
  dispatch (SCH-BILL-5) or when a window closed with no run
  (SCH-BILL-7), through the existing notification templates. A silent
  failure to bill is the most expensive silence in the product.
- **SCH-BILL-12 (Should).** `/billing-runs` shows the next scheduled run
  per cycle, so "is it going to happen" is answerable before the day.

## 4. What stays fixed, and why

Recorded so it is not re-argued: **the five cron patterns stay in code
for now.** Three of them are not preferences but the *resolution* of a
tenant-facing setting, and making them editable converts a performance
knob into a correctness change with no error to show for it:

| Scheduler | What a slower cadence actually does |
|---|---|
| `delinquency-dispatch` | A tenant whose `delinquencyRunHourLocal` falls between fires never runs. No job, no error, no notice sent. |
| `suspension-transitions` | "Activates at its start date" stops being true to the hour. |
| `notification-send` | Mail and SMS are late, and nothing on screen says why. |

`billing-dispatch` joins that list the moment SCH-BILL-2 reads a
tenant-local hour from it.

- **SCH-FIX-1 (Should).** The two that **are** preferences —
  `audit-retention` (04:00 UTC, which is "run it when the database is
  quiet for your region") and `sla-breach-sweep` (a slower sweep only
  lags the breach flag) — may become editable, after spec 24 steps 2–3.
  They need the signed command path because changing a pattern means
  removing and re-upserting the scheduler on whichever node holds it,
  while `reconcileSchedulers` deletes any id not in the registry: two
  nodes disagreeing about a pattern is two nodes fighting over it.
- **SCH-FIX-2 (Should).** If a pattern ever becomes editable it is a
  validated choice, not a free-text cron. `0 4 * * *` and `4 * * * *`
  differ by one character and by a factor of 24.
- **SCH-FIX-3 (Must).** Any scheduler backing a tenant-facing
  time-of-day setting declares a **floor** — at least hourly — enforced
  where the pattern is set, so the tenant setting cannot be made
  unreachable.

## 5. More than one node

The scheduler half holds up in a cluster without a leader (above). Three
things around it do not, and they are cheaper to fix than to discover.

- **SCH-NODE-1 (Must).** `reconcileSchedulers` runs on **every** worker
  boot and deletes any scheduler id its own build does not know. During
  a rolling deploy that is two builds disagreeing: the new node arms
  `billing-dispatch-cron`, the old node boots and deletes it as an
  orphan, and since registration only happens at boot the cron stays
  gone until something restarts. Reconcile must therefore either be
  confined to ids the booting build owns, or stop being a boot
  side-effect and become a deliberate operation — the console being the
  obvious place, now that SCH-VIEW-3 shows orphans.
- **SCH-NODE-2 (Must).** `billing-runs` declares `concurrency: 1` and
  the worker module explains it in terms of the database — "two in
  parallel would halve neither's wall clock", and "the two must not run
  concurrently over one run, and concurrency 1 already guarantees that".
  That limit is per `Worker` instance, so three nodes run three billing
  runs at once and the second sentence stops being true. `queues.ts` is
  already the honest one ("One run at a time **per replica**"); the
  worker module is not. **Resolved in §6:** the limit becomes two
  numbers, and the per-run guarantee moves to the database, where no
  concurrency setting can delete it.
- **SCH-NODE-3 (Must).** A boot sweep that reclaims work must judge on
  **progress, not status**. `reclaimZombieBillingRuns` selected every
  run with `status = RUNNING`, with no age test and no job id, and ran
  on every boot — so a node booting during a deploy re-enqueued the run
  another node was halfway through, around the `attempts: 1` that exists
  to stop exactly that. Fixed 2026-10-30 by the rule the imports sweep
  beside it already used: a staleness cutoff on `last_progress_at`,
  plus a deterministic job id so two boots in the same hour enqueue one
  job. Any future sweep that looks for abandoned work follows the same
  two rules.
- **SCH-NODE-4 (Should).** A queue with an armed scheduler and **no
  worker attached for longer than its own interval** raises an alert,
  not only a row on a page. The failure this spec is here to prevent is
  silent, and "nobody opened the console" and "the month did not bill"
  must not be the same event.

## 6. How much runs at once

`concurrency` is two different limits wearing one word, and the console
needs both. They bound different resources, and neither can be computed
from the other.

| | Bounds | Stays true when the fleet changes |
|---|---|---|
| **Per node** | one process: heap, CPU, its own `pg.Pool` — 10 connections, the library default, since no `max` is set | yes |
| **Cluster limit** | the shared resource: total concurrent load on one database | yes |

What runs is `min(cluster limit, attached workers × per node)`. Three
nodes at per-node 1 hold three between them, so a cluster limit of 4
never binds and the queue tops out at 3; raise per node to 2 and the same
4 is reached exactly. **The cluster limit does not have to divide by the
node count**, because it is not shared out between nodes — it is one gate
every node checks before taking a job.

- **SCH-CONC-1 (Must).** Both numbers are configurable per queue by the
  platform actor, and **neither is derived from the other or from the
  node count.** `QUEUE_DEFAULTS` stays in code as the fallback for a
  queue nobody has configured.
- **SCH-CONC-2 (Must).** The cluster limit is
  `Queue.setGlobalConcurrency(n)` — an `HSET` of `concurrency` into
  `bull:<queue>:meta`, the field beside `paused`. The gate is in
  `moveToActive`'s Lua (`LLEN active >= concurrency`), evaluated in
  Redis, so every node honours a change on its next fetch. It needs no
  part of spec 24's command path, for the reason SCH-PAUSE-2 gives.
  **Unset means no limit** (`removeGlobalConcurrency`), which is today's
  behaviour and therefore the default: nothing changes until an operator
  chooses a number.
- **SCH-CONC-3 (Must).** Per node is applied through the `Worker`
  `concurrency` setter (present in bullmq 5.76.2, `worker.js:213`),
  which assigns `_concurrency` and nothing else — so lowering it stops
  that worker fetching while jobs already running finish, cancellation
  being a separate `cancelAllJobs`. Each worker reads **one stored
  number for itself**, never a share computed from how many nodes it can
  see.
- **SCH-CONC-4 (Must).** The two differ in how a change reaches a node,
  and the spec should not pretend otherwise. The cluster limit is
  honoured passively: the gate is in Redis and no process has to be
  told. Per node has to reach a live `Worker` object. Until there is a
  delivery mechanism, **per node takes effect at next worker start**,
  which the console can already do. The cheap mechanism is a poll of the
  config hash — one `HGETALL`, where up to one interval of staleness is
  harmless because the number is a ceiling and not a correctness
  property; the alternative is spec 24's command path.
- **SCH-CONC-5 (Must).** The rejected design, recorded so it is not
  re-proposed: *one field `G`, constrained to multiples of `n`, with per
  node derived as `G/n`.* Two costs, either disqualifying.
  - **It raises per-node load when the fleet shrinks.** A node dies,
    `n` goes 3→2, and every survivor recomputes its own limit *upward*,
    from `G/3` to `G/2`. If the first node died of load — the realistic
    way it dies, partway through a twelve-thousand-account run — the
    response to that death is to hand more concurrent work to the
    machines next in line. Fixed per-node limits shed load instead:
    total capacity drops, queue depth grows, and depth is the signal
    worth seeing.
  - **The multiple goes stale with nobody editing it.** 6 is valid
    against three nodes; scale to four and `6/4` is not an integer.
    Rounding down turns the operator's 6 into 4 silently; rounding up
    gives 2+2+2+0 — capped at 6 by the cluster limit, not by the
    division. `min()` was doing the clamping all along, so the division
    never had to be exact, which leaves the constraint buying nothing
    and invalidating stored config on every scaling event.
- **SCH-CONC-6 (Must).** The UI prints the effective cap under the two
  fields, from the attached-worker count `connected-clients.ts` already
  reads out of `CLIENT LIST` — *"3 workers attached → 3 in flight at
  most"*. A cluster limit above `attached × per node` is **not
  rejected**: it binds the moment a node is added, and validating it
  would refuse a legitimate value, then refuse it again halfway through
  every rolling deploy. The arithmetic is shown; the number is the
  operator's.
- **SCH-CONC-7 (Must).** `billing-runs` keeps **per node 1**, and its
  cluster limit must not be settable above 1 until SCH-CONC-8 lands. The
  only thing stopping generation and posting of one run from overlapping
  today is that a single replica can hold one job (SCH-NODE-2). The
  moment an operator can type 2, that guarantee is theirs to delete by
  accident.
- **SCH-CONC-8 (Must).** Per-run exclusion belongs in the **database**,
  not in a concurrency number. The invariant is one job per *run*, not
  N per cluster: two runs at once are fine and two tenants at once are
  the point, while generation and posting of one run are not. A
  conditional claim — the shape `postBill` already uses, `UPDATE … WHERE
  posted_at IS NULL`, against the `status`, `posting_started_at` and
  `last_progress_at` columns SCH-NODE-3 made the sweep read — makes the
  overlap impossible at any concurrency. Only then is the cluster limit
  a free capacity knob.
- **SCH-CONC-9 (Should).** The cluster limit needs no store of ours:
  BullMQ's `meta` hash is the single copy and the thing that enforces
  it. Per node does, and a `platform:queue-concurrency` Redis hash
  beside `platform:workers` is the cheap answer, with `QUEUE_DEFAULTS`
  as the fallback. See open question 6.
- **SCH-CONC-10 (Should).** A queue whose cluster limit sits below its
  attached capacity is called out wherever its counts appear, as
  SCH-PAUSE-4 treats `paused`. A throttled queue and a slow queue look
  identical from a count.

## 7. Cross-cutting

- **SCH-X-1 (Must).** Every new route is platform-actor gated, except
  the two tenant settings in SCH-BILL-8, which are `tenant_profile:EDIT`
  like the rest of `/settings/automation`.
- **SCH-X-2 (Must).** The dispatcher's cross-tenant read runs as
  `cis_platform`; the per-tenant work it enqueues runs under
  `runAsTenant` via `scopedJob`, like every other fan-out. A sweep on a
  confined connection finds nothing and reports success.
- **SCH-X-3 (Must).** Pause, resume, concurrency changes and dispatch
  outcomes are logged with actor and node, the old value beside the new
  (`component: "scheduler-control"`). They are not
  `audit_log` rows: that table needs a `utility_id` and a uuid
  `entity_id`, and these acts are about a queue. Spec 24 hit the same
  wall and named the migration that would close both.
- **SCH-X-4 (Must).** Integration tests mock `enqueueSafely`. A test
  that enqueues into the dev Redis leaves jobs that look like real stuck
  work on this very console — which is how 102 unrunnable dev jobs
  appeared.
- **SCH-X-5 (Must).** `dispatchBilling(now)` is a pure-ish function
  taking the clock, like `dispatchDelinquency(now)`, so month-end,
  timezone and missed-tick cases are unit-testable without a container.

---

## Suggested slices

| Slice | Delivers | Unblocks |
|---|---|---|
| 1 | Scheduler view (SCH-VIEW-*) | Seeing what is armed and what is orphaned — read-only, no new writes |
| 2 | Pause, resume and the two limits (SCH-PAUSE-*, SCH-CONC-*) | The incident levers, without waiting on spec 24 |
| 3 | Billing dispatcher (SCH-BILL-*) | Billing that happens on its own day |
| 4 | Editable cadence for the two preferences (SCH-FIX-1, 2) | After spec 24 steps 2–3 only |

Pause and the limits are one slice because they are one Redis hash, one
route shape and one card: `paused` and `concurrency` sit side by side in
`bull:<queue>:meta`.

SCH-NODE-1 belongs to whichever slice ships first — it is a property of
the cluster rather than of any capability here, and it is wrong today.
SCH-NODE-3 is already fixed. SCH-NODE-2 is resolved by §6, and within
slice 2 the database claim (SCH-CONC-8) lands before `billing-runs`
accepts a cluster limit above 1 (SCH-CONC-7).

Slice 1 is worth shipping alone. Slice 3 is the one that answers the
question this spec exists for, and it depends on nothing in 1 or 2.

## Open questions

1. **Does a scheduled run notify anyone on success?** SCH-BILL-11 covers
   failure. A monthly "12,384 bills generated" is either reassurance or
   noise, and which it is depends on whether anyone is accountable for
   looking.
2. **May the platform operator start a tenant's billing run?** The
   console can retry and replay jobs today. Starting a *new* run charges
   a tenant's customers, which reads like a different kind of authority.
   My inclination is no, and that the console's job is to show why the
   tenant's own schedule did not fire.
3. **`created_by` nullable, or a reserved system uuid?** SCH-BILL-9
   proposes nullable, matching the audit convention. A reserved uuid
   keeps the column non-null at the cost of a row that is not a user.
4. **Who is told about an orphaned scheduler?** SCH-VIEW-3 shows it. It
   only appears after a deploy removes a cron, which is rare enough that
   a page may be enough and an alert may be noise.
5. **Does `billingEnabled` belong per cycle rather than per tenant?** A
   utility running a monthly residential cycle and a quarterly
   irrigation one may want one automated and the other not. Per tenant
   is the smaller change and matches every other toggle; per cycle is
   where the bill day already lives.
6. **How does a per-node limit reach a running worker?** SCH-CONC-4
   takes effect at next worker start, which is honest and may be
   sufficient — the console can restart a worker, and this is a capacity
   knob rather than an incident lever, the cluster limit being the one
   that acts immediately. A poll of `platform:queue-concurrency` buys
   live edits for an interval of staleness; spec 24's command path buys
   them properly and is not due yet. My inclination is to ship
   next-start and add the poll only if an operator asks twice.
