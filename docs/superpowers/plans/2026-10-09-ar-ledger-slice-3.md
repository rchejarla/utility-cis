# AR Ledger Slice 3 — Fees, Adjustments and Reason Codes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. No per-task subagent review — one whole-branch review at the end — so this plan carries the interface contract. Read every task's **Interfaces** block before writing code in it.

**Goal:** A utility can charge a fee, forgive a charge, and write one off as bad debt — each citing a tenant-defined reason, each a distinct act the finance department can report on separately.

**Architecture:** Three new services under `packages/api/src/services/ar/`: `reason.service.ts` resolves and seeds the tenant's reason codes; `fee.service.ts` raises a fee; `adjustment.service.ts` posts a manual debit, a waiver or a write-off. A migration adds the two CHECK constraints deferred from slice 1, now that reasons exist to satisfy them. All money operations keep slice 1-2's shape: one transaction, the account row lock, `recomputeAccountCache` before commit.

**Tech Stack:** Fastify + TypeScript on `tsx`, Prisma 6 against PostgreSQL 16, Zod validators shared between API and web, Vitest with testcontainers.

**Spec:** `docs/superpowers/specs/2026-10-09-ar-ledger-design.md` — §3.4 (extensibility lives in the reason), §3.5 (waive / correct / write off are three acts), §4.2 (the deferred CHECKs), §4.4 `LedgerReasonDef`, §6.4 `assessFee`, §6.5 `adjust` / `waive` / `writeOff`, §8 (`ar_adjustments` module key), §10 slice 3.

## Global Constraints

Everything in slice 2's Global Constraints still holds — `Prisma.Decimal` only, signed amounts, positive `LedgerApplication.amount`, the §5 invariants, one transaction per operation, `audit-wrap` on every mutation, an explicit `utilityId` predicate on every query, the account lock taken by the code that needs it. In addition:

- **Nothing is ever deleted or edited.** A waiver does not touch `bill.total`: the bill stands as issued and the *receivable* is reduced. A wrong bill is a rebill, not a waiver. Spec §3.5.
- **The three acts stay distinct.** Wrong → `REVERSAL`. Right but forgiven → `ADJUSTMENT_CREDIT` + reason. Right but uncollectable → `WRITE_OFF` + reason. Collapsing them loses billing accuracy, concessions and bad debt as separately reportable facts, and it is unrecoverable from history. Spec §3.5.
- **Extensibility lives in the reason, not the type.** `LedgerEntryType` is a fixed enum; what varies per utility is the business reason. No new entry types in this slice. Spec §3.3, §3.4.
- **`LedgerReasonDef` has no `requiresApproval` column.** It would be write-only until an approvals workflow exists, and approval cannot be a state on a ledger entry — posting is final, so a waiver awaiting approval must not reduce the balance. That needs a request object outside the ledger. Spec §4.4.
- **`appliesToType` restricts which entry type may cite a reason**, and the service enforces it. Spec §4.4.

## Decisions this plan takes beyond the spec

These were established by checking the live schema and data, not by reading alone.

1. **The `reason_id` CHECK cannot be what §4.2 specifies.** §4.2 asks for `reason_id IS NOT NULL` on FEE / ADJUSTMENT_DEBIT / ADJUSTMENT_CREDIT / WRITE_OFF. Two already-shipped paths write such rows without a reason, so adding it fails outright — `ERROR: check constraint "tmp_reason_required" of relation "ledger_entry" is violated by some row`:
   - `seed.js`'s opening balances are `ADJUSTMENT_DEBIT` with no reason and no bill (two rows in the dev database today);
   - `postBill` writes `ADJUSTMENT_CREDIT` for a bill that nets negative, with no reason — though it does carry `bill_id` since slice 1's fix wave.

   **Resolution:** the constraint is `reason_id IS NOT NULL OR bill_id IS NOT NULL` for those four types. A credit that names the bill it came from is self-explaining; anything else must cite a reason. The seeder is changed to cite a seeded `OPENING_BALANCE` reason rather than relying on the escape, so the escape covers exactly one path and that path is bill-derived.

   Rejected: making `postBill` cite a seeded reason. That couples posting a negative bill to reason seeds existing, so a tenant with no seeds could not post one — a worse failure than the constraint being one clause looser.

2. **The `assessed_on_id` CHECK is the one-way implication, not the one §4.2 implies.** "FEE only — the debit that went unpaid" cannot mean every FEE names one: a tap fee or a meter test fee is assessed on nothing. The enforceable rule is the converse — only a FEE may name an `assessed_on_id` — and that is what the migration adds.

3. **`assessFee`'s `dueDate` is optional and defaults to 30 days after the effective date.** §6.4 says it should default to "the next bill's due date", which is not knowable: the next bill may not exist yet, and deriving it would duplicate `computeBillPeriod` for a value the operator can see. The spec's intent belongs with slice 6, where late fees are raised automatically and the cycle is in hand; recorded there.

4. **A manual debit absorbs open credits**, the same way a posted bill does (§6.1 step 4). Not specified for `ADJUSTMENT_DEBIT`, but the slice 2 precedent is that any new debit absorbs, and the alternative leaves an account showing an open credit and an open debit that should have cancelled.

5. **A waiver or write-off applies only to the debit it names, and does not spill.** §6.5 is explicit that waiving more than is owed "leaves an open credit — a refund due", so the leftover stays open rather than being allocated across other debits. This needs a new one-target function in `allocation.service.ts`; the general `applyCreditToDebits` walk is for payments.

## Review Focus

Five conditions the spec implies that no task's happy path exercises.

- **Waiving more than the debit owes** — the excess must stay open on the credit as a refund due, and must NOT spill onto other open debits. Test in Task 5.
- **Citing a reason whose `appliesToType` does not match** — e.g. a `BAD_DEBT` reason on a FEE. Must be a 422 naming the mismatch, not a posted entry with a nonsense reason. Test in Task 3 and Task 6.
- **Citing a reason belonging to another tenant** — must be refused as not found, not silently accepted because the id is a valid uuid. Test in Task 3.
- **A fee with no `assessedOnId`** — a tap fee is assessed on nothing, so this is the normal case for most fees and must be accepted; the migration's CHECK must not require it. Test in Task 2 and Task 4.
- **An inactive reason code** — `isActive = false` means retired, so a new entry must not be able to cite it, while entries that already cite it stay readable. Test in Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/validators/ledger.ts` | `assessFeeSchema`, `adjustSchema`, `waiveSchema`, `writeOffSchema`, `DEFAULT_REASON_CODES` |
| `packages/shared/src/events/index.ts` | `LEDGER_FEE_CREATED`, `LEDGER_ADJUSTMENT_CREATED`, `LEDGER_REASON_CREATED` |
| `packages/shared/src/modules/constants.ts` | `ar_adjustments` module key + role presets |
| `packages/shared/prisma/migrations/<ts>_ledger_reason_constraints/migration.sql` | The two deferred CHECKs |
| `packages/api/src/services/ar/reason.service.ts` | **New.** Resolve, list and seed a tenant's reason codes |
| `packages/api/src/services/ar/allocation.service.ts` | Add `applyCreditToOneDebit` |
| `packages/api/src/services/ar/fee.service.ts` | **New.** `assessFee` |
| `packages/api/src/services/ar/adjustment.service.ts` | **New.** `adjustDebit`, `waive`, `writeOff` |
| `packages/api/src/routes/ar.ts` | Four endpoints + the reason-code list |
| `seed.js` | Seed reason codes; opening balances cite `OPENING_BALANCE` |

---

## Task 1: Shared vocabulary — reason codes, validators, module key

**Files:**
- Modify: `packages/shared/src/validators/ledger.ts`, `packages/shared/src/events/index.ts`, `packages/shared/src/modules/constants.ts`
- Test: `packages/shared/src/validators/__tests__/ledger.test.ts`, `packages/shared/src/modules/__tests__/constants.test.ts`

**Interfaces — Produces:**
- `DEFAULT_REASON_CODES: readonly { code: string; label: string; appliesToType: LedgerEntryTypeName }[]` — the per-tenant seed set: `LATE_FEE`, `NSF_FEE`, `RECONNECT_FEE`, `TAP_FEE`, `METER_TEST_FEE` (FEE); `OPENING_BALANCE`, `BILLING_CORRECTION_DEBIT` (ADJUSTMENT_DEBIT); `COURTESY_WAIVER`, `GOODWILL`, `BILLING_CORRECTION_CREDIT` (ADJUSTMENT_CREDIT); `BAD_DEBT`, `SMALL_BALANCE` (WRITE_OFF).
- `assessFeeSchema` → `{ amount: string; reasonId: string; dueDate?: string; assessedOnId?: string; effectiveDate?: string; memo?: string }`
- `adjustSchema` → `{ amount: string; reasonId: string; dueDate?: string; effectiveDate?: string; memo?: string }`
- `waiveSchema` / `writeOffSchema` → `{ amount: string; reasonId: string; debitId: string; effectiveDate?: string; memo?: string }`
- `EVENT_TYPES.LEDGER_FEE_CREATED = "ledger_fee.created"`, `LEDGER_ADJUSTMENT_CREATED = "ledger_adjustment.created"`, `LEDGER_REASON_CREATED = "ledger_reason.created"`
- Module key `"ar_adjustments"`

All money amounts reuse slice 2's `positiveMoney`: the request always carries a positive amount and the service decides the sign. `waiveSchema` and `writeOffSchema` require `debitId` because §6.5 applies them to a nominated debit.

- [ ] **Step 1: Write the failing tests**

```ts
describe("DEFAULT_REASON_CODES", () => {
  it("covers all four types that require a reason", () => {
    const types = new Set(DEFAULT_REASON_CODES.map((r) => r.appliesToType));
    expect([...types].sort()).toEqual(
      ["ADJUSTMENT_CREDIT", "ADJUSTMENT_DEBIT", "FEE", "WRITE_OFF"].sort(),
    );
  });

  it("has unique codes, since (utilityId, code) is unique in the table", () => {
    const codes = DEFAULT_REASON_CODES.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  // seed.js's opening balances cite this one; without it the reason CHECK
  // added in task 2 cannot be satisfied by a seeded database.
  it("includes OPENING_BALANCE as an ADJUSTMENT_DEBIT reason", () => {
    const r = DEFAULT_REASON_CODES.find((x) => x.code === "OPENING_BALANCE");
    expect(r?.appliesToType).toBe("ADJUSTMENT_DEBIT");
  });

  it("keeps every code within the column's 50 characters", () => {
    for (const r of DEFAULT_REASON_CODES) {
      expect(r.code.length).toBeLessThanOrEqual(50);
      expect(r.label.length).toBeLessThanOrEqual(255);
    }
  });
});

describe("assessFeeSchema", () => {
  const reasonId = "00000000-0000-4000-8000-00000000aa01";

  it("accepts a positive amount with a reason", () => {
    expect(assessFeeSchema.parse({ amount: "25.00", reasonId })).toEqual({
      amount: "25.00",
      reasonId,
    });
  });

  it("requires a reasonId — a fee with no reason is what this slice exists to prevent", () => {
    expect(() => assessFeeSchema.parse({ amount: "25.00" })).toThrow();
  });

  it("rejects a negative or zero amount", () => {
    expect(() => assessFeeSchema.parse({ amount: "-25.00", reasonId })).toThrow();
    expect(() => assessFeeSchema.parse({ amount: "0.00", reasonId })).toThrow();
  });

  // Review Focus: most fees are assessed on nothing.
  it("leaves assessedOnId optional", () => {
    expect(assessFeeSchema.parse({ amount: "25.00", reasonId }).assessedOnId).toBeUndefined();
  });

  it("rejects a dueDate that is not a real date", () => {
    expect(() => assessFeeSchema.parse({ amount: "25.00", reasonId, dueDate: "2026-02-30" })).toThrow();
  });
});

describe("waiveSchema", () => {
  const reasonId = "00000000-0000-4000-8000-00000000aa01";
  const debitId = "00000000-0000-4000-8000-00000000bb01";

  it("requires the debit it is applied to", () => {
    expect(() => waiveSchema.parse({ amount: "10.00", reasonId })).toThrow();
    expect(waiveSchema.parse({ amount: "10.00", reasonId, debitId }).debitId).toBe(debitId);
  });

  it("rejects a debitId that is not a uuid", () => {
    expect(() => waiveSchema.parse({ amount: "10.00", reasonId, debitId: "nope" })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/shared && pnpm exec vitest run src/validators/__tests__/ledger.test.ts`
Expected: FAIL — `DEFAULT_REASON_CODES is not exported`.

- [ ] **Step 3: Add the constants and schemas**

In `packages/shared/src/validators/ledger.ts`, after `DEBIT_ALLOCATION_ORDER`:

```ts
/** The four types that must cite a reason, per spec §4.2. */
export type ReasonedType = "FEE" | "ADJUSTMENT_DEBIT" | "ADJUSTMENT_CREDIT" | "WRITE_OFF";

/**
 * The reason codes seeded for a new tenant, following the
 * PremiseTypeDef / MeasureTypeDef convention (spec §4.4).
 *
 * This is a starting set, not a closed one: what genuinely varies per
 * utility is the business reason behind a fee or adjustment, and a
 * utility adds its own without a code change (§3.4). The three acts the
 * types encode do NOT vary — wrong is a reversal, forgiven is a credit,
 * uncollectable is a write-off (§3.5).
 */
export const DEFAULT_REASON_CODES = [
  { code: "LATE_FEE", label: "Late payment fee", appliesToType: "FEE" },
  { code: "NSF_FEE", label: "Returned payment fee", appliesToType: "FEE" },
  { code: "RECONNECT_FEE", label: "Reconnection fee", appliesToType: "FEE" },
  { code: "TAP_FEE", label: "Tap fee", appliesToType: "FEE" },
  { code: "METER_TEST_FEE", label: "Meter test fee", appliesToType: "FEE" },
  { code: "OPENING_BALANCE", label: "Opening balance", appliesToType: "ADJUSTMENT_DEBIT" },
  { code: "BILLING_CORRECTION_DEBIT", label: "Billing correction — charge", appliesToType: "ADJUSTMENT_DEBIT" },
  { code: "COURTESY_WAIVER", label: "Courtesy waiver", appliesToType: "ADJUSTMENT_CREDIT" },
  { code: "GOODWILL", label: "Goodwill credit", appliesToType: "ADJUSTMENT_CREDIT" },
  { code: "BILLING_CORRECTION_CREDIT", label: "Billing correction — credit", appliesToType: "ADJUSTMENT_CREDIT" },
  { code: "BAD_DEBT", label: "Written off — uncollectable", appliesToType: "WRITE_OFF" },
  { code: "SMALL_BALANCE", label: "Written off — small balance", appliesToType: "WRITE_OFF" },
] as const satisfies readonly { code: string; label: string; appliesToType: ReasonedType }[];
```

Then the four bodies:

```ts
/**
 * Body for POST /api/v1/accounts/:id/fees (§6.4).
 *
 * `amount` is positive and stays positive — a fee increases what the
 * customer owes. `assessedOnId` is optional because most fees are
 * assessed on nothing: a tap fee or a meter test fee has no unpaid
 * debit behind it. `dueDate` defaults to 30 days after the effective
 * date; §6.4 wants the next bill's due date, which needs the billing
 * cycle and lands with slice 6's automatic late fees.
 */
export const assessFeeSchema = z.object({
  amount: positiveMoney,
  reasonId: z.string().uuid(),
  dueDate: calendarDate.optional(),
  assessedOnId: z.string().uuid().optional(),
  effectiveDate: calendarDate.optional(),
  memo: z.string().max(2000).optional(),
});
export type AssessFeeInput = z.infer<typeof assessFeeSchema>;

/** Body for POST /api/v1/accounts/:id/adjustments — a manual charge. */
export const adjustSchema = z.object({
  amount: positiveMoney,
  reasonId: z.string().uuid(),
  dueDate: calendarDate.optional(),
  effectiveDate: calendarDate.optional(),
  memo: z.string().max(2000).optional(),
});
export type AdjustInput = z.infer<typeof adjustSchema>;

/**
 * Bodies for waiving and writing off. Both name the debit they apply to
 * (§6.5) and both take a positive amount that the service negates.
 *
 * Any amount is allowed, so a partial waiver is free. Waiving more than
 * is owed, or waiving an already-paid charge, leaves an open credit —
 * a refund due — rather than being an error.
 */
const creditAgainstDebit = z.object({
  amount: positiveMoney,
  reasonId: z.string().uuid(),
  debitId: z.string().uuid(),
  effectiveDate: calendarDate.optional(),
  memo: z.string().max(2000).optional(),
});
export const waiveSchema = creditAgainstDebit;
export const writeOffSchema = creditAgainstDebit;
export type WaiveInput = z.infer<typeof waiveSchema>;
export type WriteOffInput = z.infer<typeof writeOffSchema>;
```

- [ ] **Step 4: Run to verify they pass**

Expected: PASS.

- [ ] **Step 5: Event types and module key**

In `events/index.ts`, after `LEDGER_REVERSAL_CREATED`:

```ts
  LEDGER_FEE_CREATED: "ledger_fee.created",
  LEDGER_ADJUSTMENT_CREATED: "ledger_adjustment.created",
  LEDGER_REASON_CREATED: "ledger_reason.created",
```

In `modules/constants.ts`: add `"ar_adjustments",` to `MODULES` after `"payments"`; add
`ar_adjustments: { label: "AR Adjustments", icon: "faScaleBalanced" },` to `MODULE_META` in the same position; grant `ar_adjustments: ["VIEW", "CREATE", "EDIT"]` to CSR and `ar_adjustments: ["VIEW"]` to Read-Only.

`constants.test.ts` from the slice 2 review will now fail until `seed.js` gets the key in Task 2 — that is the guard working, and Task 2 fixes it. Note it and move on rather than editing the test.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
cd packages/shared && pnpm exec vitest run src/validators
git add packages/shared/src
git commit -m "feat(ar): reason codes, fee and adjustment validators, ar_adjustments module key (slice 3 task 1)"
```

---

## Task 2: Migration — the two deferred CHECKs, and reason seeds

**Files:**
- Create: `packages/shared/prisma/migrations/20261010120000_ledger_reason_constraints/migration.sql`
- Modify: `packages/shared/prisma/schema.prisma` (docstrings only — the CHECKs are not expressible in Prisma)
- Modify: `seed.js`
- Test: `packages/api/src/__tests__/integration/ledger-shape.integration.test.ts`

**Interfaces — Produces:** constraints `ledger_entry_reason_required` and `ledger_entry_assessed_on_only_fee`; `OPENING_BALANCE`-citing opening balances in the seeder.

- [ ] **Step 1: Write the failing shape tests**

Append to `ledger-shape.integration.test.ts`, which already has `rejectsWith`:

```ts
  it("rejects a FEE with no reason and no bill", async () => {
    await rejectsWith(
      "ledger_entry_reason_required",
      "type, amount, open_amount, due_date, effective_date",
      `'FEE', 10, 10, current_date, current_date`,
    );
  });

  it("rejects a WRITE_OFF with no reason", async () => {
    await rejectsWith(
      "ledger_entry_reason_required",
      "type, amount, open_amount, effective_date",
      `'WRITE_OFF', -10, -10, current_date`,
    );
  });

  // The escape clause, and the only path that uses it: a credit derived
  // from a bill that netted negative names the bill, which explains it.
  it("accepts an ADJUSTMENT_CREDIT that names a bill instead of a reason", async () => {
    const { prisma } = prismaImports;
    const billId = await makeShapeBill();
    const n = await prisma.$executeRawUnsafe(
      `insert into ledger_entry (utility_id, account_id, type, amount, open_amount, effective_date, bill_id)
       values ('${utilityId}'::uuid, '${accountId}'::uuid, 'ADJUSTMENT_CREDIT', -10, -10, current_date, '${billId}'::uuid)`,
    );
    expect(n).toBe(1);
  });

  // Review Focus: most fees are assessed on nothing, so the constraint
  // must be the one-way implication and not require assessed_on_id.
  it("accepts a FEE with a reason and no assessed_on_id", async () => {
    const { prisma } = prismaImports;
    const reasonId = await makeShapeReason("FEE");
    const n = await prisma.$executeRawUnsafe(
      `insert into ledger_entry (utility_id, account_id, type, amount, open_amount, due_date, effective_date, reason_id)
       values ('${utilityId}'::uuid, '${accountId}'::uuid, 'FEE', 10, 10, current_date, current_date, '${reasonId}'::uuid)`,
    );
    expect(n).toBe(1);
  });

  it("rejects a non-FEE that names an assessed_on_id", async () => {
    const { prisma } = prismaImports;
    const reasonId = await makeShapeReason("ADJUSTMENT_DEBIT");
    const anchor = await prisma.ledgerEntry.findFirstOrThrow({ where: { utilityId } });
    await expect(
      prisma.$executeRawUnsafe(
        `insert into ledger_entry (utility_id, account_id, type, amount, open_amount, due_date, effective_date, reason_id, assessed_on_id)
         values ('${utilityId}'::uuid, '${accountId}'::uuid, 'ADJUSTMENT_DEBIT', 10, 10, current_date, current_date, '${reasonId}'::uuid, '${anchor.id}'::uuid)`,
      ),
    ).rejects.toThrow(/ledger_entry_assessed_on_only_fee/);
  });
```

Add the two helpers next to the existing fixture code:

```ts
async function makeShapeReason(appliesToType: string): Promise<string> {
  const { prisma } = prismaImports;
  const r = await prisma.ledgerReasonDef.create({
    data: {
      utilityId,
      code: `SHAPE-${Math.random().toString(36).slice(2, 8)}`,
      label: "Shape fixture",
      appliesToType: appliesToType as never,
    },
  });
  return r.id;
}

async function makeShapeBill(): Promise<string> {
  const { prisma } = prismaImports;
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const bill = await prisma.bill.create({
    data: {
      utilityId,
      accountId,
      billingCycleId: account.billingCycleId,
      periodStart: new Date("2026-04-16"),
      periodEnd: new Date("2026-05-15"),
      billDate: new Date("2026-05-15"),
      dueDate: new Date("2026-06-14"),
      subtotal: "-10",
      taxes: "0",
      credits: "0",
      total: "-10",
      billNumber: `SHAPE-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return bill.id;
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-shape.integration.test.ts`
Expected: the two `rejectsWith` cases FAIL because the inserts succeed — there is no constraint yet.

- [ ] **Step 3: Write the migration**

`packages/shared/prisma/migrations/20261010120000_ledger_reason_constraints/migration.sql`:

```sql
-- AR Ledger slice 3. The two CHECK constraints deferred from slice 1,
-- addable now that LedgerReasonDef is seeded and the services that write
-- these types cite a reason.
--
-- Neither is the constraint spec §4.2 literally asks for, and both
-- departures are deliberate.

-- §4.2 asks for `reason_id IS NOT NULL` on these four types. Two shipped
-- paths write such rows without one, so that constraint cannot be added:
-- seed.js's opening balances (ADJUSTMENT_DEBIT) and postBill's credit for
-- a bill that nets negative (ADJUSTMENT_CREDIT). The seeder now cites
-- OPENING_BALANCE; the bill-derived credit keeps no reason, because
-- requiring one would couple posting a negative bill to a tenant having
-- reason seeds, and a credit that names its bill is self-explaining.
-- Hence: a reason, OR the bill it came from.
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_reason_required" CHECK (
  "type" NOT IN ('FEE','ADJUSTMENT_DEBIT','ADJUSTMENT_CREDIT','WRITE_OFF')
  OR "reason_id" IS NOT NULL
  OR "bill_id" IS NOT NULL
);

-- §4.2's field table says assessed_on_id is "FEE only — the debit that
-- went unpaid". That cannot mean every FEE names one: a tap fee or a
-- meter test fee is assessed on nothing. The enforceable rule is the
-- converse — only a FEE may name one.
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_assessed_on_only_fee" CHECK (
  "assessed_on_id" IS NULL OR "type" = 'FEE'
);
```

- [ ] **Step 4: Apply and run the tests**

```bash
cd packages/shared && pnpm exec prisma migrate deploy
cd ../api && pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-shape.integration.test.ts
```

Expected: PASS, 15 tests. If `migrate deploy` fails with "is violated by some row", the dev database still holds reason-less rows — re-seed after Step 5 and apply again.

- [ ] **Step 5: Seed the reason codes and fix the opening balances**

In `seed.js`, add `"ar_adjustments"` to `allModules` after `"payments"`, grant it to the CSR role alongside `payments`, then before the opening-balance block:

```js
  // AR reason codes (module 23 slice 3). Mirrors DEFAULT_REASON_CODES in
  // packages/shared/src/validators/ledger.ts — seed.js cannot import the
  // TypeScript constant, so the list is duplicated and the shared test
  // packages/shared/src/modules/__tests__/constants.test.ts guards the
  // module keys the same way.
  const reasonCodes = [
    ["LATE_FEE", "Late payment fee", "FEE"],
    ["NSF_FEE", "Returned payment fee", "FEE"],
    ["RECONNECT_FEE", "Reconnection fee", "FEE"],
    ["TAP_FEE", "Tap fee", "FEE"],
    ["METER_TEST_FEE", "Meter test fee", "FEE"],
    ["OPENING_BALANCE", "Opening balance", "ADJUSTMENT_DEBIT"],
    ["BILLING_CORRECTION_DEBIT", "Billing correction — charge", "ADJUSTMENT_DEBIT"],
    ["COURTESY_WAIVER", "Courtesy waiver", "ADJUSTMENT_CREDIT"],
    ["GOODWILL", "Goodwill credit", "ADJUSTMENT_CREDIT"],
    ["BILLING_CORRECTION_CREDIT", "Billing correction — credit", "ADJUSTMENT_CREDIT"],
    ["BAD_DEBT", "Written off — uncollectable", "WRITE_OFF"],
    ["SMALL_BALANCE", "Written off — small balance", "WRITE_OFF"],
  ];
  const reasonByCode = {};
  for (const [code, label, appliesToType] of reasonCodes) {
    const r = await p.ledgerReasonDef.create({
      data: { utilityId: UID, code, label, appliesToType },
    });
    reasonByCode[code] = r.id;
  }
  console.log("  " + reasonCodes.length + " AR reason codes");
```

Then the opening-balance entry gains `reasonId: reasonByCode["OPENING_BALANCE"]`, and its comment is updated to say the reason is required by `ledger_entry_reason_required`.

- [ ] **Step 6: Verify the seeder twice, and the drift guard**

```bash
node seed.js && node seed.js
cd packages/shared && pnpm exec vitest run src/modules/__tests__/constants.test.ts
```

Expected: both seed runs exit 0 — the reset block already clears `ledger_reason_def` before `ledger_entry`, added in the slice 1 fix wave — and the module drift guard passes now that `ar_adjustments` is in both lists.

- [ ] **Step 7: Mirror into schema.prisma and commit**

Add to the `LedgerEntry` docstring that `reason_id` is required for the four reasoned types unless the entry names a bill, and that only a FEE may carry `assessedOnId`. Then:

```bash
pnpm typecheck
git add packages/shared seed.js packages/api/src
git commit -m "feat(ar): add the deferred reason and assessed-on CHECKs, seed reason codes (slice 3 task 2)"
```

---

## Task 3: `reason.service.ts`

**Files:**
- Create: `packages/api/src/services/ar/reason.service.ts`
- Test: `packages/api/src/__tests__/integration/ledger-reason.integration.test.ts`

**Interfaces — Produces:**
- `listReasons(utilityId: string, appliesToType?: ReasonedType): Promise<ReasonRow[]>` where `ReasonRow = { id: string; code: string; label: string; appliesToType: string; isActive: boolean }` — active only unless `includeInactive` is passed.
- `resolveReason(tx: TxClient, utilityId: string, reasonId: string, expectedType: ReasonedType): Promise<ReasonRow>` — throws `REASON_NOT_FOUND` (404) for an unknown, other-tenant or inactive reason, and `REASON_TYPE_MISMATCH` (422) when `appliesToType` disagrees with `expectedType`.
- `seedDefaultReasons(utilityId, actorId, actorName): Promise<{ created: number }>` — idempotent, for onboarding a tenant.

`resolveReason` is the single gate every writing service goes through, so the type check cannot be forgotten in one of them.

- [ ] **Step 1: Write the failing tests**

Fixture shape as slice 2's suites (account `REASON-001`). Cases:

```ts
describe("resolveReason", () => {
  it("resolves an active reason of the expected type", async () => { /* happy path */ });

  // Review Focus: a BAD_DEBT reason on a FEE.
  it("refuses a reason whose appliesToType disagrees", async () => {
    const badDebt = await makeReason("BAD_DEBT_X", "WRITE_OFF");
    await expect(
      prisma.$transaction((tx) => reason.resolveReason(tx, utilityId, badDebt, "FEE")),
    ).rejects.toMatchObject({ code: "REASON_TYPE_MISMATCH", statusCode: 422 });
  });

  // Review Focus: another tenant's reason.
  it("refuses a reason belonging to another tenant", async () => {
    const stray = await makeReasonFor(otherUtilityId, "STRAY", "FEE");
    await expect(
      prisma.$transaction((tx) => reason.resolveReason(tx, utilityId, stray, "FEE")),
    ).rejects.toMatchObject({ code: "REASON_NOT_FOUND" });
  });

  // Review Focus: a retired code.
  it("refuses an inactive reason for a new entry", async () => {
    const retired = await makeReason("RETIRED", "FEE", false);
    await expect(
      prisma.$transaction((tx) => reason.resolveReason(tx, utilityId, retired, "FEE")),
    ).rejects.toMatchObject({ code: "REASON_NOT_FOUND" });
  });

  it("refuses an unknown id", async () => { /* 404 */ });
});

describe("listReasons", () => {
  it("returns active reasons only, ordered by code", async () => { /* ... */ });
  it("filters by appliesToType when asked", async () => { /* ... */ });
  it("includes inactive ones when asked, so history stays readable", async () => { /* ... */ });
  it("never returns another tenant's reasons", async () => { /* ... */ });
});

describe("seedDefaultReasons", () => {
  it("creates the full default set for a fresh tenant", async () => {
    const res = await reason.seedDefaultReasons(freshUtilityId, ACTOR, "T");
    expect(res.created).toBe(DEFAULT_REASON_CODES.length);
  });

  it("is idempotent — a second call creates nothing and does not throw", async () => {
    await reason.seedDefaultReasons(freshUtilityId, ACTOR, "T");
    const again = await reason.seedDefaultReasons(freshUtilityId, ACTOR, "T");
    expect(again.created).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail** — cannot resolve `reason.service.js`.

- [ ] **Step 3: Write the service**

```ts
import { DEFAULT_REASON_CODES, EVENT_TYPES, type ReasonedType } from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import type { TxClient } from "./posting.service.js";

/**
 * The tenant's reason codes — why a fee or adjustment was raised.
 *
 * `resolveReason` is the single gate every writing service goes through,
 * so the `appliesToType` rule cannot be enforced in three places and
 * forgotten in a fourth. An inactive code is refused for a NEW entry but
 * still listed on request, because entries that already cite it have to
 * stay readable (§4.4).
 */

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export interface ReasonRow {
  id: string;
  code: string;
  label: string;
  appliesToType: string;
  isActive: boolean;
}

export async function resolveReason(
  tx: TxClient,
  utilityId: string,
  reasonId: string,
  expectedType: ReasonedType,
): Promise<ReasonRow> {
  const row = await tx.ledgerReasonDef.findFirst({
    where: { id: reasonId, utilityId },
    select: { id: true, code: true, label: true, appliesToType: true, isActive: true },
  });
  // An inactive code is indistinguishable from a missing one here on
  // purpose: both mean "you may not cite this on a new entry", and
  // telling the caller which would leak that the id exists.
  if (!row || !row.isActive) {
    throw err("REASON_NOT_FOUND", `Reason ${reasonId} not found or inactive`, 404);
  }
  if (row.appliesToType !== expectedType) {
    throw err(
      "REASON_TYPE_MISMATCH",
      `Reason ${row.code} applies to ${row.appliesToType}, not ${expectedType}`,
      422,
    );
  }
  return row;
}

export async function listReasons(
  utilityId: string,
  opts: { appliesToType?: ReasonedType; includeInactive?: boolean } = {},
): Promise<ReasonRow[]> {
  return prisma.ledgerReasonDef.findMany({
    where: {
      utilityId,
      ...(opts.appliesToType ? { appliesToType: opts.appliesToType } : {}),
      ...(opts.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ appliesToType: "asc" }, { code: "asc" }],
    select: { id: true, code: true, label: true, appliesToType: true, isActive: true },
  });
}

/**
 * Put the default set on a tenant that has none. Idempotent: skips codes
 * that already exist, so it is safe to call on every onboarding run and
 * after the default list grows.
 */
export async function seedDefaultReasons(
  utilityId: string,
  actorId: string,
  actorName: string,
): Promise<{ created: number }> {
  return prisma.$transaction(async (tx) => {
    const existing = new Set(
      (
        await tx.ledgerReasonDef.findMany({ where: { utilityId }, select: { code: true } })
      ).map((r) => r.code),
    );
    let created = 0;
    for (const def of DEFAULT_REASON_CODES) {
      if (existing.has(def.code)) continue;
      const row = await tx.ledgerReasonDef.create({
        data: {
          utilityId,
          code: def.code,
          label: def.label,
          appliesToType: def.appliesToType as never,
        },
      });
      await writeAuditRow(
        tx,
        { utilityId, actorId, actorName, entityType: "LedgerReasonDef" },
        EVENT_TYPES.LEDGER_REASON_CREATED,
        row.id,
        null,
        row,
      );
      created++;
    }
    return { created };
  });
}
```

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Prove the type check discriminates** — change `row.appliesToType !== expectedType` to `false`; "refuses a reason whose appliesToType disagrees" must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(ar): resolve, list and seed tenant reason codes (slice 3 task 3)"
```

---

## Task 4: `fee.service.ts` — `assessFee`

**Files:**
- Create: `packages/api/src/services/ar/fee.service.ts`
- Test: `packages/api/src/__tests__/integration/ledger-fee.integration.test.ts`

**Interfaces:**
- Consumes: `resolveReason`; `lockAccount`, `recomputeAccountCache`, `TxClient`; `applyCreditsToDebit`; `AssessFeeInput`.
- Produces: `assessFee(utilityId, actorId, actorName, accountId, input: AssessFeeInput, existingTx?): Promise<AssessFeeResult>` where `AssessFeeResult = { feeId: string; amount: string; applied: Application[]; balance: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
it("raises a positive FEE citing its reason and ages on its own due date", async () => {
  const res = await fee.assessFee(utilityId, ACTOR, "T", accountId, {
    amount: "25.00", reasonId: lateFeeId, dueDate: "2026-07-14",
  });
  const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.feeId } });
  expect(entry.type).toBe("FEE");
  expect(entry.amount.toFixed(2)).toBe("25.00");
  expect(entry.reasonId).toBe(lateFeeId);
  expect(entry.dueDate?.toISOString().slice(0, 10)).toBe("2026-07-14");
  expect(res.balance).toBe("25.00");
});

// Review Focus: most fees are assessed on nothing.
it("raises a fee with no assessedOnId", async () => { /* accepted, assessedOnId null */ });

it("records the debit a late fee was assessed on", async () => { /* assessedOnId set */ });

it("defaults dueDate to 30 days after the effective date", async () => { /* ... */ });

it("refuses a reason that is not a FEE reason", async () => {
  await expect(
    fee.assessFee(utilityId, ACTOR, "T", accountId, { amount: "25.00", reasonId: badDebtId }),
  ).rejects.toMatchObject({ code: "REASON_TYPE_MISMATCH" });
});

it("absorbs an open credit, like any new debit", async () => { /* applied has 1, balance net */ });

it("refuses an assessedOnId belonging to another account", async () => {
  await expect(/* ... */).rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });
});

it("refuses an unknown account", async () => { /* ACCOUNT_NOT_FOUND */ });

it("writes one audit row", async () => { /* ... */ });

it("leaves nothing behind when the caller's transaction rolls back", async () => { /* ... */ });
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Write the service**

```ts
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { EVENT_TYPES, type AssessFeeInput } from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { lockAccount, recomputeAccountCache, type TxClient } from "./posting.service.js";
import { applyCreditsToDebit, type Application } from "./allocation.service.js";
import { resolveReason } from "./reason.service.js";

/**
 * Raising a fee — an off-cycle charge that ages on its own clock (§6.4).
 *
 * Fee GENERATION is out of scope: nothing here decides when a late fee
 * is due or how much it is. This is the entry point that slice 6's
 * late-fee job and the operator screen both call.
 *
 * `assessedOnId` is optional and usually absent. A late fee names the
 * debit that went unpaid; a tap fee or meter test fee is assessed on
 * nothing, which is why the database constraint is "only a FEE may name
 * one" rather than "every FEE must".
 */

const DEFAULT_FEE_DUE_DAYS = 30;

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export interface AssessFeeResult {
  feeId: string;
  amount: string;
  applied: Application[];
  balance: string;
}

export async function assessFee(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: AssessFeeInput,
  existingTx?: TxClient,
): Promise<AssessFeeResult> {
  const run = async (tx: TxClient): Promise<AssessFeeResult> => {
    await lockAccount(tx, utilityId, accountId);
    await resolveReason(tx, utilityId, input.reasonId, "FEE");

    if (input.assessedOnId) {
      // It has to be this account's entry, or the fee claims provenance
      // it does not have.
      const anchor = await tx.ledgerEntry.findFirst({
        where: { id: input.assessedOnId, utilityId, accountId },
        select: { id: true },
      });
      if (!anchor) {
        throw err("ENTRY_NOT_FOUND", `Entry ${input.assessedOnId} not found on this account`, 404);
      }
    }

    const amount = new Prisma.Decimal(input.amount);
    const effectiveDate = new Date(input.effectiveDate ?? new Date().toISOString().slice(0, 10));
    const dueDate = input.dueDate
      ? new Date(input.dueDate)
      : new Date(effectiveDate.getTime() + DEFAULT_FEE_DUE_DAYS * 86_400_000);

    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "FEE",
        amount,
        openAmount: amount,
        // Every debit must carry a due date or the aging index cannot
        // see it (slice 1's R8).
        dueDate,
        effectiveDate,
        reasonId: input.reasonId,
        assessedOnId: input.assessedOnId ?? null,
        memo: input.memo ?? null,
        createdBy: actorId,
      },
    });

    // A new debit absorbs open credits, the same as a posted bill.
    const applied = await applyCreditsToDebit(tx, utilityId, accountId, entry.id);
    const cache = await recomputeAccountCache(tx, utilityId, accountId);

    return { feeId: entry.id, amount: amount.toFixed(2), applied, balance: cache.balance };
  };

  const runWithAudit = async (tx: TxClient): Promise<AssessFeeResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_FEE_CREATED,
      result.feeId,
      null,
      result,
    );
    return result;
  };

  if (existingTx) return runWithAudit(existingTx);
  return prisma.$transaction(runWithAudit);
}
```

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Prove the fee outranks a bill in allocation**

A fee and an older bill both open, then a payment covering only the fee: the fee must close and the bill stay open. This exercises `DEBIT_ALLOCATION_ORDER` against a real `FEE` row for the first time — slice 2 could only use `ADJUSTMENT_DEBIT`, because `FEE` had no writer and the reason CHECK did not exist yet.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(ar): assessFee raises an off-cycle charge against a reason (slice 3 task 4)"
```

---

## Task 5: `adjustment.service.ts` — manual debit, waiver, write-off

**Files:**
- Create: `packages/api/src/services/ar/adjustment.service.ts`
- Modify: `packages/api/src/services/ar/allocation.service.ts` (add `applyCreditToOneDebit`)
- Test: `packages/api/src/__tests__/integration/ledger-adjustment.integration.test.ts`

**Interfaces — Produces:**
- `applyCreditToOneDebit(tx, utilityId, accountId, creditId, debitId): Promise<Application[]>` in `allocation.service.ts` — applies a credit to exactly one nominated debit, up to what that debit owes, and leaves any excess open. Returns at most one application.
- `adjustDebit(utilityId, actorId, actorName, accountId, input: AdjustInput, existingTx?)` → `{ entryId, amount, applied, balance }`
- `waive(utilityId, actorId, actorName, accountId, input: WaiveInput, existingTx?)` → `{ entryId, amount, applied, unapplied, balance }`
- `writeOff(...)` — same shape as `waive`

`waive` and `writeOff` differ only in the entry type and the reason type they demand, so they share one private core. They are separate exports because §3.5 is explicit that concessions and bad debt are different facts.

- [ ] **Step 1: Write the failing tests**

```ts
describe("waive", () => {
  it("reduces the nominated debit and closes both when it matches", async () => { /* ... */ });

  it("waives part of a debit, leaving the rest owed", async () => { /* ... */ });

  // Review Focus: the excess must not spill onto other debits.
  it("leaves the excess open as a refund due and does not touch other debits", async () => {
    const small = await debit("10.00", "2026-06-14");
    const other = await debit("50.00", "2026-05-14"); // older, would be next in line
    const res = await adjustment.waive(utilityId, ACTOR, "T", accountId, {
      amount: "30.00", reasonId: courtesyId, debitId: small,
    });
    expect(await openOf(small)).toBe("0.00");
    expect(await openOf(other)).toBe("50.00");      // untouched
    expect(res.unapplied).toBe("20.00");            // refund due
    expect(await openOf(res.entryId)).toBe("-20.00");
    expect(res.balance).toBe("30.00");              // 50 − 20
  });

  it("waives an already-paid charge, leaving a full credit", async () => { /* ... */ });
  it("refuses a WRITE_OFF reason", async () => { /* REASON_TYPE_MISMATCH */ });
  it("refuses a debit in another account", async () => { /* ENTRY_NOT_FOUND */ });
  it("refuses to apply to a credit entry", async () => { /* NOT_A_DEBIT, 422 */ });
  it("does not touch bill.total", async () => { /* the bill stands as issued, §3.5 */ });
});

describe("writeOff", () => {
  it("posts a WRITE_OFF, which is a different fact from a waiver", async () => {
    const res = await adjustment.writeOff(/* ... */);
    const e = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.entryId } });
    expect(e.type).toBe("WRITE_OFF");
  });
  it("refuses an ADJUSTMENT_CREDIT reason", async () => { /* REASON_TYPE_MISMATCH */ });
});

describe("adjustDebit", () => {
  it("posts a positive ADJUSTMENT_DEBIT with a due date", async () => { /* ... */ });
  it("absorbs an open credit, like any new debit", async () => { /* ... */ });
  it("refuses a credit reason", async () => { /* REASON_TYPE_MISMATCH */ });
});
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Add `applyCreditToOneDebit`**

```ts
/**
 * Apply a credit to exactly ONE nominated debit, up to what that debit
 * owes, leaving any excess open on the credit.
 *
 * Distinct from `applyCreditToDebits` on purpose. A payment is money
 * against the account, so it walks every open debit in priority order. A
 * waiver or write-off forgives a SPECIFIC charge (§6.5), so it must not
 * spill onto others — waiving $30 of a $10 charge leaves a $20 refund
 * due, not $20 off the next bill.
 */
export async function applyCreditToOneDebit(
  tx: TxClient,
  utilityId: string,
  accountId: string,
  creditId: string,
  debitId: string,
): Promise<Application[]> {
  await lockAccount(tx, utilityId, accountId);

  const [credit, debit] = await Promise.all([
    tx.ledgerEntry.findFirstOrThrow({
      where: { id: creditId, utilityId, accountId },
      select: { openAmount: true },
    }),
    tx.ledgerEntry.findFirstOrThrow({
      where: { id: debitId, utilityId, accountId },
      select: { openAmount: true },
    }),
  ]);

  const available = credit.openAmount.negated();
  if (available.lte(0) || debit.openAmount.lte(0)) return [];

  const amount = Prisma.Decimal.min(available, debit.openAmount);
  return [await apply(tx, utilityId, creditId, debitId, amount)];
}
```

- [ ] **Step 4: Write `adjustment.service.ts`**

```ts
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import {
  EVENT_TYPES,
  type AdjustInput,
  type WaiveInput,
  type WriteOffInput,
} from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { lockAccount, recomputeAccountCache, type TxClient } from "./posting.service.js";
import {
  applyCreditToOneDebit,
  applyCreditsToDebit,
  type Application,
} from "./allocation.service.js";
import { resolveReason } from "./reason.service.js";

/**
 * Manual charges, waivers and write-offs — the acts an operator performs
 * on a receivable that is otherwise correct.
 *
 * `waive` and `writeOff` are separate exports although their mechanics
 * are identical, because §3.5 is explicit that they are different facts:
 * a concession and a bad debt are reported separately by any finance
 * department, and collapsing them is unrecoverable from history. The
 * third act — the charge was WRONG — is not here; that is `reverseEntry`.
 *
 * None of these touches `bill.total`. The bill stands as issued and the
 * receivable is reduced. A bill computed wrongly is a rebill (slice 5d).
 */

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export interface AdjustmentResult {
  entryId: string;
  /** Signed: positive for a manual charge, negative for a credit. */
  amount: string;
  applied: Application[];
  balance: string;
}

export interface CreditResult extends AdjustmentResult {
  /** Absolute value left unapplied — a refund due. */
  unapplied: string;
}

async function postCredit(
  type: "ADJUSTMENT_CREDIT" | "WRITE_OFF",
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: WaiveInput | WriteOffInput,
  existingTx?: TxClient,
): Promise<CreditResult> {
  const run = async (tx: TxClient): Promise<CreditResult> => {
    await lockAccount(tx, utilityId, accountId);
    await resolveReason(tx, utilityId, input.reasonId, type);

    const target = await tx.ledgerEntry.findFirst({
      where: { id: input.debitId, utilityId, accountId },
      select: { id: true, amount: true },
    });
    if (!target) {
      throw err("ENTRY_NOT_FOUND", `Entry ${input.debitId} not found on this account`, 404);
    }
    if (target.amount.lte(0)) {
      throw err("NOT_A_DEBIT", `Entry ${input.debitId} is not a charge`, 422);
    }

    const signed = new Prisma.Decimal(input.amount).negated();
    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type,
        amount: signed,
        openAmount: signed,
        dueDate: null, // a credit has nothing to fall due
        effectiveDate: new Date(input.effectiveDate ?? new Date().toISOString().slice(0, 10)),
        reasonId: input.reasonId,
        memo: input.memo ?? null,
        createdBy: actorId,
      },
    });

    const applied = await applyCreditToOneDebit(
      tx, utilityId, accountId, entry.id, input.debitId,
    );
    const cache = await recomputeAccountCache(tx, utilityId, accountId);
    const after = await tx.ledgerEntry.findUniqueOrThrow({
      where: { id: entry.id },
      select: { openAmount: true },
    });

    return {
      entryId: entry.id,
      amount: signed.toFixed(2),
      applied,
      unapplied: after.openAmount.negated().toFixed(2),
      balance: cache.balance,
    };
  };

  const runWithAudit = async (tx: TxClient): Promise<CreditResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_ADJUSTMENT_CREATED,
      result.entryId,
      null,
      result,
    );
    return result;
  };

  if (existingTx) return runWithAudit(existingTx);
  return prisma.$transaction(runWithAudit);
}

/** The charge was right and we are forgiving it. */
export function waive(
  utilityId: string, actorId: string, actorName: string, accountId: string,
  input: WaiveInput, existingTx?: TxClient,
): Promise<CreditResult> {
  return postCredit("ADJUSTMENT_CREDIT", utilityId, actorId, actorName, accountId, input, existingTx);
}

/** The charge was right and we are never collecting it. */
export function writeOff(
  utilityId: string, actorId: string, actorName: string, accountId: string,
  input: WriteOffInput, existingTx?: TxClient,
): Promise<CreditResult> {
  return postCredit("WRITE_OFF", utilityId, actorId, actorName, accountId, input, existingTx);
}

/** A charge raised by hand, outside billing. */
export async function adjustDebit(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: AdjustInput,
  existingTx?: TxClient,
): Promise<AdjustmentResult> {
  const run = async (tx: TxClient): Promise<AdjustmentResult> => {
    await lockAccount(tx, utilityId, accountId);
    await resolveReason(tx, utilityId, input.reasonId, "ADJUSTMENT_DEBIT");

    const amount = new Prisma.Decimal(input.amount);
    const effectiveDate = new Date(input.effectiveDate ?? new Date().toISOString().slice(0, 10));
    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "ADJUSTMENT_DEBIT",
        amount,
        openAmount: amount,
        dueDate: input.dueDate
          ? new Date(input.dueDate)
          : new Date(effectiveDate.getTime() + 30 * 86_400_000),
        effectiveDate,
        reasonId: input.reasonId,
        memo: input.memo ?? null,
        createdBy: actorId,
      },
    });

    const applied = await applyCreditsToDebit(tx, utilityId, accountId, entry.id);
    const cache = await recomputeAccountCache(tx, utilityId, accountId);
    return { entryId: entry.id, amount: amount.toFixed(2), applied, balance: cache.balance };
  };

  const runWithAudit = async (tx: TxClient): Promise<AdjustmentResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_ADJUSTMENT_CREATED,
      result.entryId,
      null,
      result,
    );
    return result;
  };

  if (existingTx) return runWithAudit(existingTx);
  return prisma.$transaction(runWithAudit);
}
```

- [ ] **Step 5: Run to verify they pass.**

- [ ] **Step 6: Prove the no-spill rule discriminates**

Swap `applyCreditToOneDebit` for `applyCreditToDebits` in `postCredit`. "leaves the excess open as a refund due and does not touch other debits" must fail, with the older $50 debit reduced to $30. Restore.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(ar): manual charges, waivers and write-offs against a reason (slice 3 task 5)"
```

---

## Task 6: HTTP surface

**Files:**
- Modify: `packages/api/src/routes/ar.ts`
- Test: `packages/api/src/__tests__/integration/ledger-routes.integration.test.ts`

**Interfaces — Produces:**

| Method | Path | Gate |
|---|---|---|
| GET | `/api/v1/ar/reasons` | `ar_adjustments:VIEW` |
| POST | `/api/v1/accounts/:id/fees` | `ar_adjustments:CREATE` |
| POST | `/api/v1/accounts/:id/adjustments` | `ar_adjustments:CREATE` |
| POST | `/api/v1/accounts/:id/waivers` | `ar_adjustments:EDIT` |
| POST | `/api/v1/accounts/:id/write-offs` | `ar_adjustments:EDIT` |

Waiving and writing off sit on EDIT rather than CREATE: raising a charge and forgiving one are different authority, which is why §8 splits the keys at all. `GET /ar/reasons` takes optional `appliesToType` and `includeInactive` query parameters.

- [ ] **Step 1: Write the failing tests** — for each route: the happy path, 403 without the permission and nothing written, 404 for another tenant's account, and 400 for a missing `reasonId`. Plus the Review Focus 422 for a type mismatch through HTTP. Extend the fixture with an `ADJUSTER` subject holding `ar_adjustments: ["VIEW","CREATE","EDIT"]` and enable the module.

- [ ] **Step 2: Run to verify they fail** — 404, routes absent.

- [ ] **Step 3: Add the routes**, following the shape already in `ar.ts`: parse `idParamSchema`, parse the body schema, call the service, `201`. `GET /ar/reasons` returns `{ data: ReasonRow[] }` and `200`.

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ar): fee, adjustment, waiver, write-off and reason endpoints (slice 3 task 6)"
```

---

## Task 7: Property test, seed data and documentation

**Files:**
- Modify: `packages/api/src/__tests__/integration/ledger-reconciliation.integration.test.ts`
- Modify: `seed.js`
- Modify: `docs/specs/23-accounts-receivable.md`, `docs/specs/10-payments-and-collections.md`, `docs/specs/00-data-model-overview.md`, `docs/design/utility-cis-architecture.md`, `docs/superpowers/specs/2026-10-09-ar-ledger-design.md`

- [ ] **Step 1: Extend the property test with fees and waivers**

Add to the loop, keeping the explicit application model from slice 2:

```ts
      // Every fifth step, raise a fee — a debit of a different class, so
      // allocation's type ranking is exercised by the property test and
      // not only by its own unit cases.
      if (i % 5 === 4) {
        const feeCents = 500 + Math.floor(next() * 2_000);
        const due = "2026-07-" + String(10 + Math.floor(next() * 18)).padStart(2, "0");
        const res = await fee.assessFee(utilityId, ACTOR, "T", accountId, {
          amount: (feeCents / 100).toFixed(2), reasonId: lateFeeId, dueDate: due,
        });
        modelBalance += feeCents;
        seq++;
        const d: DebitRef = { due, seq, open: feeCents, cls: 0 }; // FEE ranks first
        absorbInto(d);
        debits.push(d);
        fees++;
      }
```

`DebitRef` gains a `cls` field (0 for FEE, 2 for BILL_CHARGE) and the model's ordering becomes `cls`, then `due`, then `seq` — mirroring `DEBIT_ALLOCATION_ORDER`. Factor the absorption loop into `absorbInto(d)` since two call sites now need it. Assert `expect(fees).toBeGreaterThan(0)` at the end, and keep every existing per-iteration assertion including the per-entry §5 check.

- [ ] **Step 2: Run it.** The model's ordering now has to match allocation's for the balance *and* `lastDueDate` to agree every iteration. If it diverges, the model is wrong about priority — fix the model, not the assertion.

- [ ] **Step 3: Seed demo fees and a waiver**

In `seed.js`, after the opening balances, raise one `LATE_FEE` on the first delinquent account and waive part of it with `COURTESY_WAIVER`, writing the ledger rows and the application directly and then setting the cache to match — the same approach the opening balances already use, and for the same reason: the seeder does not import TypeScript services. Keep `GET /api/v1/ar/reconciliation` clean on a fresh seed, and verify that.

- [ ] **Step 4: Update the specs** — spec 23 (slice 3 complete; `LedgerReasonDef` now seeded and written; the five new endpoints with gates; the three-acts rule as a business rule; `ar_adjustments`; the two CHECKs now enforced and how they differ from §4.2); 10-payments-and-collections (waivers and write-offs have shipped; what remains is payment plans, the collections workflow and write-off *approval*); 00-data-model-overview (`LedgerReasonDef` row); architecture §8; and the design doc (§10 slice 3 complete, §11 recording the two constraint departures with the evidence for each).

- [ ] **Step 5: Full verification**

```bash
pnpm typecheck
cd packages/shared && pnpm exec vitest run
cd ../api && pnpm exec vitest run
cd ../api && pnpm exec vitest run --config vitest.integration.config.ts
cd ../.. && node seed.js && node seed.js
cd packages/shared && pnpm exec prisma migrate status
```

- [ ] **Step 6: Commit**

```bash
git commit -m "test(ar): property test covers fees and waivers; specs record slice 3 (slice 3 task 7)"
```

---

## Self-Review

**Spec coverage.** §3.4 extensibility in the reason — Task 1's `DEFAULT_REASON_CODES` plus Task 3's service. §3.5 three distinct acts — Task 5's separate `waive` / `writeOff` exports and the business rule in Task 7. §4.2 deferred CHECKs — Task 2, with both departures argued from evidence. §4.4 `LedgerReasonDef` including no `requiresApproval` — Tasks 1-3. §6.4 `assessFee` — Task 4. §6.5 `adjust` / `waive` / `writeOff` — Task 5. §8 `ar_adjustments` — Tasks 1 and 6. §10 slice 3 — all seven. **Deliberately out:** approvals (needs a request object outside the ledger, §4.4); fee *generation* (§6.4 says so; slice 6); the statement and aging views (slice 4); rebill (slice 5d).

**Placeholders.** Tasks 1-5 carry full code. Task 6 gives the route table, the gates and the four assertions per route but follows an established shape in `ar.ts` rather than repeating it five times; Task 7 names each document and what changes in it. Both are thinner than Tasks 1-5 by intent, and neither leaves a design decision open.

**Type consistency.** `ReasonedType` is defined in Task 1 and consumed by `resolveReason` in Task 3 and every service in Tasks 4-5. `Application` and `TxClient` come from slice 2 unchanged. `applyCreditToOneDebit` is added in Task 5 before its only caller. `CreditResult extends AdjustmentResult` adds exactly `unapplied`, matching `recordPayment`'s shape from slice 2.

**Review Focus coverage.** Over-waiving → Task 5, with a discrimination proof. Reason type mismatch → Tasks 3, 4, 5 and 6. Other tenant's reason → Task 3. Fee with no `assessedOnId` → Tasks 2 and 4. Inactive reason → Task 3.

**Known risks.** (1) Task 2's migration can fail to apply on a database holding reason-less rows from earlier slices; Step 4 says what to do. (2) Task 7's property model must mirror `DEBIT_ALLOCATION_ORDER` once two classes are in play — the first time the model has to know about priority rather than just dates. (3) `seed.js` now duplicates a third list (reason codes) with only a comment tying it to the shared constant; the module-key guard does not cover it, and whether that needs its own guard is a question for the whole-branch review.
