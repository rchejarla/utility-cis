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
  // An account with no ledger entries, in the same tenant: balance 0 and
  // SUM = 0 must NOT be reported as drift.
  await prisma.account.create({
    data: { utilityId, accountNumber: "RECON-EMPTY", accountType: "RESIDENTIAL", status: "ACTIVE", billingCycleId },
  });
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

  it("does not report an account with no entries and a zero balance", async () => {
    const drift = await recon.reconcileBalances(utilityId);
    expect(drift.map((d) => d.accountNumber)).not.toContain("RECON-EMPTY");
    expect(drift).toEqual([]);
  });

  it("reports an account with no entries but a non-zero balance", async () => {
    const { prisma } = prismaImports;
    const empty = await prisma.account.findFirstOrThrow({ where: { utilityId, accountNumber: "RECON-EMPTY" } });
    await prisma.account.update({ where: { id: empty.id }, data: { balance: "412.80" } });
    try {
      const drift = await recon.reconcileBalances(utilityId);
      expect(drift).toEqual([
        { accountId: empty.id, accountNumber: "RECON-EMPTY", cached: "412.80", ledger: "0.00" },
      ]);
    } finally {
      await prisma.account.update({ where: { id: empty.id }, data: { balance: 0 } });
    }
  });

  it("scopes by utility: another tenant's drift is not reported", async () => {
    const { prisma } = prismaImports;
    const other = "00000000-0000-4000-8000-0000000000bb";
    const stray = await prisma.account.create({
      data: { utilityId: other, accountNumber: "RECON-OTHER", accountType: "RESIDENTIAL", status: "ACTIVE", billingCycleId, balance: "5.00" },
    });
    try {
      await expect(recon.reconcileBalances(utilityId)).resolves.toEqual([]);
      const drift = await recon.reconcileBalances(other);
      expect(drift.map((d) => d.accountId)).toEqual([stray.id]);
    } finally {
      await prisma.account.delete({ where: { id: stray.id } });
    }
  });

  it("holds the invariants across a long sequence that includes partial settlement", async () => {
    const { prisma } = prismaImports;
    // Deterministic LCG rather than a new fast-check dependency.
    let state = 1_234_567;
    const next = () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;

    // Independent model, in integer cents, that never touches the ledger
    // SQL: if recomputeAccountCache or the reconcile query summed the wrong
    // column (amount instead of open_amount) or dropped a row, the cache
    // would diverge from this model even though both read the same table.
    const model: { due: string; open: number }[] = []; // open debits
    // Credit sitting open, in cents, from bills that netted negative. The
    // model has to carry this since slice 2: §6.1 step 4 absorbs open
    // credits into each new debit, so a debit's openAmount is its amount
    // minus whatever credit was waiting.
    let openCredit = 0;
    let modelBalance = 0;
    let settlements = 0;
    let fullSettlements = 0;
    let absorptions = 0;

    for (let i = 0; i < 40; i++) {
      const cents = Math.floor(next() * 20_000) - 2_000; // -20.00 .. 180.00
      if (cents !== 0) {
        const day = 10 + Math.floor(next() * 18);
        const due = `2026-06-${String(day).padStart(2, "0")}`;
        const billId = await makeBill((cents / 100).toFixed(4), due);
        await posting.postBill(utilityId, ACTOR, "Tester", billId);
        modelBalance += cents;
        if (cents > 0) {
          // The new debit absorbs whatever credit is open, oldest first.
          // Absorption moves value between two open amounts, so it never
          // changes the balance — only which rows are still open.
          const absorbed = Math.min(cents, openCredit);
          if (absorbed > 0) absorptions++;
          openCredit -= absorbed;
          const open = cents - absorbed;
          if (open > 0) model.push({ due, open });
        } else {
          // A bill that nets negative posts a credit, which stays open
          // until a later debit takes it.
          openCredit += -cents;
        }
      }

      // Every third step, settle part of the oldest open debit by hand
      // (slice 2 owns recordPayment), so open_amount != amount for real.
      if (i % 3 === 2 && model.length > 0) {
        model.sort((a, b) => a.due.localeCompare(b.due));
        const target = model[0]!;
        // Occasionally settle in full, so fully-settled debits (open = 0)
        // are exercised by the oldest-due-date query too.
        const pay = next() < 0.25 ? target.open : Math.max(1, Math.floor(target.open * (0.2 + next() * 0.8)));
        const debits = await prisma.ledgerEntry.findMany({
          where: { utilityId, accountId, type: "BILL_CHARGE", openAmount: { gt: 0 }, dueDate: new Date(target.due) },
        });
        const debit = debits.find((d) => Math.round(Number(d.openAmount) * 100) === target.open);
        expect(debit).toBeDefined();
        await prisma.$transaction(async (tx) => {
          const credit = await tx.ledgerEntry.create({
            data: {
              utilityId, accountId, type: "PAYMENT",
              amount: (-pay / 100).toFixed(2), openAmount: "0.00",
              effectiveDate: new Date("2026-06-01"), tender: "CHECK",
            },
          });
          await tx.ledgerApplication.create({
            data: { utilityId, creditId: credit.id, debitId: debit!.id, amount: (pay / 100).toFixed(2) },
          });
          await tx.ledgerEntry.update({
            where: { id: debit!.id },
            data: { openAmount: ((target.open - pay) / 100).toFixed(2) },
          });
          await posting.recomputeAccountCache(tx, utilityId, accountId);
        });
        if (pay === target.open) fullSettlements++;
        target.open -= pay;
        modelBalance -= pay;
        settlements++;
        if (target.open === 0) model.shift();
      }

      // Reconciliation holds throughout...
      await expect(recon.reconcileBalances(utilityId)).resolves.toEqual([]);
      // ...and the cache equals the independent model, not just the ledger.
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(Math.round(Number(account.balance) * 100)).toBe(modelBalance);
      const oldest = [...model].sort((a, b) => a.due.localeCompare(b.due))[0];
      expect(account.lastDueDate?.toISOString().slice(0, 10) ?? null).toBe(oldest?.due ?? null);
    }

    expect(settlements).toBeGreaterThan(5);
    expect(fullSettlements).toBeGreaterThan(0);
    // The sequence must actually exercise §6.1 step 4, or the model's
    // openCredit arithmetic is never put under any pressure.
    expect(absorptions).toBeGreaterThan(0);
    const entries = await prisma.ledgerEntry.findMany({ where: { utilityId } });
    expect(entries.length).toBeGreaterThan(20);
    // The sign invariants must be exercised on genuinely part-settled rows.
    expect(entries.some((e) => e.type === "BILL_CHARGE" && Number(e.openAmount) > 0 && Number(e.openAmount) < Number(e.amount))).toBe(true);
    for (const e of entries) {
      const amount = Number(e.amount);
      const open = Number(e.openAmount);
      expect(Math.abs(open)).toBeLessThanOrEqual(Math.abs(amount));
      if (open !== 0) expect(Math.sign(open)).toBe(Math.sign(amount));
    }
  }, 180_000);
});
