import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  seedAsPlatform,
  endAdminPool,
  truncateTables,
  ACTOR,
  TENANT_A,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

/*
 * `evaluateAll` sends notices, which enqueue. Mocked so a run leaves
 * nothing behind in the dev Redis that looks like real stuck work.
 */
vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

/**
 * A tier that replaces what the ladder charged below it.
 *
 * Task 5 of `docs/superpowers/plans/2026-10-25-collections-wiring.md`.
 *
 * $10 at 15 days and then $25 at 30 days should leave $25 owing, not
 * $35 — the second charge is the penalty for being a month late, not an
 * addition to the penalty for being a fortnight late.
 *
 * What it must not get wrong is *which* fees it reverses. It walks
 * `DelinquencyAction.feeEntryId`, so the candidates are the fees this
 * ladder itself raised at lower tiers. A bounced-payment fee and a late
 * fee a CSR added by hand have no delinquency action, so neither is
 * reachable — whatever the tenant has named its reasons. The question is
 * ownership, not category, which is why it cannot be a filter on the
 * reason code.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/delinquency.service.js");
let fee: typeof import("../../services/ar/fee.service.js");
let payment: typeof import("../../services/ar/payment.service.js");
let fix: TenantFixture;

const evaluateAll = (...args: Parameters<typeof svc.evaluateAll>) =>
  runAsTenant(args[0], async () => svc.evaluateAll(...args));

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

async function reasonId(code: string): Promise<string> {
  return seedAsPlatform(async () => {
    const r = await prismaImports.prisma.ledgerReasonDef.findFirstOrThrow({
      where: { utilityId: TENANT_A, code },
      select: { id: true },
    });
    return r.id;
  });
}

interface Rung {
  tier: number;
  days: number;
  fee: string;
  feeType?: "FLAT_FEE" | "PERCENT_OF_BALANCE";
  mode?: "ACCUMULATE" | "REPLACE_LOWER_TIERS";
  reasonCode?: string;
}

/**
 * A real past-due debit on the account.
 *
 * Every case that sweeps twice needs one. Without it
 * `recomputeAccountCache` sets `lastDueDate` from the only open entry
 * there is — the fee just raised, due in 30 days — and the second
 * sweep stops at `daysPastDue <= 0` without evaluating the account at
 * all. Two cases in this file passed on that accident.
 */
async function principal(amount: string, dueDaysAgo = 40) {
  const reason = await reasonId("OPENING_BALANCE");
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.create({
      data: {
        utilityId: TENANT_A,
        accountId: fix.accountId,
        type: "ADJUSTMENT_DEBIT",
        amount,
        openAmount: amount,
        effectiveDate: daysAgo(dueDaysAgo + 10),
        dueDate: daysAgo(dueDaysAgo),
        reasonId: reason,
      },
    }),
  );
}

async function stillPastDue(): Promise<boolean> {
  const account = await seedAsPlatform(async () =>
    prismaImports.prisma.account.findUniqueOrThrow({
      where: { id: fix.accountId },
      select: { lastDueDate: true, balance: true },
    }),
  );
  if (!account.lastDueDate || account.balance.lte(0)) return false;
  return account.lastDueDate.getTime() < Date.now();
}

/** The tenant's ladder, one row per rung. */
async function ladder(rungs: Rung[]) {
  for (const r of rungs) {
    const reason = await reasonId(r.reasonCode ?? "LATE_FEE");
    await seedAsPlatform(async () =>
      prismaImports.prisma.delinquencyRule.create({
        data: {
          utilityId: TENANT_A,
          name: `Tier ${r.tier}`,
          tier: r.tier,
          daysPastDue: r.days,
          minBalance: "1.00",
          actionType: "NOTICE_EMAIL",
          autoApply: true,
          isActive: true,
          effectiveDate: daysAgo(365),
          feeType: r.feeType ?? "FLAT_FEE",
          feeAmount: r.fee,
          feeReasonId: reason,
          feeMode: r.mode ?? "ACCUMULATE",
        },
      }),
    );
  }
}

async function pastDue(opts: { balance: string; days: number }) {
  return seedAsPlatform(async () =>
    prismaImports.prisma.account.update({
      where: { id: fix.accountId },
      data: { balance: opts.balance, lastDueDate: daysAgo(opts.days) },
    }),
  );
}

/** A fee an operator raised, not the ladder — so it has no action. */
async function feeByHand(opts: { amount: string; reasonCode: string }) {
  const reason = await reasonId(opts.reasonCode);
  return runAsTenant(TENANT_A, async () =>
    fee.assessFee(TENANT_A, ACTOR, "Tester", fix.accountId, {
      amount: opts.amount,
      reasonId: reason,
    }),
  );
}

/** What is still owed on fees: reversed ones sit at zero. */
async function openFeeTotal(): Promise<string> {
  return seedAsPlatform(async () => {
    const agg = await prismaImports.prisma.ledgerEntry.aggregate({
      where: { utilityId: TENANT_A, type: "FEE" },
      _sum: { openAmount: true },
    });
    return (agg._sum.openAmount ?? 0).toString();
  });
}

async function countOf(type: "FEE" | "REVERSAL"): Promise<number> {
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.count({ where: { utilityId: TENANT_A, type } }),
  );
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/delinquency.service.js");
  fee = await import("../../services/ar/fee.service.js");
  payment = await import("../../services/ar/payment.service.js");
}, 240_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetDb();
  await truncateTables(
    "delinquency_action, delinquency_rule, ledger_application, ledger_entry, ledger_reason_def",
  );
  fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);
  await seedAsPlatform(async () => {
    const { seedDefaultReasons } = await import("../../services/ar/reason.service.js");
    await seedDefaultReasons(TENANT_A, ACTOR, "Tester");
  });
});

describe("REPLACE_LOWER_TIERS", () => {
  it("reverses the lower tier's fee and raises its own", async () => {
    await ladder([
      { tier: 1, days: 15, fee: "10.00" },
      { tier: 2, days: 30, fee: "25.00", mode: "REPLACE_LOWER_TIERS" },
    ]);
    await pastDue({ balance: "100.00", days: 35 });

    await evaluateAll(TENANT_A);

    expect(await openFeeTotal()).toBe("25");
    expect(await countOf("FEE")).toBe(2);
    expect(await countOf("REVERSAL")).toBe(1);
  });

  it("accumulates when the tier does not ask to replace", async () => {
    await ladder([
      { tier: 1, days: 15, fee: "10.00" },
      { tier: 2, days: 30, fee: "25.00" },
    ]);
    await pastDue({ balance: "100.00", days: 35 });

    await evaluateAll(TENANT_A);

    expect(await openFeeTotal()).toBe("35");
    expect(await countOf("REVERSAL")).toBe(0);
  });

  /*
   * Review Focus 5. A returned-payment fee has no delinquency action, so
   * it is not in the candidate set — which is why this holds however the
   * tenant has named it.
   */
  it("leaves a returned-payment fee alone", async () => {
    await feeByHand({ amount: "30.00", reasonCode: "NSF_FEE" });
    await ladder([
      { tier: 1, days: 15, fee: "10.00" },
      { tier: 2, days: 30, fee: "25.00", mode: "REPLACE_LOWER_TIERS" },
    ]);
    await pastDue({ balance: "100.00", days: 35 });

    await evaluateAll(TENANT_A);

    expect(await openFeeTotal()).toBe("55");
  });

  /*
   * The case a reason filter would have broken: this fee cites exactly
   * the reason the ladder's own tiers cite, and still must not be
   * touched, because a CSR raised it and the ladder did not.
   */
  it("leaves an operator's own late fee alone, citing the same reason", async () => {
    await feeByHand({ amount: "15.00", reasonCode: "LATE_FEE" });
    await ladder([
      { tier: 1, days: 15, fee: "10.00" },
      { tier: 2, days: 30, fee: "25.00", mode: "REPLACE_LOWER_TIERS" },
    ]);
    await pastDue({ balance: "100.00", days: 35 });

    await evaluateAll(TENANT_A);

    expect(await openFeeTotal()).toBe("40");
  });

  it("replaces once, not on every sweep", async () => {
    await principal("100.00");
    await ladder([
      { tier: 1, days: 15, fee: "10.00" },
      { tier: 2, days: 30, fee: "25.00", mode: "REPLACE_LOWER_TIERS" },
    ]);
    await pastDue({ balance: "100.00", days: 35 });

    await evaluateAll(TENANT_A);
    await evaluateAll(TENANT_A);

    expect(await stillPastDue()).toBe(true);
    expect(await countOf("FEE")).toBe(2);
    expect(await countOf("REVERSAL")).toBe(1);
  });

  /*
   * Critical, and the reason replacement moved inside the `if (amount)`
   * branch. A percentage tier whose base is nothing — the principal is
   * paid and only the earlier penalty is left open — would otherwise
   * reverse the fee below it and raise nothing in its place. That is
   * forgiveness arriving as a side effect of a schedule, which is what
   * the `delinquency_rule_replace_needs_fee` CHECK exists to forbid;
   * the CHECK constrains the configuration and could not see this.
   */
  it("does not reverse the lower tier's fee when its own charge rounds to nothing", async () => {
    await principal("100.00");
    await ladder([{ tier: 1, days: 15, fee: "10.00" }]);
    await pastDue({ balance: "100.00", days: 35 });
    await evaluateAll(TENANT_A);

    // The principal is settled; only tier 1's $10 penalty is open, and
    // `penaltyBase` excludes penalties, so a percentage of it is zero.
    await seedAsPlatform(async () =>
      prismaImports.prisma.ledgerEntry.updateMany({
        where: { utilityId: TENANT_A, type: "ADJUSTMENT_DEBIT" },
        data: { openAmount: "0.00" },
      }),
    );
    await ladder([
      { tier: 2, days: 30, fee: "0.0150", feeType: "PERCENT_OF_BALANCE", mode: "REPLACE_LOWER_TIERS" },
    ]);
    await pastDue({ balance: "10.00", days: 35 });

    await evaluateAll(TENANT_A);

    expect(await openFeeTotal()).toBe("10");
    expect(await countOf("REVERSAL")).toBe(0);
  });

  /*
   * `resolveAccount` resolves the highest live tier and cancels the
   * PENDING ones, so a lower COMPLETED action can outlive the tier above
   * it. When that account falls behind again, the replacing tier meets a
   * candidate whose fee is already reversed — and `reverseEntry` refuses
   * to reverse twice, so without a guard the whole tenant's sweep throws.
   */
  /*
   * `reverseEntry` refuses a second reversal with a 409, so a replacing
   * tier that meets an already-reversed candidate would throw and take
   * the rest of the tenant's sweep with it. Reachable without any race:
   * an operator waives tier 1's fee at the counter, and tier 2 arrives
   * afterwards for the first time.
   */
  it("skips a candidate fee somebody has already reversed", async () => {
    await principal("100.00");
    await ladder([{ tier: 1, days: 15, fee: "10.00" }]);
    await pastDue({ balance: "100.00", days: 20 });
    await evaluateAll(TENANT_A);

    const [tierOne] = await seedAsPlatform(async () =>
      prismaImports.prisma.delinquencyAction.findMany({
        where: { utilityId: TENANT_A },
        select: { feeEntryId: true },
      }),
    );
    await runAsTenant(TENANT_A, async () => {
      const { reverseEntry } = await import("../../services/ar/reversal.service.js");
      return reverseEntry(TENANT_A, ACTOR, "Tester", tierOne!.feeEntryId!, {
        memo: "Waived at the counter",
      });
    });

    await ladder([{ tier: 2, days: 30, fee: "25.00", mode: "REPLACE_LOWER_TIERS" }]);
    await pastDue({ balance: "100.00", days: 35 });

    await expect(evaluateAll(TENANT_A)).resolves.toBeDefined();
    // One reversal — the operator's. The sweep added none, and tier 2
    // still charged.
    expect(await countOf("REVERSAL")).toBe(1);
    expect(await openFeeTotal()).toBe("25");
  });

  /*
   * The consequence worth documenting rather than hiding. Reversing a
   * fee that was already paid hands the payment back as open credit,
   * which the new fee then absorbs: $25 raised, $10 of payment freed and
   * re-applied, $15 still owed on fees — and no money has gone missing.
   */
  it("returns a paid lower-tier fee to credit when it reverses it", async () => {
    await ladder([{ tier: 1, days: 15, fee: "10.00" }]);
    await pastDue({ balance: "100.00", days: 20 });
    await evaluateAll(TENANT_A);

    await runAsTenant(TENANT_A, async () =>
      payment.recordPayment(TENANT_A, ACTOR, "Tester", fix.accountId, {
        amount: "10.00",
        tender: "CASH",
      }),
    );

    await ladder([{ tier: 2, days: 30, fee: "25.00", mode: "REPLACE_LOWER_TIERS" }]);
    await pastDue({ balance: "100.00", days: 35 });

    await evaluateAll(TENANT_A);

    expect(await openFeeTotal()).toBe("15");
  });
});
