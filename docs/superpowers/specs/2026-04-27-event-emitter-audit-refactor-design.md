# EventEmitter Audit Pipeline Refactor — Design

**Date:** 2026-04-27
**Status:** Designed; implementation plan at [`docs/superpowers/plans/2026-04-27-event-emitter-audit-refactor.md`](../plans/2026-04-27-event-emitter-audit-refactor.md).
**Scope:** Replace the in-process EventEmitter audit pipeline with in-transaction `tx.auditLog.create(...)` calls inside the same `prisma.$transaction` as the entity mutation. Deletes `events/emitter.ts`, `events/audit-writer.ts`, and the `DomainEvent` type. Updates `lib/audit-wrap.ts` and all 17 service callers. The Ship 1 scheduler migration plan flagged this as Ship 2's highest-value item; this doc operationalizes it.

---

## 1. Context

### 1.1 Current architecture

Every mutating service goes through `auditCreate()` / `auditUpdate()` in `packages/api/src/lib/audit-wrap.ts`:

```typescript
return auditCreate(
  { utilityId, actorId, actorName, entityType: "Customer" },
  EVENT_TYPES.CUSTOMER_CREATED,
  () => prisma.customer.create({ data: {...} })
);
```

The wrapper:
1. Runs `op()` directly on `prisma` — no shared transaction.
2. Synchronously calls `domainEvents.emitDomainEvent({...})` (an EventEmitter).
3. The listener registered by `startAuditWriter()` (`packages/api/src/events/audit-writer.ts`) pushes the event onto an in-process queue.
4. A serial drain pops events one-at-a-time, opens its own `prisma.$transaction`, sets `app.current_utility_id`, and inserts the audit row.

There are 47 audit-wrap call sites across 17 services. The architecture has been stable since Phase 1.

### 1.2 The architectural-discipline review

This pipeline was flagged earlier in the engagement (memory: `feedback_architectural_pattern_cost_benefit.md`) as exactly the kind of speculative-decoupling that the project's CLAUDE.md guards against:

> *"The original audit-writer EventEmitter pipeline in the codebase made the same kind of speculative-decoupling mistake — added a layer for hypothetical future consumers that never materialized, and lost atomicity in the process."*

The intent at the time of original design was presumably "loose coupling between mutation and audit so future consumers (notification triggers? analytics?) could subscribe to the same event stream." That second consumer never arrived. The decoupling cost — and the atomicity bug it produced — remained.

Applying the project's architectural-discipline checklist now:

1. **State the simpler alternative first.** A single `prisma.$transaction` that does both the mutation and the audit insert. One transaction, one connection, atomic. No queue. No serial drain. No EventEmitter.
2. **Name the concrete cost the pattern pays.** The current EventEmitter pipeline pays atomicity (mutation can commit while audit fails silently), DB round-trips (two transactions instead of one), connection-pool footprint (audit needs a fresh connection because the original was returned), and durability (the in-process queue is lost on process crash). The simpler alternative pays nothing because the audit insert is one extra `INSERT INTO audit_log ...` on a transaction that's already open.
3. **Verify the conditions that justify the pattern hold.** A pub/sub fan-out makes sense when there are multiple, independent, externally-deployed subscribers (e.g., a Kafka topic feeding analytics + audit + notifications). In this codebase: one subscriber (audit-writer), in-process. The conditions that justify the pattern do not hold.
4. **Default to direct.** The direct version is in scope.
5. **"Future flexibility" is not a justification.** YAGNI applies. If a second consumer arrives, re-introduce a pub/sub layer at that point — backed by a durable queue (BullMQ — already in the codebase post-Ship-1), not an in-process EventEmitter.
6. **Steelman existing code before replacing it.** The serial drain + per-event transaction pattern in `audit-writer.ts:32-72` is well-written defensive code. The author was clearly trying to prevent connection-pool exhaustion under burst traffic. The fix isn't "the existing code is bad" — it's "the *abstraction* it implements is unnecessary; once removed, the defensive concerns it addresses dissolve too."

### 1.3 Concrete bug examples this fixes

The atomicity gap is not theoretical. Specific scenarios where the current pipeline misbehaves:

- **Process crash after mutation, before drain.** The customer row is in the DB; the audit row never lands. There's no record of who created the customer. Most importantly, **there's no way to retroactively reconstruct the audit row** because the EventEmitter's queue is in-process memory, lost on restart.
- **Audit-write failure silently swallowed.** `audit-writer.ts:62-67` catches errors and logs them, but the mutation has already committed. The system has no exception escalation path; the operator finds out only when an auditor notices the gap.
- **RLS-context drift.** The audit-write opens a fresh connection from the pool. That connection may have been used previously by another tenant's request and may have stale `app.current_utility_id`. The audit-writer sets it transactionally to be safe — but this is two SETs (one per request, one per audit write) where one would do.
- **Doubled connection-pool footprint.** Each audited mutation now demands two connections in close sequence — original mutation + audit-write. Under traffic, this halves the effective pool size. The original code's comment about "one connection at a time" is acknowledging the issue without resolving it.

---

## 2. Target architecture

### 2.1 New `audit-wrap.ts` signature

```typescript
export interface AuditContext {
  utilityId: string;
  actorId: string;
  actorName?: string;
  entityType: string;
}

type WithId = { id: string };

export async function auditCreate<T extends WithId>(
  ctx: AuditContext,
  eventType: string,
  op: (tx: Prisma.TransactionClient) => Promise<T>,
  existingTx?: Prisma.TransactionClient
): Promise<T>;

export async function auditUpdate<T extends WithId>(
  ctx: AuditContext,
  eventType: string,
  before: unknown,
  op: (tx: Prisma.TransactionClient) => Promise<T>,
  existingTx?: Prisma.TransactionClient
): Promise<T>;
```

Two changes from the current signature:

- `op` now receives a `Prisma.TransactionClient` (`tx`) instead of operating on the global `prisma`. Callers go from `() => prisma.customer.create(...)` to `(tx) => tx.customer.create(...)`. Mechanical change.
- Optional `existingTx` parameter. If provided, the wrapper runs `op` and the audit insert against that client (caller already in a transaction). If not, the wrapper opens a fresh `prisma.$transaction`.

### 2.2 Implementation sketch

```typescript
async function auditCreateImpl<T extends WithId>(
  tx: Prisma.TransactionClient,
  ctx: AuditContext,
  eventType: string,
  op: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  await tx.$executeRaw`SELECT set_config('app.current_utility_id', ${ctx.utilityId}, true)`;
  const entity = await op(tx);
  await tx.auditLog.create({
    data: {
      utilityId: ctx.utilityId,
      entityType: ctx.entityType,
      entityId: entity.id,
      action: mapEventTypeToAction(eventType),
      actorId: ctx.actorId,
      actorName: ctx.actorName,
      beforeState: null,
      afterState: entity as unknown as Prisma.InputJsonValue,
      metadata: { eventType },  // preserve the richer event-type for queryability
    },
  });
  return entity;
}

export async function auditCreate<T extends WithId>(
  ctx: AuditContext,
  eventType: string,
  op: (tx: Prisma.TransactionClient) => Promise<T>,
  existingTx?: Prisma.TransactionClient
): Promise<T> {
  if (existingTx) {
    return auditCreateImpl(existingTx, ctx, eventType, op);
  }
  return prisma.$transaction((tx) => auditCreateImpl(tx, ctx, eventType, op));
}
```

`auditUpdate` mirrors the shape with `beforeState` populated from the `before` parameter.

`mapEventTypeToAction` moves from `audit-writer.ts` into `audit-wrap.ts` (or a small shared helper file). Same logic: `"customer.created"` → `"CREATE"`, `"customer.revised"` → `"UPDATE"`, `"customer.deleted"` → `"DELETE"`.

### 2.3 What gets deleted

- `packages/api/src/events/audit-writer.ts` — entire file.
- `packages/api/src/events/emitter.ts` — entire file.
- `packages/api/src/events/` — directory if empty after the above.
- `import { startAuditWriter } from "./events/audit-writer.js"` in `app.ts:11`.
- `startAuditWriter()` call in `app.ts:125`.
- `DomainEvent` type from `packages/shared/src/...` — verify with grep before deleting; it may have other consumers (none expected, but check).
- `domainEvents.on(...)` test fixture in `packages/api/src/__tests__/audit-wrap.test.ts` — replaced by direct assertion against `tx.auditLog.create` (see §3.4).

### 2.4 What stays

- The `AuditLog` schema model and table — unchanged.
- Worker-process code paths that already write audit rows in transactions via `tx.auditLog.createMany(...)` directly (suspension worker, SLA-breach worker) — unchanged. These never went through the EventEmitter.
- Per-tenant RLS policy on `audit_log` — unchanged.
- The 47 audit-wrap call sites — signature change only; logic unchanged.

---

## 3. Migration

### 3.1 The signature change is mechanical

Every callsite goes from this:

```typescript
return auditCreate(
  { utilityId, actorId, actorName, entityType: "Customer" },
  EVENT_TYPES.CUSTOMER_CREATED,
  () => prisma.customer.create({ data: {...} })
);
```

To this:

```typescript
return auditCreate(
  { utilityId, actorId, actorName, entityType: "Customer" },
  EVENT_TYPES.CUSTOMER_CREATED,
  (tx) => tx.customer.create({ data: {...} })
);
```

The TypeScript compiler will refuse to build any callsite where `op` is still `() => prisma.foo.create(...)` once the signature changes — because Prisma's `TransactionClient` and the global `PrismaClient` differ in type. This means the migration is forced to be complete; nothing slips through.

### 3.2 Callsites that already wrap in `$transaction`

Some services (e.g., `service-suspension.service.ts`, `service-request.service.ts`) already call `prisma.$transaction(async (tx) => { ... })` for multi-step mutations. These callsites currently use raw `tx.foo.create(...)` without going through `auditCreate`/`auditUpdate`. They write audit rows directly via `tx.auditLog.createMany(...)`.

**No change required for these.** They're already correct — atomic, transactional, no EventEmitter. The refactor doesn't touch them.

If a service uses BOTH patterns — outer `$transaction` plus inner `auditCreate` — the migration uses the new `existingTx` parameter:

```typescript
return prisma.$transaction(async (outerTx) => {
  const customer = await auditCreate(
    { utilityId, actorId, actorName, entityType: "Customer" },
    EVENT_TYPES.CUSTOMER_CREATED,
    (tx) => tx.customer.create({...}),
    outerTx  // pass the outer tx through
  );
  await auditCreate(
    { utilityId, actorId, actorName, entityType: "Account" },
    EVENT_TYPES.ACCOUNT_CREATED,
    (tx) => tx.account.create({...}),
    outerTx
  );
  return customer;
});
```

This preserves single-transaction atomicity for multi-step service flows.

### 3.3 The `mapEventTypeToAction` move

Currently in `audit-writer.ts:14-21`. Moves to `audit-wrap.ts` as a top-level helper. No behavior change; same five-line function.

### 3.4 Test rewrite

`packages/api/src/__tests__/audit-wrap.test.ts` currently asserts events fire on the `domainEvents` EventEmitter. After the refactor, there's no EventEmitter — assertions move to "audit_log row exists with the right shape." Two options:

- **Mock-based:** mock `prisma.auditLog.create` and assert call arguments. Faster; no DB.
- **Integration-style:** real Postgres (testcontainers) and query `audit_log` after `auditCreate`. Slower; covers the full path.

Recommendation: keep the unit test mock-based for fast TDD; add a small integration test that exercises one create + one update against testcontainers Postgres to verify the SQL actually lands. The integration test slots into the existing `__tests__/integration/` directory alongside the worker integration tests.

### 3.5 `DomainEvent` type cleanup

`DomainEvent` is exported from `@utility-cis/shared`. It's only consumed by the audit pipeline as far as I've seen, but I'll grep before deleting:

```bash
grep -rn "DomainEvent\|domainEvents" packages/ --include="*.ts" | grep -v __tests__
```

If any non-audit caller exists, document it in the migration plan and decide case-by-case.

### 3.6 Order of changes (in one commit)

1. Update `lib/audit-wrap.ts` to the new signature.
2. Delete `events/audit-writer.ts` and `events/emitter.ts`.
3. Remove `startAuditWriter()` import + call from `app.ts`.
4. Update each of 17 services in turn — let TypeScript compiler errors guide you. Each is a 1-character change per call (`()` → `(tx)`) plus replacing `prisma.` with `tx.`.
5. Update `audit-wrap.test.ts` to assert against `prisma.auditLog.create` mock or DB.
6. Verify `DomainEvent` type has no remaining consumers; delete it from `packages/shared`.
7. Run full test suite. Fix any test fixtures that still reference `domainEvents`.

Everything in one commit because the signature change is structural — partial states aren't shippable.

---

## 4. Verification

### 4.1 Atomicity test

A new integration test:

```typescript
it("audit row lives or dies with the mutation", async () => {
  // Force the audit insert to fail mid-transaction
  await expect(
    auditCreate(ctx, "customer.created", (tx) => {
      // entity creation succeeds...
      return tx.customer.create({ data: {...} });
    })
  ).rejects.toThrow();
  
  // ...but the customer should NOT exist either
  const count = await prisma.customer.count({ where: { utilityId: ctx.utilityId } });
  expect(count).toBe(0);
});
```

In the current architecture this test is impossible to write — the audit failure is silenced; the mutation commits anyway. After the refactor, the test passes.

### 4.2 Performance check

A microbenchmark comparing pre/post: 1000 customer creations, measured wall-clock + DB connection-pool peak. Expectation:

- Wall-clock improves slightly (one fewer transaction round-trip per mutation).
- Pool footprint decreases (one connection per mutation instead of two).

If either gets worse, investigate before merging. Connection-pool peak is the more important metric — under burst load, the current architecture can starve the pool.

### 4.3 Behavior parity

Sweep through every audited operation in the codebase, run it before + after the refactor, compare the resulting `audit_log` rows. They should be identical (same `entityType`, `entityId`, `action`, `actorId`, `beforeState`, `afterState`).

The `metadata.eventType` field is new in the refactor (preserves the richer type info from the EventEmitter). Pre-refactor `metadata` was empty; post-refactor `metadata = { eventType: "customer.created" }`. This is an additive change; downstream queries reading `metadata` get strictly more info.

---

## 5. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Refactor breaks an audit emit somewhere subtle (e.g., a test fixture bypassed `auditCreate` to hand-roll the EventEmitter call) | **High** | TypeScript compiler is the safety net — every callsite using the old signature fails to build. Plus a grep for `domainEvents.emit` finds any direct emitter call. |
| Inner `op(tx)` does something Prisma's `TransactionClient` doesn't support | Medium | Prisma's `TransactionClient` supports the same methods as the main client minus `$transaction` itself (no nested interactive transactions). Most service ops are simple `create`/`update`/`delete` — no risk. |
| Some caller relies on the EventEmitter for non-audit reasons | Medium | Grep `domainEvents.on(` and `domainEvents.addListener(` before deletion. Expected: only `audit-writer.ts` registers listeners. |
| Pre-existing nested `prisma.$transaction` callers break when `auditCreate` opens its own `$transaction` | Medium | The optional `existingTx` parameter handles this. Audit each multi-step service flow during the migration; any that uses `prisma.$transaction(async (tx) => { ... auditCreate(...) ... })` switches to passing `tx` as the new `existingTx`. |
| Missed callsite where audit row is now silently going through transactional path that wasn't tested under load | Low | Behavior parity test (§4.3) catches missing rows. Performance test (§4.2) catches pool exhaustion. |
| `mapEventTypeToAction`'s heuristic ("ends with .created") doesn't cover an event type | Low | Same heuristic exists today in `audit-writer.ts`; not a new risk. The function defaults to `"UPDATE"` for unknown types. |
| `DomainEvent` type has a downstream consumer I'm not aware of | Low | Grep before deleting; if any consumer exists, scope the cleanup to just the audit pipeline and leave `DomainEvent` for them. |

---

## 6. Out of scope

1. **Adding new audit metadata fields** beyond `eventType`. The schema doesn't change. If `metadata` should carry richer payloads (request IDs, IP addresses, user-agent), that's a separate enhancement.
2. **Re-architecting the worker process audit path.** Workers already write audits transactionally via `tx.auditLog.createMany` in their service helpers. Untouched.
3. **Replacing the audit pipeline with an external system** (Kafka, Loki, etc.). The system stays Postgres-backed; this refactor only fixes the in-process atomicity issue.
4. **Adding event sourcing.** This refactor doesn't introduce a notion of "domain events" as first-class entities. The eventType string is metadata; audit_log remains a flat row-per-mutation table.
5. **Notification + delinquency atomicity** (Task 10 audit's open items). Those services don't go through `auditCreate` at all — they have their own audit emit logic. They need separate refactors. Scope clearly: this doc covers the EventEmitter pipeline only.

---

## 7. Open questions

1. **Should we keep `metadata.eventType` on every row, or only when it differs from the inferred action?** Keeping it always means richer queries but slightly more storage. Recommendation: always — the storage cost is trivial and the query benefit is real.

2. **Should `auditCreate`/`auditUpdate` accept a `metadata` parameter so callers can pass per-mutation context?** Currently they don't; the EventEmitter pipeline doesn't pass arbitrary metadata. Recommendation: yes, add it as an optional 5th parameter (`metadata?: Record<string, unknown>`) so future enhancements (request IDs, etc.) don't require another signature change.

3. **What happens to the `EVENT_TYPES` constant?** It's currently in `@utility-cis/shared`. After the refactor, `eventType` is just a string passed to `auditCreate`. Keep the constant for consistency? Recommendation: yes — operators reading the audit log appreciate consistent strings.

These are decisions for the executing engineer to confirm during implementation; the design doesn't force them either way.

---

## 8. Effort

**S-M (~1-2 days)** with subagent-driven development. The refactor is mechanical; the bulk of the time is rerunning tests and validating behavior parity. Test rewrite is ~half of the work.

Implementation plan: [`docs/superpowers/plans/2026-04-27-event-emitter-audit-refactor.md`](../plans/2026-04-27-event-emitter-audit-refactor.md).
