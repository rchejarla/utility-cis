# EventEmitter Audit Pipeline Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Replace the in-process EventEmitter audit pipeline with in-transaction `tx.auditLog.create(...)` calls. Closes the atomicity gap between entity mutation and audit write. Removes a speculative-decoupling layer that has only one consumer. Updates `lib/audit-wrap.ts` and 17 service callers; deletes `events/emitter.ts`, `events/audit-writer.ts`, and the `DomainEvent` type. Same single transaction for both the mutation and its audit row, half the connection-pool footprint, and no more silently-swallowed audit failures.

**Spec:** [`docs/superpowers/specs/2026-04-27-event-emitter-audit-refactor-design.md`](../specs/2026-04-27-event-emitter-audit-refactor-design.md) — read §2 (target architecture) and §3 (migration shape) first. The signature change for `auditCreate`/`auditUpdate` is the load-bearing decision.

**Status of dependencies:** None. The EventEmitter pipeline has no upstream dependencies; this refactor is self-contained. Doesn't depend on Task 11 (legacy scheduler removal) or any Bozeman work. Can ship anytime.

**Effort:** S-M, ~1-2 days. The mechanical signature change is small; behavior-parity validation is the bulk of the work.

---

## File Structure

### Deleted

| Path | Reason |
|---|---|
| `packages/api/src/events/audit-writer.ts` | Logic moves into `lib/audit-wrap.ts` (in-transaction). |
| `packages/api/src/events/emitter.ts` | Sole consumer was `audit-writer`. No other listeners. |
| `packages/api/src/events/` | Directory empty after the two files above are removed. |

### Modified

| Path | Change |
|---|---|
| `packages/api/src/lib/audit-wrap.ts` | New signatures: `op` accepts a `Prisma.TransactionClient`; optional `existingTx` parameter. Wrapping `prisma.$transaction` does the audit insert in the same transaction as `op(tx)`. `mapEventTypeToAction` helper moves here from `audit-writer.ts`. |
| `packages/api/src/app.ts` | Remove `import { startAuditWriter } from "./events/audit-writer.js"` (line 11) and the `startAuditWriter()` call (line 125). |
| 17 service files (see §"Migration matrix" below) | Each `auditCreate` / `auditUpdate` callsite changes from `() => prisma.foo.create(...)` to `(tx) => tx.foo.create(...)`. Service files that already wrap in their own `prisma.$transaction(async (outerTx) => {...})` AND use `auditCreate` inside need to pass `outerTx` as the new `existingTx` parameter. |
| `packages/api/src/__tests__/audit-wrap.test.ts` | Rewrite from EventEmitter-based assertions to mocked `prisma.auditLog.create` assertions. |
| `packages/shared/src/...` | Remove `DomainEvent` type if no remaining consumers (verify via grep first). |
| `packages/api/src/__tests__/integration/audit-wrap.integration.test.ts` (new) | One small testcontainers test exercising real audit-row landing. |

### Migration matrix — services using `auditCreate`/`auditUpdate`

| Service | Calls | Notes |
|---|---|---|
| `services/customer.service.ts` | 2 | Straightforward |
| `services/account.service.ts` | 2 | Straightforward |
| `services/contact.service.ts` | 2 | Straightforward |
| `services/premise.service.ts` | 2 | Straightforward |
| `services/meter.service.ts` | 2 | Straightforward |
| `services/meter-event.service.ts` | 2 | Straightforward |
| `services/meter-read.service.ts` | 2 | Inspect for outer `$transaction` (multi-register events use one) |
| `services/service-agreement.service.ts` | 2 | Inspect for outer `$transaction` |
| `services/service-event.service.ts` | 2 | Straightforward |
| `services/service-request.service.ts` | 6 | Has multi-step flows; check each for outer `$transaction` |
| `services/service-suspension.service.ts` | 6 | Has multi-step flows |
| `services/sla.service.ts` | 2 | Straightforward |
| `services/rate-schedule.service.ts` | 2 | Has `revise` flow that uses outer `$transaction` |
| `services/billing-cycle.service.ts` | 2 | Straightforward |
| `services/commodity.service.ts` | 2 | Straightforward |
| `services/uom.service.ts` | 2 | Straightforward |
| `services/container.service.ts` | 3 | Straightforward |

47 callsites total (per `grep -c auditCreate\\\|auditUpdate packages/api/src/services/`).

---

## Task 0: Pre-checks

**Goal:** Confirm assumptions before touching code.

**Steps:**
- [ ] **0.1** `grep -rn "domainEvents\.on\|domainEvents\.addListener\|domainEvents\.once" packages/ --include="*.ts"` — verify ONLY `audit-writer.ts` registers a listener. If anything else listens, scope the refactor accordingly.
- [ ] **0.2** `grep -rn "domainEvents\.emit\b\|emitDomainEvent" packages/ --include="*.ts"` — verify the only `emit` callsites are inside `audit-wrap.ts`. If anything else emits, that's an unexpected caller; investigate before proceeding.
- [ ] **0.3** `grep -rn "DomainEvent" packages/ --include="*.ts"` — list every consumer of the type. If any production code outside the audit pipeline uses it, scope the cleanup more conservatively.
- [ ] **0.4** Check for nested `$transaction` callers: `grep -rB 5 "auditCreate\|auditUpdate" packages/api/src/services/ | grep -B 5 "prisma\.\$transaction"` — find any service that already has an outer transaction containing an `auditCreate` call. These need the new `existingTx` parameter.
- [ ] **0.5** `pnpm --filter @utility-cis/api test` — confirm the test suite is green BEFORE the refactor. Establishes a baseline.

**Verification:** All preconditions hold. No surprise consumers of the EventEmitter or the `DomainEvent` type.

---

## Task 1: Update `lib/audit-wrap.ts`

**Goal:** Change the `auditCreate` / `auditUpdate` signatures to take a `tx`-receiving callback. Move `mapEventTypeToAction` from `audit-writer.ts` into this module. Wrap each callsite in a `$transaction` (or use the caller's `existingTx`).

**Files:**
- Modify: `packages/api/src/lib/audit-wrap.ts`

**Steps:**
- [ ] **1.1** Update imports: add `import type { Prisma } from "@prisma/client"; import { prisma } from "./prisma.js";`. Remove the `domainEvents` import.
- [ ] **1.2** Add the `mapEventTypeToAction` helper (copy from `audit-writer.ts:14-21`).
- [ ] **1.3** Add the private `auditCreateImpl(tx, ctx, eventType, op)` and `auditUpdateImpl(tx, ctx, eventType, before, op)` helpers per the spec §2.2 sketch. Each does:
  - `tx.$executeRaw\`SELECT set_config('app.current_utility_id', ${ctx.utilityId}, true)\`` — transactional SET so the context doesn't leak post-commit.
  - `const entity = await op(tx);`
  - `await tx.auditLog.create({ data: { ..., metadata: { eventType } } });`
  - Return `entity`.
- [ ] **1.4** Update the public `auditCreate` signature:
  ```typescript
  export async function auditCreate<T extends WithId>(
    ctx: AuditContext,
    eventType: string,
    op: (tx: Prisma.TransactionClient) => Promise<T>,
    existingTx?: Prisma.TransactionClient
  ): Promise<T> {
    if (existingTx) return auditCreateImpl(existingTx, ctx, eventType, op);
    return prisma.$transaction((tx) => auditCreateImpl(tx, ctx, eventType, op));
  }
  ```
- [ ] **1.5** Same shape for `auditUpdate`.
- [ ] **1.6** Optional 5th parameter `metadata?: Record<string, unknown>` on both — merged into the audit row's `metadata` JSON alongside `eventType`. (Per spec §7 question — recommended `yes`.)
- [ ] **1.7** Type-check the file in isolation: `pnpm --filter @utility-cis/api exec tsc --noEmit packages/api/src/lib/audit-wrap.ts` (won't compile yet because callers haven't been updated; expected).

**Verification:** `lib/audit-wrap.ts` is internally consistent. The whole project does NOT yet type-check — that's the point; the compiler will guide the rest of the migration.

---

## Task 2: Migrate service callsites (the ~17-file fan-out)

**Goal:** Update every `auditCreate`/`auditUpdate` callsite. The TypeScript compiler refuses to build until every callsite uses the new signature, which is the right safety net.

**Files:**
- Modify: every file from the migration matrix above (17 services).

**Steps:**

For EACH service in the migration matrix (sequentially is fine; can also dispatch as separate subagents):

- [ ] **2.X.1** Read the service's `auditCreate` / `auditUpdate` callsites.
- [ ] **2.X.2** For each callsite:
  - Change the lambda signature: `() => prisma.foo.create(...)` becomes `(tx) => tx.foo.create(...)`.
  - If the surrounding code is inside an outer `prisma.$transaction(async (outerTx) => {...})` with the audit call inside, pass `outerTx` as the 4th argument. Don't wrap in another `$transaction`.
- [ ] **2.X.3** For services with multi-step flows (e.g., `service-request.service.ts:assignServiceRequest` may do an UPDATE + insert + audit), check whether the existing flow is already inside a `prisma.$transaction`. If yes: pass that as `existingTx`. If no: the new `auditCreate` opens its own transaction, which is fine for single-op flows.
- [ ] **2.X.4** Type-check that file alone: `pnpm --filter @utility-cis/api exec tsc --noEmit`. If errors point at this service file, fix them; if errors point at others, defer until those are migrated.
- [ ] **2.X.5** Run that service's unit tests: `pnpm --filter @utility-cis/api test -- <service-name>`.

Repeat for all 17. Order doesn't matter (no inter-service dependencies in the audit pattern), but doing customer → account → premise → meter (the foundational entities) first means broken downstream tests fail loudly; doing them last means broken upstream services hide them.

**Verification after all 17:** `pnpm --filter @utility-cis/api exec tsc --noEmit` clean across the whole package. Full unit test suite green.

---

## Task 3: Delete `events/audit-writer.ts` + `events/emitter.ts`

**Goal:** Remove the now-orphaned files. Remove the call site in `app.ts`.

**Files:**
- Delete: `packages/api/src/events/audit-writer.ts`, `packages/api/src/events/emitter.ts`, `packages/api/src/events/` (directory)
- Modify: `packages/api/src/app.ts`

**Steps:**
- [ ] **3.1** Delete `packages/api/src/events/audit-writer.ts`.
- [ ] **3.2** Delete `packages/api/src/events/emitter.ts`.
- [ ] **3.3** Confirm `packages/api/src/events/` is empty; delete the directory.
- [ ] **3.4** In `packages/api/src/app.ts`: remove `import { startAuditWriter } from "./events/audit-writer.js";` (line 11) and the `startAuditWriter();` call (line 125).
- [ ] **3.5** `pnpm --filter @utility-cis/api exec tsc --noEmit`. Should be clean — Task 2 already did the heavy lifting; this just removes dead files.

**Verification:** No remaining references to `domainEvents`, `audit-writer`, `startAuditWriter`, `DomainEventEmitter` anywhere in `packages/api/src/`. Grep returns zero hits.

---

## Task 4: Clean up `DomainEvent` type

**Goal:** Remove the `DomainEvent` type from shared if no consumers remain.

**Files:**
- Possibly: `packages/shared/src/domain-event.ts` or wherever `DomainEvent` lives.
- Possibly: `packages/shared/src/index.ts` to remove the re-export.

**Steps:**
- [ ] **4.1** `grep -rn "DomainEvent" packages/ --include="*.ts" | grep -v __tests__` — list remaining consumers.
- [ ] **4.2** If only test fixtures reference it, those tests are no longer valid (they tested the EventEmitter behavior); they should have been removed in Task 5 below.
- [ ] **4.3** If any production code references `DomainEvent`, document it and leave the type in place. The audit pipeline isn't the only possible consumer; if Phase 2 brought in something else, scope this cleanup conservatively.
- [ ] **4.4** If zero consumers remain, delete the type definition + the re-export from `packages/shared/src/index.ts`.
- [ ] **4.5** `pnpm --filter @utility-cis/shared build` and `pnpm --filter @utility-cis/api exec tsc --noEmit` — both clean.

**Verification:** Grep for `DomainEvent` returns zero hits in production code (or only the documented exceptions).

---

## Task 5: Rewrite the audit-wrap test

**Goal:** Replace EventEmitter-based assertions with `prisma.auditLog.create` mock assertions.

**Files:**
- Modify: `packages/api/src/__tests__/audit-wrap.test.ts`

**Steps:**
- [ ] **5.1** Remove the `domainEvents.on(...)` setup + teardown.
- [ ] **5.2** For each test case: set up a mock `Prisma.TransactionClient` (use the existing `mocks/prisma.ts` fixture if appropriate, or create a tighter mock). Assert that `auditCreate(...)` calls `tx.auditLog.create` with the expected payload.
- [ ] **5.3** Cover the new code paths:
  - `auditCreate` without `existingTx` opens a `$transaction` — assert `prisma.$transaction` is called.
  - `auditCreate` with `existingTx` does NOT open a new transaction — assert `prisma.$transaction` is NOT called; assert the provided tx receives both the `op` call and the audit insert.
  - Error in `op` rolls back — neither the entity nor the audit row should land.
- [ ] **5.4** Verify `metadata.eventType` is set correctly.
- [ ] **5.5** Verify the action-mapping (`customer.created` → `CREATE`, etc.).
- [ ] **5.6** Run: `pnpm --filter @utility-cis/api test -- audit-wrap`.

**Verification:** All test cases pass. Coverage is at least as broad as the pre-refactor test (4 cases) plus the new ones above.

---

## Task 6: Add an integration test for atomicity

**Goal:** A small testcontainers-backed test that proves the audit row is atomic with the mutation.

**Files:**
- Create: `packages/api/src/__tests__/integration/audit-wrap.integration.test.ts`

**Steps:**
- [ ] **6.1** Use the existing testcontainers Postgres fixture (same pattern as `worker-suspension.test.ts`).
- [ ] **6.2** Test 1: Successful `auditCreate` lands BOTH the entity and an `audit_log` row. Assert via direct DB query.
- [ ] **6.3** Test 2: Force a failure inside the transaction (e.g., `op` throws after entity create but before audit) — verify NEITHER row exists.
  - Implementation hint: the easiest way to force this is to write a test-only wrapper that wraps `auditCreate` and throws between entity creation and the audit insert. Or use the `existingTx` parameter and roll back the outer transaction explicitly.
- [ ] **6.4** Test 3: `auditCreate` with `existingTx` joins the caller's transaction. Roll back the outer transaction; verify NO rows in either table.
- [ ] **6.5** Run: `pnpm --filter @utility-cis/api test:integration -- audit-wrap`.

**Verification:** All three integration tests pass.

---

## Task 7: Behavior-parity sweep

**Goal:** For each of the 17 services, manually verify the audit log looks the same after the refactor as before.

**Steps:**
- [ ] **7.1** Pick a representative operation in each service (e.g., `createCustomer`, `createAccount`, `createPremise`, ..., `createServiceRequest`, `transitionServiceRequest`, `cancelServiceRequest` for SR's six callsites).
- [ ] **7.2** Run the operation against a clean database (or reset the audit_log table).
- [ ] **7.3** Query `audit_log` and compare against the expected shape: `entityType`, `entityId`, `action`, `actorId`, `beforeState`, `afterState`, `metadata.eventType`. The pre-refactor `metadata` was empty; post-refactor it has `eventType`. That's the only intentional difference.
- [ ] **7.4** Document any unexpected differences in the commit message.

**Verification:** Audit-row shapes match pre-refactor for every audited operation.

---

## Task 8: Performance check

**Goal:** Confirm the refactor doesn't regress throughput or pool usage.

**Steps:**
- [ ] **8.1** Microbenchmark: 1000 sequential `customer.create` calls under both architectures. Record wall-clock + peak DB connection count.
- [ ] **8.2** Expectation: post-refactor wall-clock ≤ pre-refactor (one fewer round-trip per audited mutation should help slightly). Pool peak should be roughly half (one connection per mutation instead of two).
- [ ] **8.3** Burst test: 100 concurrent customer creates. Verify the post-refactor doesn't starve the connection pool. The current architecture's serial-drain audit-writer can fall behind under burst; the new architecture's audit insert is part of the mutation transaction, so there's no separate queue to back up.
- [ ] **8.4** If either result is worse than expected, investigate before merging.

**Verification:** Performance numbers documented in the commit message. No regression vs. baseline.

---

## Task 9: Final cleanup + commit

**Goal:** One clean commit with the whole refactor.

**Steps:**
- [ ] **9.1** Final type-check: `pnpm --filter @utility-cis/api exec tsc --noEmit` and `pnpm --filter @utility-cis/shared build` — both clean.
- [ ] **9.2** Final test run: full unit + integration suite passes.
- [ ] **9.3** Review the diff: `git diff --stat`. Should show ~17 services modified (each ~5-10 lines), `lib/audit-wrap.ts` rewritten, two `events/*.ts` files deleted, one new integration test, one rewritten unit test, possibly `packages/shared` updates if `DomainEvent` was deletable.
- [ ] **9.4** Single commit with title `refactor(audit): replace EventEmitter pipeline with in-transaction audit writes`. Body documents the architectural-discipline rationale (per the spec §1.2), the migration shape, and the behavior-parity verification results.
- [ ] **9.5** Push.

**Verification:** PR reviewer can read the commit message, understand the rationale, and trust that no behavior changed except (a) atomicity is now guaranteed and (b) `audit_log.metadata.eventType` is now populated.

---

## Notes for the executing agent

1. **Don't refactor anything else "while you're in there."** Per CLAUDE.md architectural-discipline guidance: bug fix scope = only the bug. If you spot another smell during the migration, file it for later and stay focused.

2. **The TypeScript compiler is your friend.** Once Task 1 lands, every callsite that's still using the old `() => prisma.foo.create(...)` signature won't compile. Use the compiler errors as your worklist. Don't try to find and fix everything by grep in advance.

3. **Prisma's `TransactionClient` lacks `$transaction`.** If a service was doing `prisma.$transaction` AND wanted to call `auditCreate` inside it AND that service had nested transactions for some other reason, this won't compile (Prisma rightly disallows nested interactive transactions). I haven't seen any such case in the existing services, but watch for it.

4. **The `set_config('app.current_utility_id', ..., true)` inside the transaction is intentional.** The third argument `true` means transactional — the SET applies only inside the transaction and is automatically reset on commit/rollback. This avoids the connection-pool leak that the non-transactional `setTenantContext()` (third arg `false`) is designed to handle differently.

5. **Worker code paths that already use `tx.auditLog.createMany` directly stay as-is.** Don't try to "consolidate" them through `auditCreate` — they're a different shape (bulk audit writes from a sweep). The atomicity goal is already met for them.

6. **Effort estimate is honest.** The 17-service fan-out is mechanical but tedious. Take it slow on the multi-step services (service-request, service-suspension) where outer `$transaction` calls already exist; those are where you'll need to use `existingTx` correctly.
