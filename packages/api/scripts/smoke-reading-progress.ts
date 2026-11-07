/**
 * Reading progress for every cycle, against the seeded dev database.
 *
 * Run: `npx tsx --env-file=.env scripts/smoke-reading-progress.ts`
 *
 * It exists for the reason the other two smoke scripts do: the unit
 * suites mock Prisma end to end and the integration suite builds its
 * own fixtures, so neither can say whether the **seeded** data
 * exercises what it looks like it exercises. This one walks four joins
 * — cycle to account, account to agreement, agreement to service point,
 * point to meter — and a `none` on two relations. Every one of those is
 * a place a query can be quietly wrong and still return rows.
 *
 * Expect, on a freshly seeded database (the windows move with the
 * month, the counts do not):
 *
 *   R01  expected 9   read 5   outstanding 4
 *   R02  expected 3   read 0   outstanding 3
 *
 * Which is worth knowing in itself: the seed reads two services and the
 * three TOU ones, and leaves seven meters never read. A run over either
 * cycle skips exactly those — "the seed gives most meters no reads", as
 * `dev-seed.integration.test.ts` puts it, now visible before the run
 * rather than in its skip list afterwards.
 */
import { prisma } from "../src/lib/prisma.js";
import { runAsTenant } from "../src/lib/tenant-context.js";
import { getReadingProgress } from "../src/services/reading-progress.service.js";

const UTILITY_ID = "00000000-0000-4000-8000-000000000001";

async function main(): Promise<void> {
  const out = await runAsTenant(UTILITY_ID, async () => {
    const cycles = await prisma.billingCycle.findMany({
      where: { utilityId: UTILITY_ID },
      select: { id: true, cycleCode: true },
      orderBy: { cycleCode: "asc" },
    });
    const lines: string[] = [];
    for (const c of cycles) {
      const p = await getReadingProgress(UTILITY_ID, {
        billingCycleId: c.id,
        page: 1,
        limit: 10,
      });
      lines.push(
        `${p.cycleCode}  window ${p.windowStart.toISOString().slice(0, 10)}..${p.windowEnd
          .toISOString()
          .slice(0, 10)}  expected ${p.expected}  read ${p.read}  outstanding ${p.outstanding}`,
      );
      for (const r of p.data) {
        lines.push(
          `    ${r.meterNumber}  ${r.agreementNumber}  ${r.accountNumber}  last read ${
            r.lastReadDate ? r.lastReadDate.toISOString().slice(0, 10) : "never"
          }`,
        );
      }
    }
    return lines;
  });
  console.log(out.join("\n"));
  await prisma.$disconnect();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("FAILED:", err);
    process.exit(1);
  },
);
