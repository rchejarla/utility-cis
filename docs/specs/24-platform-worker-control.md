# 24 — Platform Worker Control

**Status:** design, not built. "What exists today" is shipped; everything
under "Design" is proposed.

**Audience:** the platform operator — a `CisUser` with a null
`utility_id` (tenancy design note, Q2). Every route here is
`{ config: { platform: true } }`.

**Revision 2.** Revision 1 proposed one worker process per queue and
host-local control. Both were wrong, for reasons recorded under
"Decisions reversed".

---

## The problem

Workers are a separate Node process (`packages/api/src/worker.ts`).
`start_dev.bat` deliberately does not start one, so the ordinary state of
a development stack is eight queues filling up with nothing attached to
work them — and a queue with no worker has exactly the same counts as a
healthy idle one. The console now reports attachment per queue, which
makes the condition visible. This spec is about acting on it, including
when there is more than one API node.

## What exists today

| | |
|---|---|
| `GET /api/v1/platform/queues` | counts, DLQ depth, recent failures, per-queue worker attachment, `workerProcess` |
| `POST /api/v1/platform/workers/start` | `{queues?}` — spawns one process (empty means all) |
| `POST /api/v1/platform/workers/stop` | asks that process to drain |

One worker, one Redis key (`platform:worker-process`). Start spawns
`node --import tsx --env-file=.env src/worker.ts` detached, `WORKER_QUEUES`
in the environment, stdio to `worker.log`. Stop asks the worker's own
HTTP server (`POST /shutdown`, loopback only) and falls back to SIGTERM.
`workerControlAllowed()` is true in development, opt-in elsewhere.

## Constraints, measured

Checked against the running stack, not reasoned about.

**C1 — A second worker on the same host dies at startup.**
`startHealthServer` binds `WORKER_HTTP_PORT` with no `error` handler, so
the second process exits 1 on `EADDRINUSE`. Verified: `exit=1`,
`address: '::', port: 3002`.

**C2 — Concurrency is per process, so splitting multiplies load.** Three
worker processes serving `imports` is 12 concurrent batches against one
Postgres, not three shares of 4. One worker holds 1 connection idle
(measured 3 → 4); Prisma's pool is `physical_cpus × 2 + 1` per process
with no `connection_limit` set, against `max_connections = 100`.

**C3 — A pid is meaningless off its host, and loopback never leaves it.**
Both shipped stop paths are host-local, and `/shutdown` refuses
non-loopback callers by design.

**C4 — BullMQ already carries worker identity in Redis.** A `Worker` given
`{ name }` sets its connection name to `bull:<base64 queue>:w:<name>`, and
`getWorkers()` returns it as `rawname`. Verified in `worker.js` and
against a live worker (`bull:ZGVsaW5xdWVuY3ktdGVuYW50`).

**C5 — An unnamed Redis connection is invisible; a named one is a
registry.** The API's own connections show `name=` empty in `CLIENT LIST`.
Naming them makes every API node enumerable, with the TCP connection
itself as the liveness signal.

**C6 — Only one handler is CPU-bound.** The rate engine in a billing run
is synchronous JavaScript; while it runs, the other seven handlers, the
health server and the lock-renewal timers are all blocked on the same
event loop. `lockDuration` is 60s and renewal fires at 30s, so a
synchronous stretch past 30s can expire a job's own lock.

## Decisions reversed

**One process per queue: dropped.** Six of the eight queues are
concurrency-1 cron sweeps that return in milliseconds; a process each
means eight Prisma pools, eight ports (C1) and eight log files to run
nothing. And per-process concurrency (C2) means splitting does not divide
work, it multiplies capacity against one database.

The useful axis is workload shape, not queue identity (C6): one process
for `billing-runs`, one for the other seven, is the only split that buys
something — the CPU-bound handler stops starving the I/O-bound ones. It
is not needed today (no production load) so it is recorded here and not
built. `WORKER_QUEUES` already expresses it.

**Host-local control: dropped in favour of pub/sub.** Scoping control to
the node serving the request degenerates behind a load balancer: Stop
would work roughly 1-in-N times and otherwise advise an operator to
"use that node", which they have no way to address.

## Design

### D1 — Identity

Each worker gets an id at spawn, passed as `WORKER_ID`, and passes
`name: WORKER_ID` to every `Worker` it constructs. Its connections then
appear in `CLIENT LIST` as `bull:<queue>:w:<id>` (C4), so **liveness and
identity are readable from any node with no heartbeat key and no TTL to
tune.**

Registry: Redis hash `platform:workers`, field = worker id, value
`{ id, node, pid, queues[], startedAt, healthPort, logFile }`. Keyed by
id, not by queue or node: a worker serves several queues, a queue may
have several workers, and a node may run several workers.

### D2 — Node discovery

Name the API's Redis connection at construction (C5):

```js
new Redis(config.REDIS_URL, { connectionName: `api:${hostname()}` })
```

`CLIENT LIST` then enumerates the live API nodes, each with an `age`.
Dedupe by name, since a node holds more than one connection.

**Rejected:** a `platform:api-nodes` hash each node refreshes. It needs a
heartbeat interval and a staleness threshold, and can report a dead node
as alive for up to one interval. A TCP connection cannot.

### D3 — Commands travel over pub/sub

Channel `platform:node-control`. The API node serving the HTTP request
publishes; every control-enabled node subscribes and ignores commands not
addressed to it.

```json
{ "id": "<uuid>", "action": "start" | "stop", "node": "api-9b21",
  "workerId": "<uuid, stop only>", "queues": ["imports"],
  "actorId": "<operator>", "issuedAt": "<iso>", "sig": "<hmac>" }
```

Pub/sub rather than a per-node Redis list, **deliberately for its lack of
durability**: "start a worker on api-9b21" is meaningful now and harmful
twenty minutes later when that node returns. A dropped command is the
correct outcome for a lifecycle operation; a queued one is not.

The target node, on receipt: verify the signature, check
`workerControlAllowed()`, then run **the existing single-host
implementation** — `startWorkerProcess` / `stopWorkerProcess` unchanged.
The HTTP handler and the subscriber become two triggers for one code
path.

### D4 — Commands are signed, and only opted-in nodes listen

Without this, write access to Redis becomes remote code execution on
every API node — a materially larger blast radius than an HTTP endpoint
behind an operator token, and Redis has no per-channel authorisation.

Two defences:

1. **A node that does not allow worker control does not subscribe.**
   `workerControlAllowed()` already exists and already defaults to off
   outside development, so the reachable set is exactly the nodes that
   opted in.
2. **HMAC the payload** with `WORKER_CONTROL_SECRET`, verified before
   acting. A Redis writer without the application secret cannot command
   anything. This is the piece not to skip: Redis is usually more exposed
   than app config, and the whole point is that the two are separate.

The verb set stays closed (`start`, `stop`), queue names are validated
against `ALL_QUEUE_NAMES`, and no operator input reaches a command line —
the selection travels in the spawned process's environment, as it does
today. Every command is logged with its issuing node, the actor, and
whether the signature verified.

### D5 — The result is observed, not replied to

The HTTP call returns **202** with the command id. It does not wait.

The authoritative answer to "is a worker running on api-9b21" is already
cluster-wide (D1, D2), so a reply message would be a second and weaker
source of the same truth, and would need correlation ids, a reply channel
and timeout semantics.

Two things close the gap that leaves:

- **Refuse before publishing.** If the target node is not in the node
  list (D2), answer 409 "api-9b21 is not connected" rather than
  publishing into the void.
- **An outcome record.** The acting node writes
  `platform:node-command:<id>` — `{accepted | refused, code, message}` —
  with a short TTL, and the status response carries any outcome for
  recent commands. Without it every failure looks identical: the six
  refusal codes that are immediate today (`ALREADY_RUNNING`,
  `UNKNOWN_QUEUE`, `WORKER_CONTROL_DISABLED`, …) would all become
  silence, which is a regression from the single-host behaviour.

A command whose target dies between the check and the publish produces no
outcome; the page reports "asked at HH:MM, no outcome yet" after a grace
period rather than implying success.

### D6 — The page

```
WORKER PROCESSES                              attached: 8 of 8 queues

  api-7f3c  ← you are here   worker 4a1f · pid 4242 · since 14:02   [ Stop ]
  api-9b21                   worker 9c02 · pid 881  · since 09:15   [ Stop ]
  api-2d08                   no worker                              [ Start ]

  [ Start worker on api-7f3c ]
```

Every node from D2, every worker from D1. Stop is offered for any worker,
because D3 can reach any node. Start names the node it will act on.

### D7 — What the console still will not do

- Pause or resume a queue. That is a decision about a queue, not a
  worker, and `getQueueHealth` already reports `paused` so an externally
  paused queue is visible.
- Scale a worker Deployment. Cluster credentials do not belong here.
- Choose placement for a *new* node. Only nodes that exist can be
  addressed.

## Config

| Variable | Default | Meaning |
|---|---|---|
| `WORKER_CONTROL_ENABLED` | false | Required outside development. Also gates **subscribing** (D4). |
| `WORKER_CONTROL_SECRET` | — | HMAC key for commands. Required when control is enabled. |
| `WORKER_HTTP_PORT` | 3002 | The started worker's health and shutdown port |

## Audit

Logged (`component: "worker-control"`, with actor, issuing node and
target), not written to `audit_log`, which requires a `utility_id` and a
uuid `entity_id`. These actions are about a host, not a tenant — the same
wall the queue job verbs hit on the cross-tenant sweeps. Making those
columns nullable is the migration that would close both.

## Build order

1. **D1 + D2** — worker ids, named API connections, registry as a hash.
   Pure reporting: the page starts listing every node and worker, and
   this is correct in a cluster on its own.
2. **D4** — the secret and the signing helper, before anything listens.
3. **D3 + D5** — the subscriber, the command path, the outcome record.
4. **D6** — the page.

Step 1 is worth shipping alone and changes no behaviour. Nothing after it
is worth shipping without step 2.

## If this is not wanted

The alternative remains: report cluster-wide (step 1), and leave worker
lifecycle to the orchestrator, which restarts a crashed worker, drains on
deploy and reports what is running — three things the console would do
worse. Worker control then stays a single-host development convenience,
which is what `WORKER_CONTROL_ENABLED=false` already means in production.
