# AR Ledger Slice 2 — Payments, Allocation and Reversal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. No per-task subagent review is planned — one whole-branch review at the end — so this plan carries the interface contract. Read every task's **Interfaces** block before writing code in it.

**Goal:** Money received reduces what an account owes, applied against specific open charges in a defined order, and any posted entry can be reversed with its consumed amounts restored exactly.

**Architecture:** Three new services under `packages/api/src/services/ar/`, each with one responsibility: `allocation.service.ts` applies open credits to open debits in the tenant's priority order; `payment.service.ts` records money received; `reversal.service.ts` negates a posted entry and restores what it consumed. All three run inside one transaction with the existing `audit-wrap` helpers and recompute `Account.balance` before committing. No events, no queues, no second transaction — same rule as slice 1.

**Tech Stack:** Fastify + TypeScript on `tsx`, Prisma 6 against PostgreSQL 16, Zod validators shared between API and web, Vitest with testcontainers for integration tests.

**Spec:** `docs/superpowers/specs/2026-10-09-ar-ledger-design.md` — §4.3 `LedgerApplication`, §5 invariants, §6.2 `recordPayment`, §6.3 allocation, §6.6 `reverseEntry`, §6.1 step 4 (open-credit auto-apply), §10 slice 2.

## Global Constraints

- Money in the ledger is `Decimal(14,2)`. All arithmetic uses `Prisma.Decimal`, never JavaScript numbers. Spec §4.6.
- `amount` and `openAmount` are **signed** from one viewpoint: positive increases what the customer owes the utility. Spec §3.3a.
- `openAmount` shares the sign of `amount`, and `abs(openAmount) <= abs(amount)`. Spec §5.
- `LedgerApplication.amount` is **always positive**. The parents' signs make it subtract from a debit and add to a credit, both converging on zero. Spec §4.3, §5.
- `debit.openAmount = debit.amount − Σ applications on that debit`; `credit.openAmount = credit.amount + Σ applications on that credit`; `account.balance = SUM(openAmount)`. Spec §5.
- `amount`, `type`, `dueDate` and `effectiveDate` are **immutable** once posted. `openAmount` is maintained bookkeeping, not history. Spec §5.
- Every balance-changing operation runs **in one transaction** and recomputes `Account.balance` before committing. Spec §6 preamble.
- Every mutation wraps in `audit-wrap` (`auditCreate` / `writeAuditRow`), which sets `app.current_utility_id` transaction-scoped before writing.
- Every query carries an explicit `utilityId` predicate. RLS does not enforce (the application role is a superuser and owns the tables), so these predicates are the only tenant separation. See `docs/design/utility-cis-architecture.md` §7.1.
- The allocation ranking lives in **one constant**, in `@utility-cis/shared`. Spec §6.3 — tenant-configurable ordering is explicitly not built.
- Service files are `allocation.service.ts`, `payment.service.ts`, `reversal.service.ts` — not `ar-allocation.service.ts`. The folder qualifies them. Spec §3.9.

## Decisions this plan takes beyond the spec

1. **`reasonId` is optional on `reverseEntry`.** §6.6's signature takes one, but `LedgerReasonDef` is seeded in slice 3, so requiring it would be unsatisfiable. §4.2's required-reason list covers FEE / ADJUSTMENT_DEBIT / ADJUSTMENT_CREDIT / WRITE_OFF and excludes REVERSAL. Tightens in slice 3.
2. **A reversal is applied against the entry it reverses, in full.** §6.6 says to restore the original's consumed amounts but is silent on the reversal's own `openAmount`. Leaving both open gets the balance right and leaves a bounced payment available as an open credit for allocation to spend again. Applying the reversal against the original zeroes both and leaves the restored counterparties open. Verified against the live CHECK constraints in both directions.
3. **The API takes a positive `amount` for a payment; the service negates it.** An operator types `50.00`. Sign errors are the bug class here, so a negative or zero input is refused at the validator.
4. **Allocation takes the account row lock itself**, as its first statement, matching slice 1's decision to put the lock in `recomputeAccountCache` rather than in its callers. Re-locking a row the transaction already holds costs nothing.
5. **Unknown debit types rank last in allocation**, not first. `DEBIT_ALLOCATION_ORDER.indexOf(type)` returns `-1` for a type not in the list, which would sort it ahead of everything; `rankDebitType` maps that to `Number.MAX_SAFE_INTEGER` instead.

## Review Focus

Five conditions the spec implies that no task's happy path exercises. Each has a test assigned to the task that owns the code.

- **A payment larger than everything owed** — the leftover must stay as `openAmount` on the payment, which *is* a customer credit balance, and the account balance must go negative. Overpayment needs no special case (§5). Test in Task 3.
- **A payment amount of `0`, or negative** — `CHECK (amount <> 0)` would reject zero from deep inside the transaction as a 500, and a negative input would post money received as money owed. Both must be a 400 at the edge. Test in Task 1 and Task 6.
- **A `FEE` outranks an older `BILL_CHARGE`** — ordering is by type class first and date second, so a fee raised today is paid before a bill due six months ago (§6.3). A comparator sorted by date first passes every happy-path test. Test in Task 2.
- **Reversing a partially-applied payment** — must restore exactly what each application consumed and no more. A reversal that restores the payment's full `amount` to the debits silently creates money. Test in Task 5.
- **Reversing the same entry twice, and reversing a `REVERSAL`** — both must be refused with a 409. Without the first guard, each reversal doubles the correction; the second has no coherent meaning. Test in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/validators/ledger.ts` | Add `DEBIT_ALLOCATION_ORDER`, `recordPaymentSchema`, `reverseEntrySchema` |
| `packages/shared/src/events/index.ts` | Add `LEDGER_PAYMENT_CREATED`, `LEDGER_REVERSAL_CREATED` |
| `packages/shared/src/modules/constants.ts` | Add the `payments` module key, its label, and role presets |
| `packages/api/src/services/ar/posting.service.ts` | Extract and export `lockAccount`; auto-apply open credits (§6.1 step 4) |
| `packages/api/src/services/ar/allocation.service.ts` | **New.** The two allocation walks and their comparator |
| `packages/api/src/services/ar/payment.service.ts` | **New.** `recordPayment` |
| `packages/api/src/services/ar/reversal.service.ts` | **New.** `reverseEntry` |
| `packages/api/src/routes/ar.ts` | Add the payment and reverse endpoints |

---

## Task 1: Shared vocabulary — allocation order, validators, module key

**Files:**
- Modify: `packages/shared/src/validators/ledger.ts`
- Modify: `packages/shared/src/events/index.ts`
- Modify: `packages/shared/src/modules/constants.ts`
- Test: `packages/shared/src/validators/__tests__/ledger.test.ts`

**Interfaces:**
- Consumes: `DebitType`, `CreditType` from `validators/ledger.ts` (slice 1).
- Produces:
  - `DEBIT_ALLOCATION_ORDER: readonly ["FEE", "ADJUSTMENT_DEBIT", "BILL_CHARGE"]`
  - `recordPaymentSchema` → `RecordPaymentInput = { amount: string; tender: "CARD"|"ACH"|"CASH"|"CHECK"|"LOCKBOX"; receivedAt?: string; externalRef?: string; memo?: string }`
  - `reverseEntrySchema` → `ReverseEntryInput = { reasonId?: string; memo?: string }`
  - `EVENT_TYPES.LEDGER_PAYMENT_CREATED = "ledger_payment.created"`, `EVENT_TYPES.LEDGER_REVERSAL_CREATED = "ledger_reversal.created"`
  - Module key `"payments"`

- [ ] **Step 1: Write the failing tests**

In `packages/shared/src/validators/__tests__/ledger.test.ts`, append:

```ts
import {
  DEBIT_ALLOCATION_ORDER,
  recordPaymentSchema,
  reverseEntrySchema,
} from "../ledger";

describe("DEBIT_ALLOCATION_ORDER", () => {
  // Spec §6.3: reconnection fees, then late fees, then oldest bills FIFO.
  it("ranks fees before adjustments before bill charges", () => {
    expect([...DEBIT_ALLOCATION_ORDER]).toEqual([
      "FEE",
      "ADJUSTMENT_DEBIT",
      "BILL_CHARGE",
    ]);
  });

  it("covers every debit type, so no debit is unrankable", () => {
    const debitTypes = ["BILL_CHARGE", "FEE", "ADJUSTMENT_DEBIT"];
    expect([...DEBIT_ALLOCATION_ORDER].sort()).toEqual(debitTypes.sort());
  });
});

describe("recordPaymentSchema", () => {
  it("accepts a positive amount with a tender", () => {
    expect(recordPaymentSchema.parse({ amount: "50.00", tender: "CHECK" })).toEqual({
      amount: "50.00",
      tender: "CHECK",
    });
  });

  // Review Focus: a negative amount would post money received as money owed.
  it("rejects a negative or zero amount", () => {
    expect(() => recordPaymentSchema.parse({ amount: "-50.00", tender: "CHECK" })).toThrow();
    expect(() => recordPaymentSchema.parse({ amount: "0.00", tender: "CHECK" })).toThrow();
    expect(() => recordPaymentSchema.parse({ amount: "0", tender: "CHECK" })).toThrow();
  });

  it("rejects a non-decimal amount and more than two decimal places", () => {
    expect(() => recordPaymentSchema.parse({ amount: "fifty", tender: "CHECK" })).toThrow();
    expect(() => recordPaymentSchema.parse({ amount: "50.001", tender: "CHECK" })).toThrow();
  });

  it("requires a tender and rejects an unknown one", () => {
    expect(() => recordPaymentSchema.parse({ amount: "50.00" })).toThrow();
    expect(() => recordPaymentSchema.parse({ amount: "50.00", tender: "BITCOIN" })).toThrow();
  });

  it("rejects a receivedAt that is not a real date", () => {
    expect(() =>
      recordPaymentSchema.parse({ amount: "50.00", tender: "CHECK", receivedAt: "2026-02-30" }),
    ).toThrow();
  });
});

describe("reverseEntrySchema", () => {
  it("accepts an empty body — reasonId is slice 3", () => {
    expect(reverseEntrySchema.parse({})).toEqual({});
  });

  it("rejects a reasonId that is not a uuid", () => {
    expect(() => reverseEntrySchema.parse({ reasonId: "nope" })).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && pnpm exec vitest run src/validators/__tests__/ledger.test.ts`
Expected: FAIL — `DEBIT_ALLOCATION_ORDER is not exported`.

- [ ] **Step 3: Add the constant and the schemas**

In `packages/shared/src/validators/ledger.ts`, after `ENTRY_SIGN`:

```ts
/**
 * The order open debits are paid down in: fees first, then manual
 * debits, then bills — so a reconnection or late fee clears before the
 * oldest bill. Within a class, oldest `dueDate` wins, tie-broken by
 * `postedAt`. See spec §6.3.
 *
 * One constant, deliberately. Spec 10 wants this tenant-configurable;
 * it is not built, because no second tenant wants a different order.
 * When one does it moves to `TenantSetting`, which already exists.
 */
export const DEBIT_ALLOCATION_ORDER = [
  "FEE",
  "ADJUSTMENT_DEBIT",
  "BILL_CHARGE",
] as const satisfies readonly DebitType[];
```

Then, after `postBillSchema`:

```ts
/** A money amount as a positive decimal string with at most 2dp. */
const positiveMoney = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "must be a positive amount with at most 2 decimal places")
  .refine((s) => Number(s) > 0, "amount must be greater than zero");

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine(
    (s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
    "not a real date",
  );

/**
 * Body for POST /api/v1/accounts/:id/payments.
 *
 * `amount` is **positive** here — what the operator typed, money
 * received. The service negates it when it writes the PAYMENT entry,
 * because the ledger's sign convention is the customer's obligation to
 * the utility (§3.3a). Rejecting a negative here is what stops money
 * received being posted as money owed.
 */
export const recordPaymentSchema = z.object({
  amount: positiveMoney,
  tender: z.enum(["CARD", "ACH", "CASH", "CHECK", "LOCKBOX"]),
  receivedAt: calendarDate.optional(),
  externalRef: z.string().max(100).optional(),
  memo: z.string().max(2000).optional(),
});

export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

/**
 * Body for POST /api/v1/ledger-entries/:id/reverse.
 *
 * `reasonId` is optional in slice 2 because `LedgerReasonDef` is seeded
 * in slice 3; §4.2's required-reason list excludes REVERSAL, so this is
 * consistent with the data model rather than a shortcut.
 */
export const reverseEntrySchema = z.object({
  reasonId: z.string().uuid().optional(),
  memo: z.string().max(2000).optional(),
});

export type ReverseEntryInput = z.infer<typeof reverseEntrySchema>;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/shared && pnpm exec vitest run src/validators/__tests__/ledger.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the event types**

In `packages/shared/src/events/index.ts`, after `LEDGER_ENTRY_CREATED`:

```ts
  LEDGER_PAYMENT_CREATED: "ledger_payment.created",
  LEDGER_REVERSAL_CREATED: "ledger_reversal.created",
```

Both keys agree with their values, and both end `.created` so `audit-wrap`'s `mapEventTypeToAction` records them as CREATE.

- [ ] **Step 6: Add the module key**

In `packages/shared/src/modules/constants.ts`: add `"payments",` to `MODULES` immediately after `"accounts"`; add `payments: { label: "Payments", icon: "faMoneyCheckDollar" },` to `MODULE_META` in the same position; and in the role presets add `payments: ["VIEW", "CREATE", "EDIT"],` to CSR, `payments: ["VIEW"],` to Read-Only. Leave Field Technician without it.

`ar_adjustments` is **not** added here — it belongs to slice 3, with the credits, waivers and write-offs it gates.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck
git add packages/shared/src
git commit -m "feat(ar): allocation order, payment and reversal validators, payments module key (slice 2 task 1)"
```

---

## Task 2: Allocation — the two walks

**Files:**
- Modify: `packages/api/src/services/ar/posting.service.ts` (extract and export `lockAccount`)
- Create: `packages/api/src/services/ar/allocation.service.ts`
- Test: `packages/api/src/__tests__/integration/ledger-allocation.integration.test.ts`

**Interfaces:**
- Consumes: `TxClient` and `recomputeAccountCache` from `posting.service.js`; `DEBIT_ALLOCATION_ORDER` from `@utility-cis/shared`.
- Produces:
  - `lockAccount(tx: TxClient, utilityId: string, accountId: string): Promise<void>` — exported from `posting.service.ts`, throws `ACCOUNT_NOT_FOUND` (404) when no row matches.
  - `interface Application { applicationId: string; creditId: string; debitId: string; amount: string }`
  - `rankDebitType(type: string): number`
  - `applyCreditToDebits(tx, utilityId, accountId, creditId): Promise<Application[]>`
  - `applyCreditsToDebit(tx, utilityId, accountId, debitId): Promise<Application[]>`

Neither allocation function recomputes the balance — its caller does, once, after allocating.

- [ ] **Step 1: Extract `lockAccount` in posting.service.ts**

Replace the lock block inside `recomputeAccountCache` with a call, and add the exported function above it:

```ts
/**
 * Take the per-account row lock that every balance-changing path holds.
 *
 * Asserting a row came back matters twice over: `SELECT ... FOR UPDATE`
 * takes no lock at all when it matches nothing, and proving the row is
 * this tenant's is what makes the later `account.update` safe, since
 * Prisma's `where: { id }` carries no utilityId and RLS does not
 * currently enforce.
 */
export async function lockAccount(
  tx: TxClient,
  utilityId: string,
  accountId: string,
): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM account
     WHERE id = ${accountId}::uuid AND utility_id = ${utilityId}::uuid
       FOR UPDATE`;
  if (locked.length === 0) {
    throw err("ACCOUNT_NOT_FOUND", `Account ${accountId} not found`, 404);
  }
}
```

`recomputeAccountCache`'s first statement becomes `await lockAccount(tx, utilityId, accountId);`, keeping the docstring sentence that says it locks.

- [ ] **Step 2: Write the failing tests**

Create `packages/api/src/__tests__/integration/ledger-allocation.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 2 — applying an open credit to open debits in the §6.3 order:
 * type class first (FEE, ADJUSTMENT_DEBIT, BILL_CHARGE), then oldest
 * dueDate, then postedAt.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");
let allocation: typeof import("../../services/ar/allocation.service.js");

let accountId: string;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  allocation = await import("../../services/ar/allocation.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "ALLOC-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: cycle.id,
    },
  });
  accountId = account.id;
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.ledgerApplication.deleteMany({});
  await prisma.ledgerEntry.deleteMany({});
  await prisma.account.update({
    where: { id: accountId },
    data: { balance: 0, lastDueDate: null },
  });
});

async function debit(
  type: "BILL_CHARGE" | "FEE" | "ADJUSTMENT_DEBIT",
  amount: string,
  dueDate: string,
): Promise<string> {
  const { prisma } = prismaImports;
  // BILL_CHARGE requires a bill_id by CHECK, so use ADJUSTMENT_DEBIT's
  // shape for the ordering fixtures and cover BILL_CHARGE via postBill
  // in the payment suite.
  const e = await prisma.ledgerEntry.create({
    data: {
      utilityId,
      accountId,
      type,
      amount,
      openAmount: amount,
      dueDate: new Date(dueDate),
      effectiveDate: new Date(dueDate),
      createdBy: ACTOR,
    },
  });
  return e.id;
}

async function credit(amount: string): Promise<string> {
  const { prisma } = prismaImports;
  const e = await prisma.ledgerEntry.create({
    data: {
      utilityId,
      accountId,
      type: "PAYMENT",
      amount: `-${amount}`,
      openAmount: `-${amount}`,
      effectiveDate: new Date("2026-06-01"),
      tender: "CHECK",
      createdBy: ACTOR,
    },
  });
  return e.id;
}

async function openOf(id: string): Promise<string> {
  const { prisma } = prismaImports;
  const e = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id } });
  return e.openAmount.toFixed(2);
}

describe("rankDebitType", () => {
  it("ranks the three debit types in the spec's order", () => {
    expect(allocation.rankDebitType("FEE")).toBeLessThan(
      allocation.rankDebitType("ADJUSTMENT_DEBIT"),
    );
    expect(allocation.rankDebitType("ADJUSTMENT_DEBIT")).toBeLessThan(
      allocation.rankDebitType("BILL_CHARGE"),
    );
  });

  // Decision 5: indexOf returns -1 for an unknown type, which would sort
  // it ahead of everything. It must sort last instead.
  it("ranks an unknown type last, not first", () => {
    expect(allocation.rankDebitType("REVERSAL")).toBeGreaterThan(
      allocation.rankDebitType("BILL_CHARGE"),
    );
  });
});

describe("applyCreditToDebits", () => {
  it("consumes a single debit exactly and closes both sides", async () => {
    const { prisma } = prismaImports;
    const d = await debit("ADJUSTMENT_DEBIT", "40.00", "2026-06-14");
    const c = await credit("40.00");

    const made = await prisma.$transaction((tx) =>
      allocation.applyCreditToDebits(tx, utilityId, accountId, c),
    );

    expect(made).toHaveLength(1);
    expect(made[0]!.amount).toBe("40.00");
    expect(await openOf(d)).toBe("0.00");
    expect(await openOf(c)).toBe("0.00");
  });

  // Review Focus: class beats date.
  it("pays a fee raised today before a bill due six months ago", async () => {
    const { prisma } = prismaImports;
    const old = await debit("ADJUSTMENT_DEBIT", "100.00", "2026-01-01");
    const fee = await debit("FEE", "25.00", "2026-06-30");
    const c = await credit("25.00");

    await prisma.$transaction((tx) =>
      allocation.applyCreditToDebits(tx, utilityId, accountId, c),
    );

    expect(await openOf(fee)).toBe("0.00");
    expect(await openOf(old)).toBe("100.00");
  });

  it("takes the oldest dueDate within a class", async () => {
    const { prisma } = prismaImports;
    const newer = await debit("ADJUSTMENT_DEBIT", "30.00", "2026-06-14");
    const older = await debit("ADJUSTMENT_DEBIT", "30.00", "2026-05-14");
    const c = await credit("30.00");

    await prisma.$transaction((tx) =>
      allocation.applyCreditToDebits(tx, utilityId, accountId, c),
    );

    expect(await openOf(older)).toBe("0.00");
    expect(await openOf(newer)).toBe("30.00");
  });

  it("spreads across debits and leaves a shortfall open", async () => {
    const { prisma } = prismaImports;
    const a = await debit("ADJUSTMENT_DEBIT", "30.00", "2026-05-14");
    const b = await debit("ADJUSTMENT_DEBIT", "30.00", "2026-06-14");
    const c = await credit("45.00");

    const made = await prisma.$transaction((tx) =>
      allocation.applyCreditToDebits(tx, utilityId, accountId, c),
    );

    expect(made.map((m) => m.amount)).toEqual(["30.00", "15.00"]);
    expect(await openOf(a)).toBe("0.00");
    expect(await openOf(b)).toBe("15.00");
    expect(await openOf(c)).toBe("0.00");
  });

  it("leaves the credit open when there is nothing to pay", async () => {
    const { prisma } = prismaImports;
    const c = await credit("25.00");

    const made = await prisma.$transaction((tx) =>
      allocation.applyCreditToDebits(tx, utilityId, accountId, c),
    );

    expect(made).toEqual([]);
    expect(await openOf(c)).toBe("-25.00");
  });

  it("writes one LedgerApplication row per application, all positive", async () => {
    const { prisma } = prismaImports;
    await debit("ADJUSTMENT_DEBIT", "30.00", "2026-05-14");
    await debit("ADJUSTMENT_DEBIT", "30.00", "2026-06-14");
    const c = await credit("45.00");

    await prisma.$transaction((tx) =>
      allocation.applyCreditToDebits(tx, utilityId, accountId, c),
    );

    const apps = await prisma.ledgerApplication.findMany({ where: { utilityId } });
    expect(apps).toHaveLength(2);
    for (const a of apps) expect(Number(a.amount)).toBeGreaterThan(0);
  });

  it("does not touch another tenant's debits", async () => {
    const { prisma } = prismaImports;
    const other = "00000000-0000-4000-8000-0000000000bb";
    const otherCycle = await prisma.billingCycle.create({
      data: { utilityId: other, name: "R1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
    });
    const otherAccount = await prisma.account.create({
      data: {
        utilityId: other,
        accountNumber: "ALLOC-OTHER",
        accountType: "RESIDENTIAL",
        status: "ACTIVE",
        billingCycleId: otherCycle.id,
      },
    });
    const strayDebit = await prisma.ledgerEntry.create({
      data: {
        utilityId: other,
        accountId: otherAccount.id,
        type: "ADJUSTMENT_DEBIT",
        amount: "90.00",
        openAmount: "90.00",
        dueDate: new Date("2026-01-01"),
        effectiveDate: new Date("2026-01-01"),
      },
    });
    const c = await credit("90.00");

    try {
      const made = await prisma.$transaction((tx) =>
        allocation.applyCreditToDebits(tx, utilityId, accountId, c),
      );
      expect(made).toEqual([]);
      const stray = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: strayDebit.id } });
      expect(stray.openAmount.toFixed(2)).toBe("90.00");
    } finally {
      await prisma.ledgerEntry.delete({ where: { id: strayDebit.id } });
      await prisma.account.delete({ where: { id: otherAccount.id } });
      await prisma.billingCycle.delete({ where: { id: otherCycle.id } });
    }
  });
});

describe("applyCreditsToDebit", () => {
  it("consumes open credits oldest postedAt first", async () => {
    const { prisma } = prismaImports;
    const first = await credit("10.00");
    const second = await credit("10.00");
    // postedAt defaults to now(); force a deterministic order.
    await prisma.$executeRaw`UPDATE ledger_entry SET posted_at = now() - interval '2 days' WHERE id = ${first}::uuid`;
    await prisma.$executeRaw`UPDATE ledger_entry SET posted_at = now() - interval '1 day' WHERE id = ${second}::uuid`;
    const d = await debit("ADJUSTMENT_DEBIT", "15.00", "2026-06-14");

    const made = await prisma.$transaction((tx) =>
      allocation.applyCreditsToDebit(tx, utilityId, accountId, d),
    );

    expect(made.map((m) => m.creditId)).toEqual([first, second]);
    expect(await openOf(first)).toBe("0.00");
    expect(await openOf(second)).toBe("-5.00");
    expect(await openOf(d)).toBe("0.00");
  });

  it("is a no-op when no credit is open", async () => {
    const { prisma } = prismaImports;
    const d = await debit("ADJUSTMENT_DEBIT", "15.00", "2026-06-14");
    const made = await prisma.$transaction((tx) =>
      allocation.applyCreditsToDebit(tx, utilityId, accountId, d),
    );
    expect(made).toEqual([]);
    expect(await openOf(d)).toBe("15.00");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-allocation.integration.test.ts`
Expected: FAIL — cannot resolve `../../services/ar/allocation.service.js`.

- [ ] **Step 4: Write allocation.service.ts**

```ts
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { DEBIT_ALLOCATION_ORDER } from "@utility-cis/shared";
import { lockAccount, type TxClient } from "./posting.service.js";

/**
 * Applying open credits to open debits.
 *
 * Two walks over one mechanic, because both directions are needed: a new
 * payment consumes existing debits (§6.2), and a newly posted debit
 * consumes existing credits (§6.1 step 4). Each application consumes
 * what it can; a shortfall stays as `openAmount` on whichever side ran
 * out, so partial payments and overpayments need no special case.
 *
 * Neither function recomputes `Account.balance` — the caller does that
 * once, after allocating, so one operation writes the cache once.
 */

export interface Application {
  applicationId: string;
  creditId: string;
  debitId: string;
  amount: string;
}

/**
 * Where a debit type sits in the payment order. Lower is paid first.
 *
 * An unknown type ranks LAST. `indexOf` returns -1 for anything not in
 * the list, which would sort it ahead of a fee; the only types that can
 * reach here and are not in the list are credits (filtered out by
 * `openAmount > 0`) and REVERSAL, whose openAmount is 0 by construction
 * because `reverseEntry` applies it against the entry it reverses.
 */
export function rankDebitType(type: string): number {
  const i = (DEBIT_ALLOCATION_ORDER as readonly string[]).indexOf(type);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

interface DebitRow {
  id: string;
  type: string;
  openAmount: Prisma.Decimal;
  dueDate: Date | null;
  postedAt: Date;
}

/** Spec §6.3: type class, then oldest dueDate, then postedAt. */
function compareDebits(a: DebitRow, b: DebitRow): number {
  const rank = rankDebitType(a.type) - rankDebitType(b.type);
  if (rank !== 0) return rank;
  // A debit with no dueDate cannot age, so it sorts after ones that can.
  const da = a.dueDate ? a.dueDate.getTime() : Number.MAX_SAFE_INTEGER;
  const db = b.dueDate ? b.dueDate.getTime() : Number.MAX_SAFE_INTEGER;
  if (da !== db) return da - db;
  const pa = a.postedAt.getTime();
  const pb = b.postedAt.getTime();
  if (pa !== pb) return pa - pb;
  // Total order, so a tie never depends on row order from the database.
  return a.id.localeCompare(b.id);
}

async function apply(
  tx: TxClient,
  utilityId: string,
  creditId: string,
  debitId: string,
  amount: Prisma.Decimal,
): Promise<Application> {
  const row = await tx.ledgerApplication.create({
    data: { utilityId, creditId, debitId, amount },
  });
  // A debit's openAmount shrinks toward 0; a credit's grows toward 0.
  await tx.ledgerEntry.update({
    where: { id: debitId },
    data: { openAmount: { decrement: amount } },
  });
  await tx.ledgerEntry.update({
    where: { id: creditId },
    data: { openAmount: { increment: amount } },
  });
  return {
    applicationId: row.id,
    creditId,
    debitId,
    amount: amount.toFixed(2),
  };
}

/**
 * Consume one open credit against this account's open debits, in the
 * §6.3 order. Leftover stays open on the credit — a credit balance.
 */
export async function applyCreditToDebits(
  tx: TxClient,
  utilityId: string,
  accountId: string,
  creditId: string,
): Promise<Application[]> {
  await lockAccount(tx, utilityId, accountId);

  const credit = await tx.ledgerEntry.findFirstOrThrow({
    where: { id: creditId, utilityId, accountId },
    select: { openAmount: true },
  });
  let remaining = credit.openAmount.negated();
  if (remaining.lte(0)) return [];

  const debits = await tx.ledgerEntry.findMany({
    where: { utilityId, accountId, openAmount: { gt: 0 } },
    select: { id: true, type: true, openAmount: true, dueDate: true, postedAt: true },
  });
  debits.sort(compareDebits);

  const made: Application[] = [];
  for (const d of debits) {
    if (remaining.lte(0)) break;
    const amount = Prisma.Decimal.min(remaining, d.openAmount);
    made.push(await apply(tx, utilityId, creditId, d.id, amount));
    remaining = remaining.minus(amount);
  }
  return made;
}

/**
 * Consume this account's open credits against one open debit, oldest
 * `postedAt` first, so a credit balance is absorbed by the next charge
 * without a sweep job. Spec §6.1 step 4.
 */
export async function applyCreditsToDebit(
  tx: TxClient,
  utilityId: string,
  accountId: string,
  debitId: string,
): Promise<Application[]> {
  await lockAccount(tx, utilityId, accountId);

  const debit = await tx.ledgerEntry.findFirstOrThrow({
    where: { id: debitId, utilityId, accountId },
    select: { openAmount: true },
  });
  let remaining = debit.openAmount;
  if (remaining.lte(0)) return [];

  const credits = await tx.ledgerEntry.findMany({
    where: { utilityId, accountId, openAmount: { lt: 0 } },
    orderBy: [{ postedAt: "asc" }, { id: "asc" }],
    select: { id: true, openAmount: true },
  });

  const made: Application[] = [];
  for (const c of credits) {
    if (remaining.lte(0)) break;
    const available = c.openAmount.negated();
    const amount = Prisma.Decimal.min(remaining, available);
    made.push(await apply(tx, utilityId, c.id, debitId, amount));
    remaining = remaining.minus(amount);
  }
  return made;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-allocation.integration.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Prove the ordering test discriminates**

Temporarily change `compareDebits` to compare `dueDate` before `rank`. Run the suite. Expected: "pays a fee raised today before a bill due six months ago" FAILS with `expected '25.00' to be '0.00'`. Restore.

- [ ] **Step 7: Confirm slice 1 still passes, then commit**

```bash
cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-posting.integration.test.ts src/__tests__/integration/ledger-reconciliation.integration.test.ts
cd ../.. && pnpm typecheck
git add packages/api/src
git commit -m "feat(ar): apply open credits to open debits in the spec's order (slice 2 task 2)"
```

---

## Task 3: `recordPayment`

**Files:**
- Create: `packages/api/src/services/ar/payment.service.ts`
- Test: `packages/api/src/__tests__/integration/ledger-payment.integration.test.ts`

**Interfaces:**
- Consumes: `applyCreditToDebits`, `Application` from `allocation.service.js`; `lockAccount`, `recomputeAccountCache`, `TxClient` from `posting.service.js`; `RecordPaymentInput`, `EVENT_TYPES` from `@utility-cis/shared`; `writeAuditRow` from `../../lib/audit-wrap.js`.
- Produces:
  - `interface RecordPaymentResult { paymentId: string; amount: string; applied: Application[]; unapplied: string; balance: string }`
  - `recordPayment(utilityId: string, actorId: string, actorName: string, accountId: string, input: RecordPaymentInput, existingTx?: TxClient): Promise<RecordPaymentResult>`

`amount` in the result is the **signed** ledger amount (negative). `unapplied` is the absolute value left as a credit balance.

- [ ] **Step 1: Write the failing tests**

Create `packages/api/src/__tests__/integration/ledger-payment.integration.test.ts` with the same `beforeAll`/`beforeEach` shape as Task 2's suite (account `PAY-001`, plus `posting` and `payment` imports), and these cases:

```ts
describe("recordPayment", () => {
  it("writes a negative PAYMENT and reduces the balance", async () => {
    const { prisma } = prismaImports;
    await debit("ADJUSTMENT_DEBIT", "100.00", "2026-06-14");
    await prisma.$transaction((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));

    const res = await payment.recordPayment(utilityId, ACTOR, "Tester", accountId, {
      amount: "40.00",
      tender: "CHECK",
    });

    expect(res.amount).toBe("-40.00");
    expect(res.balance).toBe("60.00");
    expect(res.applied).toHaveLength(1);
    expect(res.unapplied).toBe("0.00");

    const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.paymentId } });
    expect(entry.type).toBe("PAYMENT");
    expect(entry.amount.toFixed(2)).toBe("-40.00");
    expect(entry.tender).toBe("CHECK");
    expect(entry.dueDate).toBeNull();
  });

  // Review Focus: overpayment becomes a credit balance, no special case.
  it("leaves the remainder open and the balance negative when it overpays", async () => {
    const { prisma } = prismaImports;
    const d = await debit("ADJUSTMENT_DEBIT", "30.00", "2026-06-14");
    await prisma.$transaction((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));

    const res = await payment.recordPayment(utilityId, ACTOR, "Tester", accountId, {
      amount: "50.00",
      tender: "CARD",
    });

    expect(res.unapplied).toBe("20.00");
    expect(res.balance).toBe("-20.00");
    expect(await openOf(d)).toBe("0.00");
    expect(await openOf(res.paymentId)).toBe("-20.00");

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("-20.00");
    // Nothing is open, so nothing ages.
    expect(account.lastDueDate).toBeNull();
  });

  it("records a payment on an account that owes nothing", async () => {
    const res = await payment.recordPayment(utilityId, ACTOR, "Tester", accountId, {
      amount: "25.00",
      tender: "CASH",
    });
    expect(res.applied).toEqual([]);
    expect(res.unapplied).toBe("25.00");
    expect(res.balance).toBe("-25.00");
  });

  it("writes one audit row for the payment", async () => {
    const { prisma } = prismaImports;
    const res = await payment.recordPayment(utilityId, ACTOR, "Tester", accountId, {
      amount: "10.00",
      tender: "ACH",
    });
    const audits = await prisma.auditLog.findMany({
      where: { entityType: "LedgerEntry", entityId: res.paymentId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("CREATE");
  });

  it("refuses an unknown account and an account in another tenant", async () => {
    await expect(
      payment.recordPayment(utilityId, ACTOR, "Tester", "00000000-0000-4000-8000-00000000dead", {
        amount: "10.00",
        tender: "CASH",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("leaves nothing behind when the caller's transaction rolls back", async () => {
    const { prisma } = prismaImports;
    await expect(
      prisma.$transaction(async (tx) => {
        await payment.recordPayment(
          utilityId, ACTOR, "Tester", accountId,
          { amount: "10.00", tender: "CASH" }, tx,
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await prisma.ledgerEntry.count({ where: { accountId } })).toBe(0);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("0.00");
  });

  it("serializes two concurrent payments on one account", async () => {
    const { prisma } = prismaImports;
    await debit("ADJUSTMENT_DEBIT", "100.00", "2026-06-14");
    await prisma.$transaction((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));

    await Promise.all([
      payment.recordPayment(utilityId, ACTOR, "T", accountId, { amount: "30.00", tender: "CASH" }),
      payment.recordPayment(utilityId, ACTOR, "T", accountId, { amount: "20.00", tender: "CASH" }),
    ]);

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("50.00");
    const sum = await prisma.$queryRaw<{ s: string }[]>`
      SELECT COALESCE(SUM(open_amount),0)::text AS s FROM ledger_entry
       WHERE utility_id = ${utilityId}::uuid AND account_id = ${accountId}::uuid`;
    expect(Number(sum[0]!.s)).toBe(50);
  }, 60_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-payment.integration.test.ts`
Expected: FAIL — cannot resolve `../../services/ar/payment.service.js`.

- [ ] **Step 3: Write payment.service.ts**

```ts
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { EVENT_TYPES, type RecordPaymentInput } from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { lockAccount, recomputeAccountCache, type TxClient } from "./posting.service.js";
import { applyCreditToDebits, type Application } from "./allocation.service.js";

/**
 * Recording money received against an account.
 *
 * The request carries a POSITIVE amount — what the operator typed. This
 * is where it becomes negative, because the ledger's sign convention is
 * the customer's obligation to the utility (§3.3a): money received
 * reduces it. The validator refuses a negative input, so there is
 * exactly one negation on this path and it is here.
 *
 * Insert, allocate (§6.3), recompute the cache — one transaction.
 */

export interface RecordPaymentResult {
  paymentId: string;
  /** The signed ledger amount, so negative. */
  amount: string;
  applied: Application[];
  /** Absolute value left unapplied — a customer credit balance. */
  unapplied: string;
  balance: string;
}

export async function recordPayment(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: RecordPaymentInput,
  existingTx?: TxClient,
): Promise<RecordPaymentResult> {
  const run = async (tx: TxClient): Promise<RecordPaymentResult> => {
    // Lock first: allocation reads open debits and writes them, so two
    // concurrent payments must serialize before either reads.
    await lockAccount(tx, utilityId, accountId);

    const signed = new Prisma.Decimal(input.amount).negated();
    const effectiveDate = new Date(input.receivedAt ?? new Date().toISOString().slice(0, 10));

    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "PAYMENT",
        amount: signed,
        openAmount: signed,
        // A credit has nothing to fall due.
        dueDate: null,
        effectiveDate,
        tender: input.tender,
        externalRef: input.externalRef ?? null,
        memo: input.memo ?? null,
        createdBy: actorId,
      },
    });

    const applied = await applyCreditToDebits(tx, utilityId, accountId, entry.id);
    const cache = await recomputeAccountCache(tx, utilityId, accountId);

    const after = await tx.ledgerEntry.findUniqueOrThrow({
      where: { id: entry.id },
      select: { openAmount: true },
    });

    return {
      paymentId: entry.id,
      amount: signed.toFixed(2),
      applied,
      unapplied: after.openAmount.negated().toFixed(2),
      balance: cache.balance,
    };
  };

  const runWithAudit = async (tx: TxClient): Promise<RecordPaymentResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_PAYMENT_CREATED,
      result.paymentId,
      null,
      result,
    );
    return result;
  };

  if (existingTx) return runWithAudit(existingTx);
  return prisma.$transaction(runWithAudit);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-payment.integration.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the sign is load-bearing**

Temporarily remove `.negated()` from `signed`. Run the suite. Expected: the first test fails on the `ledger_entry_type_sign` CHECK, because a PAYMENT with a positive amount is rejected by the database. Restore. Record the error text in the commit body.

- [ ] **Step 6: Commit**

```bash
cd ../.. && pnpm typecheck
git add packages/api/src
git commit -m "feat(ar): recordPayment writes the credit and allocates it (slice 2 task 3)"
```

---

## Task 4: `postBill` auto-applies open credits (§6.1 step 4)

**Files:**
- Modify: `packages/api/src/services/ar/posting.service.ts`
- Modify: `packages/api/src/__tests__/integration/ledger-posting.integration.test.ts`

**Interfaces:**
- Consumes: `applyCreditsToDebit` from `allocation.service.js`.
- Produces: `PostBillResult` gains `applied: Application[]`.

This removes slice 1's recorded deferral. The comment above the entry insert in `posting.service.ts` that says step 4 is deferred must be **deleted**, not amended.

- [ ] **Step 1: Write the failing test**

In `ledger-posting.integration.test.ts`, add:

```ts
it("absorbs an open credit when a bill posts", async () => {
  const { prisma } = prismaImports;
  // An open credit sitting on the account — an overpayment from before.
  const credit = await prisma.ledgerEntry.create({
    data: {
      utilityId, accountId, type: "PAYMENT",
      amount: "-20.00", openAmount: "-20.00",
      effectiveDate: new Date("2026-05-01"), tender: "CHECK", createdBy: ACTOR,
    },
  });

  const billId = await makeBill("50.0000");
  const result = await posting.postBill(utilityId, ACTOR, "Tester", billId);

  // The charge is reduced by the credit rather than both sitting open.
  const charge = await prisma.ledgerEntry.findFirstOrThrow({
    where: { billId, type: "BILL_CHARGE" },
  });
  expect(charge.amount.toFixed(2)).toBe("50.00");
  expect(charge.openAmount.toFixed(2)).toBe("30.00");

  const after = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: credit.id } });
  expect(after.openAmount.toFixed(2)).toBe("0.00");

  expect(result.applied).toHaveLength(1);
  expect(result.applied[0]!.amount).toBe("20.00");
  expect(result.balance).toBe("30.00");

  const apps = await prisma.ledgerApplication.findMany({ where: { utilityId } });
  expect(apps).toHaveLength(1);
});

it("does not absorb a credit that belongs to another account", async () => {
  const { prisma } = prismaImports;
  const otherAccount = await prisma.account.create({
    data: {
      utilityId, accountNumber: `LEDGER-OTHER-${Math.random().toString(36).slice(2, 7)}`,
      accountType: "RESIDENTIAL", status: "ACTIVE", billingCycleId,
    },
  });
  const strayCredit = await prisma.ledgerEntry.create({
    data: {
      utilityId, accountId: otherAccount.id, type: "PAYMENT",
      amount: "-20.00", openAmount: "-20.00",
      effectiveDate: new Date("2026-05-01"), tender: "CHECK", createdBy: ACTOR,
    },
  });

  const billId = await makeBill("50.0000");
  await posting.postBill(utilityId, ACTOR, "Tester", billId);

  const after = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: strayCredit.id } });
  expect(after.openAmount.toFixed(2)).toBe("-20.00");
  const charge = await prisma.ledgerEntry.findFirstOrThrow({ where: { billId } });
  expect(charge.openAmount.toFixed(2)).toBe("50.00");
});
```

Also update the existing `"nets a debit and a credit through the signed sum"` test: the balance assertion of `37.50` is unchanged and still correct, but add

```ts
  // The credit is now consumed by allocation rather than left open.
  const apps = await prisma.ledgerApplication.findMany({ where: { utilityId } });
  expect(apps).toHaveLength(1);
```

so the test states the new behaviour instead of passing by accident.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-posting.integration.test.ts -t "absorbs an open credit"`
Expected: FAIL — `expected '50.00' to be '30.00'`.

- [ ] **Step 3: Wire it in**

In `posting.service.ts`: add `import { applyCreditsToDebit, type Application } from "./allocation.service.js";`, add `applied: Application[]` to `PostBillResult`, return `applied: []` from the zero-amount path, and after the entry insert replace the slice-1 deferral comment with:

```ts
    // Spec §6.1 step 4 — absorb this account's open credits into the new
    // debit, oldest first, so a credit balance is consumed by the next
    // bill without a sweep job. A credit entry has nothing to absorb, so
    // this is a no-op on the negative-total path.
    const applied = await applyCreditsToDebit(tx, utilityId, bill.accountId, entry.id);
```

Thread `applied` into the returned result.

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-posting.integration.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run every slice 1 suite — this changes shipped behaviour**

```bash
cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/ledger-shape.integration.test.ts \
  src/__tests__/integration/ledger-posting.integration.test.ts \
  src/__tests__/integration/ledger-autopost.integration.test.ts \
  src/__tests__/integration/ledger-routes.integration.test.ts \
  src/__tests__/integration/ledger-reconciliation.integration.test.ts \
  src/__tests__/integration/ledger-allocation.integration.test.ts \
  src/__tests__/integration/ledger-payment.integration.test.ts \
  src/__tests__/integration/bill-creation.integration.test.ts
```

Expected: all pass. The reconciliation property test is the one to watch — it asserts `account.lastDueDate` equals its own model's oldest open debit, and auto-apply changes which debits are open.

- [ ] **Step 6: Commit**

```bash
cd ../.. && pnpm typecheck
git add packages/api/src
git commit -m "feat(ar): posting a bill absorbs open credits (slice 2 task 4, closes the §6.1 step 4 deferral)"
```

---

## Task 5: `reverseEntry`

**Files:**
- Create: `packages/api/src/services/ar/reversal.service.ts`
- Test: `packages/api/src/__tests__/integration/ledger-reversal.integration.test.ts`

**Interfaces:**
- Consumes: `lockAccount`, `recomputeAccountCache`, `TxClient` from `posting.service.js`; `ReverseEntryInput`, `EVENT_TYPES` from `@utility-cis/shared`.
- Produces:
  - `interface ReverseEntryResult { reversalId: string; reversedId: string; amount: string; restored: Array<{ entryId: string; openAmount: string }>; dependentFees: Array<{ id: string; amount: string; dueDate: string | null }>; balance: string }`
  - `reverseEntry(utilityId, actorId, actorName, entryId, input: ReverseEntryInput, existingTx?): Promise<ReverseEntryResult>`

`dependentFees` is **reported, never reversed** — §6.6 is explicit that a cascade is an operator decision.

- [ ] **Step 1: Write the failing tests**

Create `packages/api/src/__tests__/integration/ledger-reversal.integration.test.ts` with the Task 2 fixture shape (account `REV-001`) and:

```ts
describe("reverseEntry", () => {
  // Review Focus: restore exactly what was consumed, no more.
  it("restores a partially applied payment and leaves no reusable credit", async () => {
    const { prisma } = prismaImports;
    const d = await debit("ADJUSTMENT_DEBIT", "100.00", "2026-06-14");
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "40.00", tender: "CHECK",
    });
    expect(await openOf(d)).toBe("60.00");

    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {});

    // The 40.00 it consumed comes back on the debit — and only that.
    expect(await openOf(d)).toBe("100.00");
    expect(res.restored).toEqual([{ entryId: d, openAmount: "100.00" }]);
    // The bounced payment is closed, not left open for allocation to spend.
    expect(await openOf(pay.paymentId)).toBe("0.00");
    expect(await openOf(res.reversalId)).toBe("0.00");
    expect(res.balance).toBe("100.00");

    const rev = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.reversalId } });
    expect(rev.type).toBe("REVERSAL");
    expect(rev.amount.toFixed(2)).toBe("40.00");
    expect(rev.reversesId).toBe(pay.paymentId);

    // The application it undid is gone.
    expect(await prisma.ledgerApplication.count({ where: { creditId: pay.paymentId } })).toBe(0);
  });

  it("reversing a charge that was partly paid leaves the payment as a credit", async () => {
    const { prisma } = prismaImports;
    const d = await debit("ADJUSTMENT_DEBIT", "100.00", "2026-06-14");
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "30.00", tender: "CHECK",
    });

    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", d, {});

    expect(await openOf(d)).toBe("0.00");
    expect(await openOf(res.reversalId)).toBe("0.00");
    // They paid 30 toward a charge that no longer exists: a refund due.
    expect(await openOf(pay.paymentId)).toBe("-30.00");
    expect(res.balance).toBe("-30.00");
  });

  it("reverses an unapplied payment with nothing to restore", async () => {
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "25.00", tender: "CASH",
    });
    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {});
    expect(res.restored).toEqual([]);
    expect(res.balance).toBe("0.00");
    expect(await openOf(pay.paymentId)).toBe("0.00");
  });

  // Review Focus: both refusals.
  it("refuses to reverse the same entry twice", async () => {
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "25.00", tender: "CASH",
    });
    await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {});
    await expect(
      reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {}),
    ).rejects.toMatchObject({ code: "ENTRY_ALREADY_REVERSED" });
  });

  it("refuses to reverse a REVERSAL", async () => {
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "25.00", tender: "CASH",
    });
    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {});
    await expect(
      reversal.reverseEntry(utilityId, ACTOR, "T", res.reversalId, {}),
    ).rejects.toMatchObject({ code: "CANNOT_REVERSE_REVERSAL" });
  });

  it("reports dependent fees without reversing them", async () => {
    const { prisma } = prismaImports;
    const charge = await debit("ADJUSTMENT_DEBIT", "100.00", "2026-06-14");
    const fee = await prisma.ledgerEntry.create({
      data: {
        utilityId, accountId, type: "FEE",
        amount: "15.00", openAmount: "15.00",
        dueDate: new Date("2026-07-14"), effectiveDate: new Date("2026-06-20"),
        assessedOnId: charge, createdBy: ACTOR,
      },
    });

    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", charge, {});

    expect(res.dependentFees).toEqual([
      { id: fee.id, amount: "15.00", dueDate: "2026-07-14" },
    ]);
    // Reported, not reversed — §6.6 is explicit that this is a human call.
    const stillThere = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: fee.id } });
    expect(stillThere.openAmount.toFixed(2)).toBe("15.00");
    expect(await prisma.ledgerEntry.count({ where: { reversesId: fee.id } })).toBe(0);
  });

  it("refuses an entry in another tenant", async () => {
    await expect(
      reversal.reverseEntry(
        "00000000-0000-4000-8000-0000000000bb", ACTOR, "T",
        await debit("ADJUSTMENT_DEBIT", "10.00", "2026-06-14"), {},
      ),
    ).rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });
  });

  it("writes one audit row for the reversal", async () => {
    const { prisma } = prismaImports;
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "10.00", tender: "CASH",
    });
    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {});
    const audits = await prisma.auditLog.findMany({
      where: { entityType: "LedgerEntry", entityId: res.reversalId },
    });
    expect(audits).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-reversal.integration.test.ts`
Expected: FAIL — cannot resolve `../../services/ar/reversal.service.js`.

- [ ] **Step 3: Write reversal.service.ts**

```ts
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { EVENT_TYPES, type ReverseEntryInput } from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { lockAccount, recomputeAccountCache, type TxClient } from "./posting.service.js";

/**
 * Negating a posted entry and restoring what it consumed.
 *
 * `amount`, `type` and the dates are immutable once posted (§5), so a
 * correction is a new entry, never an edit. The REVERSAL carries the
 * opposite sign and names its target in `reversesId`.
 *
 * Three steps, and the third is the one the spec leaves open:
 *
 *  1. Undo the original's applications — give back exactly what each one
 *     consumed, then delete it.
 *  2. Restore the original's own `openAmount` to its full `amount`.
 *  3. Apply the reversal against the original, in full, which zeroes
 *     both. Without this the balance is still right, but a reversed
 *     payment stays an open credit that allocation will happily spend
 *     again — a bounced cheque paying a second bill.
 *
 * Dependent fees are REPORTED, never reversed. §6.6: if we billed wrong
 * the late fee probably should go, and if the corrected amount was also
 * unpaid it probably should stand. Only a human knows which.
 */

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export interface ReverseEntryResult {
  reversalId: string;
  reversedId: string;
  /** The reversal's signed amount — the opposite of the original's. */
  amount: string;
  restored: Array<{ entryId: string; openAmount: string }>;
  dependentFees: Array<{ id: string; amount: string; dueDate: string | null }>;
  balance: string;
}

export async function reverseEntry(
  utilityId: string,
  actorId: string,
  actorName: string,
  entryId: string,
  input: ReverseEntryInput,
  existingTx?: TxClient,
): Promise<ReverseEntryResult> {
  const run = async (tx: TxClient): Promise<ReverseEntryResult> => {
    const original = await tx.ledgerEntry.findFirst({
      where: { id: entryId, utilityId },
      select: { id: true, accountId: true, type: true, amount: true, dueDate: true },
    });
    if (!original) throw err("ENTRY_NOT_FOUND", `Ledger entry ${entryId} not found`, 404);
    if (original.type === "REVERSAL") {
      throw err("CANNOT_REVERSE_REVERSAL", "A reversal cannot itself be reversed", 409);
    }

    await lockAccount(tx, utilityId, original.accountId);

    // Re-read under the lock so a reversal that committed meanwhile is seen.
    const already = await tx.ledgerEntry.count({ where: { utilityId, reversesId: entryId } });
    if (already > 0) {
      throw err("ENTRY_ALREADY_REVERSED", `Ledger entry ${entryId} is already reversed`, 409);
    }

    // 1. Undo the applications this entry took part in.
    const apps = await tx.ledgerApplication.findMany({
      where: { utilityId, OR: [{ creditId: entryId }, { debitId: entryId }] },
      select: { id: true, creditId: true, debitId: true, amount: true },
    });
    const restored: Array<{ entryId: string; openAmount: string }> = [];
    for (const a of apps) {
      const counterpartyId = a.creditId === entryId ? a.debitId : a.creditId;
      // Give back exactly what this application consumed: a debit's
      // openAmount goes back up, a credit's back down.
      const back = a.creditId === entryId
        ? { openAmount: { increment: a.amount } }
        : { openAmount: { decrement: a.amount } };
      const updated = await tx.ledgerEntry.update({
        where: { id: counterpartyId },
        data: back,
        select: { id: true, openAmount: true },
      });
      restored.push({ entryId: updated.id, openAmount: updated.openAmount.toFixed(2) });
      await tx.ledgerApplication.delete({ where: { id: a.id } });
    }

    // 2. The original is whole again.
    await tx.ledgerEntry.update({
      where: { id: entryId },
      data: { openAmount: original.amount },
    });

    // 3. The reversal, and the application that settles it against the
    //    original. A REVERSAL's sign follows its target, so the type/sign
    //    CHECK requires only that reversesId is set.
    const amount = original.amount.negated();
    const reversal = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId: original.accountId,
        type: "REVERSAL",
        amount,
        openAmount: amount,
        // A positive reversal is owed again and ages from the original's
        // date; a negative one has nothing to fall due.
        dueDate: amount.gt(0) ? original.dueDate : null,
        effectiveDate: new Date(new Date().toISOString().slice(0, 10)),
        reversesId: entryId,
        reasonId: input.reasonId ?? null,
        memo: input.memo ?? `Reversal of ${original.type} ${entryId}`,
        createdBy: actorId,
      },
    });

    const settle = new Prisma.Decimal(original.amount.abs());
    await tx.ledgerApplication.create({
      data: {
        utilityId,
        creditId: amount.gt(0) ? entryId : reversal.id,
        debitId: amount.gt(0) ? reversal.id : entryId,
        amount: settle,
      },
    });
    await tx.ledgerEntry.updateMany({
      where: { id: { in: [entryId, reversal.id] } },
      data: { openAmount: 0 },
    });

    const dependents = await tx.ledgerEntry.findMany({
      where: { utilityId, assessedOnId: entryId },
      select: { id: true, amount: true, dueDate: true },
      orderBy: { postedAt: "asc" },
    });

    const cache = await recomputeAccountCache(tx, utilityId, original.accountId);

    return {
      reversalId: reversal.id,
      reversedId: entryId,
      amount: amount.toFixed(2),
      restored,
      dependentFees: dependents.map((f) => ({
        id: f.id,
        amount: f.amount.toFixed(2),
        dueDate: f.dueDate ? f.dueDate.toISOString().slice(0, 10) : null,
      })),
      balance: cache.balance,
    };
  };

  const runWithAudit = async (tx: TxClient): Promise<ReverseEntryResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_REVERSAL_CREATED,
      result.reversalId,
      null,
      result,
    );
    return result;
  };

  if (existingTx) return runWithAudit(existingTx);
  return prisma.$transaction(runWithAudit);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-reversal.integration.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove step 3 is load-bearing**

Temporarily delete the `ledgerApplication.create` and the `updateMany` that zero both sides. Run the suite. Expected: "restores a partially applied payment and leaves no reusable credit" FAILS with `expected '-40.00' to be '0.00'` on the bounced payment — demonstrating the reusable-credit bug the step exists to prevent. Restore, and paste the failure in the commit body.

- [ ] **Step 6: Commit**

```bash
cd ../.. && pnpm typecheck
git add packages/api/src
git commit -m "feat(ar): reverseEntry restores what an entry consumed and settles against it (slice 2 task 5)"
```

---

## Task 6: HTTP surface

**Files:**
- Modify: `packages/api/src/routes/ar.ts`
- Test: `packages/api/src/__tests__/integration/ledger-routes.integration.test.ts`

**Interfaces:**
- Consumes: `recordPayment`, `reverseEntry`, `recordPaymentSchema`, `reverseEntrySchema`, `idParamSchema`.
- Produces: `POST /api/v1/accounts/:id/payments` (`payments:CREATE`, 201) and `POST /api/v1/ledger-entries/:id/reverse` (`payments:EDIT`, 201).

- [ ] **Step 1: Write the failing tests**

In `ledger-routes.integration.test.ts`: register the `payments` module in `beforeAll` alongside `accounts`

```ts
  await prisma.tenantModule.create({ data: { utilityId, moduleKey: "payments" } });
```

give VIEWER `{ accounts: ["VIEW"], payments: ["VIEW"] }`, and add a `PAYER` subject with `{ accounts: ["VIEW"], payments: ["VIEW", "CREATE", "EDIT"] }`. Then:

```ts
describe("POST /api/v1/accounts/:id/payments", () => {
  it("records a payment and returns the new balance", async () => {
    const billId = await makeBill("25.0000");
    await app.inject({
      method: "POST", url: `/api/v1/bills/${billId}/post`,
      headers: headers(), payload: {},
    });

    const res = await app.inject({
      method: "POST", url: `/api/v1/accounts/${accountId}/payments`,
      headers: headers(PAYER), payload: { amount: "10.00", tender: "CHECK" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.amount).toBe("-10.00");
    expect(body.balance).toBe("15.00");
    expect(body.applied).toHaveLength(1);
  });

  // Review Focus: a negative amount must not become a charge.
  it("returns 400 for a negative or zero amount and records nothing", async () => {
    for (const amount of ["-10.00", "0.00"]) {
      const res = await app.inject({
        method: "POST", url: `/api/v1/accounts/${accountId}/payments`,
        headers: headers(PAYER), payload: { amount, tender: "CHECK" },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
    }
    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(0);
  });

  it("returns 403 without payments:CREATE and records nothing", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/v1/accounts/${accountId}/payments`,
      headers: headers(VIEWER), payload: { amount: "10.00", tender: "CHECK" },
    });
    expect(res.statusCode).toBe(403);
    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(0);
  });

  it("returns 404 for another tenant's account", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/v1/accounts/${otherAccountId}/payments`,
      headers: headers(PAYER), payload: { amount: "10.00", tender: "CHECK" },
    });
    expect(res.statusCode).toBe(404);
    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(0);
  });
});

describe("POST /api/v1/ledger-entries/:id/reverse", () => {
  it("reverses a payment and reports no dependent fees", async () => {
    const billId = await makeBill("25.0000");
    await app.inject({
      method: "POST", url: `/api/v1/bills/${billId}/post`, headers: headers(), payload: {},
    });
    const paid = await app.inject({
      method: "POST", url: `/api/v1/accounts/${accountId}/payments`,
      headers: headers(PAYER), payload: { amount: "25.00", tender: "CHECK" },
    });
    const paymentId = JSON.parse(paid.body).paymentId;

    const res = await app.inject({
      method: "POST", url: `/api/v1/ledger-entries/${paymentId}/reverse`,
      headers: headers(PAYER), payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.amount).toBe("25.00");
    expect(body.balance).toBe("25.00");
    expect(body.dependentFees).toEqual([]);
  });

  it("returns 409 on a second reverse of the same entry", async () => {
    const billId = await makeBill("25.0000");
    const posted = await app.inject({
      method: "POST", url: `/api/v1/bills/${billId}/post`, headers: headers(), payload: {},
    });
    const entryId = JSON.parse(posted.body).entryId;

    const first = await app.inject({
      method: "POST", url: `/api/v1/ledger-entries/${entryId}/reverse`,
      headers: headers(PAYER), payload: {},
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST", url: `/api/v1/ledger-entries/${entryId}/reverse`,
      headers: headers(PAYER), payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error.code).toBe("ENTRY_ALREADY_REVERSED");
  });

  it("returns 403 without payments:EDIT", async () => {
    const billId = await makeBill("25.0000");
    const posted = await app.inject({
      method: "POST", url: `/api/v1/bills/${billId}/post`, headers: headers(), payload: {},
    });
    const res = await app.inject({
      method: "POST", url: `/api/v1/ledger-entries/${JSON.parse(posted.body).entryId}/reverse`,
      headers: headers(VIEWER), payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Expected: 404 from Fastify — the routes do not exist.

- [ ] **Step 3: Add the routes**

In `routes/ar.ts`, extend the header docstring to say the money-moving routes are gated on `payments` because taking a payment and reversing one are a different authority from reading account data, then:

```ts
  app.post(
    "/api/v1/accounts/:id/payments",
    { config: { module: "payments", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id: accountId } = idParamSchema.parse(request.params);
      const input = recordPaymentSchema.parse(request.body ?? {});
      const result = await recordPayment(utilityId, actorId, actorName, accountId, input);
      return reply.status(201).send(result);
    },
  );

  app.post(
    "/api/v1/ledger-entries/:id/reverse",
    { config: { module: "payments", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id: entryId } = idParamSchema.parse(request.params);
      const input = reverseEntrySchema.parse(request.body ?? {});
      const result = await reverseEntry(utilityId, actorId, actorName, entryId, input);
      return reply.status(201).send(result);
    },
  );
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-routes.integration.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
cd ../.. && pnpm typecheck
git add packages/api/src
git commit -m "feat(ar): payment and reverse endpoints behind the payments module (slice 2 task 6)"
```

---

## Task 7: Property test and documentation

**Files:**
- Modify: `packages/api/src/__tests__/integration/ledger-reconciliation.integration.test.ts`
- Modify: `docs/specs/23-accounts-receivable.md`
- Modify: `docs/specs/10-payments-and-collections.md`
- Modify: `docs/specs/00-data-model-overview.md`
- Modify: `docs/design/utility-cis-architecture.md`
- Modify: `docs/superpowers/specs/2026-10-09-ar-ledger-design.md`

**Interfaces:** Consumes everything above. Produces no new code.

- [ ] **Step 1: Extend the property test**

Replace the hand-rolled settlement block in `"holds the invariants across a long sequence that includes partial settlement"` with real calls, and add reversals. The independent model must now track applications:

```ts
      // Every third step, pay part of what is owed — through recordPayment
      // now, not by hand, so allocation itself is under test.
      if (i % 3 === 2 && modelBalance > 0) {
        const pay = Math.max(1, Math.floor(modelBalance * (0.2 + next() * 0.8)));
        const res = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
          amount: (pay / 100).toFixed(2),
          tender: "CHECK",
        });
        modelBalance -= pay;
        payments.push({ id: res.paymentId, cents: pay });
        settlements++;
      }

      // Every seventh step, reverse the most recent payment — NSF.
      if (i % 7 === 6 && payments.length > 0) {
        const target = payments.pop()!;
        await reversal.reverseEntry(utilityId, ACTOR, "T", target.id, {});
        modelBalance += target.cents;
        reversals++;
      }
```

Keep the existing per-iteration assertions — `reconcileBalances` resolves to `[]`, and `account.balance` equals `modelBalance` — and add, after the loop:

```ts
    expect(reversals).toBeGreaterThan(0);
    // §5: every application is positive and its two sides agree with it.
    const apps = await prisma.ledgerApplication.findMany({ where: { utilityId } });
    for (const a of apps) expect(Number(a.amount)).toBeGreaterThan(0);
    for (const e of entries) {
      const sumAsDebit = apps.filter((a) => a.debitId === e.id)
        .reduce((t, a) => t + Number(a.amount), 0);
      const sumAsCredit = apps.filter((a) => a.creditId === e.id)
        .reduce((t, a) => t + Number(a.amount), 0);
      const expected = Number(e.amount) - sumAsDebit + sumAsCredit;
      expect(Number(e.openAmount)).toBeCloseTo(expected, 2);
    }
```

That last loop is the §5 invariant stated directly, rather than inferred from the balance — the balance can be right while two entries are individually wrong in opposite directions.

- [ ] **Step 2: Run it**

Run: `cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-reconciliation.integration.test.ts`
Expected: PASS. If `reversals` is 0, raise the iteration count rather than loosening the assertion.

- [ ] **Step 3: Update the specs**

- `docs/specs/23-accounts-receivable.md`: move slice 2 to **Complete** in the roadmap; add `LedgerApplication` as written-from-slice-2 rather than empty; add the two endpoints to the API table with their gates; add the `payments` module key; add business rules for the allocation order, the positive-amount-in convention, and the reversal's settle-against-the-original rule; remove open-credit auto-apply from the deferral list.
- `docs/specs/10-payments-and-collections.md`: payments, allocation and reversal have shipped in module 23 slice 2; what remains here is payment plans, the collections workflow and write-off approval. Remove "recording payments of any tender" from the outstanding list.
- `docs/specs/00-data-model-overview.md`: `LedgerApplication`'s row says rows arrive in slice 2 — change to written by allocation from slice 2.
- `docs/design/utility-cis-architecture.md`: the AR paragraph at §8 lists payments and allocation as outstanding; move them to shipped and leave fees, waivers, write-offs and the statement view outstanding.
- `docs/superpowers/specs/2026-10-09-ar-ledger-design.md`: §10 slice 2 marked complete; record the two decisions this plan took beyond the spec (optional `reasonId`, and the reversal settling against its original) in §11 so the next slice inherits them.

- [ ] **Step 4: Full verification**

```bash
pnpm typecheck
cd packages/api && pnpm exec vitest run
cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts
cd ../shared && pnpm exec vitest run
cd ../.. && node seed.js
```

Expected: typecheck exit 0; api unit suite exit 0; every integration suite green; shared green; seed exits 0 twice in a row.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src docs
git commit -m "test(ar): property test covers payments and reversals; specs record slice 2 (slice 2 task 7)"
```

---

## Self-Review

**Spec coverage.** §4.3 `LedgerApplication` — Task 2 writes it. §5 invariants — Task 7 asserts them directly. §6.2 `recordPayment` — Task 3. §6.3 allocation order — Task 1 (constant) and Task 2 (walk). §6.1 step 4 — Task 4. §6.6 `reverseEntry` including dependent fees — Task 5. §8's `payments` module key — Task 1. §9's property requirement — Task 7. §10 slice 2 scope — all seven. **Deliberately out:** §6.4 `assessFee`, §6.5 `adjust`/`waive`/`writeOff`, the `ar_adjustments` key, `LedgerReasonDef` seeds (all slice 3); §7.1 statement view and §7.2 aging (slice 4).

**Placeholders.** None: every code step carries the code, every test step the assertions, every run step the command and the expected result.

**Type consistency.** `Application` is defined once in Task 2 and consumed by name in Tasks 3, 4 and 7. `TxClient` comes from `posting.service.ts` throughout. `lockAccount` is introduced in Task 2 step 1 before Tasks 3 and 5 call it. `RecordPaymentInput` and `ReverseEntryInput` are produced in Task 1 and consumed in Tasks 3, 5 and 6. `PostBillResult.applied` is added in Task 4, the only task that returns it.

**Review Focus coverage.** Overpayment → Task 3. Zero/negative amount → Task 1 and Task 6. Fee outranking an older bill → Task 2, with a discrimination proof in step 6. Partially-applied reversal → Task 5, with a discrimination proof in step 5. Double reverse and reversing a reversal → Task 5.

**Known risk.** Task 4 changes behaviour shipped in slice 1, so its step 5 re-runs every slice 1 suite rather than only the one it edited. The reconciliation property test is the likeliest casualty, because it asserts `lastDueDate` against its own model of which debits are open and auto-apply changes that set.

