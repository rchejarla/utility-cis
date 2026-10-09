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

  // Well-formed changed meaning in slice 3: an ADJUSTMENT_DEBIT is a
  // reasoned type, so without a reason it is now refused. The case above
  // this one pins that refusal; this one pins what valid looks like.
  it("accepts a well-formed debit", async () => {
    const { prisma } = prismaImports;
    const reasonId = await makeShapeReason("ADJUSTMENT_DEBIT");
    const n = await prisma.$executeRawUnsafe(
      `insert into ledger_entry (utility_id, account_id, type, amount, open_amount, effective_date, reason_id)
       values ('${utilityId}'::uuid, '${accountId}'::uuid, 'ADJUSTMENT_DEBIT', 10, 10, current_date, '${reasonId}'::uuid)`,
    );
    expect(n).toBe(1);
  });

  // --- Slice 3: the two CHECKs deferred from slice 1 ---------------------

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

  it("rejects an ADJUSTMENT_DEBIT with no reason", async () => {
    await rejectsWith(
      "ledger_entry_reason_required",
      "type, amount, open_amount, due_date, effective_date",
      `'ADJUSTMENT_DEBIT', 10, 10, current_date, current_date`,
    );
  });

  it("accepts a FEE that cites a reason", async () => {
    const { prisma } = prismaImports;
    const reasonId = await makeShapeReason("FEE");
    const n = await prisma.$executeRawUnsafe(
      `insert into ledger_entry (utility_id, account_id, type, amount, open_amount, due_date, effective_date, reason_id)
       values ('${utilityId}'::uuid, '${accountId}'::uuid, 'FEE', 10, 10, current_date, current_date, '${reasonId}'::uuid)`,
    );
    expect(n).toBe(1);
  });

  // The escape clause, and the only path that uses it: a credit derived
  // from a bill that netted negative names the bill, which explains it.
  // Requiring a reason there would couple posting a negative bill to a
  // tenant having reason seeds.
  it("accepts an ADJUSTMENT_CREDIT that names a bill instead of a reason", async () => {
    const { prisma } = prismaImports;
    const billId = await makeShapeBill();
    const n = await prisma.$executeRawUnsafe(
      `insert into ledger_entry (utility_id, account_id, type, amount, open_amount, effective_date, bill_id)
       values ('${utilityId}'::uuid, '${accountId}'::uuid, 'ADJUSTMENT_CREDIT', -10, -10, current_date, '${billId}'::uuid)`,
    );
    expect(n).toBe(1);
  });

  // PAYMENT and REVERSAL are not reasoned types, so neither needs one.
  it("accepts a PAYMENT with neither reason nor bill", async () => {
    const { prisma } = prismaImports;
    const n = await prisma.$executeRawUnsafe(
      `insert into ledger_entry (utility_id, account_id, type, amount, open_amount, effective_date, tender)
       values ('${utilityId}'::uuid, '${accountId}'::uuid, 'PAYMENT', -10, -10, current_date, 'CASH')`,
    );
    expect(n).toBe(1);
  });

  // Review Focus: a tap fee is assessed on nothing, so the constraint has
  // to be the one-way implication rather than requiring assessed_on_id.
  it("accepts a FEE with a reason and no assessed_on_id", async () => {
    const { prisma } = prismaImports;
    const reasonId = await makeShapeReason("FEE");
    const n = await prisma.$executeRawUnsafe(
      `insert into ledger_entry (utility_id, account_id, type, amount, open_amount, due_date, effective_date, reason_id, assessed_on_id)
       values ('${utilityId}'::uuid, '${accountId}'::uuid, 'FEE', 10, 10, current_date, current_date, '${reasonId}'::uuid, null)`,
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
