import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, seedAsPlatform } from "./_effective-dating-fixtures.js";

import { runAsTenant } from "../../lib/tenant-context.js";
/**
 * Slice 1 — postBill creates the receivable and moves the cached
 * balance, in one transaction. Covers the Review Focus cases for a
 * zero-total bill and half-cent rounding.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");

const utilityId = "00000000-0000-4000-8000-0000000000aa";
let accountId: string;
let billingCycleId: string;
let debitReasonId: string;

/**
 * The services this file calls directly, as a route reaches them:
 * acting for the tenant, not merely naming it.
 *
 * Each already takes the tenant as its first argument, and in
 * production that value came from a request or a job whose scope was
 * entered before the call — so the argument and the scope are always
 * the same id. A direct service test has the argument and not the
 * scope, and under `cis_app` a tenant table read with no scope raises
 * rather than returning the wrong rows.
 *
 * `runAsTenant` here also overrides the surrounding
 * `seedAsPlatform`, which is what lets fixture rows be arranged
 * across tenants while the call under test stays confined to one.
 */
const postBill = (...args: Parameters<typeof posting.postBill>) =>
  runAsTenant(args[0], async () => posting.postBill(...args));

beforeAll(() =>
  seedAsPlatform(async () => {
  const booted = await bootPostgres({ utilities: [utilityId] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: {
      utilityId,
      name: "Route 1",
      cycleCode: "R01",
      readDayOfMonth: 1, billDayOfMonth: 15,
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

  // Slice 3's ledger_entry_reason_required.
  const reason = await prisma.ledgerReasonDef.create({
    data: {
      utilityId,
      code: "POST-FIXTURE",
      label: "Posting suite fixture",
      appliesToType: "ADJUSTMENT_DEBIT",
    },
  });
  debitReasonId = reason.id;
}), 180_000);

afterAll(async () => {
  // `$disconnect` does not dispose a pool the application owns — that is
  // the driver-adapter contract — so the tenant and platform pools are
  // ended here. Without it the container stops while connections are
  // live and Postgres reports 57P01 after an otherwise green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
  const { prisma } = prismaImports;
  await prisma.ledgerApplication.deleteMany({});
  await prisma.ledgerEntry.deleteMany({});
  await prisma.bill.deleteMany({});
  await prisma.account.update({
    where: { id: accountId },
    data: { balance: 0, lastDueDate: null },
  });
}),
);

async function makeBill(total: string, dueDate = "2026-06-14"): Promise<string> {
  /*
   * Arranging rows, so the authority the fixtures use. Calls under test
   * re-enter their own tenant scope, so they still run as `cis_app`.
   */
  return seedAsPlatform(async () => {
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

  });
}

describe("postBill", () => {
  it("creates a BILL_CHARGE and moves the cached balance", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const billId = await makeBill("69.6500");

      const result = await postBill(utilityId, ACTOR, "Tester", billId);

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
  
    }));

  it("writes an audit row in the same transaction", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const billId = await makeBill("10.0000");
      const result = await postBill(utilityId, ACTOR, "Tester", billId);
      const audits = await prisma.auditLog.findMany({
        where: { entityType: "LedgerEntry", entityId: result.entryId! },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.action).toBe("CREATE");
  
    }));

  // Review Focus: half-cent boundary
  it("rounds a half-cent total half-up", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const billId = await makeBill("47.3250");
      await postBill(utilityId, ACTOR, "Tester", billId);
      const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { billId } });
      expect(entry.amount.toFixed(2)).toBe("47.33");
  
    }));

  // Review Focus: zero-total bill
  it("marks a zero-total bill posted without writing an entry", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const billId = await makeBill("0.0000");

      const result = await postBill(utilityId, ACTOR, "Tester", billId);

      expect(result.skippedZero).toBe(true);
      expect(result.entryId).toBeNull();
      expect(await prisma.ledgerEntry.count({ where: { billId } })).toBe(0);

      const bill = await prisma.bill.findUniqueOrThrow({ where: { id: billId } });
      expect(bill.postedAt).not.toBeNull();

      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toFixed(2)).toBe("0.00");
  
    }));

  it("posts a negative-total bill as ADJUSTMENT_CREDIT", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const billId = await makeBill("-12.5000");
      await postBill(utilityId, ACTOR, "Tester", billId);
      // The credit still names its bill — no constraint objects, and the
      // link is what a rebill would need to find this entry.
      const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { billId } });
      expect(entry.type).toBe("ADJUSTMENT_CREDIT");
      expect(entry.billId).toBe(billId);
      // ...but it has no due date: only a debit ages.
      expect(entry.dueDate).toBeNull();
      expect(entry.amount.toFixed(2)).toBe("-12.50");
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toFixed(2)).toBe("-12.50");
  
    }));

  it("refuses an unknown bill", async () => {
    await expect(
      postBill(utilityId, ACTOR, "Tester", "00000000-0000-4000-8000-00000000dead"),
    ).rejects.toMatchObject({ code: "BILL_NOT_FOUND" });
  });

  it("rejects posting the same bill twice", async () => {
    const billId = await makeBill("10.0000");
    await postBill(utilityId, ACTOR, "Tester", billId);
    await expect(postBill(utilityId, ACTOR, "Tester", billId)).rejects.toMatchObject({
      code: "BILL_ALREADY_POSTED",
    });
  });

  it("nets a debit and a credit through the signed sum", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      await postBill(utilityId, ACTOR, "Tester", await makeBill("50.0000"));
      await postBill(utilityId, ACTOR, "Tester", await makeBill("-12.5000"));
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toFixed(2)).toBe("37.50");

      // Both rows stay open and nothing is allocated. §6.1 step 4 absorbs
      // open credits into a NEW DEBIT; the second bill here posts a
      // credit, so there is nothing for it to absorb, and the existing
      // debit is not its business. The balance is right regardless because
      // it is a signed sum — only the open-item detail is unsettled, and
      // the next debit to post will absorb this credit.
      const apps = await prisma.ledgerApplication.findMany({ where: { utilityId } });
      expect(apps).toEqual([]);
  
    }));

  it("absorbs an open credit when a bill posts", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      // An open credit sitting on the account — an overpayment from before.
      const credit = await prisma.ledgerEntry.create({
        data: {
          utilityId,
          accountId,
          type: "PAYMENT",
          amount: "-20.00",
          openAmount: "-20.00",
          effectiveDate: new Date("2026-05-01"),
          tender: "CHECK",
          createdBy: ACTOR,
        },
      });

      const billId = await makeBill("50.0000");
      const result = await postBill(utilityId, ACTOR, "Tester", billId);

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
  
    }));

  it("does not absorb a credit that belongs to another account", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const otherAccount = await prisma.account.create({
        data: {
          utilityId,
          accountNumber: `LEDGER-OTHER-${Math.random().toString(36).slice(2, 7)}`,
          accountType: "RESIDENTIAL",
          status: "ACTIVE",
          billingCycleId,
        },
      });
      const strayCredit = await prisma.ledgerEntry.create({
        data: {
          utilityId,
          accountId: otherAccount.id,
          type: "PAYMENT",
          amount: "-20.00",
          openAmount: "-20.00",
          effectiveDate: new Date("2026-05-01"),
          tender: "CHECK",
          createdBy: ACTOR,
        },
      });

      try {
        const billId = await makeBill("50.0000");
        await postBill(utilityId, ACTOR, "Tester", billId);

        const after = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: strayCredit.id } });
        expect(after.openAmount.toFixed(2)).toBe("-20.00");
        const charge = await prisma.ledgerEntry.findFirstOrThrow({ where: { billId } });
        expect(charge.openAmount.toFixed(2)).toBe("50.00");
      } finally {
        await prisma.ledgerEntry.delete({ where: { id: strayCredit.id } });
        await prisma.account.delete({ where: { id: otherAccount.id } });
      }
  
    }));

  it("waits on the account row lock, then updates balance and lastDueDate", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      await postBill(utilityId, ACTOR, "Tester", await makeBill("30.0000", "2026-06-14"));
      const billB = await makeBill("20.0000", "2026-05-01");

      // Hold the account row lock in a transaction we control. FOR NO KEY
      // UPDATE, not FOR UPDATE: it still conflicts with postBill's FOR UPDATE
      // and with its final account UPDATE, but not with the FOR KEY SHARE an
      // entry insert takes through the foreign key. Plain FOR UPDATE would
      // block an unlocked poster at the insert, before its SUM, and hide the race.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const lockTaken = new Promise<void>((r) => (locked = r));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM account
                              WHERE id = ${accountId}::uuid AND utility_id = ${utilityId}::uuid
                                FOR NO KEY UPDATE`;
          // Write an entry that is uncommitted while we hold the lock. A poster
          // that does not wait for the lock sums without it and then
          // overwrites the cache with a stale total and due date.
          await tx.ledgerEntry.create({
            data: {
              utilityId,
              accountId,
              type: "ADJUSTMENT_DEBIT",
              amount: "5.00",
              openAmount: "5.00",
              dueDate: new Date("2026-04-01"),
              effectiveDate: new Date("2026-04-01"),
              reasonId: debitReasonId,
              createdBy: ACTOR,
            },
          });
          locked();
          await gate;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
      await lockTaken;

      let resolved = false;
      const posting2 = postBill(utilityId, ACTOR, "Tester", billB).then((r) => {
        resolved = true;
        return r;
      });

      // This wait is NOT what discriminates. With no account lock anywhere
      // on the path the poster would still block here: its final
      // `account.update` conflicts with the holder's FOR NO KEY UPDATE, so
      // `resolved` is false either way.
      //
      // What discriminates is the three assertions after `release()`.
      // Unlocked, the poster sums before the holder's uncommitted 5.00
      // entry is visible, so it writes 50.00 — the 30.00 already committed
      // plus its own 20.00, with the holder's 5.00 missing — and a stale
      // due date over the top. Either account lock on the path prevents
      // that; measured, removing one still passes and removing both fails
      // here with '50.00' where '55.00' is expected. Do not delete these
      // assertions — they are the test.
      await new Promise((r) => setTimeout(r, 1500));
      expect(resolved).toBe(false);

      release();
      await holder;
      const result = await posting2;
      expect(result.balance).toBe("55.00");

      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toFixed(2)).toBe("55.00");
      expect(account.lastDueDate?.toISOString().slice(0, 10)).toBe("2026-04-01");
  
    }));

  it("clears lastDueDate when no open debit remains", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const billId = await makeBill("10.0000");
      await postBill(utilityId, ACTOR, "Tester", billId);
      await prisma.$executeRaw`UPDATE ledger_entry SET open_amount = 0 WHERE bill_id = ${billId}::uuid`;
      const cache = await prisma.$transaction((tx) =>
        posting.recomputeAccountCache(tx, utilityId, accountId),
      );
      expect(cache.lastDueDate).toBeNull();
      expect(cache.balance).toBe("0.00");
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.lastDueDate).toBeNull();
  
    }));

  it("leaves nothing behind when the caller's transaction rolls back", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const billId = await makeBill("10.0000");
      await expect(
        prisma.$transaction(async (tx) => {
          await postBill(utilityId, ACTOR, "Tester", billId, {}, tx);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await prisma.ledgerEntry.count({ where: { accountId } })).toBe(0);
      const bill = await prisma.bill.findUniqueOrThrow({ where: { id: billId } });
      expect(bill.postedAt).toBeNull();
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toFixed(2)).toBe("0.00");
  
    }));
});

/**
 * Where the account stood when the bill was issued, frozen at posting.
 *
 * The bill prints arrears since the fees group shipped, and its total
 * became a quantity answering no question — rated charges plus whichever
 * non-bill entries fell inside a date window, omitting the balance
 * carried forward entirely. These three figures are what make the total
 * current charges **plus past due**, which is the standard rule.
 *
 * They are frozen rather than recomputed because `past_due_amount` reads
 * allocation state: a debit fully paid is not past due, and
 * `reverseEntry` deletes the `ledger_application` rows it undoes, so a
 * reconstruction after a reversal cannot see the allocation at all.
 * Posting is where that state is still current.
 *
 * Its own account, because the suite above shares one and these
 * assertions are absolute rather than relative.
 */
describe("the statement snapshot", () => {
  let acct: string;

  /** A bill on `acct` with its own date, posted by the caller. */
  async function billOn(billDate: string, total: string, dueDate: string): Promise<string> {
    return seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const bill = await prisma.bill.create({
        data: {
          utilityId,
          accountId: acct,
          billingCycleId,
          periodStart: new Date(billDate),
          periodEnd: new Date(billDate),
          billDate: new Date(billDate),
          dueDate: new Date(dueDate),
          subtotal: total,
          taxes: "0",
          credits: "0",
          total,
          billNumber: `BILL-SNAP-${Math.random().toString(36).slice(2, 8)}`,
        },
      });
      return bill.id;
    });
  }

  async function snapshotOf(billId: string) {
    return seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const b = await prisma.bill.findUniqueOrThrow({
        where: { id: billId },
        select: { previousBalance: true, paymentsSince: true, pastDueAmount: true },
      });
      return {
        previousBalance: b.previousBalance?.toFixed(2) ?? null,
        paymentsSince: b.paymentsSince?.toFixed(2) ?? null,
        pastDueAmount: b.pastDueAmount?.toFixed(2) ?? null,
      };
    });
  }

  beforeEach(async () => {
    acct = await seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const a = await prisma.account.create({
        data: {
          utilityId,
          accountNumber: `SNAP-${Math.random().toString(36).slice(2, 8)}`,
          accountType: "RESIDENTIAL",
          status: "ACTIVE",
          billingCycleId,
        },
      });
      return a.id;
    });
  });

  it("carries nothing forward on a first bill", async () => {
    const first = await billOn("2026-05-15", "100.00", "2026-06-14");
    await postBill(utilityId, ACTOR, "T", first);

    // No previous bill means nothing was carried, and the bill's own
    // charge is not past due on the day it is issued.
    expect(await snapshotOf(first)).toEqual({
      previousBalance: "0.00",
      paymentsSince: "0.00",
      pastDueAmount: "0.00",
    });
  });

  it("carries the previous bill's unpaid balance, and counts it past due", async () => {
    const first = await billOn("2026-05-15", "100.00", "2026-06-14");
    await postBill(utilityId, ACTOR, "T", first);

    // Second bill issued after the first fell due and went unpaid.
    const second = await billOn("2026-06-15", "40.00", "2026-07-14");
    await postBill(utilityId, ACTOR, "T", second);

    expect(await snapshotOf(second)).toEqual({
      previousBalance: "100.00",
      paymentsSince: "0.00",
      // Due 2026-06-14, which is before this bill's date. The $40 it
      // charges is not: a bill is never past due on its own issue date.
      pastDueAmount: "100.00",
    });
  });

  it("reports a payment between the bills, and drops what it settled from past due", async () => {
    const first = await billOn("2026-05-15", "100.00", "2026-06-14");
    await postBill(utilityId, ACTOR, "T", first);

    await runAsTenant(utilityId, async () => {
      const payment = await import("../../services/ar/payment.service.js");
      await payment.recordPayment(utilityId, ACTOR, "T", acct, {
        amount: "60.00",
        tender: "CHECK",
        receivedAt: "2026-06-20",
      });
    });

    const second = await billOn("2026-06-30", "40.00", "2026-07-29");
    await postBill(utilityId, ACTOR, "T", second);

    expect(await snapshotOf(second)).toEqual({
      previousBalance: "100.00",
      paymentsSince: "60.00",
      // $100 charged, $60 allocated to it — the remaining $40 is what is
      // still past due, which is the figure a plain sum cannot give.
      pastDueAmount: "40.00",
    });
  });

  /**
   * Past due is as at the **bill date**, not as at posting.
   *
   * It read the current `open_amount`, while previous balance and
   * payments were both filtered to the bill date — so a payment arriving
   * between the two instants reduced past due on a bill that reported
   * receiving no payments. On the dev database: `BILL-202610-2` dated
   * 2026-10-10, posted on the 27th, with payments on the 20th and 24th,
   * came out as $468.17 against a true $523.55 — understated by exactly
   * the payment it did not mention.
   *
   * The allocations are filtered by the paying credit's effective date,
   * which is the same rule the settlement block follows. That it is
   * computable here and not later is still the argument for freezing it:
   * `reverseEntry` deletes the rows this reads.
   */
  it("measures past due at the bill date, not at the moment of posting", async () => {
    const first = await billOn("2026-05-15", "100.00", "2026-06-14");
    await postBill(utilityId, ACTOR, "T", first);

    // Dated after the second bill's date but recorded before it posts —
    // a bill run late, which is the ordinary case for a monthly cycle
    // reviewed before posting.
    await runAsTenant(utilityId, async () => {
      const payment = await import("../../services/ar/payment.service.js");
      await payment.recordPayment(utilityId, ACTOR, "T", acct, {
        amount: "70.00",
        tender: "CHECK",
        receivedAt: "2026-06-25",
      });
    });

    const second = await billOn("2026-06-20", "40.00", "2026-07-19");
    await postBill(utilityId, ACTOR, "T", second);

    expect(await snapshotOf(second)).toEqual({
      previousBalance: "100.00",
      // The payment is dated after this bill, so it belongs to the next.
      paymentsSince: "0.00",
      // And it must not have quietly reduced this figure either: on
      // 2026-06-20 the whole $100 was outstanding and overdue.
      pastDueAmount: "100.00",
    });
  });

  it("drops a fully settled charge out of past due", async () => {
    const first = await billOn("2026-05-15", "100.00", "2026-06-14");
    await postBill(utilityId, ACTOR, "T", first);

    await runAsTenant(utilityId, async () => {
      const payment = await import("../../services/ar/payment.service.js");
      await payment.recordPayment(utilityId, ACTOR, "T", acct, {
        amount: "150.00",
        tender: "CHECK",
        receivedAt: "2026-06-01",
      });
    });

    const second = await billOn("2026-06-15", "40.00", "2026-07-14");
    await postBill(utilityId, ACTOR, "T", second);

    const snap = await snapshotOf(second);
    // The $100 was charged before the previous bill's date, so it is
    // carried; the $150 arrived after it and is reported as paid.
    expect(snap.previousBalance).toBe("100.00");
    expect(snap.paymentsSince).toBe("150.00");
    // Nothing overdue survives it, which only allocation state can say.
    expect(snap.pastDueAmount).toBe("0.00");
  });

  /**
   * An account in credit at the last bill carries that credit forward.
   *
   * `previous_balance` is the one figure of the three that may be
   * negative, and the migration's CHECKs constrain only the other two.
   * Clamping it at zero would tell a customer who paid ahead that they
   * owe money they do not.
   */
  it("carries a credit balance forward as a negative rather than clamping it", async () => {
    await runAsTenant(utilityId, async () => {
      const payment = await import("../../services/ar/payment.service.js");
      await payment.recordPayment(utilityId, ACTOR, "T", acct, {
        amount: "150.00",
        tender: "CHECK",
        // Before the first bill, so it is inside that bill's balance
        // rather than reported as a payment after it.
        receivedAt: "2026-05-01",
      });
    });

    const first = await billOn("2026-05-15", "100.00", "2026-06-14");
    await postBill(utilityId, ACTOR, "T", first);

    const second = await billOn("2026-06-15", "40.00", "2026-07-14");
    await postBill(utilityId, ACTOR, "T", second);

    const snap = await snapshotOf(second);
    // $150 in, $100 billed, as of 2026-05-15: $50 in credit.
    expect(snap.previousBalance).toBe("-50.00");
    expect(snap.paymentsSince).toBe("0.00");
    expect(snap.pastDueAmount).toBe("0.00");
  });
});
