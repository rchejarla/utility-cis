/**
 * The TOU pre-run check, against the seeded dev database.
 *
 * Run: `npx tsx --env-file=.env scripts/smoke-tou-readiness.ts`
 *
 * It exists for the reason `smoke-scheduler-config.ts` does: the unit
 * suites mock Prisma end to end, and the integration suite builds its
 * own fixtures, so neither one can tell you whether the **seeded**
 * samples exercise the checks they were seeded to exercise. The
 * register reconciliation went unseen that way — the sample meters had
 * no total dial, and `reconcileRegisters` answers "nothing to check"
 * without a total read, so the check was covered by tests and invisible
 * in the product for as long as anybody looked at it.
 *
 * Expect, on a freshly seeded database:
 *   SA-TOU-REG-001  clean
 *   SA-TOU-REG-002  REGISTERS_UNRECONCILED — 638 against 623, 15 out
 *   SA-TOU-AMI-001  clean
 *
 * Over the window the cycle is about to bill, which is what the samples
 * are seeded to cover — not a calendar month. A month is where the first
 * version of this script looked, and the interval sample covered it, and
 * the account still failed every run with `TOU_ROLLUP_FAILED`.
 */
import { prisma } from "../src/lib/prisma.js";
import { runAsTenant } from "../src/lib/tenant-context.js";
import { computeBillPeriod } from "../src/services/bill.service.js";
import {
  checkTouReadinessForAgreements,
  describeTouProblem,
} from "../src/services/tou-readiness.service.js";

const UTILITY_ID = "00000000-0000-4000-8000-000000000001";

async function main(): Promise<void> {
  const lines = await runAsTenant(UTILITY_ID, async () => {
    /*
     * The window a run would bill today, from the same function the
     * planner uses. Stated as dates here until 2026-11-06, which was
     * wrong twice over: it named a calendar month, and a hard-coded one,
     * so the check ran over a period no run ever bills and the answer
     * went stale the following month.
     */
    const account = await prisma.account.findFirstOrThrow({
      where: { utilityId: UTILITY_ID },
      orderBy: { accountNumber: "asc" },
      select: {
        createdAt: true,
        billingCycle: { select: { billDayOfMonth: true, frequency: true } },
      },
    });
    const period = computeBillPeriod(account, new Date());
    const PERIOD = { startDate: period.periodStart, endDate: period.periodEnd };

    const agreements = await prisma.serviceAgreement.findMany({
      where: { utilityId: UTILITY_ID, agreementNumber: { startsWith: "SA-TOU-" } },
      select: { id: true, agreementNumber: true },
      orderBy: { agreementNumber: "asc" },
    });

    const byAgreement = await checkTouReadinessForAgreements(
      UTILITY_ID,
      agreements.map((a) => a.id),
      PERIOD,
    );

    return agreements.map((a) => {
      const problems = byAgreement.get(a.id) ?? [];
      return problems.length === 0
        ? `${a.agreementNumber}  clean`
        : [
            `${a.agreementNumber}  ${problems.map((p) => p.kind).join(", ")}`,
            ...problems.map((p) => `    ${describeTouProblem(p)}`),
          ].join("\n");
    });
  });

  console.log(lines.join("\n"));
  await prisma.$disconnect();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("FAILED:", err);
    process.exit(1);
  },
);
