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
