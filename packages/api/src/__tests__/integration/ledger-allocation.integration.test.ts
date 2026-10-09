import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 2 — applying an open credit to open debits in the §6.3 order:
 * type class first (FEE, then ADJUSTMENT_DEBIT, then BILL_CHARGE), then
 * oldest dueDate, then postedAt.
 *
 * The fixtures write entries directly rather than through postBill,
 * because the ordering cases need debits of specific types and dates and
 * BILL_CHARGE requires a real Bill by CHECK. postBill's own path is
 * covered where it belongs, in the posting and payment suites.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let allocation: typeof import("../../services/ar/allocation.service.js");

let accountId: string;
// Every reasoned type must cite a reason since slice 3's
// ledger_entry_reason_required. One per type the fixtures write.
const reasonIdFor: Record<string, string> = {};

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
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

  for (const appliesToType of ["FEE", "ADJUSTMENT_DEBIT"] as const) {
    const r = await prisma.ledgerReasonDef.create({
      data: { utilityId, code: `ALLOC-${appliesToType}`, label: appliesToType, appliesToType },
    });
    reasonIdFor[appliesToType] = r.id;
  }
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
  type: "FEE" | "ADJUSTMENT_DEBIT",
  amount: string,
  dueDate: string,
): Promise<string> {
  const { prisma } = prismaImports;
  const e = await prisma.ledgerEntry.create({
    data: {
      utilityId,
      accountId,
      type,
      amount,
      openAmount: amount,
      dueDate: new Date(dueDate),
      effectiveDate: new Date(dueDate),
      reasonId: reasonIdFor[type]!,
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

  // indexOf returns -1 for a type not in the list, which would sort it
  // ahead of a fee. It must sort last instead.
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

  // Class, dueDate and postedAt can all tie — two debits of one class
  // raised on one date in the same instant — and the pair must still
  // allocate the same way every run.
  //
  // Honest about what this test is: it pins the observed outcome, and it
  // cannot on its own prove determinism. Removing the comparator's id
  // tie-break leaves it passing, because `Array.prototype.sort` is stable
  // and the rows happened to arrive in agreeing order. The actual
  // guarantee is the ORDER BY on the fetch in allocation.service.ts; this
  // case would start failing intermittently if that were dropped, which
  // is the best a test can do against a free-running query planner.
  it("resolves a total tie by entry id", async () => {
    const { prisma } = prismaImports;
    const a = await debit("ADJUSTMENT_DEBIT", "30.00", "2026-06-14");
    const b = await debit("ADJUSTMENT_DEBIT", "30.00", "2026-06-14");
    // Force postedAt equal as well, so id is the only thing left.
    await prisma.$executeRaw`UPDATE ledger_entry SET posted_at = timestamptz '2026-06-02 12:00:00+00'
                              WHERE id IN (${a}::uuid, ${b}::uuid)`;
    const c = await credit("30.00");

    await prisma.$transaction((tx) =>
      allocation.applyCreditToDebits(tx, utilityId, accountId, c),
    );

    const [lower, higher] = [a, b].sort((x, y) => x.localeCompare(y));
    expect(await openOf(lower!)).toBe("0.00");
    expect(await openOf(higher!)).toBe("30.00");
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

  it("is a no-op on a credit that is already fully applied", async () => {
    const { prisma } = prismaImports;
    await debit("ADJUSTMENT_DEBIT", "40.00", "2026-06-14");
    const c = await credit("10.00");
    await prisma.ledgerEntry.update({ where: { id: c }, data: { openAmount: "0.00" } });

    const made = await prisma.$transaction((tx) =>
      allocation.applyCreditToDebits(tx, utilityId, accountId, c),
    );
    expect(made).toEqual([]);
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
      data: {
        utilityId: other,
        name: "R1",
        cycleCode: "R01",
        billDayOfMonth: 15,
        frequency: "MONTHLY",
      },
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
    const strayReason = await prisma.ledgerReasonDef.create({
      data: {
        utilityId: other,
        code: "ALLOC-STRAY",
        label: "Stray",
        appliesToType: "ADJUSTMENT_DEBIT",
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
        reasonId: strayReason.id,
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
      await prisma.ledgerReasonDef.delete({ where: { id: strayReason.id } });
      await prisma.account.delete({ where: { id: otherAccount.id } });
      await prisma.billingCycle.delete({ where: { id: otherCycle.id } });
    }
  });

  it("refuses an account in another tenant", async () => {
    const { prisma } = prismaImports;
    const c = await credit("10.00");
    await expect(
      prisma.$transaction((tx) =>
        allocation.applyCreditToDebits(
          tx,
          "00000000-0000-4000-8000-0000000000bb",
          accountId,
          c,
        ),
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
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

  it("is a no-op on a debit that is already settled", async () => {
    const { prisma } = prismaImports;
    await credit("10.00");
    const d = await debit("ADJUSTMENT_DEBIT", "15.00", "2026-06-14");
    await prisma.ledgerEntry.update({ where: { id: d }, data: { openAmount: "0.00" } });

    const made = await prisma.$transaction((tx) =>
      allocation.applyCreditsToDebit(tx, utilityId, accountId, d),
    );
    expect(made).toEqual([]);
  });
});
