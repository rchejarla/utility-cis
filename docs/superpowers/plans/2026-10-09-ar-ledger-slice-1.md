# AR Ledger — Slice 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Issuing a `Bill` creates a receivable, atomically, and `Account.balance` is provably equal to the ledger.

**Architecture:** An open-item ledger. `LedgerEntry` holds one signed row per financial event; `LedgerApplication` records which credit paid which debit (written from slice 2 onward, table created here). `Account.balance` and `Account.lastDueDate` stay as caches written inside the posting transaction, never by a background job, so they cannot drift. Posting is configurable per tenant and overridable per account, defaulting to automatic.

**Tech Stack:** Prisma 6 + PostgreSQL 16 (TimescaleDB image), Fastify, Zod validators in `@utility-cis/shared`, Vitest (unit + testcontainers integration).

**Spec:** `docs/superpowers/specs/2026-10-09-ar-ledger-design.md`

## Global Constraints

- Money in the ledger is `Decimal(14,2)`. The rate engine's `Decimal(14,4)` is rounded **half-up to 2dp, once per bill**, at posting. Spec §4.6.
- `amount` and `openAmount` are **signed** from one viewpoint: positive increases what the customer owes the utility. Spec §3.3a.
- `openAmount` shares the sign of `amount`, and `abs(openAmount) <= abs(amount)`. Spec §5.
- Posting an entry and updating `account.balance` happen **in one transaction** — no events, no queues, no second transaction. Spec §3.6.
- Every mutation wraps in the existing `audit-wrap` helpers (`auditCreate` / `writeAuditRow`), which set `app.current_utility_id` transaction-scoped before writing.
- `amount`, `type`, `dueDate`, `effectiveDate` are immutable once posted. `openAmount` is maintained bookkeeping, not history.
- New tables carry `utility_id` and the standard `tenant_isolation` RLS policy, matching `bill` in `20260508130000_add_bill/migration.sql`.
- Prisma model names: `LedgerEntry`, `LedgerApplication`, `LedgerReasonDef`. Not `ArTransaction`. Spec §3.8.
- Service files live in `packages/api/src/services/ar/` and are named `posting.service.ts`, `reconciliation.service.ts` — not `ar-posting.service.ts`. The folder qualifies them. Spec §3.9.

**Deliberately not in this slice, though spec §6.1 step 4 mentions it:** auto-applying open credits when a new debit posts. Allocation and `LedgerApplication` writes are slice 2. A negative-total bill does create an open credit in slice 1, so the situation is reachable — but the *balance* is correct either way, because it is `SUM(open_amount)` and both rows stay open. Only the open-item detail is unreconciled, and slice 2's allocation is what settles it. This is a known deferral, not an oversight.

## Review Focus

Five conditions the spec implies that no task's happy path exercises. Each has a test assigned to the task that owns the code.

- **A Bill whose total rounds to 0.00** — `CHECK (amount <> 0)` would reject the entry and surface as a 500. The spec never says what posting a zero bill does. Decision taken in Task 3: set `postedAt`, write no entry, leave the balance alone. Test in Task 3.
- **A total at the half-cent boundary** — `47.3250` must become `47.33`, not `47.32`. `Prisma.Decimal` default rounding is not half-up. Test in Task 3.
- **Posting the same Bill twice** — the partial unique index raises `P2002`; a reasonable person expects a 409 naming the existing entry, not a Prisma error leaking as a 500. Test in Task 5.
- **Account override set to `false` while the tenant default is `true`** — the whole point of the override is that it wins. `??` on a boolean is correct here but `||` would silently break it. Test in Task 4.
- **An account whose debits are all settled** — `balance` must land exactly `0.00` and `lastDueDate` must clear to `null`, or delinquency keeps sweeping an account that owes nothing. Test in Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/prisma/schema.prisma` | Add 2 enums, 3 models, 3 columns |
| `packages/shared/prisma/migrations/20261009120000_ledger_foundation/migration.sql` | Tables, constraints, indexes, RLS |
| `packages/shared/src/validators/ledger.ts` | `ENTRY_SIGN`, `postBillSchema`, rounding helper |
| `packages/shared/src/events/index.ts` | `LEDGER_ENTRY_POSTED` |
| `packages/shared/src/validators/automation-config.ts` | `autoPostBills` field |
| `packages/api/src/services/ar/posting.service.ts` | `postBill`, `resolveAutoPostBills`, balance recompute |
| `packages/api/src/services/ar/reconciliation.service.ts` | Ledger-vs-cache reconciliation query |
| `packages/api/src/routes/ar.ts` | `POST /bills/:id/post`, `GET /accounts/:id/unposted-bills`, `GET /ar/reconciliation` |
| `packages/api/src/services/bill.service.ts` | Call `postBill` inside the existing transaction |
| `packages/shared/prisma/seed.ts` | Seed delinquent balances through the ledger |

---

## Task 1: Schema and migration

**Files:**
- Modify: `packages/shared/prisma/schema.prisma`
- Create: `packages/shared/prisma/migrations/20261009120000_ledger_foundation/migration.sql`
- Test: `packages/api/src/__tests__/integration/ledger-shape.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `LedgerEntry`, `LedgerApplication`, `LedgerReasonDef`; enums `LedgerEntryType`, `PaymentTender`; columns `Account.autoPostBills`, `TenantConfig.autoPostBills`, `Bill.postedAt`.

The whole `LedgerEntry` table is created here even though slice 1 only writes `BILL_CHARGE` rows. Splitting one table across three migrations to match the slices would be churn; slices gate *operations*, not columns.

- [ ] **Step 1: Write the failing shape test**

Create `packages/api/src/__tests__/integration/ledger-shape.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 — asserts the ledger schema exists with the constraints the
 * design depends on. Shape-only: no service code is exercised here.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

// A real account, so the constraint tests below cannot pass on a
// foreign-key violation instead of the CHECK they target.
const utilityId = "00000000-0000-4000-8000-0000000000aa";
let accountId: string;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "SHAPE-001",
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

async function cols(table: string): Promise<Record<string, string>> {
  const { prisma } = prismaImports;
  const rows = await prisma.$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
    `select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    table,
  );
  return Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
}

describe("ledger schema", () => {
  it("creates ledger_entry with signed money columns", async () => {
    const c = await cols("ledger_entry");
    expect(c["amount"]).toBe("numeric");
    expect(c["open_amount"]).toBe("numeric");
    expect(c["due_date"]).toBe("date");
    expect(c["effective_date"]).toBe("date");
    expect(c["bill_id"]).toBe("uuid");
    expect(c["reverses_id"]).toBe("uuid");
    expect(c["assessed_on_id"]).toBe("uuid");
  });

  it("creates ledger_application and ledger_reason_def", async () => {
    expect(Object.keys(await cols("ledger_application"))).toContain("credit_id");
    expect(Object.keys(await cols("ledger_reason_def"))).toContain("applies_to_type");
  });

  it("adds the auto-post and postedAt columns", async () => {
    expect(Object.keys(await cols("tenant_config"))).toContain("auto_post_bills");
    expect(Object.keys(await cols("account"))).toContain("auto_post_bills");
    expect(Object.keys(await cols("bill"))).toContain("posted_at");
  });

  // These three must insert against a REAL account. With a dangling
  // account_id the FK fires first and the test passes even if the CHECK
  // it claims to exercise does not exist. Asserting on the constraint
  // name is the second guard: an FK violation names the FK, not the CHECK.
  async function rejectsWith(constraint: string, cols: string, vals: string) {
    const { prisma } = prismaImports;
    await expect(
      prisma.$executeRawUnsafe(
        `insert into ledger_entry (utility_id, account_id, ${cols})
         values ('${utilityId}'::uuid, '${accountId}'::uuid, ${vals})`,
      ),
    ).rejects.toThrow(new RegExp(constraint));
  }

  it("rejects a zero amount", async () => {
    await rejectsWith(
      "ledger_entry_amount_nonzero",
      "type, amount, open_amount, effective_date",
      `'ADJUSTMENT_DEBIT', 0, 0, current_date`,
    );
  });

  it("rejects open_amount exceeding amount", async () => {
    await rejectsWith(
      "ledger_entry_open_within_amount",
      "type, amount, open_amount, effective_date",
      `'ADJUSTMENT_DEBIT', 10, 20, current_date`,
    );
  });

  it("rejects open_amount on the opposite side of amount", async () => {
    await rejectsWith(
      "ledger_entry_open_sign",
      "type, amount, open_amount, effective_date",
      `'ADJUSTMENT_DEBIT', 10, -5, current_date`,
    );
  });

  it("rejects a PAYMENT with a positive amount", async () => {
    await rejectsWith(
      "ledger_entry_type_sign",
      "type, amount, open_amount, effective_date",
      `'PAYMENT', 10, 10, current_date`,
    );
  });

  it("rejects a BILL_CHARGE with no bill", async () => {
    await rejectsWith(
      "ledger_entry_bill_charge_has_bill",
      "type, amount, open_amount, effective_date",
      `'BILL_CHARGE', 10, 10, current_date`,
    );
  });

  it("accepts a well-formed debit", async () => {
    const { prisma } = prismaImports;
    const n = await prisma.$executeRawUnsafe(
      `insert into ledger_entry (utility_id, account_id, type, amount, open_amount, effective_date)
       values ('${utilityId}'::uuid, '${accountId}'::uuid, 'ADJUSTMENT_DEBIT', 10, 10, current_date)`,
    );
    expect(n).toBe(1);
  });

  it("enables RLS on the new tables", async () => {
    const { prisma } = prismaImports;
    const rows = await prisma.$queryRaw<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('ledger_entry','ledger_application','ledger_reason_def')`;
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.relrowsecurity).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-shape.integration.test.ts
```

Expected: FAIL — `ledger_entry` columns come back empty.

- [ ] **Step 3: Add the schema**

Append to `packages/shared/prisma/schema.prisma`:

```prisma
enum LedgerEntryType {
  BILL_CHARGE
  FEE
  ADJUSTMENT_DEBIT
  PAYMENT
  ADJUSTMENT_CREDIT
  WRITE_OFF
  REVERSAL
}

enum PaymentTender {
  CARD
  ACH
  CASH
  CHECK
  LOCKBOX
}

/// One financial event against an account. Signed: positive increases
/// what the customer owes the utility, negative reduces it. `amount`,
/// `type`, `dueDate` and `effectiveDate` are immutable once written;
/// `openAmount` is maintained bookkeeping, like Account.balance.
model LedgerEntry {
  id            String          @id @default(uuid()) @db.Uuid
  utilityId     String          @map("utility_id") @db.Uuid
  accountId     String          @map("account_id") @db.Uuid
  type          LedgerEntryType @map("type")
  amount        Decimal         @map("amount") @db.Decimal(14, 2)
  openAmount    Decimal         @map("open_amount") @db.Decimal(14, 2)
  dueDate       DateTime?       @map("due_date") @db.Date
  effectiveDate DateTime        @map("effective_date") @db.Date
  postedAt      DateTime        @default(now()) @map("posted_at") @db.Timestamptz
  reasonId      String?         @map("reason_id") @db.Uuid
  billId        String?         @map("bill_id") @db.Uuid
  assessedOnId  String?         @map("assessed_on_id") @db.Uuid
  reversesId    String?         @map("reverses_id") @db.Uuid
  tender        PaymentTender?  @map("tender")
  externalRef   String?         @map("external_ref") @db.VarChar(100)
  memo          String?         @map("memo") @db.Text
  createdBy     String?         @map("created_by") @db.Uuid

  account      Account             @relation(fields: [accountId], references: [id], onDelete: Restrict)
  reason       LedgerReasonDef?    @relation(fields: [reasonId], references: [id], onDelete: Restrict)
  bill         Bill?               @relation(fields: [billId], references: [id], onDelete: Restrict)
  assessedOn   LedgerEntry?        @relation("LedgerFeeSource", fields: [assessedOnId], references: [id], onDelete: Restrict)
  assessedFees LedgerEntry[]       @relation("LedgerFeeSource")
  reverses     LedgerEntry?        @relation("LedgerReversal", fields: [reversesId], references: [id], onDelete: Restrict)
  reversedBy   LedgerEntry[]       @relation("LedgerReversal")
  creditsOut   LedgerApplication[] @relation("LedgerAppCredit")
  debitsIn     LedgerApplication[] @relation("LedgerAppDebit")

  @@index([utilityId, accountId, postedAt(sort: Desc)])
  @@index([utilityId, billId])
  @@index([assessedOnId])
  @@index([reversesId])
  @@map("ledger_entry")
}

/// Which credit paid down which debit, and by how much. `amount` is
/// always positive; the parents' signs make it subtract from a debit
/// and add to a credit, both converging on zero.
model LedgerApplication {
  id        String   @id @default(uuid()) @db.Uuid
  utilityId String   @map("utility_id") @db.Uuid
  creditId  String   @map("credit_id") @db.Uuid
  debitId   String   @map("debit_id") @db.Uuid
  amount    Decimal  @map("amount") @db.Decimal(14, 2)
  appliedAt DateTime @default(now()) @map("applied_at") @db.Timestamptz

  credit LedgerEntry @relation("LedgerAppCredit", fields: [creditId], references: [id], onDelete: Restrict)
  debit  LedgerEntry @relation("LedgerAppDebit", fields: [debitId], references: [id], onDelete: Restrict)

  @@index([creditId])
  @@index([debitId])
  @@map("ledger_application")
}

/// Why a fee or adjustment was raised, in the utility's own words.
/// Tenant-configurable, following the *TypeDef convention.
model LedgerReasonDef {
  id            String          @id @default(uuid()) @db.Uuid
  utilityId     String          @map("utility_id") @db.Uuid
  code          String          @map("code") @db.VarChar(50)
  label         String          @map("label") @db.VarChar(255)
  appliesToType LedgerEntryType @map("applies_to_type")
  isActive      Boolean         @default(true) @map("is_active")
  createdAt     DateTime        @default(now()) @map("created_at") @db.Timestamptz
  updatedAt     DateTime        @updatedAt @map("updated_at") @db.Timestamptz

  entries LedgerEntry[]

  @@unique([utilityId, code])
  @@index([utilityId, appliesToType])
  @@map("ledger_reason_def")
}
```

In the same file, add to `model Account` (beside `balance`):

```prisma
  autoPostBills Boolean? @map("auto_post_bills")
```

and to its relation block:

```prisma
  ledgerEntries LedgerEntry[]
```

Add to `model TenantConfig`:

```prisma
  autoPostBills Boolean @default(true) @map("auto_post_bills")
```

Add to `model Bill`:

```prisma
  postedAt DateTime? @map("posted_at") @db.Timestamptz
```

and to its relation block:

```prisma
  ledgerEntries LedgerEntry[]
```

- [ ] **Step 4: Write the migration**

Create `packages/shared/prisma/migrations/20261009120000_ledger_foundation/migration.sql`:

```sql
-- AR Ledger slice 1. See docs/superpowers/specs/2026-10-09-ar-ledger-design.md
--
-- Signed money: positive increases what the customer owes the utility.
-- openAmount shares its parent's sign and never exceeds it in magnitude,
-- so SUM(open_amount) over an account IS its balance.

CREATE TYPE "LedgerEntryType" AS ENUM (
  'BILL_CHARGE','FEE','ADJUSTMENT_DEBIT','PAYMENT','ADJUSTMENT_CREDIT','WRITE_OFF','REVERSAL'
);
CREATE TYPE "PaymentTender" AS ENUM ('CARD','ACH','CASH','CHECK','LOCKBOX');

CREATE TABLE "ledger_reason_def" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"      UUID NOT NULL,
  "code"            VARCHAR(50) NOT NULL,
  "label"           VARCHAR(255) NOT NULL,
  "applies_to_type" "LedgerEntryType" NOT NULL,
  "is_active"       BOOLEAN NOT NULL DEFAULT true,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ledger_reason_def_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ledger_reason_def_utility_code_key" ON "ledger_reason_def"("utility_id","code");
CREATE INDEX "ledger_reason_def_type_idx" ON "ledger_reason_def"("utility_id","applies_to_type");

CREATE TABLE "ledger_entry" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"     UUID NOT NULL,
  "account_id"     UUID NOT NULL,
  "type"           "LedgerEntryType" NOT NULL,
  "amount"         DECIMAL(14,2) NOT NULL,
  "open_amount"    DECIMAL(14,2) NOT NULL,
  "due_date"       DATE,
  "effective_date" DATE NOT NULL,
  "posted_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "reason_id"      UUID,
  "bill_id"        UUID,
  "assessed_on_id" UUID,
  "reverses_id"    UUID,
  "tender"         "PaymentTender",
  "external_ref"   VARCHAR(100),
  "memo"           TEXT,
  "created_by"     UUID,
  CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ledger_entry_account_fkey"
    FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_entry_reason_fkey"
    FOREIGN KEY ("reason_id") REFERENCES "ledger_reason_def"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_entry_bill_fkey"
    FOREIGN KEY ("bill_id") REFERENCES "bill"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_entry_assessed_on_fkey"
    FOREIGN KEY ("assessed_on_id") REFERENCES "ledger_entry"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_entry_reverses_fkey"
    FOREIGN KEY ("reverses_id") REFERENCES "ledger_entry"("id") ON DELETE RESTRICT,

  -- A zero-amount entry is never meaningful. This is also what rejects a
  -- $0 late fee; a minimum-fee policy belongs on delinquency_rule.
  CONSTRAINT "ledger_entry_amount_nonzero" CHECK ("amount" <> 0),

  -- open_amount may be fully consumed (0) but never over-consumed and
  -- never flipped to the other side of its parent.
  CONSTRAINT "ledger_entry_open_within_amount"
    CHECK (abs("open_amount") <= abs("amount")),
  CONSTRAINT "ledger_entry_open_sign"
    CHECK ("open_amount" = 0 OR sign("open_amount") = sign("amount")),

  -- Expected sign per type. REVERSAL is excluded: its amount is
  -- -original.amount, so its sign follows its target and it instead
  -- must name that target.
  CONSTRAINT "ledger_entry_type_sign" CHECK (
    ("type" IN ('BILL_CHARGE','FEE','ADJUSTMENT_DEBIT') AND "amount" > 0)
    OR ("type" IN ('PAYMENT','ADJUSTMENT_CREDIT','WRITE_OFF') AND "amount" < 0)
    OR ("type" = 'REVERSAL' AND "reverses_id" IS NOT NULL)
  ),

  -- Provenance rules: a bill charge names its bill, a fee names what it
  -- was assessed on, a payment is the only thing with a tender.
  CONSTRAINT "ledger_entry_bill_charge_has_bill" CHECK (
    "type" <> 'BILL_CHARGE' OR "bill_id" IS NOT NULL
  ),
  CONSTRAINT "ledger_entry_tender_only_payment" CHECK (
    "tender" IS NULL OR "type" = 'PAYMENT'
  )
);

-- Structural idempotency: a Bill can be posted at most once.
CREATE UNIQUE INDEX "ledger_entry_bill_charge_key"
  ON "ledger_entry"("utility_id","bill_id") WHERE "type" = 'BILL_CHARGE';

CREATE INDEX "ledger_entry_account_posted_idx"
  ON "ledger_entry"("utility_id","account_id","posted_at" DESC);
CREATE INDEX "ledger_entry_bill_idx"       ON "ledger_entry"("utility_id","bill_id");
CREATE INDEX "ledger_entry_assessed_on_idx" ON "ledger_entry"("assessed_on_id");
CREATE INDEX "ledger_entry_reverses_idx"    ON "ledger_entry"("reverses_id");

-- Aging and allocation walk only open debits. Because credits are
-- negative, `open_amount > 0` selects exactly those.
CREATE INDEX "ledger_entry_open_debits_idx"
  ON "ledger_entry"("utility_id","due_date")
  WHERE "open_amount" > 0 AND "due_date" IS NOT NULL;

CREATE TABLE "ledger_application" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "utility_id" UUID NOT NULL,
  "credit_id"  UUID NOT NULL,
  "debit_id"   UUID NOT NULL,
  "amount"     DECIMAL(14,2) NOT NULL,
  "applied_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ledger_application_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ledger_application_credit_fkey"
    FOREIGN KEY ("credit_id") REFERENCES "ledger_entry"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_application_debit_fkey"
    FOREIGN KEY ("debit_id") REFERENCES "ledger_entry"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_application_amount_positive" CHECK ("amount" > 0)
);
CREATE INDEX "ledger_application_credit_idx" ON "ledger_application"("credit_id");
CREATE INDEX "ledger_application_debit_idx"  ON "ledger_application"("debit_id");

ALTER TABLE "ledger_entry"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_reason_def"  ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ledger_entry"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);
CREATE POLICY "tenant_isolation" ON "ledger_application"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);
CREATE POLICY "tenant_isolation" ON "ledger_reason_def"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);

-- Posting configuration. Default true per the product decision; the
-- nullable account column means null inherits the tenant value, so
-- flipping the tenant setting moves every account that has not opted out.
ALTER TABLE "tenant_config" ADD COLUMN "auto_post_bills" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "account"       ADD COLUMN "auto_post_bills" BOOLEAN;

-- Cache of a derivable fact, written in the posting transaction. Lets
-- the operator screen filter unposted bills without an anti-join.
ALTER TABLE "bill" ADD COLUMN "posted_at" TIMESTAMPTZ;
```

- [ ] **Step 5: Regenerate the client and run the test**

```bash
pnpm --filter @utility-cis/shared exec prisma generate
pnpm --filter @utility-cis/shared build
pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-shape.integration.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/prisma/schema.prisma packages/shared/prisma/migrations/20261009120000_ledger_foundation packages/api/src/__tests__/integration/ledger-shape.integration.test.ts
git commit -m "feat(ar): ledger schema — entries, applications, reason defs (slice 1 task 1)"
```

---

## Task 2: Shared sign map, rounding helper, validators

**Files:**
- Create: `packages/shared/src/validators/ledger.ts`
- Modify: `packages/shared/src/validators/index.ts`
- Modify: `packages/shared/src/events/index.ts`
- Test: `packages/shared/src/validators/__tests__/ledger.test.ts`

**Interfaces:**
- Consumes: `LedgerEntryType` from Task 1's generated client (referenced as a string union, not imported, so the shared package stays free of the generated client).
- Produces: `ENTRY_SIGN`, `roundToCents(value: string | number): string`, `postBillSchema`, `EVENT_TYPES.LEDGER_ENTRY_POSTED`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/validators/__tests__/ledger.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ENTRY_SIGN, roundToCents, postBillSchema } from "../ledger";

describe("ENTRY_SIGN", () => {
  it("signs debits positive and credits negative", () => {
    expect(ENTRY_SIGN.BILL_CHARGE).toBe(1);
    expect(ENTRY_SIGN.FEE).toBe(1);
    expect(ENTRY_SIGN.ADJUSTMENT_DEBIT).toBe(1);
    expect(ENTRY_SIGN.PAYMENT).toBe(-1);
    expect(ENTRY_SIGN.ADJUSTMENT_CREDIT).toBe(-1);
    expect(ENTRY_SIGN.WRITE_OFF).toBe(-1);
  });

  it("has no entry for REVERSAL, whose sign follows its target", () => {
    expect("REVERSAL" in ENTRY_SIGN).toBe(false);
  });
});

describe("roundToCents", () => {
  it("rounds half-up at the half cent", () => {
    expect(roundToCents("47.3250")).toBe("47.33");
    expect(roundToCents("47.3249")).toBe("47.32");
    expect(roundToCents("0.005")).toBe("0.01");
  });

  it("rounds half-up away from zero for negatives", () => {
    expect(roundToCents("-47.3250")).toBe("-47.33");
  });

  it("pads to two decimal places", () => {
    expect(roundToCents("5")).toBe("5.00");
    expect(roundToCents("5.1")).toBe("5.10");
  });
});

describe("postBillSchema", () => {
  it("accepts an empty body", () => {
    expect(postBillSchema.parse({})).toEqual({});
  });

  it("accepts an effectiveDate override", () => {
    expect(postBillSchema.parse({ effectiveDate: "2026-05-15" })).toEqual({
      effectiveDate: "2026-05-15",
    });
  });

  it("rejects a malformed effectiveDate", () => {
    expect(() => postBillSchema.parse({ effectiveDate: "15/05/2026" })).toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm --filter @utility-cis/shared exec vitest run src/validators/__tests__/ledger.test.ts
```

Expected: FAIL — cannot resolve `../ledger`.

- [ ] **Step 3: Implement**

Create `packages/shared/src/validators/ledger.ts`:

```ts
import { z } from "zod";

/**
 * Ledger money rules, shared between API and UI.
 *
 * Sign convention, from one fixed viewpoint: positive increases what the
 * customer owes the utility, negative reduces it. See
 * docs/superpowers/specs/2026-10-09-ar-ledger-design.md §3.3a.
 */

export type DebitType = "BILL_CHARGE" | "FEE" | "ADJUSTMENT_DEBIT";
export type CreditType = "PAYMENT" | "ADJUSTMENT_CREDIT" | "WRITE_OFF";

/**
 * Expected sign per entry type. REVERSAL is deliberately absent: its
 * amount is -original.amount, so its sign follows the entry it reverses
 * and there is no fixed mapping to assert.
 */
export const ENTRY_SIGN: Record<DebitType | CreditType, 1 | -1> = {
  BILL_CHARGE: 1,
  FEE: 1,
  ADJUSTMENT_DEBIT: 1,
  PAYMENT: -1,
  ADJUSTMENT_CREDIT: -1,
  WRITE_OFF: -1,
};

/**
 * Round a rate-engine amount (Decimal(14,4)) to ledger precision
 * (Decimal(14,2)), half-up, away from zero.
 *
 * Implemented on integers rather than with `toFixed`, because
 * `toFixed` uses the IEEE-754 representation and rounds 1.005 to
 * "1.00". Half-up is the utility billing convention; the test pins
 * 47.3250 -> 47.33.
 */
export function roundToCents(value: string | number): string {
  const s = (typeof value === "number" ? value.toString() : value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`roundToCents: not a decimal string: ${value}`);
  }
  const neg = s.startsWith("-");
  const [intPart, fracPart = ""] = (neg ? s.slice(1) : s).split(".");

  // Three decimals is enough to decide half-up at two: no digits beyond
  // the third can flip a decision made there, because 0.0004999… is
  // always < 0.0005. Everything is integer arithmetic via BigInt, so no
  // float representation is involved in rounding money.
  const frac = (fracPart + "000").slice(0, 3);
  let cents = BigInt(intPart) * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1n;

  const whole = cents / 100n;
  const rem = cents % 100n;
  const body = `${whole}.${rem.toString().padStart(2, "0")}`;
  // Avoid "-0.00": a value that rounds to zero has no sign.
  return neg && cents !== 0n ? `-${body}` : body;
}

/** Body for POST /api/v1/bills/:id/post. Both fields optional. */
export const postBillSchema = z.object({
  effectiveDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .optional(),
});

export type PostBillInput = z.infer<typeof postBillSchema>;
```

Add to `packages/shared/src/validators/index.ts`:

```ts
export * from "./ledger";
```

Add to `EVENT_TYPES` in `packages/shared/src/events/index.ts`:

```ts
  LEDGER_ENTRY_POSTED: "ledger_entry.created",
```

- [ ] **Step 4: Run the test**

```bash
pnpm --filter @utility-cis/shared exec vitest run src/validators/__tests__/ledger.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/ledger.ts packages/shared/src/validators/index.ts packages/shared/src/validators/__tests__/ledger.test.ts packages/shared/src/events/index.ts
git commit -m "feat(ar): ENTRY_SIGN, half-up cent rounding, post-bill validator (slice 1 task 2)"
```

---

## Task 3: `postBill` and the balance cache

**Files:**
- Create: `packages/api/src/services/ar/posting.service.ts`
- Test: `packages/api/src/__tests__/integration/ledger-posting.integration.test.ts`

**Interfaces:**
- Consumes: `roundToCents`, `EVENT_TYPES.LEDGER_ENTRY_POSTED` (Task 2); `auditCreate`, `writeAuditRow` from `../../lib/audit-wrap.js`.
- Produces:
  - `postBill(utilityId: string, actorId: string, actorName: string, billId: string, input?: { effectiveDate?: string }, existingTx?: TxClient): Promise<PostBillResult>`
  - `recomputeAccountCache(tx: TxClient, utilityId: string, accountId: string): Promise<{ balance: string; lastDueDate: Date | null }>`
  - `interface PostBillResult { billId: string; entryId: string | null; amount: string; balance: string; skippedZero: boolean }`

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/__tests__/integration/ledger-posting.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 — postBill creates the receivable and moves the cached
 * balance, in one transaction. Covers the Review Focus cases for a
 * zero-total bill and half-cent rounding.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");

let utilityId: string;
let accountId: string;
let billingCycleId: string;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");

  const { prisma } = prismaImports;
  utilityId = "00000000-0000-4000-8000-0000000000aa";
  const cycle = await prisma.billingCycle.create({
    data: {
      utilityId,
      name: "Route 1",
      cycleCode: "R01",
      billDayOfMonth: 15,
      frequency: "MONTHLY",
    },
  });
  billingCycleId = cycle.id;
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "LEDGER-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId,
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
  await prisma.bill.deleteMany({});
  await prisma.account.update({
    where: { id: accountId },
    data: { balance: 0, lastDueDate: null },
  });
});

async function makeBill(total: string, dueDate = "2026-06-14"): Promise<string> {
  const { prisma } = prismaImports;
  const bill = await prisma.bill.create({
    data: {
      utilityId,
      accountId,
      billingCycleId,
      periodStart: new Date("2026-04-16"),
      periodEnd: new Date("2026-05-15"),
      billDate: new Date("2026-05-15"),
      dueDate: new Date(dueDate),
      subtotal: total,
      taxes: "0",
      credits: "0",
      total,
      billNumber: `BILL-TEST-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return bill.id;
}

describe("postBill", () => {
  it("creates a BILL_CHARGE and moves the cached balance", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("69.6500");

    const result = await posting.postBill(utilityId, ACTOR, "Tester", billId);

    expect(result.amount).toBe("69.65");
    expect(result.skippedZero).toBe(false);

    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { billId } });
    expect(entry.type).toBe("BILL_CHARGE");
    expect(entry.amount.toFixed(2)).toBe("69.65");
    expect(entry.openAmount.toFixed(2)).toBe("69.65");
    expect(entry.dueDate?.toISOString().slice(0, 10)).toBe("2026-06-14");

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("69.65");
    expect(account.lastDueDate?.toISOString().slice(0, 10)).toBe("2026-06-14");

    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: billId } });
    expect(bill.postedAt).not.toBeNull();
  });

  it("writes an audit row in the same transaction", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("10.0000");
    await posting.postBill(utilityId, ACTOR, "Tester", billId);
    const audits = await prisma.auditLog.findMany({ where: { entityType: "LedgerEntry" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("CREATE");
  });

  // Review Focus: half-cent boundary
  it("rounds a half-cent total half-up", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("47.3250");
    await posting.postBill(utilityId, ACTOR, "Tester", billId);
    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { billId } });
    expect(entry.amount.toFixed(2)).toBe("47.33");
  });

  // Review Focus: zero-total bill
  it("marks a zero-total bill posted without writing an entry", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("0.0000");

    const result = await posting.postBill(utilityId, ACTOR, "Tester", billId);

    expect(result.skippedZero).toBe(true);
    expect(result.entryId).toBeNull();
    expect(await prisma.ledgerEntry.count({ where: { billId } })).toBe(0);

    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: billId } });
    expect(bill.postedAt).not.toBeNull();

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("0.00");
  });

  it("posts a negative-total bill as ADJUSTMENT_CREDIT", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("-12.5000");
    await posting.postBill(utilityId, ACTOR, "Tester", billId);
    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { billId } });
    expect(entry.type).toBe("ADJUSTMENT_CREDIT");
    expect(entry.amount.toFixed(2)).toBe("-12.50");
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("-12.50");
  });

  it("refuses an unknown bill", async () => {
    await expect(
      posting.postBill(utilityId, ACTOR, "Tester", "00000000-0000-4000-8000-00000000dead"),
    ).rejects.toMatchObject({ code: "BILL_NOT_FOUND" });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-posting.integration.test.ts
```

Expected: FAIL — cannot resolve `../../services/ar/posting.service.js`.

- [ ] **Step 3: Implement the service**

Create `packages/api/src/services/ar/posting.service.ts`:

```ts
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { EVENT_TYPES, roundToCents } from "@utility-cis/shared";

type TxClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * AR posting — turning an issued Bill into a receivable.
 *
 * One LedgerEntry per Bill (not per segment or line): see spec §3.1.
 * The entry's amount is a snapshot, deliberately copied rather than
 * derived, because rebills will change bill totals and a receivable
 * must be frozen at posting (§3.2).
 *
 * Posting and the Account.balance update happen in ONE transaction.
 * No event, no queue — an async balance update would reopen exactly
 * the atomicity gap the EventEmitter audit pipeline had.
 */

export interface PostBillResult {
  billId: string;
  entryId: string | null;
  amount: string;
  balance: string;
  skippedZero: boolean;
}

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

/**
 * Recompute the cached Account.balance and lastDueDate from the ledger.
 *
 * balance is SUM(open_amount) — a plain sum, because both amount and
 * openAmount are signed. lastDueDate is the oldest open debit's due
 * date, and clears to null when nothing is open, so the delinquency
 * sweep stops seeing an account that owes nothing.
 */
export async function recomputeAccountCache(
  tx: TxClient,
  utilityId: string,
  accountId: string,
): Promise<{ balance: string; lastDueDate: Date | null }> {
  const [agg] = await tx.$queryRaw<{ balance: Prisma.Decimal | null }[]>`
    SELECT COALESCE(SUM(open_amount), 0) AS balance
      FROM ledger_entry
     WHERE utility_id = ${utilityId}::uuid AND account_id = ${accountId}::uuid`;
  const balance = new Prisma.Decimal(agg?.balance ?? 0).toFixed(2);

  const [oldest] = await tx.$queryRaw<{ due_date: Date | null }[]>`
    SELECT due_date
      FROM ledger_entry
     WHERE utility_id = ${utilityId}::uuid AND account_id = ${accountId}::uuid
       AND open_amount > 0 AND due_date IS NOT NULL
     ORDER BY due_date ASC
     LIMIT 1`;
  const lastDueDate = oldest?.due_date ?? null;

  await tx.account.update({
    where: { id: accountId },
    data: { balance, lastDueDate },
  });
  return { balance, lastDueDate };
}

/**
 * Post an issued Bill to the ledger.
 *
 * Idempotency is structural: a partial unique index on
 * (utility_id, bill_id) WHERE type = 'BILL_CHARGE'. A second attempt
 * raises P2002, which the route maps to 409.
 *
 * A bill whose total rounds to 0.00 is marked posted and writes no
 * entry — CHECK (amount <> 0) would reject it, and a zero receivable
 * is not a thing that can be paid. The spec is silent here; this is
 * the decision.
 */
export async function postBill(
  utilityId: string,
  actorId: string,
  actorName: string,
  billId: string,
  input: { effectiveDate?: string } = {},
  existingTx?: TxClient,
): Promise<PostBillResult> {
  const run = async (tx: TxClient): Promise<PostBillResult> => {
    const bill = await tx.bill.findUnique({
      where: { id: billId, utilityId },
      select: { id: true, accountId: true, total: true, dueDate: true, billDate: true, postedAt: true },
    });
    if (!bill) throw err("BILL_NOT_FOUND", `Bill ${billId} not found`, 404);
    if (bill.postedAt) {
      throw err("BILL_ALREADY_POSTED", `Bill ${billId} was already posted`, 409);
    }

    const amount = roundToCents(bill.total.toString());
    const effectiveDate = new Date(input.effectiveDate ?? bill.billDate.toISOString().slice(0, 10));

    if (amount === "0.00") {
      await tx.bill.update({ where: { id: billId }, data: { postedAt: new Date() } });
      const cache = await recomputeAccountCache(tx, utilityId, bill.accountId);
      return { billId, entryId: null, amount, balance: cache.balance, skippedZero: true };
    }

    // A bill that nets negative is a credit, not a debit with a negative
    // amount — keeps the type/sign constraint true and reads as what it is.
    const isCredit = amount.startsWith("-");

    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId: bill.accountId,
        type: isCredit ? "ADJUSTMENT_CREDIT" : "BILL_CHARGE",
        amount,
        openAmount: amount,
        // Only a debit ages; a credit has nothing to fall due.
        dueDate: isCredit ? null : bill.dueDate,
        effectiveDate,
        billId: isCredit ? null : bill.id,
        createdBy: actorId,
        memo: isCredit ? `Net credit from bill ${billId}` : null,
      },
    });

    await tx.bill.update({ where: { id: billId }, data: { postedAt: new Date() } });
    const cache = await recomputeAccountCache(tx, utilityId, bill.accountId);

    return { billId, entryId: entry.id, amount, balance: cache.balance, skippedZero: false };
  };

  // `auditCreate` requires an entity with an id to audit; the
  // zero-amount path produces none, so use the lower-level
  // `writeAuditRow` and emit only when an entry was actually written.
  const runWithAudit = async (tx: TxClient): Promise<PostBillResult> => {
    const result = await run(tx);
    if (result.entryId) {
      await writeAuditRow(
        tx,
        { utilityId, actorId, actorName, entityType: "LedgerEntry" },
        EVENT_TYPES.LEDGER_ENTRY_POSTED,
        result.entryId,
        null,
        result,
      );
    }
    return result;
  };

  if (existingTx) return runWithAudit(existingTx);
  return prisma.$transaction(runWithAudit);
}

export type { TxClient };
```

- [ ] **Step 4: Run the test**

```bash
pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-posting.integration.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/ar/posting.service.ts packages/api/src/__tests__/integration/ledger-posting.integration.test.ts
git commit -m "feat(ar): postBill writes the receivable and the balance cache in one transaction (slice 1 task 3)"
```

---

## Task 4: Auto-post configuration and wiring into bill generation

**Files:**
- Modify: `packages/shared/src/validators/automation-config.ts`
- Modify: `packages/api/src/services/ar/posting.service.ts` (add `resolveAutoPostBills`)
- Modify: `packages/api/src/services/bill.service.ts:189-257`
- Test: `packages/api/src/__tests__/integration/ledger-autopost.integration.test.ts`

**Interfaces:**
- Consumes: `postBill` (Task 3).
- Produces: `resolveAutoPostBills(tx: TxClient, utilityId: string, accountId: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/__tests__/integration/ledger-autopost.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 — auto-post resolution. Tenant default, overridable per
 * account, default on. Covers the Review Focus case where the account
 * override is false while the tenant default is true.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");

const utilityId = "00000000-0000-4000-8000-0000000000aa";
let accountId: string;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "AUTOPOST-001",
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
  await prisma.tenantConfig.deleteMany({ where: { utilityId } });
  await prisma.account.update({ where: { id: accountId }, data: { autoPostBills: null } });
});

async function setTenant(autoPostBills: boolean) {
  const { prisma } = prismaImports;
  await prisma.tenantConfig.create({ data: { utilityId, autoPostBills } });
}

async function setAccount(autoPostBills: boolean | null) {
  const { prisma } = prismaImports;
  await prisma.account.update({ where: { id: accountId }, data: { autoPostBills } });
}

describe("resolveAutoPostBills", () => {
  it("defaults to true when no tenant config row exists", async () => {
    const { prisma } = prismaImports;
    await expect(posting.resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(true);
  });

  it("follows the tenant default when the account does not override", async () => {
    const { prisma } = prismaImports;
    await setTenant(false);
    await expect(posting.resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(false);
    await prisma.tenantConfig.deleteMany({ where: { utilityId } });
    await setTenant(true);
    await expect(posting.resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(true);
  });

  // Review Focus: the override must win, including when it is `false`
  it("lets an account override of false beat a tenant default of true", async () => {
    const { prisma } = prismaImports;
    await setTenant(true);
    await setAccount(false);
    await expect(posting.resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(false);
  });

  it("lets an account override of true beat a tenant default of false", async () => {
    const { prisma } = prismaImports;
    await setTenant(false);
    await setAccount(true);
    await expect(posting.resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-autopost.integration.test.ts
```

Expected: FAIL — `posting.resolveAutoPostBills is not a function`.

- [ ] **Step 3: Implement the resolver**

Append to `packages/api/src/services/ar/posting.service.ts`:

```ts
/**
 * Resolve whether a Bill posts automatically on generation.
 *
 * Tenant default, overridable per account. `??` not `||`, so an account
 * override of `false` beats a tenant default of `true` — which is the
 * entire point of having an override. Null on the account means inherit,
 * so flipping the tenant setting moves every account that has not
 * explicitly opted out.
 *
 * No tenant_config row means an unconfigured tenant, which takes the
 * column default: auto-post on.
 */
export async function resolveAutoPostBills(
  tx: TxClient,
  utilityId: string,
  accountId: string,
): Promise<boolean> {
  const [account, config] = await Promise.all([
    tx.account.findUnique({ where: { id: accountId }, select: { autoPostBills: true } }),
    tx.tenantConfig.findUnique({ where: { utilityId }, select: { autoPostBills: true } }),
  ]);
  return account?.autoPostBills ?? config?.autoPostBills ?? true;
}
```

- [ ] **Step 4: Add the config field to the validator and its service**

Three places, not one. `AutomationConfigSchema` is the *full* config shape, and `automation-config.service.ts` builds that shape field-by-field from an explicit row interface — adding the Zod field alone fails `pnpm typecheck`.

In `packages/shared/src/validators/automation-config.ts`, add to `AutomationConfigSchema`:

```ts
  autoPostBills: z.boolean(),
```

In `packages/api/src/services/automation-config.service.ts`, add to the `AutomationConfigRow` interface (around line 35):

```ts
  autoPostBills: boolean;
```

and to the object `toDto` returns (around line 51):

```ts
    autoPostBills: row.autoPostBills,
```

Then check the `select` / `upsert` in `getAutomationConfig` further down the same file: if it names columns explicitly, add `autoPostBills: true` to the select and `autoPostBills: true` to the create defaults, so the shape stays complete for a tenant with no config row.

- [ ] **Step 5: Wire posting into bill generation**

In `packages/api/src/services/bill.service.ts`, inside the `auditCreate` callback, replace the final `return assembleBillWithSegments(tx, utilityId, bill.id);` with:

```ts
      // Post to the ledger in THIS transaction when auto-post is on, so
      // a Bill and its receivable commit together or not at all.
      const { resolveAutoPostBills, postBill } = await import("./ar/posting.service.js");
      if (await resolveAutoPostBills(tx, utilityId, accountId)) {
        await postBill(utilityId, actorId, actorName, bill.id, {}, tx);
      }

      return assembleBillWithSegments(tx, utilityId, bill.id);
```

- [ ] **Step 6: Run the test and the existing bill suite**

```bash
pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-autopost.integration.test.ts
pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/bill-creation.integration.test.ts
```

Expected: both PASS. The bill-creation suite must still pass — it now posts as a side effect, and its assertions are about Bill totals, which are unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/services/ar/posting.service.ts packages/api/src/services/bill.service.ts packages/shared/src/validators/automation-config.ts packages/api/src/__tests__/integration/ledger-autopost.integration.test.ts
git commit -m "feat(ar): tenant + account auto-post config, wired into bill generation (slice 1 task 4)"
```

---

## Task 5: Post endpoint and unposted-bills query

**Files:**
- Create: `packages/api/src/routes/ar.ts`
- Modify: `packages/api/src/app.ts:151` (register the routes)
- Test: `packages/api/src/__tests__/integration/ledger-routes.integration.test.ts`

**Interfaces:**
- Consumes: `postBill` (Task 3), `postBillSchema` (Task 2).
- Produces: `arRoutes` Fastify plugin; `POST /api/v1/bills/:id/post`, `GET /api/v1/accounts/:id/unposted-bills`.

Gated on the **`agreements`** module key, the same permission as bill generation (bill routes moved there in commit `69a559a`). Deliberately not a stronger gate: if posting required more permission than generating, turning auto-post on would let a user create receivables they cannot create directly.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/__tests__/integration/ledger-routes.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 — HTTP surface for manual posting. Covers the Review Focus
 * case of posting the same Bill twice surfacing as 409, not a 500.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;
let accountId: string;
let billingCycleId: string;

function makeToken() {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: ACTOR,
      utility_id: utilityId,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}
const headers = () => ({ authorization: `Bearer ${makeToken()}` });

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  const appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  billingCycleId = cycle.id;
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "ROUTES-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId,
      autoPostBills: false,
    },
  });
  accountId = account.id;
  await prisma.tenantModule.create({ data: { utilityId, moduleKey: "agreements" } });
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateTenantModulesCache(utilityId);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.ledgerEntry.deleteMany({});
  await prisma.bill.deleteMany({});
  await prisma.account.update({ where: { id: accountId }, data: { balance: 0, lastDueDate: null } });
});

async function makeBill(total = "25.0000"): Promise<string> {
  const { prisma } = prismaImports;
  const bill = await prisma.bill.create({
    data: {
      utilityId,
      accountId,
      billingCycleId,
      periodStart: new Date("2026-04-16"),
      periodEnd: new Date("2026-05-15"),
      billDate: new Date("2026-05-15"),
      dueDate: new Date("2026-06-14"),
      subtotal: total,
      taxes: "0",
      credits: "0",
      total,
      billNumber: `BILL-R-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return bill.id;
}

describe("POST /api/v1/bills/:id/post", () => {
  it("posts the bill and returns the new balance", async () => {
    const billId = await makeBill();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/post`,
      headers: headers(),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.amount).toBe("25.00");
    expect(body.balance).toBe("25.00");
  });

  // Review Focus: duplicate post must be a clean 409
  it("returns 409 when the bill is already posted", async () => {
    const billId = await makeBill();
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/post`,
      headers: headers(),
      payload: {},
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/post`,
      headers: headers(),
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error.code).toBe("BILL_ALREADY_POSTED");
  });

  it("returns 404 for an unknown bill", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bills/00000000-0000-4000-8000-00000000dead/post",
      headers: headers(),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/v1/accounts/:id/unposted-bills", () => {
  it("lists only bills with no postedAt", async () => {
    const unposted = await makeBill("10.0000");
    const posted = await makeBill("20.0000");
    await app.inject({
      method: "POST",
      url: `/api/v1/bills/${posted}/post`,
      headers: headers(),
      payload: {},
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${accountId}/unposted-bills`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.map((b: { id: string }) => b.id)).toEqual([unposted]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-routes.integration.test.ts
```

Expected: FAIL — 404 on both routes.

- [ ] **Step 3: Implement the routes**

Create `packages/api/src/routes/ar.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { postBillSchema } from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { postBill } from "../services/ar/posting.service.js";

/**
 * AR routes. Posting is gated on the `agreements` module — the same
 * permission as bill generation — because when auto-post is on,
 * generating a bill IS posting it. A stronger gate here would let
 * someone bypass this permission by turning auto-post on.
 */
export async function arRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    "/api/v1/bills/:id/post",
    { config: { module: "agreements", permission: "CREATE" } },
    async (request, reply) => {
      const input = postBillSchema.parse(request.body ?? {});
      const result = await postBill(
        request.user.utilityId,
        request.user.id,
        request.user.name ?? request.user.email,
        request.params.id,
        input,
      );
      return reply.status(201).send(result);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/accounts/:id/unposted-bills",
    { config: { module: "agreements", permission: "VIEW" } },
    async (request, reply) => {
      const bills = await prisma.bill.findMany({
        where: {
          utilityId: request.user.utilityId,
          accountId: request.params.id,
          postedAt: null,
        },
        orderBy: { periodEnd: "asc" },
        select: {
          id: true,
          billNumber: true,
          periodStart: true,
          periodEnd: true,
          dueDate: true,
          total: true,
        },
      });
      return reply.send({
        data: bills.map((b) => ({ ...b, total: b.total.toFixed(4) })),
      });
    },
  );
}
```

- [ ] **Step 4: Register the routes**

In `packages/api/src/app.ts`, add the import beside the other route imports:

```ts
import { arRoutes } from "./routes/ar.js";
```

and register it after `importRoutes`:

```ts
  await app.register(arRoutes);
```

- [ ] **Step 5: Run the test**

```bash
pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-routes.integration.test.ts
```

Expected: PASS, 4 tests. If the 409 comes back as 500, the `statusCode` property set by `err()` in Task 3 is not reaching the error handler — check `middleware/error-handler.ts` reads `statusCode`.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/ar.ts packages/api/src/app.ts packages/api/src/__tests__/integration/ledger-routes.integration.test.ts
git commit -m "feat(ar): manual post endpoint and unposted-bills list (slice 1 task 5)"
```

---

## Task 6: Reconciliation, the property test, and seeding through the ledger

**Files:**
- Create: `packages/api/src/services/ar/reconciliation.service.ts`
- Modify: `packages/api/src/routes/ar.ts` (add the reconciliation endpoint)
- Modify: `packages/shared/prisma/seed.ts`
- Test: `packages/api/src/__tests__/integration/ledger-reconciliation.integration.test.ts`

**Interfaces:**
- Consumes: `postBill`, `recomputeAccountCache` (Task 3).
- Produces: `reconcileBalances(utilityId: string): Promise<BalanceDrift[]>`; `interface BalanceDrift { accountId: string; accountNumber: string; cached: string; ledger: string }`.

The seed change is in this task rather than its own: the seeder currently sets `balance = 412.80` with no entries behind it, so reconciliation fails on a fresh seed the moment it exists. The test and the fix have to land together.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/__tests__/integration/ledger-reconciliation.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 — the cache is provably equal to the ledger. The property
 * test is the real guard on the §5 invariants: it replays a long
 * deterministic sequence of postings and asserts reconciliation holds
 * throughout. Also covers the Review Focus case of a fully settled
 * account clearing lastDueDate.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");
let recon: typeof import("../../services/ar/reconciliation.service.js");

let accountId: string;
let billingCycleId: string;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  recon = await import("../../services/ar/reconciliation.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  billingCycleId = cycle.id;
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "RECON-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId,
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
  await prisma.bill.deleteMany({});
  await prisma.account.update({ where: { id: accountId }, data: { balance: 0, lastDueDate: null } });
});

async function makeBill(total: string, dueDate: string): Promise<string> {
  const { prisma } = prismaImports;
  const bill = await prisma.bill.create({
    data: {
      utilityId,
      accountId,
      billingCycleId,
      periodStart: new Date("2026-04-16"),
      periodEnd: new Date("2026-05-15"),
      billDate: new Date("2026-05-15"),
      dueDate: new Date(dueDate),
      subtotal: total,
      taxes: "0",
      credits: "0",
      total,
      billNumber: `BILL-RC-${Math.random().toString(36).slice(2, 10)}`,
    },
  });
  return bill.id;
}

describe("reconcileBalances", () => {
  it("reports no drift after a posting", async () => {
    const billId = await makeBill("31.4100", "2026-06-14");
    await posting.postBill(utilityId, ACTOR, "Tester", billId);
    await expect(recon.reconcileBalances(utilityId)).resolves.toEqual([]);
  });

  it("detects a hand-corrupted cache", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("31.4100", "2026-06-14");
    await posting.postBill(utilityId, ACTOR, "Tester", billId);
    await prisma.account.update({ where: { id: accountId }, data: { balance: "999.99" } });

    const drift = await recon.reconcileBalances(utilityId);
    expect(drift).toHaveLength(1);
    expect(drift[0]!.cached).toBe("999.99");
    expect(drift[0]!.ledger).toBe("31.41");
  });

  // Review Focus: a fully settled account
  it("clears lastDueDate and lands on exactly 0.00 when nothing is open", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("40.0000", "2026-06-14");
    await posting.postBill(utilityId, ACTOR, "Tester", billId);

    // Settle it by hand: slice 2 owns recordPayment, so write the credit
    // and its application directly, then recompute the cache.
    const debit = await prisma.ledgerEntry.findFirstOrThrow({ where: { billId } });
    await prisma.$transaction(async (tx) => {
      const credit = await tx.ledgerEntry.create({
        data: {
          utilityId,
          accountId,
          type: "PAYMENT",
          amount: "-40.00",
          openAmount: "0.00",
          effectiveDate: new Date("2026-06-01"),
          tender: "CHECK",
        },
      });
      await tx.ledgerApplication.create({
        data: { utilityId, creditId: credit.id, debitId: debit.id, amount: "40.00" },
      });
      await tx.ledgerEntry.update({
        where: { id: debit.id },
        data: { openAmount: "0.00" },
      });
      await posting.recomputeAccountCache(tx, utilityId, accountId);
    });

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("0.00");
    expect(account.lastDueDate).toBeNull();
    await expect(recon.reconcileBalances(utilityId)).resolves.toEqual([]);
  });

  it("holds the invariants across a long deterministic sequence", async () => {
    const { prisma } = prismaImports;
    // Deterministic LCG rather than a new fast-check dependency.
    let state = 1_234_567;
    const next = () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;

    for (let i = 0; i < 40; i++) {
      const cents = Math.floor(next() * 20_000) - 2_000; // -20.00 .. 180.00
      if (cents === 0) continue;
      const total = (cents / 100).toFixed(4);
      const day = 10 + Math.floor(next() * 18);
      const billId = await makeBill(total, `2026-06-${String(day).padStart(2, "0")}`);
      await posting.postBill(utilityId, ACTOR, "Tester", billId);

      await expect(recon.reconcileBalances(utilityId)).resolves.toEqual([]);
    }

    // Every entry still satisfies the §5 sign invariants.
    const entries = await prisma.ledgerEntry.findMany({ where: { utilityId } });
    expect(entries.length).toBeGreaterThan(20);
    for (const e of entries) {
      const amount = Number(e.amount);
      const open = Number(e.openAmount);
      expect(Math.abs(open)).toBeLessThanOrEqual(Math.abs(amount));
      if (open !== 0) expect(Math.sign(open)).toBe(Math.sign(amount));
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-reconciliation.integration.test.ts
```

Expected: FAIL — cannot resolve `reconciliation.service.js`.

- [ ] **Step 3: Implement the service**

Create `packages/api/src/services/ar/reconciliation.service.ts`:

```ts
import { prisma } from "../../lib/prisma.js";

/**
 * Proof that Account.balance equals the ledger.
 *
 * The cache is written only inside posting transactions, never by a
 * background job, so it should never drift. "Should never" is not
 * evidence — this query is the evidence, and it runs both as an
 * integration test and as an admin endpoint.
 */

export interface BalanceDrift {
  accountId: string;
  accountNumber: string;
  cached: string;
  ledger: string;
}

export async function reconcileBalances(utilityId: string): Promise<BalanceDrift[]> {
  const rows = await prisma.$queryRaw<
    { account_id: string; account_number: string; cached: string; ledger: string }[]
  >`
    SELECT a.id            AS account_id,
           a.account_number,
           a.balance::text AS cached,
           COALESCE(SUM(e.open_amount), 0)::text AS ledger
      FROM account a
      LEFT JOIN ledger_entry e
             ON e.account_id = a.id AND e.utility_id = a.utility_id
     WHERE a.utility_id = ${utilityId}::uuid
     GROUP BY a.id, a.account_number, a.balance
    HAVING a.balance <> COALESCE(SUM(e.open_amount), 0)
     ORDER BY a.account_number`;

  return rows.map((r) => ({
    accountId: r.account_id,
    accountNumber: r.account_number,
    cached: Number(r.cached).toFixed(2),
    ledger: Number(r.ledger).toFixed(2),
  }));
}
```

- [ ] **Step 4: Add the endpoint**

Append inside `arRoutes` in `packages/api/src/routes/ar.ts`:

```ts
  app.get(
    "/api/v1/ar/reconciliation",
    { config: { module: "tenant_profile", permission: "VIEW" } },
    async (request, reply) => {
      const { reconcileBalances } = await import("../services/ar/reconciliation.service.js");
      const drift = await reconcileBalances(request.user.utilityId);
      return reply.send({ ok: drift.length === 0, drift });
    },
  );
```

- [ ] **Step 5: Fix the seed to go through the ledger**

There are **two** seeders and only one sets balances. `seed_db.bat` runs `node seed.js` at the repo root, which sets them at `seed.js:1087-1088`. `packages/shared/prisma/seed.ts` — the one the integration suites run via tsx — never touches `balance`, so the test-seeded database reconciles trivially and needs no change.

Replace `seed.js:1087-1088`:

```js
  await p.account.update({ where: { id: aArr[0].id }, data: { balance: 412.80, lastDueDate: thirtyDaysAgo } });
  await p.account.update({ where: { id: aArr[1].id }, data: { balance: 85.50, lastDueDate: fifteenDaysAgo } });
```

with:

```js
  // Opening balances come from real ledger entries, not typed-in numbers.
  // GET /api/v1/ar/reconciliation compares account.balance against
  // SUM(ledger_entry.open_amount), so a balance with nothing behind it
  // shows as drift on every fresh seed.
  for (const [acct, amount, dueDate] of [
    [aArr[0], "412.80", thirtyDaysAgo],
    [aArr[1], "85.50", fifteenDaysAgo],
  ]) {
    await p.ledgerEntry.create({
      data: {
        utilityId: UID,
        accountId: acct.id,
        type: "ADJUSTMENT_DEBIT",
        amount,
        openAmount: amount,
        dueDate,
        effectiveDate: dueDate,
        memo: "Seeded opening balance for delinquency demo",
      },
    });
    await p.account.update({
      where: { id: acct.id },
      data: { balance: amount, lastDueDate: dueDate },
    });
  }
```

`ADJUSTMENT_DEBIT` carries no `reasonId` here because `LedgerReasonDef` has no seeds until slice 3; the `reason_id IS NOT NULL` constraint for adjustment types is introduced with those seeds, in slice 3.

- [ ] **Step 6: Run the test, then verify a fresh seed reconciles**

```bash
pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ledger-reconciliation.integration.test.ts
```

Expected: PASS, 4 tests.

Then against the dev database:

```bash
pnpm --filter @utility-cis/shared exec prisma migrate deploy
node seed.js
```

Expected: the seed completes, and `GET /api/v1/ar/reconciliation` returns `{"ok":true,"drift":[]}`.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/services/ar/reconciliation.service.ts packages/api/src/routes/ar.ts packages/shared/prisma/seed.ts packages/api/src/__tests__/integration/ledger-reconciliation.integration.test.ts
git commit -m "feat(ar): reconciliation query, property test, seed through the ledger (slice 1 task 6)"
```

---

## Task 7: Documentation

**Files:**
- Modify: `docs/specs/10-payments-and-collections.md`
- Modify: `docs/specs/00-data-model-overview.md`
- Modify: `docs/design/utility-cis-architecture.md`
- Modify: `docs/specs/18-theme-and-configuration.md`

Required by CLAUDE.md: a Prisma model change updates the relevant functional spec and the master design doc.

- [ ] **Step 1: Update module 10**

In `docs/specs/10-payments-and-collections.md`, change the `**Entities:**` line from `Payment (planned, new), PaymentPlan (planned), …` to:

```markdown
**Entities:** PaymentPlan (planned), AdhocCharge (planned), WriteOff (planned). The ledger itself — `LedgerEntry`, `LedgerApplication`, `LedgerReasonDef` — lives in module 23.
```

Then replace the `### The gap this module has to close` section wholesale with:

```markdown
### Status of the gap

Closed on the charge side. `Account.balance` is now written from the ledger inside the posting transaction and reconciled by `GET /api/v1/ar/reconciliation`; delinquency therefore sweeps real receivables rather than seeded values. Still outstanding here: recording payments of any tender, allocation, waivers and write-offs (module 23 slices 2–3), then payment plans and the collections workflow.
```

- [ ] **Step 2: Update the data-model overview**

In `docs/specs/00-data-model-overview.md`, add to the entity reference:

```markdown
| LedgerEntry | One financial event against an account. Signed: positive increases what the customer owes. |
| LedgerApplication | Which credit paid down which debit, and by how much. |
| LedgerReasonDef | Why a fee or adjustment was raised, in the utility's own words. Tenant-configurable. |
```

- [ ] **Step 3: Update the master design doc**

In `docs/design/utility-cis-architecture.md`, replace the `**Not built: AR posting.**` paragraph in the Phase 3 section with:

```markdown
**AR posting (shipped — module 23 slice 1).** An issued `Bill` posts one signed `LedgerEntry`, and `Account.balance` plus `lastDueDate` are recomputed from the ledger in the same transaction. Posting is configurable per tenant (`TenantConfig.autoPostBills`) and overridable per account, defaulting to automatic. `GET /api/v1/ar/reconciliation` proves the cache matches the ledger. Still outstanding: payments and allocation, fees, waivers and write-offs, and the statement view that shows a customer their amount due.
```

- [ ] **Step 4: Record the new config flag**

In `docs/specs/18-theme-and-configuration.md`, add to the `TenantConfig` field table:

```markdown
| auto_post_bills | BOOLEAN | Default true. When false, a generated Bill waits for an explicit post. Overridable per account by the nullable `account.auto_post_bills`, where null inherits this value — so flipping this moves every account that has not opted out. |
```

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs(ar): record the ledger in module 10, data model, architecture and config (slice 1 task 7)"
```

---

## Final verification

- [ ] **Run the whole suite**

```bash
pnpm typecheck
pnpm --filter @utility-cis/shared test
pnpm --filter @utility-cis/api test
pnpm --filter @utility-cis/api exec vitest run --config vitest.integration.config.ts
```

Expected: all green. The integration config runs suites serially in a single fork, so the full run takes several minutes.

- [ ] **Confirm the dev stack still boots**

```bash
start_prod.bat
```

Then `GET /api/v1/ar/reconciliation` returns `{"ok":true,"drift":[]}`.
