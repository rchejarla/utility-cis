# Payment Plans, Slice 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An account can be put on a deferred payment agreement that names the debts it covers, and the delinquency ladder leaves those debts alone while it is kept.

**Architecture:** A `payment_plan` row with a `payment_plan_debit` join naming the covered `ledger_entry` debits. Suppression happens at the ladder's two clocks — the per-bill charging pass and the account-level age — and nowhere else. The plan's terms are tenant policy in a `settings` namespace, edited under Collections beside the delinquency rules. Nothing about a plan changes the balance; it changes when money is chased.

**Tech Stack:** Fastify + Prisma 7 (driver adapter), PostgreSQL with RLS, Zod validators in `packages/shared`, Next.js app router, Vitest (unit + integration with testcontainers).

**Spec:** `docs/superpowers/specs/2026-10-26-payment-plans-design.md`

## Global Constraints

- **Never run `prisma migrate dev`.** Write migration SQL by hand; apply with `migrate deploy`. See CLAUDE.md.
- Every tenant-scoped table carries `utility_id`, every key between two tenant-scoped tables is a **composite** `(utility_id, fk) -> parent (utility_id, id)`, and every such table has RLS `ENABLE`d **and** `FORCE`d with a `tenant_isolation` policy on **one-argument** `current_setting`. `schema-invariants.integration.test.ts` enforces all three.
- Money is `Decimal`, never a JS number. Ledger money is `Decimal(14,2)`.
- **No business logic keys on a reason code** — reason codes are tenant-configurable.
- Tenant scope travels in `AsyncLocalStorage`; `await` inside `runAsTenant`, never return a lazy `PrismaPromise` out of the scope.
- **Tests must not enqueue into the dev Redis** — mock `enqueueSafely` in any test exercising a route that enqueues.
- Writes that must not half-happen go in one transaction; an external dispatch never goes inside one.
- Portal reads carry the ownership check in the query (`customerId` in the `where`); a miss is a 404, not a 403.
- Update the functional spec and design doc with any data-model, API or UI change (CLAUDE.md).

## Review Focus

Five things the design implies that no task's tests exercise by default. Each has a test added to the task that owns the code.

1. **A covered debit settled by something other than a plan payment** — a waiver or a write-off takes it to zero. Does the plan complete, and is that right? (Task 8)
2. **A second ACTIVE plan on one account.** `payment_plan_debit`'s PK stops a debit belonging to two plans, but nothing yet stops two plans existing. (Task 4)
3. **A plan agreed over zero debits**, or over debits that are all already settled — a plan that is complete the moment it is created. (Task 4)
4. **A tenant with no `paymentPlans` settings at all** — the namespace absent rather than partial, which is every tenant until somebody opens the screen. (Task 2)
5. **An account with no uncovered debits**, where the "current bill unpaid" default test has nothing to look at and must not therefore default the plan. (Task 9)

---

### Task 1: The tables

**Files:**
- Create: `packages/shared/prisma/migrations/20261028120000_payment_plan/migration.sql`
- Modify: `packages/shared/prisma/schema.prisma`
- Test: `packages/api/src/__tests__/integration/schema-invariants.integration.test.ts` (existing; it must pass unchanged)

**Interfaces:**
- Produces: `PaymentPlan` and `PaymentPlanDebit` Prisma models; enums `PaymentPlanStatus` (`PENDING`, `ACTIVE`, `COMPLETED`, `DEFAULTED`, `CANCELLED`) and `PaymentPlanFrequency` (`WEEKLY`, `BIWEEKLY`, `MONTHLY`).

- [ ] **Step 1: Write the migration**

`payment_plan`: `id`, `utility_id`, `account_id`, `status`, `total_balance NUMERIC(14,2)`, `down_payment NUMERIC(14,2) NULL`, `installment_amount NUMERIC(14,2)`, `installment_frequency`, `installment_count INTEGER`, `start_date DATE`, `missed_before_default INTEGER`, `approved_by UUID`, `notes TEXT`, `created_at`, `updated_at`.

`payment_plan_debit`: `utility_id`, `plan_id`, `entry_id`, `created_at`, `PRIMARY KEY (utility_id, entry_id)` — a debit belongs to at most one plan — and an index on `(utility_id, plan_id)`.

Composite FKs on both tables (`utility_id` to `utility`; `(utility_id, account_id)`, `(utility_id, plan_id)`, `(utility_id, entry_id)`), all `ON DELETE RESTRICT`: a plan is history and a ledger entry is reversed, never deleted. `delinquency_action_fee`'s migration is the shape to copy.

CHECKs: `installment_count > 0`, `installment_amount > 0`, `total_balance > 0`, `missed_before_default > 0`, `down_payment IS NULL OR down_payment >= 0`.

RLS `ENABLE` + `FORCE` + `tenant_isolation` on both, one-argument `current_setting`.

`payment_plan` needs `UNIQUE (utility_id, id)` so `payment_plan_debit` can reference it compositely.

- [ ] **Step 2: Add both models to `schema.prisma`**

Scalar FK columns only where Prisma cannot express the composite (it cannot, for the same reason as `delinquency_rule.fee_reason_id`); the keys live in the migration. Document that on the model.

- [ ] **Step 3: Apply and generate**

Run: `cd packages/shared && npx prisma migrate deploy && npx prisma generate`
Expected: one migration applied, client regenerated.

- [ ] **Step 4: Run the schema invariants**

Run: `cd packages/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/schema-invariants.integration.test.ts`
Expected: PASS. It catches a new table with no RLS policy and a key that regressed to a single column — both have happened before.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/prisma packages/api
git commit -m "feat(plans): payment_plan and payment_plan_debit"
```

---

### Task 2: The terms, as tenant policy

**Files:**
- Create: `packages/shared/src/validators/payment-plan-terms.ts`
- Modify: `packages/api/src/services/payment-plan/terms.ts` (create)
- Test: `packages/api/src/__tests__/services/payment-plan-terms.test.ts`

**Interfaces:**
- Produces: `PaymentPlanTermsSchema` (Zod, `.strict()`), `DEFAULT_PLAN_TERMS`, and `resolvePlanTerms(utilityId): Promise<PaymentPlanTerms>` reading `UtilityConfig.settings.paymentPlans`.

Keys and defaults, from the design §4a: `downPaymentPercent` 25, `minInstallments` 3, `maxInstallments` 12, `frequency` `MONTHLY`, `graceDays` 5, `missedInstallmentsBeforeDefault` 1, `partialInstallmentCounts` false, `currentBillCountsTowardDefault` true, `suppressFeesWhileKept` true, `assessSuppressedFeesOnDefault` false, `allowSecondPlanAfterDefault` true.

- [ ] **Step 1: Write the failing tests**

```ts
it("falls back to every default when the tenant has no paymentPlans namespace", async () => {
  vi.mocked(prisma.utilityConfig.findUnique).mockResolvedValue({ settings: {} } as never);
  await expect(resolvePlanTerms("util-1")).resolves.toEqual(DEFAULT_PLAN_TERMS);
});

it("takes the tenant's value where it has one and the default elsewhere", async () => {
  vi.mocked(prisma.utilityConfig.findUnique).mockResolvedValue({
    settings: { paymentPlans: { downPaymentPercent: 15 } },
  } as never);
  const terms = await resolvePlanTerms("util-1");
  expect(terms.downPaymentPercent).toBe(15);
  expect(terms.minInstallments).toBe(DEFAULT_PLAN_TERMS.minInstallments);
});

it("refuses a maximum below the minimum, which would offer no valid plan", () => {
  expect(() => PaymentPlanTermsSchema.parse({ minInstallments: 6, maxInstallments: 3 })).toThrow();
});
```

- [ ] **Step 2: Run them — expect FAIL on `resolvePlanTerms` not defined**

Run: `cd packages/api && npx vitest run src/__tests__/services/payment-plan-terms.test.ts`

- [ ] **Step 3: Implement the schema and `resolvePlanTerms(utilityId: string): Promise<PaymentPlanTerms>`**

Read defensively, the way `issuerOf` does: a tenant that never opened the screen has no `paymentPlans` key. Partial namespaces merge over the defaults per key, which is what makes Review Focus 4 pass.

- [ ] **Step 4: Run — expect PASS. Step 5: Commit.**

---

### Task 3: The terms screen

**Files:**
- Create: `packages/web/app/delinquency/plan-terms/page.tsx`
- Modify: `packages/web/components/sidebar.tsx` (a Collections item), `packages/api/src/routes/delinquency.ts` (GET/PUT the namespace)
- Test: `packages/web/app/delinquency/plan-terms/__tests__/page.test.tsx`

**Interfaces:**
- Consumes: `PaymentPlanTermsSchema` (Task 2).
- Produces: `GET /api/v1/delinquency/plan-terms`, `PUT /api/v1/delinquency/plan-terms`, both `{ config: { module: "delinquency", permission: "VIEW" | "EDIT" } }`.

Under Collections beside the rules, **not** in Settings (design §4a): where a value is stored must not pick the screen. Four groups, each reading as a sentence — see the design for the wording.

- [ ] **Step 1: Write the failing test** — the screen renders the tenant's saved values, and a `PUT` carries the whole namespace.
- [ ] **Step 2: Run it — expect FAIL.**
- [ ] **Step 3: Implement the routes and the page.**
- [ ] **Step 4: Run — expect PASS. Step 5: Commit.**

---

### Task 4: Agreeing a plan

**Files:**
- Create: `packages/api/src/services/payment-plan/create.ts`
- Test: `packages/api/src/__tests__/integration/payment-plan-create.integration.test.ts`

**Interfaces:**
- Consumes: `resolvePlanTerms` (Task 2).
- Produces: `createPaymentPlan(utilityId, actorId, actorName, accountId, input): Promise<PaymentPlanResult>` where `input` is `{ entryIds: string[]; downPayment?: string; installmentCount: number; startDate: string; notes?: string }`.

`total_balance` is the sum of the covered debits' **`open_amount`**, not `amount` (design §4aa). One transaction; lock the account first, as every other ledger writer does.

- [ ] **Step 1: Write the failing tests**

```ts
it("freezes the balance from what is still open, not the face value", async () => {
  // A $100 charge with $40 paid contributes $60.
});

it("refuses an instalment count outside the tenant's terms, naming the bound", async () => {
  await expect(create({ installmentCount: 2 })).rejects.toMatchObject({ code: "INSTALLMENTS_BELOW_MINIMUM" });
});

it("refuses a debit that already belongs to a plan", async () => {
  // Review Focus 2's sibling: the PK enforces it, and the service
  // should say so rather than surfacing a P2002.
});

it("refuses a plan over no open debits", async () => {
  await expect(create({ entryIds: [] })).rejects.toMatchObject({ code: "NOTHING_TO_COVER" });
});

it("refuses a second active plan on one account", async () => {
  // Review Focus 2. Nothing in the schema stops it; the service must.
});

it("covers debits of every kind, not only bill charges", async () => {
  // Review Focus for §4aa: a BILL_CHARGE, a FEE and an ADJUSTMENT_DEBIT
  // in one plan, which is what a real account looks like.
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Validate against terms before writing anything; audit the creation with `writeAuditRow` inside the transaction.
- [ ] **Step 4: Run — expect PASS. Step 5: Commit.**

---

### Task 5: Suppression at the charging pass

**Files:**
- Modify: `packages/api/src/services/delinquency-fee.ts`
- Test: `packages/api/src/__tests__/integration/delinquency-fee.integration.test.ts`

**Interfaces:**
- Consumes: `payment_plan_debit`, `payment_plan.status`.
- Produces: `chargeableDebits` excludes a debit covered by a plan in `PENDING` or `ACTIVE`, gated on the tenant's `suppressFeesWhileKept`.

- [ ] **Step 1: Write the failing test** — a covered overdue debit is charged no fee; an uncovered one beside it still is.
- [ ] **Step 2: Run — expect FAIL (the fee is raised).**
- [ ] **Step 3: Implement** — one `NOT EXISTS` in the existing raw query, not a second query.
- [ ] **Step 4: Run — expect PASS. Step 5: Commit.**

---

### Task 6: Suppression at the account clock

**Files:**
- Modify: `packages/api/src/services/delinquency.service.ts`
- Test: `packages/api/src/__tests__/integration/delinquency-aging.integration.test.ts`

**Interfaces:**
- Produces: `evaluateAll` derives `daysPastDue` from **the oldest open debit not covered by an active plan**, not from `Account.lastDueDate`.

**Do not redefine `Account.lastDueDate`** (design §5). That column is AR's and means "the oldest open debit" full stop; reconciliation and the aging query read it.

- [ ] **Step 1: Write the failing test** — an account whose only overdue debt is covered files no action at all; the same account with one uncovered overdue bill files for that bill's age.
- [ ] **Step 2: Run — expect FAIL. Step 3: Implement. Step 4: Run — expect PASS. Step 5: Commit.**

---

### Task 7: Allocation

**Files:**
- Modify: `packages/api/src/services/ar/allocation.service.ts`, `packages/api/src/services/ar/payment.service.ts`
- Test: `packages/api/src/__tests__/integration/ledger-allocation.integration.test.ts`

**Interfaces:**
- Produces: `applyCreditsToDebit` and the payment path take an optional `{ paymentPlanId?: string }`. Without it, uncovered debits are candidates first and covered ones only once those are clear. With it, only that plan's covered debits are candidates.

The design's §4aa flaw: a customer pays their current bill, the allocator puts it on the oldest arrears, the current bill stays open, and the plan defaults on §7's test. **Both modes are the existing allocator with the candidate set filtered** — the oldest-due rule, the type-class ranking and the determinism are unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
it("settles the current bill before the arrears a plan covers", async () => {
  // The flaw this task exists for: without it the payment lands on the
  // oldest covered debit and the current bill stays open.
});

it("sends a payment marked against a plan to that plan's debits only", async () => {});

it("reaches covered debits once nothing uncovered is left", async () => {});
```

- [ ] **Step 2: Run — expect FAIL. Step 3: Implement. Step 4: Run — expect PASS. Step 5: Commit.**

---

### Task 8: Completing and cancelling

**Files:**
- Create: `packages/api/src/services/payment-plan/lifecycle.ts`
- Test: `packages/api/src/__tests__/integration/payment-plan-lifecycle.integration.test.ts`

**Interfaces:**
- Produces: `cancelPaymentPlan(utilityId, actorId, actorName, planId, notes)`; `sweepPaymentPlans(utilityId)` closing plans whose covered debits are all at `open_amount = 0`.

COMPLETED is derived, not counted (design §8): every covered debit at zero. Both acts are idempotent because both read state.

- [ ] **Step 1: Write the failing tests**

```ts
it("completes a plan once every covered debit is settled", async () => {});

it("completes a plan whose debts were waived rather than paid", async () => {
  // Review Focus 1. A waiver or write-off takes a covered debit to zero
  // without a payment. The plan is satisfied — the debt is gone — and
  // the sweep must not wait for money that will never arrive.
});

it("cancelling stops suppression without touching the ledger", async () => {
  // A cancelled plan covers nothing; no entry is written, reversed or
  // moved. The debts return to the ladder exactly as they were.
});
```

- [ ] **Step 2: Run — expect FAIL. Step 3: Implement. Step 4: Run — expect PASS. Step 5: Commit.**

---

### Task 9: Defaulting

**Files:**
- Modify: `packages/api/src/services/payment-plan/lifecycle.ts`
- Test: `packages/api/src/__tests__/integration/payment-plan-default.integration.test.ts`

**Interfaces:**
- Produces: `sweepPaymentPlans` reports each plan's **late** instalments, raises the late notice for any that became late since the last pass, and defaults on either test — instalments **missed** (date + `graceDays` passed) by `missedInstallmentsBeforeDefault`, or (when `currentBillCountsTowardDefault`) an uncovered debit past due.

Instalment *n* is due `start_date + (n - 1) * frequency`; there is no instalment table (design §4). **Late is not missed** (design §7): an instalment inside `graceDays` leaves the plan ACTIVE and suppression intact.

- [ ] **Step 1: Write the failing tests**

```ts
it("leaves a plan active while an instalment is late but inside grace", async () => {
  // Late by one day with graceDays 5. The plan is ACTIVE, suppression
  // holds, and no fee is charged on a covered debt. Defaulting here was
  // the first draft's behaviour and it contradicted the CSR panel,
  // which shows "1 payment behind" as a state.
});

it("reports how many instalments are late, which the status cannot", async () => {});

it("notifies once when an instalment goes late, not on every sweep", async () => {
  // Nobody is defaulted silently, and nobody is told five times.
});

it("misses an instalment once grace expires, and defaults at the threshold", async () => {});

it("treats a part payment as a miss unless the tenant says otherwise", async () => {
  // $30 against a $65.44 instalment. partialInstallmentCounts is false.
});

it("defaults a plan when a bill outside it goes unpaid past its due date", async () => {
  // The hole the first draft had: paying every instalment while never
  // paying a new bill kept the plan, and its suppression, alive.
});

it("does not default a plan on an account with nothing uncovered", async () => {
  // Review Focus 5. The second test has nothing to look at; "no
  // uncovered debt" is not "an unpaid current bill".
});

it("leaves already-charged fees alone on default by default", async () => {
  // assessSuppressedFeesOnDefault is false unless a tenant says so.
});
```

- [ ] **Step 2: Run — expect FAIL. Step 3: Implement.**

**Decision to record in the plan ledger, not to invent in code:** on DEFAULTED the covered debits return at their *real* ages, so the next sweep files every tier they qualify for — a customer can receive the tier-1 email, the tier-2 email and the tier-3 SMS in one night, then shut-off eligibility. That is correct by the rules and unpleasant in the inbox. Implement it as described; if the tenant wants fewer notices that is the notification configuration's problem, not the plan's. Note it in the spec.

- [ ] **Step 4: Wire it into the delinquency worker, as the first pass**

Modify: `packages/api/src/workers/delinquency-worker.ts`. `sweepPaymentPlans(utilityId)` runs **before** `evaluateDelinquencyForTenant`, inside the same tenant scope, alongside the two passes already there.

First, because the ladder's suppression reads plan state: a plan that defaults this tick must be chaseable this tick, and a plan that completes must stop suppressing before anything is charged. Second cron, and the two race over the same account and the order depends on scheduling — which is the kind of bug that appears once a month at 03:00. The worker already orders its passes for exactly this sort of reason; `sweepReconnections` carries the comment saying so.

The job's log line gains the plan counts, the way the other two passes report theirs.

- [ ] **Step 5: Write the failing test** for the ordering: a plan that defaults on this tick has its debits charged by the same tick's charging pass.

Test: `packages/api/src/__tests__/integration/worker-delinquency.test.ts`

- [ ] **Step 6: Run — expect PASS. Step 7: Commit.**

---

### Task 10: The API

**Files:**
- Create: `packages/api/src/routes/payment-plans.ts`
- Modify: `packages/api/src/app.ts`, `packages/shared/src/validators/payment-plan.ts` (create)
- Test: `packages/api/src/__tests__/integration/payment-plan-routes.integration.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/accounts/:id/payment-plans`, `POST /api/v1/accounts/:id/payment-plans`, `GET /api/v1/payment-plans/:id`, `POST /api/v1/payment-plans/:id/cancel`. Module `delinquency`; `VIEW` to read, `CREATE` to agree, `EDIT` to cancel.
- The read returns the derived schedule and derived progress — `onTrack`, `installmentsBehind`, `remaining` — not just the stored columns (design §4b).

- [ ] **Step 1: Write the failing tests**, including that the covered-debt list carries each debit's bill number or its `assessedOn` bill, or neither, mirroring the AR tab's Bill column.
- [ ] **Step 2: Run — expect FAIL. Step 3: Implement. Step 4: Run — expect PASS. Step 5: Commit.**

---

### Task 11: The screens, and the button that lied

**Files:**
- Create: `packages/web/components/payment-plans/agree-plan-dialog.tsx`, `packages/web/components/payment-plans/plan-panel.tsx`
- Modify: `packages/web/app/accounts/[id]/page.tsx`, `packages/web/app/delinquency/shutoff-eligible/page.tsx`, `packages/web/components/ar/ar-tab.tsx`
- Test: `packages/web/components/payment-plans/__tests__/agree-plan-dialog.test.tsx`, `.../plan-panel.test.tsx`

**Interfaces:**
- Consumes: the Task 10 routes.

Design §4b is the specification for both. The dialog **proposes** a plan from the terms and lets the operator adjust within them; refusals explain themselves at the control. The panel answers four questions in call order, beginning with whether the customer is keeping to it.

The shut-off queue's `PAYMENT_PLAN` button currently calls `resolveAccount(..., "PAYMENT_PLAN")`, which writes a word on an action row and stops nothing. It opens the dialog instead.

- [ ] **Step 1: Write the failing tests**

```ts
it("proposes the down payment and the schedule from the tenant's terms", async () => {});
it("offers only instalment counts the terms allow", async () => {});
it("shows a covered debt with no bill, which an opening balance is", async () => {});
it("says the customer is behind, which the status alone does not", async () => {});
it("warns when an unpaid new bill puts the plan at risk", async () => {});
```

- [ ] **Step 2: Run — expect FAIL. Step 3: Implement.**
- [ ] **Step 4:** Mark a covered debit in the AR tab, reading `in a payment plan`, so a CSR on the ledger can see it is not to be chased.
- [ ] **Step 5: Run — expect PASS.**
- [ ] **Step 6: Update specs** — `10-payments-and-collections.md` (the entity, superseding its sketch), `11-delinquency.md` (suppression, and the default-notices consequence from Task 9), `19-rbac.md` if a permission is added.
- [ ] **Step 7: Commit.**

---

## Self-Review

**Spec coverage.** §3 covered debits → Task 1, 4. §4 entity → Task 1. §4a terms → Task 2, 3. §4aa allocation → Task 7. §4b screens → Task 11. §5 suppression → Tasks 5, 6. §6 fees already raised → no task: nothing is waived on agreement, so there is nothing to build. §7 breaking → Task 9. §8 lifecycle → Task 8. §9 constraints → Global Constraints. §10 slice 1 → all. Slices 2 and 3 are out of scope.

**Not in this slice, deliberately:** the portal view of a plan (slice 2), SaaSLogic (slice 3), `assessSuppressedFeesOnDefault: true` — Task 9 tests the default only; the true path needs deferred fees recorded when skipped, which is slice 2's work and should not be half-built here.

**Type consistency.** `resolvePlanTerms` (Task 2) is consumed by Tasks 3, 4, 5, 9 under that name. `createPaymentPlan` and `sweepPaymentPlans` keep their signatures from Tasks 4 and 8 through Tasks 9 and 10.

**Proportion.** Eleven tasks, each a migration, a service, a screen or a suppression point, each with its own test cycle and a reviewer's gate.
