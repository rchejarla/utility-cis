# Collections Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: executed 2026-10-25**, natively, task by task. Every box below is
ticked. The rulings taken during execution — nineteen of them, including
three that changed what a task built — are in the commit messages and were
reported at handoff; the specs named in Task 9 carry the decisions.

**Goal:** Make the delinquency ladder charge what it is owed, dispatch the field work it implies, and show the customer the charge on their next bill.

**Architecture:** Delinquency already decides correctly — it reads `Account.balance` and `Account.lastDueDate`, which `recomputeAccountCache` maintains from `ledger_entry`, and `applicableRules` already selects *every* tier an account has passed, so escalation at 15/30/45 days is existing behaviour. What it writes is a `DelinquencyAction` and a notification and nothing financial: grep `ledgerEntry` in `delinquency.service.ts` returns 0. This plan connects that decision to the ledger, to the service request module, and to the bill. The fee commits inside the action's transaction because a duplicate fee is a wrong bill; the work orders are state-driven sweeps because a late work order costs nothing.

**Tech Stack:** Fastify, Prisma 7 over a `pg` driver adapter, PostgreSQL 16, BullMQ, Zod, Vitest with testcontainers.

**Spec:** `docs/specs/11-delinquency.md`, `docs/specs/10-payments-and-collections.md`, `docs/specs/23-accounts-receivable.md`. Requirements: `docs/bozeman/17-implementation-gap-analysis.md` — #145, #198, #199.

## Global Constraints

- **Every write runs inside a tenant scope.** The app connects as `cis_app`, which RLS applies to; an unscoped read of a tenant table raises 22P02 rather than returning zero rows. Worker paths get their scope from `scopedJob` via `QUEUE_TENANCY`; `delinquency-tenant` is `per-tenant`, so a job with no `utilityId` is refused.
- **Every foreign key between two tenant-scoped tables is composite** — `(utility_id, <fk>) -> parent (utility_id, id)`. A fixture that builds a cross-tenant row is refused by the database.
- **Never run `prisma migrate dev`**, and never edit an applied migration — Prisma checksums them and refuses a modified one. Each task that changes the schema gets its own migration file.
- **Tests must not enqueue into the dev Redis.** `evaluateAll` sends notices, which enqueue; every suite here mocks `enqueueSafely`.
- **Money is `Decimal`** and arithmetic goes through `Prisma.Decimal`, never JS numbers. Fee *rates* are `DECIMAL(10,4)` because `0.015` is 1.5%; fee *amounts* are `DECIMAL(10,2)`.
- **No business logic keys on a reason code.** Reasons are tenant-configurable, so a hardcoded `LATE_FEE` or `NSF_FEE` would miss a tenant that names its own. Which reason a tier uses is **configuration on the tier** (`DelinquencyRule.feeReasonId`). Where behaviour depends on a reason's *nature* it reads a column (`LedgerReasonDef.isPenalty`). Where it depends on *which fee the ladder raised* it reads the link from `DelinquencyAction.feeEntryId`. Three mechanisms, no string matching.

## Review Focus

Five things no happy path covers, each with a test in the task that owns it.

1. **Two workers evaluate the same account in the same hour and raise the fee twice.** The cadence is `0 * * * *` with BullMQ retries behind it, and today's only guard is an in-memory `Set` built before the loop — two workers build it separately. A duplicate notice is embarrassing; a duplicate fee is a wrong bill. → Task 1.
2. **A newly configured tier reaches backwards.** `DelinquencyRule.effectiveDate` exists and the matching filter ignores it, so adding a tier today fires it against every historically past-due account — today that sends notices, and after Task 3 it would charge them. → Task 1.
3. **A tier is saved citing a reason that is not a fee reason.** `resolveReason` refuses it, but at *sweep* time — so the error lands on a worker at 03:00 after other accounts in the tenant have already been noticed, rather than on the operator who typed it. → Task 3.
4. **A percentage fee compounds on a penalty.** 1.5% of a balance that already contains tier 1's fee charges a penalty on a penalty, while excluding *all* fees would stop a late fee applying to an unpaid tap fee, which is real money for real work. → Task 4.
5. **A replacement reverses the wrong fee.** A bounced-payment fee and an operator's manual late fee must both survive a tier that replaces lower tiers. → Task 5.

---

### Task 1: The ladder stops double-charging and stops reaching backwards

Independent of fees and worth shipping alone: both defects are live today, and after Task 3 each becomes a money defect.

**Files:**
- Create: `packages/shared/prisma/migrations/20261026090000_delinquency_guards/migration.sql`
- Modify: `packages/api/src/services/delinquency.service.ts:61-68` (the `applicableRules` filter)
- Test: `packages/api/src/__tests__/integration/delinquency-guards.integration.test.ts`

**Interfaces:**
- Produces: a partial unique index `delinquency_action_one_live_per_rule` on `delinquency_action (utility_id, account_id, rule_id) WHERE status IN ('PENDING','COMPLETED')`; `applicableRules` additionally requires `rule.effectiveDate <= account.lastDueDate`.

**The decision.** The simpler version keeps the in-memory `Set`. Its concrete cost: it cannot see another process. Two `delinquency-tenant` jobs for the same tenant, or one job retried after a partial failure, each build the `Set` before the loop and neither sees the other's writes. A database constraint is the only guard that spans processes. The `Set` stays — it avoids work — but it is no longer what prevents duplicates. The index is **partial** because a RESOLVED or CANCELLED action is history and must not stop the account re-entering the tier later.

`effectiveDate` gates against `lastDueDate`, not against today: the question is whether the rule was in force when the debt became due.

- [x] **Step 1: Write the failing test** — `delinquency-guards.integration.test.ts`:

```ts
it("creates one action per rule however many times it is evaluated", async () => {
  await rule({ tier: 1, daysPastDue: 10 });
  await pastDue({ balance: "100.00", days: 15 });
  await evaluateAll(TENANT_A);
  await evaluateAll(TENANT_A);
  expect(await countActions()).toBe(1);
});

it("refuses a second live action for the same account and rule", async () => {
  // Review Focus 1, at the level the Set cannot reach: a direct insert
  // is what a second worker's write looks like.
  const r = await rule({ tier: 1, daysPastDue: 10 });
  await pastDue({ balance: "100.00", days: 15 });
  await evaluateAll(TENANT_A);
  await expect(insertActionDirectly({ ruleId: r.id })).rejects.toThrow(/unique/i);
});

it("lets the account re-enter a tier once the action is resolved", async () => {
  const r = await rule({ tier: 1, daysPastDue: 10 });
  await pastDue({ balance: "100.00", days: 15 });
  await evaluateAll(TENANT_A);
  await resolveActions();
  await evaluateAll(TENANT_A);
  expect(await countActions()).toBe(2);
});

it("does not fire a tier configured after the debt came due", async () => {
  // Review Focus 2. Today this creates an action, which is the bug.
  await pastDue({ balance: "100.00", days: 30 });
  await rule({ tier: 1, daysPastDue: 10, effectiveDate: daysAgo(5) });
  await evaluateAll(TENANT_A);
  expect(await countActions()).toBe(0);
});

it("fires a tier that was in force when the debt came due", async () => {
  await pastDue({ balance: "100.00", days: 30 });
  await rule({ tier: 1, daysPastDue: 10, effectiveDate: daysAgo(60) });
  await evaluateAll(TENANT_A);
  expect(await countActions()).toBe(1);
});

it("still charges every tier the account has passed", async () => {
  // The escalation ladder is existing behaviour and must not regress:
  // 50 days past due with tiers at 15/30/45 is three actions.
  await rule({ tier: 1, daysPastDue: 15, effectiveDate: daysAgo(90) });
  await rule({ tier: 2, daysPastDue: 30, effectiveDate: daysAgo(90) });
  await rule({ tier: 3, daysPastDue: 45, effectiveDate: daysAgo(90) });
  await pastDue({ balance: "100.00", days: 50 });
  await evaluateAll(TENANT_A);
  expect(await countActions()).toBe(3);
});
```

- [x] **Step 2: Run it** — `pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/delinquency-guards.integration.test.ts`. Expected: FAIL — the direct-insert case with no unique violation, and both `effectiveDate` cases.
- [x] **Step 3: Write the migration** — the partial unique index above, nothing else.
- [x] **Step 4: Add the `effectiveDate` predicate** to `applicableRules`, and catch Prisma `P2002` on the new index around the action insert, treating it as "another worker got there first" — skip the account, do not fail the sweep.
- [x] **Step 5: Run it** — Expected: PASS, 6/6.
- [x] **Step 6: Run `worker-delinquency` and `delinquency-aging`** — Expected: pass. These exercise the matching filter, so a wrong predicate shows up here.
- [x] **Step 7: Commit** — `fix(delinquency): one action per tier, and no tier reaches backwards`

---

### Task 2: A reason knows whether it is a penalty

**Files:**
- Modify: `packages/shared/prisma/schema.prisma` — `LedgerReasonDef.isPenalty`
- Create: `packages/shared/prisma/migrations/20261026091000_reason_is_penalty/migration.sql`
- Modify: `packages/shared/src/validators/ledger.ts` — `DEFAULT_REASON_CODES` and the reason schemas
- Modify: `packages/api/src/services/ar/reason.service.ts` — seed the flag
- Test: `packages/api/src/__tests__/integration/ledger-reason.integration.test.ts` (extend)

**Interfaces:**
- Produces: `LedgerReasonDef.isPenalty Boolean @default(false)`; `DEFAULT_REASON_CODES` entries gain `isPenalty`, true for `LATE_FEE` and `NSF_FEE` only.

**The decision.** Task 4 needs to know which outstanding money is *principal*. It cannot ask the entry's `type` — all five seeded fee reasons are `FEE` — and it must not ask the code, because reasons are tenant-configurable and a tenant's own "Late charge" would be missed. So the nature of the reason becomes a property of the reason, set by whoever defines it. Default `false`, so existing custom reasons keep counting as principal until someone says otherwise: that direction over-charges nobody.

- [x] **Step 1: Write the failing test** — `seedDefaultReasons` marks `LATE_FEE` and `NSF_FEE` as penalties and `TAP_FEE`, `METER_TEST_FEE`, `RECONNECT_FEE` as not; a tenant-created reason defaults to `false` and can be set `true` through the API; and **a re-run against a tenant that already has the rows sets the flag**.
- [x] **Step 2: Run it** — Expected: FAIL, `isPenalty` not a known field.
- [x] **Step 3: Add the column and migration**, then the flag in `DEFAULT_REASON_CODES` and the create/update schemas. The seeder currently skips codes it already has (`if (existing.has(def.code)) continue;`) — that line must update the flag instead of skipping, or it never lands on an existing tenant, which is every tenant.
- [x] **Step 4: Run it** — Expected: PASS.
- [x] **Step 5: Run `ledger-reason`, `provisioning`, `dev-seed`** — Expected: pass. `provisioning` seeds reasons for a new tenant, `dev-seed` runs the whole seed.
- [x] **Step 6: Commit** — `feat(ar): a reason says whether it is a penalty`

---

### Task 3: A tier charges a flat fee, citing the reason it was configured with

**Files:**
- Modify: `packages/shared/prisma/schema.prisma` — `DelinquencyRule` fee columns, `DelinquencyAction.feeEntryId`
- Create: `packages/shared/prisma/migrations/20261026092000_delinquency_fee/migration.sql`
- Modify: `packages/shared/src/validators/delinquency.ts` — `createDelinquencyRuleSchema` / `updateDelinquencyRuleSchema`
- Modify: `packages/api/src/routes/delinquency.ts` — validate the reason at save time
- Modify: `packages/api/src/services/delinquency.service.ts` — the action-creation block
- Modify: `packages/api/src/services/provisioning.service.ts` — the system actor
- Test: `packages/api/src/__tests__/integration/delinquency-fee.integration.test.ts`

**Interfaces:**
- Consumes: `assessFee(utilityId, actorId, actorName, accountId, input, existingTx?)` from `services/ar/fee.service.js`, where `AssessFeeInput` is `{ amount, reasonId, assessedOnId?, memo? }`. **No change to the fee service** — the transaction seam already exists.
- Produces: `DelinquencyRule.feeType DelinquencyFeeType?` (`FLAT_FEE | PERCENT_OF_BALANCE`), `feeAmount Decimal? @db.Decimal(10,4)`, `maxFee Decimal? @db.Decimal(10,2)`, `feeReasonId String?`; `DelinquencyAction.feeEntryId String?`; `SYSTEM_ACTOR_ID`.

**Three decisions.**

*Which reason the fee cites.* The delinquency logic does not know and must not: reasons are tenant-configurable, so there is no code it could hardcode. The **tier carries the reason** — `DelinquencyRule.feeReasonId`, a composite FK to `ledger_reason_def` so a tenant's rule cannot cite another tenant's reason — and the operator picks it when configuring the tier. The sweep reads `rule.feeReasonId` and passes it to `assessFee`, which puts it through `resolveReason(tx, utilityId, reasonId, "FEE")`.

*Where that is validated.* `resolveReason` is the backstop, not the gate. On its own it fails at **sweep** time: a tier saved citing an `ADJUSTMENT_DEBIT` reason throws at 03:00, inside a worker, possibly after other accounts in that tenant have already been noticed, and the operator who typed it learns nothing. So the rule's save path checks `appliesToType = 'FEE'` and `isActive` and returns a 400 naming the reason. Both layers stay: the save-time check is for the human, the sweep-time one is for the database's own integrity, since a reason can be deactivated after a rule cites it.

*Where the fee is configured at all.* Spec 10 plans a separate `PenaltyRule` with its own `days_past_due`, `min_balance` and `account_type`. Those are fields `DelinquencyRule` already has, and the escalation an operator wants — $10 at 15 days, 1.5% at 30, shut-off at 45 — is exactly the tier ladder that exists and is already kept distinct by `@@unique([utilityId, accountType, tier])`. A separate entity means one row per rung anyway, two ladders to maintain, and nothing keeping the thresholds in step. So the fee goes on the tier and **`PenaltyRule` comes out of spec 10** in Task 9. If fees ever need a cadence unrelated to notices, that is when it earns its place.

*Who the actor is.* `assessFee` requires an `actorId` and writes it to the audit row; delinquency records `triggeredBy: "AUTOMATED"` with a null `triggeredByUserId`. Seed a reserved `cis_user` per tenant rather than widening `assessFee`: `audit_log.source` already distinguishes `scheduler:*` from `user:*`, and a real row keeps every existing join from `audit_log.actor_id` working.

- [x] **Step 1: Write the failing test** — `delinquency-fee.integration.test.ts`:

```ts
it("raises the flat fee the tier configures, citing the tier's reason", async () => {
  const reasonId = await reasonOfType("FEE");
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeType: "FLAT_FEE", feeAmount: "25.00", feeReasonId: reasonId });
  await pastDue({ balance: "100.00", days: 15 });
  await evaluateAll(TENANT_A);
  const fees = await feeEntries();
  expect(fees).toHaveLength(1);
  expect(fees[0].amount.toString()).toBe("25");
  expect(fees[0].openAmount.toString()).toBe("25");
  expect(fees[0].reasonId).toBe(reasonId);
});

it("lets two tiers cite different reasons", async () => {
  // The reason is configuration, not a constant: a utility may book a
  // first-notice charge and a final-notice charge differently.
  const first = await reasonNamed("Late payment fee");
  const second = await reasonNamed("Final notice charge");
  await ruleWithFee({ tier: 1, daysPastDue: 15, feeType: "FLAT_FEE", feeAmount: "10.00", feeReasonId: first });
  await ruleWithFee({ tier: 2, daysPastDue: 30, feeType: "FLAT_FEE", feeAmount: "20.00", feeReasonId: second });
  await pastDue({ balance: "100.00", days: 35 });
  await evaluateAll(TENANT_A);
  expect((await feeEntries()).map((f) => f.reasonId).sort()).toEqual([first, second].sort());
});

it("links the fee to the action that raised it", async () => {
  // Task 5 depends on this link; nothing else does.
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeType: "FLAT_FEE", feeAmount: "25.00" });
  await pastDue({ balance: "100.00", days: 15 });
  await evaluateAll(TENANT_A);
  const [action] = await actions();
  const [fee] = await feeEntries();
  expect(action.feeEntryId).toBe(fee.id);
});

it("raises it once however many times the tier is evaluated", async () => {
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeType: "FLAT_FEE", feeAmount: "25.00" });
  await pastDue({ balance: "100.00", days: 15 });
  await evaluateAll(TENANT_A);
  await evaluateAll(TENANT_A);
  expect(await countFees()).toBe(1);
});

it("raises no fee for a tier that configures none", async () => {
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeType: null, feeAmount: null, feeReasonId: null });
  await pastDue({ balance: "100.00", days: 15 });
  await evaluateAll(TENANT_A);
  expect(await countActions()).toBe(1);
  expect(await countFees()).toBe(0);
});

it("refuses to save a tier citing a reason that is not a fee reason", async () => {
  // Review Focus 3. The error belongs to the operator who typed it, at
  // the moment they typed it — not to a worker at 03:00.
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/delinquency-rules",
    headers: staffHeaders(),
    payload: ruleBody({ feeType: "FLAT_FEE", feeAmount: "25.00", feeReasonId: await reasonOfType("ADJUSTMENT_DEBIT") }),
  });
  expect(res.statusCode).toBe(400);
  expect(JSON.parse(res.body).error.code).toBe("REASON_NOT_A_FEE");
});

it("writes neither the action nor the fee if the reason stopped being usable", async () => {
  // The backstop: a reason deactivated after the rule cited it. Better a
  // sweep that fails and can be re-run than an account marked
  // delinquent with no charge, or charged with nobody told.
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeType: "FLAT_FEE", feeAmount: "25.00" });
  await deactivateTheRulesReason();
  await pastDue({ balance: "100.00", days: 15 });
  await expect(evaluateAll(TENANT_A)).rejects.toThrow();
  expect(await countActions()).toBe(0);
  expect(await countFees()).toBe(0);
});
```

- [x] **Step 2: Run it** — Expected: FAIL, `feeType` not a known field.
- [x] **Step 3: Write the schema and migration.** `DelinquencyFeeType` enum; the four rule columns with a composite FK for `feeReasonId`; `DelinquencyAction.feeEntryId` with a composite FK to `ledger_entry` and `ON DELETE SET NULL (fee_entry_id)` — the column-list form, because the unqualified one nulls `utility_id` too. CHECKs: `feeType IS NULL` ⇔ `feeAmount IS NULL` ⇔ `feeReasonId IS NULL` (an amount with no reason is a charge nobody can explain; a reason with no amount is dead configuration), `feeAmount > 0`, and `maxFee IS NULL OR feeType = 'PERCENT_OF_BALANCE'` (a cap on a flat fee is meaningless).
- [x] **Step 4: Validate the reason at save time** in the rule routes — `appliesToType = 'FEE'` and `isActive`, 400 with code `REASON_NOT_A_FEE`.
- [x] **Step 5: Seed the system actor** in `provisionTenant`, exported as `SYSTEM_ACTOR_ID`.
- [x] **Step 6: Raise the fee in the action's transaction.** Wrap the per-account-per-rule branch in `prisma.$transaction`; create the action with `tx`; when `rule.feeType` is set call `assessFee(..., tx)` with `rule.feeReasonId` and set `feeEntryId` from its result. The **notification stays outside and after** the transaction: an external dispatch inside one holds a database lock across someone else's network call, and a notice that fails to send leaves `status` PENDING, which is what that column is for.
- [x] **Step 7: Run it** — Expected: PASS, 7/7.
- [x] **Step 8: Run `worker-delinquency`, `ledger-fee`, `provisioning`, `schema-invariants`** — Expected: pass. `schema-invariants` checks the new FKs are composite.
- [x] **Step 9: Commit** — `feat(delinquency): a tier charges a flat fee, once, citing its own reason`

---

### Task 4: A tier charges a percentage, capped, of what is actually owed

**Files:**
- Create: `packages/api/src/services/delinquency-fee-base.ts`
- Modify: `packages/api/src/services/delinquency.service.ts`
- Test: `packages/api/src/__tests__/integration/delinquency-fee.integration.test.ts` (extend)

**Interfaces:**
- Produces: `penaltyBase(tx: TxClient, utilityId: string, accountId: string): Promise<Prisma.Decimal>` — the sum of `open_amount` over entries whose reason is not a penalty.

**The decision.** The base excludes entries whose `reason.isPenalty` is true and nothing else. Excluding every `FEE` would stop a late fee applying to an unpaid tap fee — real money for real work — and including penalties charges 1.5% on tier 1's own fee. `isPenalty` is the only thing that distinguishes them, and it cannot be a code list.

- [x] **Step 1: Write the failing test**:

```ts
it("charges the rate against the balance", async () => {
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeType: "PERCENT_OF_BALANCE", feeAmount: "0.0150" });
  await pastDue({ balance: "200.00", days: 15 });
  await evaluateAll(TENANT_A);
  expect((await feeEntries())[0].amount.toString()).toBe("3");
});

it("caps a percentage fee at maxFee", async () => {
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeType: "PERCENT_OF_BALANCE", feeAmount: "0.1000", maxFee: "5.00" });
  await pastDue({ balance: "200.00", days: 15 });
  await evaluateAll(TENANT_A);
  expect((await feeEntries())[0].amount.toString()).toBe("5");
});

it("excludes a prior penalty from the base but not an ordinary fee", async () => {
  // Review Focus 4, and the whole reason `isPenalty` exists. $100 of
  // bill charge plus a $40 unpaid tap fee is $140 of principal; a $10
  // late fee already raised is not. 10% of 140 is 14, not 15.
  await chargeOf({ amount: "100.00", type: "BILL_CHARGE" });
  await feeOf({ amount: "40.00", penalty: false });
  await feeOf({ amount: "10.00", penalty: true });
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeType: "PERCENT_OF_BALANCE", feeAmount: "0.1000" });
  await pastDue({ balance: "150.00", days: 15 });
  await evaluateAll(TENANT_A);
  expect((await latestLadderFee()).amount.toString()).toBe("14");
});

it("rounds a percentage fee to cents, half up", async () => {
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeType: "PERCENT_OF_BALANCE", feeAmount: "0.0333" });
  await pastDue({ balance: "100.00", days: 15 });
  await evaluateAll(TENANT_A);
  expect((await feeEntries())[0].amount.toString()).toBe("3.33");
});

it("raises nothing when the computed fee rounds to zero", async () => {
  await ruleWithFee({ tier: 1, daysPastDue: 10, feeType: "PERCENT_OF_BALANCE", feeAmount: "0.0001" });
  await pastDue({ balance: "1.00", days: 15 });
  await evaluateAll(TENANT_A);
  expect(await countFees()).toBe(0);
  expect(await countActions()).toBe(1);
});
```

- [x] **Step 2: Run it** — Expected: FAIL on the percentage branch.
- [x] **Step 3: Implement `penaltyBase`** — one aggregate over `ledger_entry` left-joined to `ledger_reason_def`, summing `open_amount` where the reason is null or `is_penalty` is false, excluding `DEPOSIT` the way `recomputeAccountCache` does.
- [x] **Step 4: Compute the fee** — `FLAT_FEE` takes `feeAmount` as-is; `PERCENT_OF_BALANCE` is `penaltyBase × feeAmount` rounded to 2dp half-up, then `min(maxFee)` if set. A computed zero raises nothing and still creates the action: the tier happened, there was just nothing to charge.
- [x] **Step 5: Run it** — Expected: PASS, 12/12 for the file.
- [x] **Step 6: Run `ledger-fee`, `ledger-posting`, `delinquency-aging`** — Expected: pass.
- [x] **Step 7: Commit** — `feat(delinquency): a percentage tier charges principal, not its own penalties`

---

### Task 5: A tier can replace the ladder's earlier fees

**Files:**
- Modify: `packages/shared/prisma/schema.prisma` — `DelinquencyRule.feeMode`
- Create: `packages/shared/prisma/migrations/20261026093000_delinquency_fee_mode/migration.sql`
- Modify: `packages/api/src/services/delinquency.service.ts`
- Test: `packages/api/src/__tests__/integration/delinquency-fee-replace.integration.test.ts`

**Interfaces:**
- Consumes: `reverseEntry(utilityId, actorId, actorName, entryId, input, existingTx?)` from `services/ar/reversal.service.js`, `ReverseEntryInput` = `{ reasonId?, memo? }`.
- Produces: `DelinquencyRule.feeMode DelinquencyFeeMode @default(ACCUMULATE)` — `ACCUMULATE | REPLACE_LOWER_TIERS`.

**The decision, and the thing it must not get wrong.** A `REPLACE_LOWER_TIERS` tier reverses the fees **the ladder itself raised at lower tiers of the same `accountType`**, found by walking `DelinquencyAction.feeEntryId` — never by reason. That is what keeps a bounced-payment fee and an operator's manual late fee out of the candidate set: neither has a delinquency action, so neither can be reached, whatever the tenant has named its reasons. This is also why the link exists rather than a filter on reason: the question is *ownership*, not category.

Reversal rather than deletion, so the statement reads $10 fee → $10 reversal → $25 fee, and because `reverseEntry` gives back what the entry consumed. Default `ACCUMULATE`, which is existing behaviour, so nobody's bills change until someone configures otherwise.

**A consequence to document, not hide:** if the reversed fee was already paid, the reversal returns that payment to open credit, which re-allocates against the new fee. Net owing is right; the statement shows a reversal and a re-allocation rather than one charge. A replacement smaller than what was already paid leaves the account in credit and possibly refundable.

- [x] **Step 1: Write the failing test**:

```ts
it("reverses the lower tier's fee and raises its own", async () => {
  await ladder([{ tier: 1, days: 15, fee: "10.00" }, { tier: 2, days: 30, fee: "25.00", mode: "REPLACE_LOWER_TIERS" }]);
  await pastDue({ balance: "100.00", days: 35 });
  await evaluateAll(TENANT_A);
  expect((await openFeeTotal()).toString()).toBe("25");   // not 35
  expect(await countFees()).toBe(3);                      // 10, its reversal, 25
});

it("leaves a bounced-payment fee alone", async () => {
  // Review Focus 5. It has no delinquency action, so it is not in the
  // candidate set — which is why this holds whatever it is called.
  await feeOf({ amount: "30.00", penalty: true, raisedBy: "operator" });
  await ladder([{ tier: 1, days: 15, fee: "10.00" }, { tier: 2, days: 30, fee: "25.00", mode: "REPLACE_LOWER_TIERS" }]);
  await pastDue({ balance: "100.00", days: 35 });
  await evaluateAll(TENANT_A);
  expect((await openFeeTotal()).toString()).toBe("55");   // 30 + 25
});

it("leaves an operator's own late fee alone, citing the same reason", async () => {
  // The case a reason filter would have broken: this fee cites exactly
  // the reason tier 1 uses, and still must not be touched.
  await assessFeeByHand({ amount: "15.00", reasonId: await theLadderReason() });
  await ladder([{ tier: 1, days: 15, fee: "10.00" }, { tier: 2, days: 30, fee: "25.00", mode: "REPLACE_LOWER_TIERS" }]);
  await pastDue({ balance: "100.00", days: 35 });
  await evaluateAll(TENANT_A);
  expect((await openFeeTotal()).toString()).toBe("40");   // 15 + 25
});

it("accumulates when the tier does not ask to replace", async () => {
  await ladder([{ tier: 1, days: 15, fee: "10.00" }, { tier: 2, days: 30, fee: "25.00" }]);
  await pastDue({ balance: "100.00", days: 35 });
  await evaluateAll(TENANT_A);
  expect((await openFeeTotal()).toString()).toBe("35");
});

it("replaces once, not on every sweep", async () => {
  await ladder([{ tier: 1, days: 15, fee: "10.00" }, { tier: 2, days: 30, fee: "25.00", mode: "REPLACE_LOWER_TIERS" }]);
  await pastDue({ balance: "100.00", days: 35 });
  await evaluateAll(TENANT_A);
  await evaluateAll(TENANT_A);
  expect(await countFees()).toBe(3);
});

it("returns a paid lower-tier fee to credit when it reverses it", async () => {
  await ladder([{ tier: 1, days: 15, fee: "10.00" }]);
  await pastDue({ balance: "100.00", days: 20 });
  await evaluateAll(TENANT_A);
  await payExactly("10.00");
  await ladder([{ tier: 2, days: 30, fee: "25.00", mode: "REPLACE_LOWER_TIERS" }]);
  await pastDue({ balance: "100.00", days: 35 });
  await evaluateAll(TENANT_A);
  // $25 raised, $10 of payment freed and re-applied: $15 owed on fees,
  // and no money has gone missing.
  expect((await openFeeTotal()).toString()).toBe("15");
});
```

- [x] **Step 2: Run it** — Expected: FAIL, `feeMode` not a known field.
- [x] **Step 3: Add `feeMode` and its migration.**
- [x] **Step 4: Implement the replacement** inside the same transaction as the action and the new fee: select live actions for this account whose rule has a lower `tier` and the same `accountType` and whose `feeEntryId` is not null; `reverseEntry(..., tx)` each, with a memo naming the tier that replaced it; then raise this tier's fee.
- [x] **Step 5: Run it** — Expected: PASS, 6/6.
- [x] **Step 6: Run `ledger-reversal`, `ledger-allocation`, `ledger-payment`, `refund`** — Expected: pass. The paid-fee case touches allocation and reversal together, which is where this goes wrong quietly.
- [x] **Step 7: Commit** — `feat(delinquency): a tier can replace what the ladder charged below it`

---

### Task 6: The shut-off work order (#198)

**Files:**
- Create: `packages/api/src/services/delinquency-work-order.service.ts`
- Modify: `packages/shared/prisma/schema.prisma` — `DelinquencyRule.serviceRequestTypeCode`
- Create: `packages/shared/prisma/migrations/20261026094000_delinquency_work_order/migration.sql`
- Modify: `packages/shared/src/validators/service-request.ts` — `createServiceRequestSchema`
- Modify: `packages/api/src/services/service-request.service.ts`
- Modify: `packages/api/src/workers/delinquency-worker.ts`
- Test: `packages/api/src/__tests__/integration/delinquency-work-order.integration.test.ts`

**Interfaces:**
- Consumes: `createServiceRequest(utilityId, actorId, actorName, data)`. `CreateServiceRequestInput` carries `requestType`, `priority`, `description`, `requestSubtype?`, `accountId?`, `premiseId?`, `serviceAgreementId?` — and **not** `delinquencyActionId`, which this task adds. The schema is `.strict()`, so passing it today is a validation error, not a dropped field.
- Produces: `sweepDelinquencyWorkOrders(utilityId: string): Promise<{ created: number }>`; `delinquencyActionId` on `createServiceRequestSchema`.

**The decision.** `createServiceRequest` cannot join the action's transaction: it calls `nextRequestNumber`, which opens `prisma.$transaction` of its own for the counter row, so a nested call holds a second pooled connection while the first holds the account lock — under an hourly fan-out across tenants that is how a pool runs dry. Threading `existingTx` through the counter is the other real option, rejected on an asymmetry: a *late* work order costs nothing, a *duplicate* fee costs money, so Task 3 must be atomic and this must only be eventually correct. A sweep also has to exist for Task 7, which has no event to hang off at all.

Keyed on state — "which live shut-off actions have no service request?" — so it is idempotent by construction and recovers from the service request module being down.

- [x] **Step 1: Write the failing test** — one work order per shut-off action; nothing on a second pass; **nothing recreated after an operator cancels it** (the query asks whether one was *ever* created, not whether one is open); nothing for a tier configuring no type; nothing for another tenant's actions.
- [x] **Step 2: Run it** — Expected: FAIL, not defined.
- [x] **Step 3: Widen `createServiceRequestSchema`** with `delinquencyActionId: z.string().uuid().optional().nullable()` and pass it through. `ServiceRequest.delinquencyActionId` and the `DelinquencyAction.serviceRequests` back-relation already exist and have gone unused since the module shipped.
- [x] **Step 4: Add `serviceRequestTypeCode`** to `DelinquencyRule`, validated at rule-save time by `assertServiceRequestTypeCode` rather than by a foreign key — the type defs allow global rows with a null `utility_id`, which a composite key cannot reference.
- [x] **Step 5: Implement the sweep**, priority from the rule's tier, a failure on one action logged and skipped rather than thrown — one unroutable account must not stop the rest.
- [x] **Step 6: Run it** — Expected: PASS, 5/5.
- [x] **Step 7: Call it from the worker** after `evaluateAll`, inside the same `scopedJob` scope.
- [x] **Step 8: Run `worker-delinquency`, `service-request-lifecycle`, `service-request-reads`** — Expected: pass.
- [x] **Step 9: Commit** — `feat(delinquency): a shut-off tier dispatches the field work`

---

### Task 7: The reconnection request (#199)

**Files:**
- Modify: `packages/api/src/services/delinquency-work-order.service.ts`
- Modify: `packages/api/src/workers/delinquency-worker.ts`
- Test: `packages/api/src/__tests__/integration/delinquency-work-order.integration.test.ts` (extend)

**Interfaces:**
- Produces: `sweepReconnections(utilityId: string): Promise<{ created: number; resolved: number }>`.

**The decision.** #199 has no trigger today and the obvious candidate is "a payment brought the balance to zero". Hanging it off `recordPayment` would put collections in the money path, so taking a payment could fail because the service request module refused — backwards. State again: "which accounts have a live shut-off action and nothing owing?"

**Order in the worker matters:** reconnections run **before** work orders, so an account that paid is resolved before anything dispatches against it.

- [x] **Step 1: Write the failing test** — a reconnection request and the action `RESOLVED` with `resolutionType: "PAID"` when the balance clears; nothing for an account still owing; and **no disconnect dispatched for an account that cleared in the same hour**, asserting the only request raised is the `RECONNECT`.
- [x] **Step 2: Run it** — Expected: FAIL, not defined.
- [x] **Step 3: Implement it** — live shut-off actions whose account balance is `<= 0`; per account, in one transaction, create the `RECONNECT` request and set the action `RESOLVED` / `resolutionType: "PAID"` / `resolvedAt`, so an action never reads resolved without its request existing.
- [x] **Step 4: Run it** — Expected: PASS, 8/8 for the file.
- [x] **Step 5: Call it from the worker** before `sweepDelinquencyWorkOrders`.
- [x] **Step 6: Run `worker-delinquency`, `ledger-payment`, `delinquency-aging`** — Expected: pass.
- [x] **Step 7: Commit** — `feat(delinquency): a paid account asks to be turned back on`

---

### Task 8: The customer can see the fee

Without this, Tasks 3–5 are correct and invisible. A fee raises the account balance, and `BillSegmentLine` rows come entirely from the rating engine — each carries a `sourceScheduleId` and `sourceComponentId`, because a line *is* a rated charge. A fee has neither. So the customer would receive a bill for consumption and owe more than it says, with nothing explaining the difference.

**Files:**
- Modify: `packages/api/src/services/bill-presentation.service.ts`
- Modify: the bill document template
- Test: `packages/api/src/__tests__/integration/bill-document.integration.test.ts` (extend)

**Interfaces:**
- Produces: `BillPresentationActivity` on `BillPresentation` — `{ entries: Array<{ date: Date; label: string; amount: string }>; total: string } | null`.

**The decision.** This follows the shape `settlement` already set, for the reason its own comment gives: *"Payments arriving after the bill date belong on the next bill, which is how balance-forward billing works anyway."* So activity is ledger entries that are neither this bill's `BILL_CHARGE` nor an application already shown under `settlement`, dated **after the previous bill's `billDate` and at or before this one's** — and the upper bound is not optional. A document that reads the ledger at render time stops being a record of what the customer was shown, which is what `sha256` and byte-stable regeneration exist to protect: a reprint of last March must not acquire a fee raised in April.

There is no previous-bill notion in the service today, so this task establishes one: the same account's most recent bill with `billDate < this.billDate`. Null for a first bill, in which case activity starts from the account's opening.

Labels come from the reason's `label` — the tenant's own wording, never a code and never a hardcoded string.

- [x] **Step 1: Write the failing test** — a fee raised between two bills appears on the later one with the reason's label and amount; it does **not** appear on the earlier one; a reprint after a *later* fee is byte-identical to the first render; a first bill with no predecessor renders without an activity block.
- [x] **Step 2: Run it** — Expected: FAIL, no activity on the presentation.
- [x] **Step 3: Implement the previous-bill lookup and the activity query**, bounded both sides.
- [x] **Step 4: Render it** in the template, between the charges and the totals box.
- [x] **Step 5: Run it** — Expected: PASS.
- [x] **Step 6: Run `bill-document`, `bill-list`, `billing-run`, `e2e-rating`** — Expected: pass. `bill-document` is where byte-stability is pinned.
- [x] **Step 7: Commit** — `feat(bills): a bill shows the account activity behind its balance`

---

### Task 9: Say what it does now

**Files:**
- Modify: `docs/specs/11-delinquency.md`, `docs/specs/10-payments-and-collections.md`, `docs/specs/23-accounts-receivable.md`, `docs/specs/09-billing.md`
- Modify: `docs/bozeman/17-implementation-gap-analysis.md`

- [x] **Step 1: Remove `PenaltyRule` from spec 10** and say why: its four identifying fields are `DelinquencyRule`'s, and the escalation an operator wants is the tier ladder that already exists. Record what would bring it back — fees on a cadence unrelated to notices.
- [x] **Step 2: Record the decisions** in spec 11: the fee inside the action's transaction (against two statements), the partial unique index (against the in-memory `Set`), `effectiveDate` gating (and that ignoring it was a live bug), the reason as tier configuration validated at save time (against any code the service could have known), the work orders as sweeps (against threading a transaction through the request counter), and replacement by `feeEntryId` (against reason codes, which are tenant-configurable).
- [x] **Step 3: Note in spec 23** that `FEE` entries have a second writer and that `isPenalty` exists for the percentage base; and in spec 09 that a bill presents account activity bounded at its own `billDate`.
- [x] **Step 4: Correct the gap doc** — #145, #198, #199 out of absent, with the date, the way architecture §7.1 records the RLS work.
- [x] **Step 5: Commit** — `docs: delinquency charges, dispatches, and shows up on the bill`

---

## Self-review

**Spec coverage.** #145 is Tasks 3–5 and 8 — the fee, and the fee being visible. #198 is Task 6, #199 Task 7. Spec 11's notice tiers and spec 23's ledger are existing and untouched except where named. Out of scope deliberately: payment plans (#147/148) and the aging dashboard (#149/150); this plan is the wiring that makes a payment plan worth offering, since today the ladder decides and nothing happens.

**Step scan.** Each code step names the signature and the file. SQL appears only where the constraint *is* the decision — the partial index's `WHERE`, the paired-nullability CHECKs, the `SET NULL (fee_entry_id)` column list — because a reader who writes those differently has built something else.

**Type consistency.** `sweepDelinquencyWorkOrders(utilityId)` and `sweepReconnections(utilityId)` match between Tasks 6, 7 and their worker steps. `assessFee`'s sixth parameter and `reverseEntry`'s sixth are both `existingTx?: TxClient`, verified in the services as they stand — no AR signature changes anywhere. `DelinquencyAction.feeEntryId` is produced in Task 3 and consumed in Task 5. `LedgerReasonDef.isPenalty` is produced in Task 2 and consumed in Task 4 only.

**Review Focus.** All five have a test in the owning task: 1 and 2 in Task 1, 3 in Task 3, 4 in Task 4, 5 in Tasks 5, 6 and 7.

**Proportion.** Nine tasks against roughly a dozen files, and the length is in seven decisions and three corrections, not transcribed bodies.

**What review of this plan caught, since the first draft would have shipped all of it.** A flat-only fee, when spec 10 had already specified `fee_type` and `max_fee` and an operator escalating 15/30/45 needs percentages. "Exclude prior fees" from the percentage base, which would have stopped a late fee applying to an unpaid tap fee — it is prior *penalties* that compound, and only the tenant knows which of their reasons those are. A fee that appeared nowhere on the bill: four tasks would have passed their tests, the ledger would have been right, and the customer would have received a bill that did not add up. And an argument that leaned on `NSF_FEE` being a different code three paragraphs after ruling code-matching out — the honest answer is that an NSF fee has no delinquency action, so it is never a candidate, whatever it is named.

**One thing left for the executor to decide**, flagged rather than guessed: Task 5's statement presentation when a replaced fee was already paid. The ledger is unambiguous — reversal frees the payment, which re-allocates — but whether the bill shows that as a reversal plus a re-allocation or nets it into one line is billing policy, and Task 8 is where it surfaces.
