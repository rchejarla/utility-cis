/**
 * Bill one service agreement and print the lines (spec 26, TOU-ENG-1).
 *
 * The TOU chain had never been run end to end: the engine rates
 * `tou_period`, the loader answers `meter:tou:*` off stamped reads, the
 * bill-segment service asks for the codes the tariff prices — and
 * nothing had put a bill out of the other end. This is that run, kept
 * because it is also how the next person checks a tariff against a real
 * agreement without a billing cycle and a worker.
 *
 *   npx tsx scripts/rate-service-agreement.ts \
 *     --utility-id <uuid> --agreement SA-TOU-REG-001
 *
 * `--from`/`--to` bill an explicit window; omitted, the period is
 * resolved from the agreement's unbilled reads the way a real run does.
 * **It writes a BillSegment**, like any other rating — this is not a
 * dry run.
 */
import { prisma } from "../src/lib/prisma.js";
import { runAsTenant } from "../src/lib/tenant-context.js";
import { createBillSegmentForServiceAgreement } from "../src/services/bill-segment.service.js";

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

async function main() {
  const utilityId = required("utility-id");
  const agreementNumber = required("agreement");
  const from = arg("from");
  const to = arg("to");

  await runAsTenant(utilityId, async () => {
    const sa = await prisma.serviceAgreement.findFirst({
      where: { utilityId, agreementNumber },
      select: { id: true, agreementNumber: true },
    });
    if (!sa) throw new Error(`No service agreement numbered ${agreementNumber} in this utility.`);

    const segment = await createBillSegmentForServiceAgreement(
      utilityId,
      null,
      "rate-service-agreement script",
      sa.id,
      from && to ? { periodStart: new Date(from), periodEnd: new Date(to) } : {},
    );

    const d = (v: unknown) => Number(v).toFixed(4);
    console.log(
      `\n${sa.agreementNumber}  ${segment.periodStart.toISOString().slice(0, 10)}` +
        ` .. ${segment.periodEnd.toISOString().slice(0, 10)}`,
    );
    console.log("".padEnd(66, "-"));
    for (const l of segment.lines) {
      const qty = l.quantity === null ? "" : `${d(l.quantity)} ${l.unit ?? ""}`;
      console.log(`  ${String(l.label).padEnd(30)} ${qty.padStart(18)} ${d(l.amount).padStart(12)}`);
    }
    console.log("".padEnd(66, "-"));
    console.log(`  ${"subtotal".padEnd(30)} ${"".padStart(18)} ${d(segment.subtotal).padStart(12)}`);
    console.log(`  ${"taxes".padEnd(30)} ${"".padStart(18)} ${d(segment.taxes).padStart(12)}`);
    console.log(`  ${"total".padEnd(30)} ${"".padStart(18)} ${d(segment.total).padStart(12)}\n`);
  });
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
