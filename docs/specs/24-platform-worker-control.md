# 24 — Platform Worker Control

**Status:** design, not built. The shipped subset is described under
"What exists today"; everything under "Design" is proposed.

**Audience:** the platform operator — a `CisUser` with a null
`utility_id` (see the tenancy design note, Q2). Every route here is
`{ config: { platform: true } }`.

---

## The problem

Workers are a separate Node process (`packages/api/src/worker.ts`).
`start_dev.bat` deliberately does not start one, so the ordinary state of
a development stack is eight queues filling up with nothing attached to
work them — and a queue with no worker has exactly the same counts as a
healthy idle one. The platform console now reports attachment per queue,
which makes the condition visible. This spec is about acting on it.

Two requirements drive the design beyond what is built:

1. **Start one queue at a time, not all of them.** An operator who wants
   to drain `imports` should not also set off `notification-send`, which
   dispatches email and SMS, or `audit-retention`, which deletes rows.
2. **Work correctly with more than one API server.** The shipped version
   is host-local in three places and would let a cluster start workers it
   cannot stop.

## What exists today

| | |
|---|---|
| `GET /api/v1/platform/queues` | counts, dead-letter depth, recent failures, per-queue worker attachment, and `workerProcess` |
| `POST /api/v1/platform/workers/start` | `{queues?: string[]}` — spawns **one** process for those queues (empty means all) |
| `POST /api/v1/platform/workers/stop` | stops the one process this console started |

One worker at a time, recorded under a single Redis key
`platform:worker-process`. Start spawns
`node --import tsx --env-file=.env src/worker.ts` detached, with
`WORKER_QUEUES` in the environment and stdio to `worker.log`. Stop asks
the worker's own HTTP server (`POST /shutdown`, loopback only) and falls
back to `SIGTERM`. `workerControlAllowed()` is true in development and
requires `WORKER_CONTROL_ENABLED` elsewhere.

## Constraints, measured

These are the facts the design has to obey. Each was checked against the
running stack rather than reasoned about, because two earlier guesses in
this area were wrong.

**C1 — A second worker process on the same host dies at startup.**
`startHealthServer` binds `WORKER_HTTP_PORT` (3002) and registers no
`error` handler, so the second process exits 1 on `EADDRINUSE`. Verified:
`exit=1`, `address: '::', port: 3002`. *Consequence: per-queue processes
need a port each, and the port is also the channel a stop travels on, so
it must be recorded per worker rather than read from config.*

**C2 — Database connections are cheap idle and not under load.** One
worker holds 1 connection at rest (measured: 3 → 4). Prisma's pool limit
is `physical_cpus × 2 + 1` per process and `DATABASE_URL` sets no
`connection_limit`; this host has 14 logical CPUs and Postgres is at
`max_connections = 100`. Eight *busy* processes could therefore demand
far more than the server allows. *Consequence: N processes need an
explicit per-worker `connection_limit` and a cap on N.*

**C3 — A pid is meaningless off its host, and loopback never leaves it.**
Both shipped stop paths — `fetch("http://127.0.0.1:<port>/shutdown")` and
`process.kill(pid)` — only work on the host that spawned the worker, and
the `/shutdown` route refuses non-loopback callers by design. With
several API replicas behind a load balancer, the replica that serves a
request is arbitrary. *Consequence: a cluster can start workers it cannot
stop. This is the real defect, not a missing feature.*

**C4 — BullMQ already carries a worker's identity in Redis.** A `Worker`
constructed with `{ name }` sets its connection name to
`bull:<base64 queue>:w:<name>`, and `queue.getWorkers()` returns that as
`rawname`. Verified by reading `worker.js` and by watching a running
worker appear as `bull:ZGVsaW5xdWVuY3ktdGVuYW50`. *Consequence: liveness
and identity are available from any host without inventing a heartbeat.*

## Design

### D1 — The registry becomes a set

Redis hash `platform:workers`, field = worker id, value:

```
{ id, pid, host, queues: string[], startedAt, healthPort, logFile }
```

The id is generated at spawn and passed to the process as `WORKER_ID`.

Keyed by id, not by queue: a worker legitimately serves several queues,
and a queue legitimately has several workers — that is how BullMQ scales
horizontally. Keying by queue makes both unrepresentable.

`GET /platform/queues` returns `workers: WorkerRecord[]` in place of the
single `workerProcess`. The page shows one row per worker (host, pid,
queues, uptime) with its own Stop.

### D2 — Liveness comes from Redis, not from the pid

Each worker passes `name: WORKER_ID` when constructing its `Worker`s
(C4). A record is live when a client named `bull:<queue>:w:<id>` is
connected, which `getWorkers()` already reports and which any API replica
can read. `process.kill(pid, 0)` stays as a same-host refinement only.

This replaces the "a record from another host is assumed running"
compromise in the shipped version, and it needs no heartbeat key, no TTL
to tune, and no new connection.

### D3 — Stop travels over Redis

Workers subscribe to a `platform:worker-control` pub/sub channel and
act on `{ action: "stop", id }` by running the `shutdown()` they already
have. Any replica can stop any worker, because the message goes through
the thing every process shares.

The HTTP `/shutdown` route stays as the manual escape hatch, and
`process.kill` stays as the same-host last resort. Order of attempts:
pub/sub → HTTP (if same host) → signal (if same host). The response
reports which was used and whether it drained, as it does now.

### D4 — Start is host-local, and says so

Nothing portable starts a process on another machine. Start therefore
spawns on whichever API host served the request, and the response names
that host. The page groups workers by host so an arbitrary placement is
visible rather than surprising.

**Rejected:** a desired-state key that each API host reconciles. That is
a scheduler, and the project's architectural checklist is pointed
directly at it. If placement matters, the orchestrator is the tool —
`WORKER_QUEUES` already exists so a worker Deployment can serve a subset.

### D5 — Start takes a queue selection, and defaults to none

`POST /platform/workers/start { queues: string[] }`, validated against
`ALL_QUEUE_NAMES`. The page's control is a queue picker with **nothing
selected by default**, so starting one queue at a time is the path of
least resistance and starting all eight is a deliberate act.

Per start:
- a port from `WORKER_HTTP_PORT`..`+WORKER_MAX_PROCESSES`, the first not
  claimed in the registry and free to bind (C1);
- `worker-<id>.log`, so one worker's output is readable without the
  others interleaved;
- `connection_limit=WORKER_DB_CONNECTION_LIMIT` (default 5) appended to
  the worker's `DATABASE_URL`, bounding the total at
  `WORKER_MAX_PROCESSES × 5` (C2);
- refusal past `WORKER_MAX_PROCESSES` (default 4) on this host.

**The default start stays one process for all queues.** Eight processes
to serve eight queues costs eight ports, eight Prisma pools and eight log
files for a workload one process already handles — `QUEUE_DEFAULTS` tunes
concurrency per queue inside it. One per queue is a thing an operator may
choose, not the shape of the thing.

### D6 — What the console will not do

- Pause or resume a queue. That is a decision about a queue rather than
  about a worker, and `getQueueHealth` already reports `paused` so an
  externally paused queue is visible.
- Scale a worker Deployment. Cluster credentials do not belong in a web
  console.
- Choose the host a worker starts on (D4).

## Config

| Variable | Default | Meaning |
|---|---|---|
| `WORKER_CONTROL_ENABLED` | false | Required outside development (`workerControlAllowed()`) |
| `WORKER_HTTP_PORT` | 3002 | Base of the port range a started worker binds |
| `WORKER_MAX_PROCESSES` | 4 | Cap per API host; also the port range width |
| `WORKER_DB_CONNECTION_LIMIT` | 5 | Appended to a started worker's `DATABASE_URL` |

## Audit

Starting and stopping a worker is logged (`component: "worker-control"`,
with the actor) and **not** written to `audit_log`, which requires a
`utility_id` and a uuid `entity_id`. These actions are about a host, not
a tenant. Same wall the queue job verbs hit on the cross-tenant sweeps;
making those columns nullable is the migration that would close both.

## Build order

1. **D1 + D2** — registry as a set, identity and liveness from Redis.
   No behaviour change for a single worker; the page starts listing.
2. **D5** — port allocation, per-worker log, connection limit, cap, and
   the queue picker. This is the "one at a time" requirement.
3. **D3** — pub/sub stop, which is the cluster correctness fix.
4. **D4** — host grouping in the page, and the docs sentence about
   placement.

Steps 1–2 are useful on their own and are what a single-host deployment
needs. Step 3 is what makes `WORKER_CONTROL_ENABLED` defensible in a
cluster; until it ships, the honest position is that production keeps
the flag off and scales the worker Deployment.
