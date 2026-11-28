/**
 * Bill accounts for one period through the real billing code — the seed's
 * demo bills (`seed.js`).
 *
 * The seed used to write its bills straight to the tables with amounts
 * "plausible rather than computed", from only the first of an agreement's
 * schedules and two of its charges. A residential electric bill had no
 * supply, tax or rider lines and a service charge the tariff does not
 * have; comparing such a bill with another rate (the shadow bill) compared
 * real rating with fiction. Found 2026-11-28.
 *
 * So the seed shells out to this, as it does to `provision-tenant.ts` and
 * `roll-up-intervals.ts` — it is CommonJS and cannot import the services.
 * For each account: rate every agreement over the period
 * (`createBillSegmentForServiceAgreement`, which also marks the reads it
 * used as billed), assemble the bill (`generateBillForAccount`, auto-post
 * suppressed), and post it (`postBill`, which writes the receivable and
 * the balance) unless the account is named in `--unposted`.
 *
 * An agreement that cannot be rated — no assignment in force, no reads in
 * the period — is reported and skipped rather than invented, and an
 * account none of whose agreements rated gets no bill.
 *
 *   npx tsx scripts/seed-rated-bills.ts --utility-id <uuid> \
 *     --period-start 2026-09-11 --period-end 2026-10-10 \
 *     --accounts <id,id,…> [--unposted <id>]
 *
 * Prints one JSON line per account.
 */
import { prisma } from "../src/lib/prisma.js";
import { runAsTenant } from "../src/lib/tenant-context.js";
import { createBillSegmentForServiceAgreement } from "../src/services/bill-segment.service.js";
import { generateBillForAccount } from "../src/services/bill.service.js";
import { postBill } from "../src/services/ar/posting.service.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function required(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`Missing --${name}`);
    process.exit(1);
  }
  return v;
}

const ACTOR = "Seed";

async function main() {
  const utilityId = required("utility-id");
  const periodStart = new Date(`${required("period-start")}T00:00:00.000Z`);
  const periodEnd = new Date(`${required("period-end")}T00:00:00.000Z`);
  const accountIds = required("accounts").split(",").filter(Boolean);
  const unposted = new Set((arg("unposted") ?? "").split(",").filter(Boolean));

  await runAsTenant(utilityId, async () => {
    for (const accountId of accountIds) {
      const agreements = await prisma.serviceAgreement.findMany({
        where: {
          utilityId,
          accountId,
          startDate: { lte: periodEnd },
          OR: [{ endDate: null }, { endDate: { gte: periodStart } }],
        },
        orderBy: { agreementNumber: "asc" },
        select: { id: true, agreementNumber: true },
      });

      const skipped: string[] = [];
      let rated = 0;
      for (const sa of agreements) {
        try {
          await createBillSegmentForServiceAgreement(utilityId, null, ACTOR, sa.id, { periodStart, periodEnd });
          rated++;
        } catch (e) {
          skipped.push(`${sa.agreementNumber}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (rated === 0) {
        console.log(JSON.stringify({ accountId, bill: null, skipped }));
        continue;
      }

      const bill = await generateBillForAccount(utilityId, null, ACTOR, accountId, {
        window: { periodStart, periodEnd },
        suppressAutoPost: true,
      });
      const posted = !unposted.has(accountId);
      if (posted) {
        await postBill(utilityId, null, ACTOR, bill.id, {
          effectiveDate: periodEnd.toISOString().slice(0, 10),
        });
      }
      console.log(
        JSON.stringify({ accountId, bill: bill.billNumber, total: bill.total, segments: rated, posted, skipped }),
      );
    }
  });
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
