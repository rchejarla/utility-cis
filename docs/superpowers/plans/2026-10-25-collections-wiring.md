# Collections Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the delinquency process produce something — a late fee in the ledger and a work order for the field — instead of terminating in a notice and a row.

**Architecture:** Delinquency already decides correctly. It reads `Account.balance` and `Account.lastDueDate`, which `recomputeAccountCache` maintains from `ledger_entry`, and it runs hourly via `delinquency-dispatch` → `delinquency-tenant`. What it writes is a `DelinquencyAction` and a notification, and nothing else: grep for `ledgerEntry` in `delinquency.service.ts` returns 0. This plan connects the decision to the two modules that already know how to act on it. The fee is raised **inside** the action's transaction, because a duplicate fee is a wrong bill. The work order is created by a **state-driven sweep**, because a work order that is merely late is recoverable and `createServiceRequest` cannot join another transaction.

**Tech Stack:** Fastify, Prisma 7 over a `pg` driver adapter, PostgreSQL 16, BullMQ, Zod, Vitest with testcontainers.

**Spec:** `docs/specs/11-delinquency.md` and `docs/specs/23-accounts-receivable.md`. Requirements: `docs/bozeman/17-implementation-gap-analysis.md` — #145, #198, #199.

## Global Constraints

- **Every write runs inside a tenant scope.** The application connects as `cis_app`, which RLS applies to; an unscoped read of a tenant table raises 22P02, it does not return zero rows. Worker paths get their scope from `scopedJob` via `QUEUE_TENANCY`; `delinquency-tenant` is `per-tenant`, so a job with no `utilityId` is refused rather than widened.
- **Every foreign key between two tenant-scoped tables is composite** — `(utility_id, <fk>) -> parent (utility_id, id)`. A fixture that builds a cross-tenant row will be refused by the database, which is the point.
- **Never run `prisma migrate dev`.** Write migrations by hand. `schema.prisma` cannot express 35 CHECKs, 62 RLS policies, the composite keys or partial indexes, and `migrate dev` generates a migration reverting all of it.
- **New tenant tables need RLS enabled, FORCEd, and a policy**, or `assertRlsEnforced` refuses to start in production and `schema-invariants.integration.test.ts` fails. This plan adds no tables, only columns and indexes.
- **Tests must not enqueue into the dev Redis.** A suite exercising a path that enqueues mocks `enqueueSafely`.
- **Money is `Decimal(10,2)`** on these tables and arithmetic goes through `Prisma.Decimal`, never JS numbers.
- `assessFee`'s reason must be a `FEE` reason — `resolveReason(tx, utilityId, reasonId, "FEE")` is the gate every writing service goes through, and it refuses the wrong `appliesToType`.

## Review Focus

The five things most likely to bite a person using this, that no task's happy path covers. Each has a test in the task that owns the code.

1. **Two workers evaluate the same account in the same hour and raise the fee twice.** The cadence is `0 * * * *` with retries behind it, and today the only guard is an in-memory `Set` built before the loop. A duplicate fee is a wrong bill, not a duplicate email. → Task 1.
2. **A rule configured with a fee amount but no reason, or a reason of the wrong type.** The fee would either be raised without a reason the operator can explain, or refused at `resolveReason` *after* the notice went out. → Task 1.
3. **The fee is raised and the notice fails to send**, or the reverse. Either leaves an account charged with nobody told, or told with nothing charged. → Task 1.
4. **An account clears its balance the same hour its shut-off action is created.** The reconnect sweep and the work-order sweep must not both act, and the customer must not be shut off for a debt they have paid. → Task 3.
5. **A shut-off action whose work order was created and then cancelled by an operator.** The sweep must not recreate it forever. → Task 2.

---

### Task 1: Delinquency raises the late fee (#145)

**Files:**
- Modify: `packages/shared/prisma/schema.prisma` — `DelinquencyRule.feeAmount`, `DelinquencyRule.feeReasonId`
- Create: `packages/shared/prisma/migrations/20261026090000_delinquency_fee/migration.sql`
- Modify: `packages/api/src/services/delinquency.service.ts:95-112` (the action-creation block)
- Modify: `packages/shared/src/validators/delinquency.ts` — the rule schemas
- Test: `packages/api/src/__tests__/integration/delinquency-fee.integration.test.ts`

**Interfaces:**
- Consumes: `assessFee(utilityId, actorId, actorName, accountId, input, existingTx?)` from `services/ar/fee.service.js` — **already takes a transaction**, so nothing in the fee service changes. `AssessFeeInput` is `{ amount, reasonId, assessedOnId?, memo? }`.
- Produces: `DelinquencyRule.feeAmount: Decimal?` and `DelinquencyRule.feeReasonId: String?`; a `delinquency_action` row and its `ledger_entry` committed together.

**The decision this task makes, and why.** The simpler version is `create the action, then call assessFee` — two statements, no transaction. Its concrete cost: the hourly cadence and BullMQ's retries give many chances for a crash between them, and the two failure shapes are a fee nobody can explain (no action) and a shut-off notice with no charge (no fee). The in-memory `Set` cannot prevent either, because it is computed before the loop and two workers compute it separately. So the fee joins the action's transaction, and uniqueness moves to the database — a partial unique index, which is the only guard that holds across two processes. The `Set` stays as an optimisation that avoids work, not as the thing preventing duplicates. This is the same argument `audit-wrap` makes for audit rows, with money in place of history.

- [ ] **Step 1: Write the failing test** — `delinquency-fee.integration.test.ts`:

```ts
it("raises the configured fee into the ledger when the rule fires", async () => {
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeAmount: "25.00" });
  await pastDueAccount({ balance: "100.00", daysPastDue: 15 });

  await runAsTenant(TENANT_A, async () => evaluateAll(TENANT_A));

  const fees = await seedAsPlatform(async () =>
    prisma.ledgerEntry.findMany({ where: { utilityId: TENANT_A, type: "FEE" } }),
  );
  expect(fees).toHaveLength(1);
  expect(fees[0].amount.toString()).toBe("25.00");
  expect(fees[0].openAmount.toString()).toBe("25.00");
});

it("raises it once when the same rule is evaluated twice", async () => {
  // Review Focus 1. The second pass is what an hourly cron and a retry
  // both look like.
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeAmount: "25.00" });
  await pastDueAccount({ balance: "100.00", daysPastDue: 15 });

  await runAsTenant(TENANT_A, async () => evaluateAll(TENANT_A));
  await runAsTenant(TENANT_A, async () => evaluateAll(TENANT_A));

  const fees = await seedAsPlatform(async () =>
    prisma.ledgerEntry.count({ where: { utilityId: TENANT_A, type: "FEE" } }),
  );
  expect(fees).toBe(1);
});

it("raises no fee for a rule that configures none", async () => {
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeAmount: null });
  await pastDueAccount({ balance: "100.00", daysPastDue: 15 });

  await runAsTenant(TENANT_A, async () => evaluateAll(TENANT_A));

  const actions = await seedAsPlatform(async () =>
    prisma.delinquencyAction.count({ where: { utilityId: TENANT_A } }),
  );
  const fees = await seedAsPlatform(async () =>
    prisma.ledgerEntry.count({ where: { utilityId: TENANT_A, type: "FEE" } }),
  );
  expect(actions).toBe(1);
  expect(fees).toBe(0);
});

it("writes neither the action nor the fee when the reason is the wrong type", async () => {
  // Review Focus 2 and 3. A WRITE_OFF reason on a fee is refused by
  // `resolveReason`, and the action must not survive that refusal.
  const writeOffReason = await reasonOfType("ADJUSTMENT_DEBIT");
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeAmount: "25.00", feeReasonId: writeOffReason });
  await pastDueAccount({ balance: "100.00", daysPastDue: 15 });

  await expect(
    runAsTenant(TENANT_A, async () => evaluateAll(TENANT_A)),
  ).rejects.toThrow();

  expect(await countOf("delinquencyAction")).toBe(0);
  expect(await countOf("ledgerEntry", { type: "FEE" })).toBe(0);
});
```

- [ ] **Step 2: Run it** — `pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/delinquency-fee.integration.test.ts`
  Expected: FAIL. The first case fails on `feeAmount` not existing in the rule model; after Step 3's schema change it fails with 0 ledger entries.

- [ ] **Step 3: Add the columns and the index.** In `schema.prisma`, `DelinquencyRule` gains `feeAmount Decimal? @map("fee_amount") @db.Decimal(10, 2)` and `feeReasonId String? @map("fee_reason_id") @db.Uuid`, with a relation to `LedgerReasonDef` (`onDelete: Restrict` — a reason cited by a rule is in use). Hand-write `20261026090000_delinquency_fee/migration.sql`:

```sql
ALTER TABLE delinquency_rule
  ADD COLUMN fee_amount NUMERIC(10,2),
  ADD COLUMN fee_reason_id UUID;

-- Composite, like every key between two tenant-scoped tables: a rule in
-- one tenant must not cite another tenant's reason.
ALTER TABLE delinquency_rule
  ADD CONSTRAINT delinquency_rule_fee_reason_fkey
  FOREIGN KEY (utility_id, fee_reason_id)
  REFERENCES ledger_reason_def (utility_id, id) ON DELETE RESTRICT;

-- A fee amount without a reason is a charge nobody can explain, and a
-- reason without an amount is configuration that does nothing. Refused
-- at the table so a rules UI cannot save half of it.
ALTER TABLE delinquency_rule
  ADD CONSTRAINT delinquency_rule_fee_complete
  CHECK ((fee_amount IS NULL) = (fee_reason_id IS NULL));

ALTER TABLE delinquency_rule
  ADD CONSTRAINT delinquency_rule_fee_amount_positive
  CHECK (fee_amount IS NULL OR fee_amount > 0);

-- The guard that holds across two processes, which the in-memory Set in
-- `evaluateAll` cannot: one live action per account per rule. Partial,
-- because a RESOLVED or CANCELLED action is history and must not block
-- the account re-entering the tier later.
CREATE UNIQUE INDEX delinquency_action_one_live_per_rule
  ON delinquency_action (utility_id, account_id, rule_id)
  WHERE status IN ('PENDING', 'COMPLETED');
```

- [ ] **Step 4: Raise the fee inside the action's transaction** in `delinquency.service.ts`. Wrap the per-account, per-rule branch in `prisma.$transaction`, create the `DelinquencyAction` with `tx`, and when `rule.feeAmount` is set call `assessFee(utilityId, SYSTEM_ACTOR_ID, "Delinquency", account.id, { amount, reasonId, memo }, tx)`. Catch the unique-violation (`P2002` on `delinquency_action_one_live_per_rule`) and treat it as "another worker got there first" — skip, do not fail the sweep. The notification send stays **outside** the transaction and after it, because an external dispatch inside a transaction holds a database lock for the duration of someone else's network call; a notice that fails to send leaves `status` PENDING, which is what that column is for.

- [ ] **Step 5: Run the tests** — same command. Expected: PASS, 4/4.

- [ ] **Step 6: Run the suites this touches** — `delinquency-aging`, `worker-delinquency`, `ledger-fee`, `schema-invariants`. Expected: all pass. `schema-invariants` matters because the new foreign key must be composite and the new column must not widen the nullable-`utility_id` set.

- [ ] **Step 7: Commit** — `feat(delinquency): a tier that charges a fee charges it once`

---

### Task 2: The work-order sweep (#198)

**Files:**
- Create: `packages/api/src/services/delinquency-work-order.service.ts`
- Modify: `packages/shared/prisma/schema.prisma` — `DelinquencyRule.serviceRequestTypeCode`
- Modify: the Task 1 migration (same file, one migration for both column sets)
- Modify: `packages/api/src/workers/delinquency-worker.ts` — call the sweep after `evaluateAll`
- Test: `packages/api/src/__tests__/integration/delinquency-work-order.integration.test.ts`

**Interfaces:**
- Consumes: `createServiceRequest(utilityId, actorId, actorName, data)` from `services/service-request.service.js`. `CreateServiceRequestInput` carries `requestType`, `priority`, `description` and the optional `accountId`, `premiseId`, `serviceAgreementId`, `requestSubtype` — and **not** `delinquencyActionId`, which this task has to add.
- Produces: `delinquencyActionId` on `createServiceRequestSchema`. The column and the relation already exist on `ServiceRequest`; only the create input is missing it, and the schema is `.strict()`, so passing it today is a validation error rather than a silently dropped field.
- Produces: `sweepDelinquencyWorkOrders(utilityId: string, now?: Date): Promise<{ created: number }>`.

**Why a sweep and not a call inside Task 1's transaction.** `createServiceRequest` cannot join one: it calls `nextRequestNumber`, which opens `prisma.$transaction` of its own for the counter row, and a second interactive transaction inside the first takes a second pooled connection while the first holds the account lock — under an hourly fan-out across tenants that is how a pool runs dry. Threading `existingTx` through the counter would work and is the other real option; it was rejected because the thing it buys is atomicity, and a *late* work order costs nothing while a *duplicate* fee costs money. The asymmetry is the whole argument: Task 1 must be atomic, this must only be eventually correct.

A sweep also has to exist anyway for Task 3, which has no event to hang off at all. One mechanism serving both is cheaper than an inline call plus a reconciliation sweep that does the same thing.

Keyed on state, not on an event: "which live shut-off actions have no service request?" That makes it idempotent by construction and recoverable from any failure, including the service request module being down.

- [ ] **Step 1: Write the failing test**:

```ts
it("creates one work order for a shut-off action that has none", async () => {
  const action = await shutOffAction({ rule: { serviceRequestTypeCode: "DISCONNECT" } });

  const { created } = await runAsTenant(TENANT_A, async () =>
    sweepDelinquencyWorkOrders(TENANT_A),
  );

  expect(created).toBe(1);
  const srs = await seedAsPlatform(async () =>
    prisma.serviceRequest.findMany({ where: { delinquencyActionId: action.id } }),
  );
  expect(srs).toHaveLength(1);
  expect(srs[0].requestType).toBe("DISCONNECT");
});

it("creates nothing on a second pass", async () => {
  await shutOffAction({ rule: { serviceRequestTypeCode: "DISCONNECT" } });
  await runAsTenant(TENANT_A, async () => sweepDelinquencyWorkOrders(TENANT_A));
  const { created } = await runAsTenant(TENANT_A, async () =>
    sweepDelinquencyWorkOrders(TENANT_A),
  );
  expect(created).toBe(0);
});

it("does not recreate a work order an operator cancelled", async () => {
  // Review Focus 5. "Has no service request" would recreate it forever;
  // the sweep asks whether one was ever created, not whether one is open.
  const action = await shutOffAction({ rule: { serviceRequestTypeCode: "DISCONNECT" } });
  await runAsTenant(TENANT_A, async () => sweepDelinquencyWorkOrders(TENANT_A));
  await cancelServiceRequestsFor(action.id);

  const { created } = await runAsTenant(TENANT_A, async () =>
    sweepDelinquencyWorkOrders(TENANT_A),
  );
  expect(created).toBe(0);
});

it("ignores a tier that configures no work order", async () => {
  await shutOffAction({ rule: { serviceRequestTypeCode: null } });
  const { created } = await runAsTenant(TENANT_A, async () =>
    sweepDelinquencyWorkOrders(TENANT_A),
  );
  expect(created).toBe(0);
});

it("does not reach another tenant's actions", async () => {
  await shutOffAction({ tenant: TENANT_B, rule: { serviceRequestTypeCode: "DISCONNECT" } });
  const { created } = await runAsTenant(TENANT_A, async () =>
    sweepDelinquencyWorkOrders(TENANT_A),
  );
  expect(created).toBe(0);
});
```

- [ ] **Step 2: Run it** — Expected: FAIL, `sweepDelinquencyWorkOrders` not defined.

- [ ] **Step 3: Widen `createServiceRequestSchema`** with `delinquencyActionId: z.string().uuid().optional().nullable()`, and pass it through in `createServiceRequest`'s create call. The schema is `.strict()`, so without this the sweep's create is refused by Zod — not ignored. Nothing else changes: `ServiceRequest.delinquencyActionId` and the `DelinquencyAction.serviceRequests` back-relation have existed since the delinquency module shipped, unused.

- [ ] **Step 4: Add `serviceRequestTypeCode`** to `DelinquencyRule` (`String? @map("service_request_type_code") @db.VarChar(100)`) in the Task 1 migration, validated against `service_request_type_def` by `assertServiceRequestTypeCode` at rule-save time rather than by a foreign key — the type defs allow global rows with a null `utility_id`, which a composite key cannot reference.

- [ ] **Step 5: Implement `sweepDelinquencyWorkOrders`** in the new service. One query for live actions (`status IN (PENDING, COMPLETED)`) whose rule carries a `serviceRequestTypeCode` and which have no `serviceRequests` rows at all, then `createServiceRequest` per action with `delinquencyActionId` set and `priority` from the rule's tier. Count what it created. A failure on one action is logged and skipped, not thrown — one unroutable account must not stop the rest.

- [ ] **Step 6: Run the tests** — Expected: PASS, 5/5.

- [ ] **Step 7: Call it from the worker** after `evaluateAll` in `delinquency-worker.ts`, inside the same `scopedJob` tenant scope.

- [ ] **Step 8: Run `worker-delinquency` and `service-request-lifecycle`** — Expected: pass.

- [ ] **Step 9: Commit** — `feat(delinquency): a shut-off tier dispatches the field work`

---

### Task 3: The reconnection sweep (#199)

**Files:**
- Modify: `packages/api/src/services/delinquency-work-order.service.ts`
- Test: `packages/api/src/__tests__/integration/delinquency-work-order.integration.test.ts`

**Interfaces:**
- Produces: `sweepReconnections(utilityId: string): Promise<{ created: number; resolved: number }>`.

**Why this is a sweep and not a hook in payment posting.** #199 has no trigger today, and the candidate event is "a payment brought the balance to zero". Hanging it off `recordPayment` would put collections logic in the money path, so taking a payment could fail because the service request module refused — exactly backwards. State again: "which accounts have a live shut-off action and nothing owing?"

- [ ] **Step 1: Write the failing test**:

```ts
it("asks for a reconnection and resolves the action when the balance clears", async () => {
  const action = await shutOffAction({ rule: { serviceRequestTypeCode: "DISCONNECT" } });
  await payOff(action.accountId);

  const { created, resolved } = await runAsTenant(TENANT_A, async () =>
    sweepReconnections(TENANT_A),
  );

  expect({ created, resolved }).toEqual({ created: 1, resolved: 1 });
  const srs = await seedAsPlatform(async () =>
    prisma.serviceRequest.findMany({
      where: { delinquencyActionId: action.id, requestType: "RECONNECT" },
    }),
  );
  expect(srs).toHaveLength(1);
  const after = await seedAsPlatform(async () =>
    prisma.delinquencyAction.findUniqueOrThrow({ where: { id: action.id } }),
  );
  expect(after.status).toBe("RESOLVED");
  expect(after.resolutionType).toBe("PAID");
});

it("leaves an account that still owes alone", async () => {
  await shutOffAction({ balance: "80.00", rule: { serviceRequestTypeCode: "DISCONNECT" } });
  const { created } = await runAsTenant(TENANT_A, async () => sweepReconnections(TENANT_A));
  expect(created).toBe(0);
});

it("does not shut off and reconnect in the same hour", async () => {
  // Review Focus 4. An account that cleared before the work order was
  // ever created should get neither: the action resolves, and no
  // disconnect is dispatched for a debt that is paid.
  const action = await shutOffAction({ rule: { serviceRequestTypeCode: "DISCONNECT" } });
  await payOff(action.accountId);

  await runAsTenant(TENANT_A, async () => sweepReconnections(TENANT_A));
  const { created } = await runAsTenant(TENANT_A, async () =>
    sweepDelinquencyWorkOrders(TENANT_A),
  );

  expect(created).toBe(0);
  const types = await seedAsPlatform(async () =>
    prisma.serviceRequest.findMany({
      where: { delinquencyActionId: action.id },
      select: { requestType: true },
    }),
  );
  expect(types.map((t) => t.requestType)).toEqual(["RECONNECT"]);
});
```

- [ ] **Step 2: Run it** — Expected: FAIL, `sweepReconnections` not defined.

- [ ] **Step 3: Implement it.** Live shut-off actions whose account has `balance <= 0`; per account, create a `RECONNECT` service request and set the action `RESOLVED` with `resolutionType: "PAID"` and `resolvedAt`, in one transaction per account so an action never reads resolved without its request existing. Resolving the action is also what makes Review Focus 4 fall out: Task 2's sweep only looks at live actions, so a resolved one is no longer a disconnect candidate. **Order matters in the worker** — reconnections before work orders, so a paid account is resolved before anything dispatches against it.

- [ ] **Step 4: Run the tests** — Expected: PASS, 8/8 for the file.

- [ ] **Step 5: Call it from the worker** before `sweepDelinquencyWorkOrders`.

- [ ] **Step 6: Run `worker-delinquency`, `delinquency-aging`, `ledger-payment`** — Expected: pass.

- [ ] **Step 7: Commit** — `feat(delinquency): a paid account asks to be turned back on`

---

### Task 4: Say what it does now

**Files:**
- Modify: `docs/specs/11-delinquency.md` — the fee and work-order behaviour, the hourly cadence, and what the partial unique index guarantees
- Modify: `docs/specs/23-accounts-receivable.md` — `FEE` entries now have a second writer, which matters to anyone reading the ledger
- Modify: `docs/bozeman/17-implementation-gap-analysis.md` — #145, #198, #199 move out of absent

- [ ] **Step 1: Record the three decisions**, each with the alternative rejected: the fee inside the action's transaction (against two statements), the work order in a sweep (against threading `existingTx` through the request counter), and the reconnection in a sweep (against a hook in payment posting).
- [ ] **Step 2: Correct the gap doc.** It currently reads `delinquency.service.ts creates no service requests` for #198/199 and lists #145 as absent. Say what closed them and on what date, the way §7.1 records the RLS work.
- [ ] **Step 3: Commit** — `docs: delinquency now charges and dispatches`

---

## Self-review

**Spec coverage.** #145 is Task 1, #198 Task 2, #199 Task 3. Spec 11's notice tiers, rule configuration and aging are untouched and already built. Nothing here addresses #147/148 (payment plans) or #149/150 (aging dashboard) — they are separate work and deliberately out of scope; this plan is only the wiring that makes a payment plan worth offering.

**Step scan.** Each code step names the signature and the file. Two carry SQL because the constraints are the decision, not an implementation detail — the partial index's `WHERE` clause and the paired-nullability CHECK are what the tasks are *for*, and a reader who writes them differently has built something else.

**Type consistency.** `sweepDelinquencyWorkOrders(utilityId, now?)` and `sweepReconnections(utilityId)` are named identically in Tasks 2, 3 and their worker steps. `assessFee`'s sixth parameter is `existingTx`, matching `fee.service.ts` as it stands — no signature change anywhere in the AR services.

This check caught one error, which is what it is for: the first draft of Task 2 said `CreateServiceRequestInput` already carried `delinquencyActionId`. It does not. The column and the back-relation exist on the model and have since the module shipped, but the create schema is `.strict()`, so the sweep's call would have been refused by Zod rather than quietly dropping the link — a failure the executor would have hit at Step 6 with no idea it was expected. Task 2 now widens the schema first, as its own step.

**Review Focus.** All five have a test in the owning task: 1 and 2 and 3 in Task 1, 5 in Task 2, 4 in Task 3.

**Proportion.** Longer than the diff will be, and the length is in three decisions and four constraints, not in transcribed bodies. The one place I have written more than the signature — the migration — is where the behaviour lives.

**A caveat the executor should know.** `SYSTEM_ACTOR_ID` in Task 1 Step 4 does not exist yet. Delinquency's actions record `triggeredBy: "AUTOMATED"` with a null `triggeredByUserId`, but `assessFee` requires an `actorId` and writes it to the audit row. Decide it in Task 1: either a reserved uuid seeded as a `cis_user`, or widen `assessFee`'s actor to accept a system sentinel. The first is less invasive and matches how `audit_log.source` already distinguishes `scheduler:*` from `user:*`.
