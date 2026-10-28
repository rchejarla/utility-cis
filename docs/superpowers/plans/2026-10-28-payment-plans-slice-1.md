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
- Produces: `PaymentPlan` and `PaymentPlanDebit` Prisma models; enums `PaymentPlanStatus` (`ACTIVE`, `COMPLETED`, `DEFAULTED`, `CANCELLED` — no PENDING, design §8) and `PaymentPlanFrequency` (`WEEKLY`, `BIWEEKLY`, `MONTHLY`).

- [ ] **Step 1: Write the migration**

`payment_plan`: `id`, `utility_id`, `account_id`, `status`, `total_balance NUMERIC(14,2)`, `down_payment NUMERIC(14,2) NULL`, `installment_amount NUMERIC(14,2)`, `installment_frequency`, `installment_count INTEGER`, `start_date DATE`, `approved_by UUID`, `notes TEXT`, `created_at`, `updated_at`.

**Plus the six terms this plan is judged by, frozen at agreement:**
`grace_days INTEGER`, `missed_before_default INTEGER`,
`partial_installment_counts BOOLEAN`, `current_bill_counts BOOLEAN`,
`suppress_fees_while_kept BOOLEAN`, `assess_suppressed_fees_on_default BOOLEAN`.

A customer agreed to *these* terms. A tenant lowering grace from five
days to two must not thereby break every plan already running, and the
alternative — reading them live — makes a live agreement's fate depend
on a settings screen nobody connected to it. Typed columns rather than a
JSON snapshot because the sweep reads them per plan, which is the
codebase's own rule for when a value earns a column.

The creation-time terms (`downPaymentPercent`, `minInstallments`,
`maxInstallments`, `frequency`) are **not** frozen separately: they
shaped this plan and are already embodied in its own columns.

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

There is no `downPaymentDueDays`. Arkansas's "close of the third business day" is a bound on how far out `start_date` may be set (Task 4), not a second clock — the down payment is the first payment and is judged by `graceDays` like any other (design §8).

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
- Produces: `createPaymentPlan(utilityId, actorId, actorName, accountId, input): Promise<PaymentPlanResult>` where
  - `input` is `{ entryIds: string[]; downPayment?: string; installmentCount: number; startDate: string; notes?: string }`
  - `PaymentPlanResult` is `{ planId: string; totalBalance: string; downPayment: string | null; installmentAmount: string; schedule: Array<{ dueDate: string; amount: string }>; coveredEntryIds: string[]; actionsResolved: number }`

`schedule` is derived and returned because it is what the customer agreed to — the down payment on `start_date`, then `installment_count` equal payments at the chosen frequency. The CSR dialog shows dates and amounts (design §4b), so it must not compute them itself.

`total_balance` is the sum of the covered debits' **`open_amount`**, not `amount` (design §4aa). `installment_amount` is `(total_balance − down_payment) / installment_count`, rounded to cents with the remainder on the **first** instalment, so the schedule sums to the balance exactly and the customer never finds a stray cent on the last payment.

The six judgement terms are copied from `resolvePlanTerms` onto the row (Task 1). **Status is `ACTIVE` on creation, always** — there is no PENDING. The down payment is the first payment, due on `start_date`, and an unpaid one is handled by the same grace-then-missed machinery as every other (design §8).

`startDate` is validated against the terms: not in the past, and no further out than the tenant's rule allows — Arkansas's three business days, expressed as a bound here rather than as a second clock.

**Agreeing a plan resolves the account's live delinquency actions**, with `resolutionType: "PAYMENT_PLAN"` — which is what that enum value has always meant and still means. What changes is that the word now records a real agreement instead of standing in for one. Without this the account keeps sitting in the shut-off queue with a plan in force.

One transaction; lock the account first, as every other ledger writer does.

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

it("refuses a plan whose debits are all already settled", async () => {
  // Review Focus 3's second half. A plan with nothing to collect is not
  // a plan, and it would otherwise be created and complete on the very
  // next sweep.
  await expect(create({ entryIds: [settledId] })).rejects.toMatchObject({ code: "NOTHING_TO_COVER" });
});

it("resolves the account's live delinquency actions", async () => {
  // Otherwise the account stays in the shut-off queue with a plan on it.
  const result = await create({ entryIds: [overdueId], installmentCount: 3 });
  expect(result.actionsResolved).toBeGreaterThan(0);
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
- Consumes: `payment_plan_debit`, `payment_plan.status`, `payment_plan.suppress_fees_while_kept`.
- Produces: `chargeableDebits` excludes a debit covered by a plan whose **`status = 'ACTIVE'`** and whose own `suppress_fees_while_kept` is true.

Read from the plan row, not from `resolvePlanTerms`: the terms were frozen when the plan was agreed (Task 1), so this needs no tenant lookup and cannot disagree with what the customer was told.

**Join through to the plan's status; do not test membership.** `payment_plan_debit` rows persist after a plan ends — they are history and the key is `RESTRICT`. A `NOT EXISTS` over the join table alone would suppress a debit forever, including after default, **and would pass every test written while the plan is still running**. Only `ACTIVE` suppresses.

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
- Produces: `evaluateAll` derives `daysPastDue` from **the oldest open debit not covered by a plan whose `status = 'ACTIVE'`**, not from `Account.lastDueDate`.

**Do not redefine `Account.lastDueDate`** (design §5). That column is AR's and means "the oldest open debit" full stop; reconciliation and the aging query read it.

Same trap as Task 5: join to `payment_plan` and read the status. Membership in the join table is not suppression.

- [ ] **Step 1: Write the failing tests**

```ts
it("files no action when the only overdue debt is covered", async () => {});

it("ages from the uncovered debt when there is one", async () => {
  // The two-bucket model: the plan holds the arrears, the new bill is
  // still chased on its own clock.
});

it("sees a defaulted plan's debits again, at their real ages", async () => {
  // The join rows survive the default, so a membership test would hide
  // these forever — and would look correct in both tests above, where
  // the plan is still running.
});
```

- [ ] **Step 2: Run — expect FAIL. Step 3: Implement. Step 4: Run — expect PASS. Step 5: Commit.**

---

### Task 7: Allocation

**Files:**
- Modify: `packages/api/src/services/ar/allocation.service.ts`, `packages/api/src/services/ar/payment.service.ts`
- Test: `packages/api/src/__tests__/integration/ledger-allocation.integration.test.ts`

**Interfaces:**
- Produces: **`applyCreditToDebits`** (line ~98 — the one that allocates a credit *across* debits, ordered by due date) and the payment path take an optional `{ paymentPlanId?: string }`. Without it, uncovered debits are candidates first and covered ones only once those are clear. With it, only that plan's covered debits are candidates.

**Three functions in that file have nearly the same name.** `applyCreditToDebits` routes a payment across debits and is the one to change. `applyCreditsToDebit` (line ~202) absorbs existing open credits *into a new debit* and is **not** changed: a new debit is never covered by a plan, because a plan names debits that existed when it was agreed. `applyCreditToOneDebit` is neither.

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
- Produces: `cancelPaymentPlan(utilityId, actorId, actorName, planId, notes)`; `sweepPaymentPlans(utilityId)` which closes COMPLETED plans and (Task 9) defaults broken ones.

COMPLETED is derived, not counted (design §8): every covered debit at zero. Both acts are idempotent because both read state.

**No activation step.** A plan is ACTIVE from agreement; the down payment is its first payment and an unpaid one is Task 9's business, not a separate lifecycle. An earlier draft had a PENDING state and two transitions to leave it, and they changed nothing the system did — suppression began at agreement either way.

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

Instalment *n* is due `start_date + (n - 1) * frequency`; there is no instalment table (design §4). **Late is not missed** (design §7): an instalment inside `grace_days` leaves the plan ACTIVE and suppression intact.

Every term this reads — `grace_days`, `missed_before_default`, `partial_installment_counts`, `current_bill_counts`, `assess_suppressed_fees_on_default` — comes from **the plan row**, frozen at agreement (Task 1). No `resolvePlanTerms` call: a plan is judged by what the customer agreed to, not by what the settings screen says today.

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
it("opens a not-yet-due bill charge unticked, and its own late fee ticked", async () => {
  // Design §4b. The proposed total is the past-due balance. A fee left
  // out would climb the ladder while its parent bill was suppressed.
});
it("says the customer is behind, which the status alone does not", async () => {});
it("warns when an unpaid new bill puts the plan at risk", async () => {});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement both components**, including the AR tab's covered-debit marker reading `in a payment plan`, so a CSR on the ledger can see a charge is not to be chased.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Seed a plan**

Create: `seed/payment-plan.js`, called from `seed.js` after the delinquency ladder, in the shape `seed/delinquency-ladder.js` already uses.

One ACTIVE plan on the demo account covering two of its open debits — the opening balance and the oldest bill charge, which is what a real arrangement looks like — with its down payment already paid, so the panel reads "on track".

Without it these two screens cannot be opened on a fresh database without hand-building a plan in SQL, and the screens are half this slice. Every other feature here seeds its demo; the ladder got a module of its own last week for the same reason.

- [ ] **Step 6: Run `seed_db.bat` and open both screens.**
Expected: the panel reads `ACTIVE — on track`, the AR tab marks the two covered debits, and the next delinquency sweep charges them no fee.
- [ ] **Step 7: Update specs** — `10-payments-and-collections.md` (the entity, superseding its sketch), `11-delinquency.md` (suppression, and the default-notices consequence from Task 9), `19-rbac.md` if a permission is added.
- [ ] **Step 8: Commit.**

---

## Self-Review

**Spec coverage.** §3 covered debits → Task 1, 4. §4 entity → Task 1. §4a terms → Task 2, 3. §4aa allocation → Task 7. §4b screens → Task 11. §5 suppression → Tasks 5, 6. §6 fees already raised → no task: nothing is waived on agreement, so there is nothing to build. §7 breaking → Task 9. §8 lifecycle → Task 8. §9 constraints → Global Constraints. §10 slice 1 → all. Slices 2 and 3 are out of scope.

**Not in this slice, deliberately:** the portal view of a plan (slice 2), SaaSLogic (slice 3), `assessSuppressedFeesOnDefault: true` — Task 9 tests the default only; the true path needs deferred fees recorded when skipped, which is slice 2's work and should not be half-built here.

**Type consistency.** `resolvePlanTerms` (Task 2) is consumed by Tasks 3 and 4 only — Tasks 5 and 9 read the frozen columns on the plan row instead, which is what freezing is for. `createPaymentPlan` returns `PaymentPlanResult` as defined in Task 4 and consumed by Tasks 10 and 11. `sweepPaymentPlans` is created in Task 8, extended in Task 9, and called from the delinquency worker in Task 9 Step 4 — not an orphan.

**Review-pass corrections (2026-10-28).** This plan was reviewed after
drafting and nine things were wrong. Recorded because the reasons
outlive the fixes:

- Task 7 named `applyCreditsToDebit`, which absorbs credits into a new
  debit. The payment allocator is `applyCreditToDebits`. Three functions
  in one file differ by two letters.
- Nothing moved a plan out of PENDING. First answered by adding
  activation and expiry; then answered properly, by removing PENDING.
  Suppression began at agreement either way, so the state changed
  nothing the system did — it was a label, two transitions and four
  tests. The down payment is the first payment, due on `start_date`,
  judged by the same grace machinery as every other. Arkansas's three
  business days is a bound on `start_date`, not a second clock.
- Terms were frozen for one field and read live for five, so a settings
  change would have retroactively broken running plans. All six
  judgement terms are now columns on the plan.
- No seed data, for a slice that is half screens.
- `PaymentPlanResult` was named and never defined.
- Task 5 needed terms it did not list; freezing removed the need.
- Review Focus 3 said "or already settled" and no test covered it.
- `resolutionTypes.PAYMENT_PLAN` looked orphaned and is not: agreeing a
  plan still resolves the live actions with it, which surfaced that
  **nothing was resolving them at all** — the account would have stayed
  in the shut-off queue with a plan in force.
- Task 11 interleaved implement and run steps.

**Proportion.** Eleven tasks, each a migration, a service, a screen or a suppression point, each with its own test cycle and a reviewer's gate.
