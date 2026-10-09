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
let payment: typeof import("../../services/ar/payment.service.js");
let reversal: typeof import("../../services/ar/reversal.service.js");

let accountId: string;
let billingCycleId: string;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  recon = await import("../../services/ar/reconciliation.service.js");
  payment = await import("../../services/ar/payment.service.js");
  reversal = await import("../../services/ar/reversal.service.js");

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

  it("holds the invariants across a long sequence of charges, payments and reversals", async () => {
    const { prisma } = prismaImports;
    // Deterministic LCG rather than a new fast-check dependency.
    let state = 1_234_567;
    const next = () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;

    // Independent model, in integer cents, that never touches the ledger
    // SQL: if recomputeAccountCache or the reconcile query summed the
    // wrong column, or allocation consumed the wrong row, the cache would
    // diverge from this model even though both read the same table.
    //
    // Applications are modelled explicitly rather than inferred, because
    // reversal gives back exactly what one payment consumed — and a
    // payment's leftover can be absorbed later by a new debit under §6.1
    // step 4, so "what it consumed" is not knowable from the payment
    // alone.
    interface DebitRef {
      due: string;
      seq: number;
      open: number;
    }
    interface Slot {
      open: number;
    }
    interface App {
      debit: DebitRef;
      credit: Slot;
      amt: number;
    }

    const debits: DebitRef[] = [];
    const credits: Slot[] = []; // open credit, in postedAt order
    let apps: App[] = [];
    const payments: { id: string; cents: number; slot: Slot }[] = [];
    let modelBalance = 0;
    let seq = 0;
    let settlements = 0;
    let fullSettlements = 0;
    let absorptions = 0;
    let reversals = 0;

    const oldestOpenDue = (): string | null => {
      const open = debits.filter((d) => d.open > 0);
      if (open.length === 0) return null;
      return open.sort((a, b) => a.due.localeCompare(b.due) || a.seq - b.seq)[0]!.due;
    };

    for (let i = 0; i < 40; i++) {
      const cents = Math.floor(next() * 20_000) - 2_000; // -20.00 .. 180.00
      if (cents !== 0) {
        const day = 10 + Math.floor(next() * 18);
        const due = "2026-06-" + String(day).padStart(2, "0");
        const billId = await makeBill((cents / 100).toFixed(4), due);
        await posting.postBill(utilityId, ACTOR, "Tester", billId);
        modelBalance += cents;
        seq++;

        if (cents > 0) {
          // Step 4: the new debit absorbs open credits, oldest postedAt
          // first. Absorption moves value between two open amounts, so it
          // never changes the balance.
          const d: DebitRef = { due, seq, open: cents };
          for (const c of credits) {
            if (d.open === 0) break;
            if (c.open === 0) continue;
            const amt = Math.min(d.open, c.open);
            c.open -= amt;
            d.open -= amt;
            apps.push({ debit: d, credit: c, amt });
            absorptions++;
          }
          debits.push(d);
        } else {
          // A bill that nets negative posts a credit, open until a debit
          // takes it.
          credits.push({ open: -cents });
        }
      }

      // Every third step, pay part of what is owed — through the real
      // recordPayment, so the allocation walk itself is under test.
      if (i % 3 === 2) {
        const owed = debits.reduce((t, d) => t + d.open, 0);
        if (owed > 0) {
          const full = next() < 0.25;
          const pay = full ? owed : Math.max(1, Math.floor(owed * (0.2 + next() * 0.7)));
          const res = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
            amount: (pay / 100).toFixed(2),
            tender: "CHECK",
          });

          // Mirror allocation: every debit here is a BILL_CHARGE, one
          // class, so the order is oldest dueDate then postedAt.
          const slot: Slot = { open: 0 };
          let remaining = pay;
          const ordered = debits
            .filter((d) => d.open > 0)
            .sort((a, b) => a.due.localeCompare(b.due) || a.seq - b.seq);
          for (const d of ordered) {
            if (remaining === 0) break;
            const amt = Math.min(remaining, d.open);
            d.open -= amt;
            remaining -= amt;
            apps.push({ debit: d, credit: slot, amt });
          }
          slot.open = remaining; // leftover is a credit balance
          credits.push(slot);
          payments.push({ id: res.paymentId, cents: pay, slot });
          modelBalance -= pay;
          settlements++;
          if (full) fullSettlements++;
        }
      }

      // Every seventh step, reverse the most recent payment — NSF.
      if (i % 7 === 6 && payments.length > 0) {
        const target = payments.pop()!;
        await reversal.reverseEntry(utilityId, ACTOR, "T", target.id, {});
        // Give back exactly what that payment consumed, wherever it went,
        // then close its own slot. The REVERSAL settles against the
        // payment, so neither contributes to the balance afterwards.
        for (const a of apps) if (a.credit === target.slot) a.debit.open += a.amt;
        apps = apps.filter((a) => a.credit !== target.slot);
        target.slot.open = 0;
        modelBalance += target.cents;
        reversals++;
      }

      // Reconciliation holds throughout...
      await expect(recon.reconcileBalances(utilityId)).resolves.toEqual([]);
      // ...and the cache equals the independent model, not just the ledger.
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(Math.round(Number(account.balance) * 100)).toBe(modelBalance);
      expect(account.lastDueDate?.toISOString().slice(0, 10) ?? null).toBe(oldestOpenDue());
    }

    expect(settlements).toBeGreaterThan(5);
    expect(fullSettlements).toBeGreaterThan(0);
    // Each of these must actually happen, or the model arithmetic that
    // covers it is never put under any pressure.
    expect(absorptions).toBeGreaterThan(0);
    expect(reversals).toBeGreaterThan(0);

    const entries = await prisma.ledgerEntry.findMany({ where: { utilityId } });
    expect(entries.length).toBeGreaterThan(20);
    expect(entries.some((e) => e.type === "REVERSAL")).toBe(true);
    // The sign invariants must be exercised on genuinely part-settled rows.
    expect(
      entries.some(
        (e) =>
          e.type === "BILL_CHARGE" &&
          Number(e.openAmount) > 0 &&
          Number(e.openAmount) < Number(e.amount),
      ),
    ).toBe(true);

    for (const e of entries) {
      const amount = Number(e.amount);
      const open = Number(e.openAmount);
      expect(Math.abs(open)).toBeLessThanOrEqual(Math.abs(amount));
      if (open !== 0) expect(Math.sign(open)).toBe(Math.sign(amount));
    }

    // §5 stated directly, per entry, against the applications that exist.
    // The balance can be right while two entries are individually wrong
    // in opposite directions; the sum hides that and this does not.
    const liveApps = await prisma.ledgerApplication.findMany({ where: { utilityId } });
    for (const a of liveApps) expect(Number(a.amount)).toBeGreaterThan(0);
    for (const e of entries) {
      const asDebit = liveApps
        .filter((a) => a.debitId === e.id)
        .reduce((t, a) => t + Number(a.amount), 0);
      const asCredit = liveApps
        .filter((a) => a.creditId === e.id)
        .reduce((t, a) => t + Number(a.amount), 0);
      expect(Number(e.openAmount)).toBeCloseTo(Number(e.amount) - asDebit + asCredit, 2);
    }
  }, 180_000);
});
