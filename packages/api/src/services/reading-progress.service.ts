import type {
  MeterReadingProgressQuery,
  OutstandingRead,
  ReadingProgress,
} from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { computeBillPeriod } from "./bill.service.js";
import { agreementInWindow } from "./billing-run/window.js";

/**
 * Which meters a cycle still has to read before it can bill (spec 08).
 *
 * **The question no screen could answer.** The read log lists reads
 * that exist, so it is structurally incapable of showing the ones that
 * do not — and that is the question that decides whether a cycle can
 * bill. Until this, the only way to find out was to start a run and
 * read the skips: every unread account came back `NO_READ_IN_WINDOW`,
 * one at a time, after the run had been created and the window closed
 * behind it.
 *
 * The window is the cycle's own, from `computeBillPeriod` with the
 * epoch as the creation date — the same call `planBillingRun` makes,
 * for the same reason: a window belongs to the cycle, not to an
 * account, and the per-account clamp inside that function would
 * otherwise give each account a different one. Sharing the call is what
 * stops this screen and the run disagreeing about "the October window".
 *
 * **An interval meter counts as read when it has intervals.** It has no
 * `meter_read` row until the roll-up runs inside a billing run, so
 * asking only about reads would report every AMI meter as outstanding —
 * a list of hundreds that needed no action, which is how a readiness
 * screen teaches people to ignore it.
 */

/*
 * `OutstandingRead` and `ReadingProgress` were declared here, and
 * again by hand in the screen that renders them. They live in
 * `@utility-cis/shared` now, as Zod schemas the web derives its types
 * from and `response-contracts.integration.test.ts` parses a real
 * response through — so the shape has one statement, checked at both
 * ends.
 *
 * **Its timestamps are ISO strings, not `Date`s.** This function builds
 * its response rather than handing back database rows, so making the
 * return type the wire type costs one `toISOString()` per field and
 * buys a compiler that checks what is produced. A `Date` in a type the
 * browser reads is a lie about the wire, and the lie is what lets
 * `new Date(x)` work in one place and `x.getTime()` throw in another.
 */

export async function getReadingProgress(
  utilityId: string,
  query: MeterReadingProgressQuery,
): Promise<ReadingProgress> {
  const cycle = await prisma.billingCycle.findFirst({
    where: { id: query.billingCycleId, utilityId },
    select: { id: true, cycleCode: true, billDayOfMonth: true, frequency: true },
  });
  if (!cycle) {
    throw Object.assign(new Error(`Billing cycle ${query.billingCycleId} not found`), {
      statusCode: 404,
      code: "CYCLE_NOT_FOUND",
    });
  }

  const window = computeBillPeriod(
    { createdAt: new Date(0), billingCycle: cycle },
    query.asOf ? new Date(query.asOf) : new Date(),
  );
  const { periodStart: windowStart, periodEnd: windowEnd } = window;
  /** Intervals are instants; the window's last day runs to its end. */
  const intervalEnd = new Date(windowEnd.getTime() + 86_400_000);

  /*
   * **The run's own filter, shared rather than copied.** This screen is
   * worth having only if it predicts what a run will do, so it asks the
   * run's question by calling the run's function
   * (`billing-run/window.ts`).
   *
   * It was a copy of the executor's literal until 2026-11-08, and
   * comparing the two found that the executor and the planner disagreed
   * — an agreement that ended mid-window was checked for configuration
   * faults and then never billed. That is fixed at the source; the note
   * is kept because this is where it was found, and because the reason
   * for sharing is that a copy drifted once already.
   *
   * One thing still open: neither filters on `status`, so a `PENDING`
   * service with a meter assigned would be attempted. It rarely has
   * one, which is why it has never shown.
   */
  const agreement = {
    account: { billingCycleId: cycle.id },
    ...agreementInWindow(window),
  };

  /** An open assignment of a meter to a service point. */
  const expectedWhere = {
    utilityId,
    removedDate: null,
    servicePoint: { serviceAgreement: agreement },
  };

  const outstandingWhere = {
    ...expectedWhere,
    meter: {
      meterReads: { none: { readDate: { gte: windowStart, lte: windowEnd } } },
      meterReadIntervals: {
        none: { intervalStart: { gte: windowStart, lt: intervalEnd } },
      },
    },
  };

  const [expected, outstanding] = await Promise.all([
    prisma.servicePointMeter.count({ where: expectedWhere }),
    prisma.servicePointMeter.count({ where: outstandingWhere }),
  ]);

  const rows = await prisma.servicePointMeter.findMany({
    where: outstandingWhere,
    orderBy: [{ meter: { meterNumber: "asc" } }],
    skip: (query.page - 1) * query.limit,
    take: query.limit,
    select: {
      meterId: true,
      meter: { select: { meterNumber: true } },
      servicePoint: {
        select: {
          premise: { select: { addressLine1: true, city: true } },
          serviceAgreement: {
            select: {
              agreementNumber: true,
              account: { select: { accountNumber: true } },
            },
          },
        },
      },
    },
  });

  /*
   * The last read of each meter on this page, in one query rather than
   * one per row. It answers the question an operator asks next — a
   * meter never read is a new service, one last read in July is a
   * meter somebody has stopped reaching.
   */
  const lastReads = rows.length
    ? await prisma.meterRead.groupBy({
        by: ["meterId"],
        where: { utilityId, meterId: { in: rows.map((r) => r.meterId) } },
        _max: { readDate: true },
      })
    : [];
  const lastByMeter = new Map(lastReads.map((g) => [g.meterId, g._max.readDate ?? null]));

  return {
    billingCycleId: cycle.id,
    cycleCode: cycle.cycleCode,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    expected,
    read: expected - outstanding,
    outstanding,
    data: rows.map((r): OutstandingRead => ({
      meterId: r.meterId,
      meterNumber: r.meter.meterNumber,
      agreementNumber: r.servicePoint?.serviceAgreement?.agreementNumber ?? "—",
      accountNumber: r.servicePoint?.serviceAgreement?.account?.accountNumber ?? "—",
      premise: r.servicePoint?.premise
        ? `${r.servicePoint.premise.addressLine1}, ${r.servicePoint.premise.city}`
        : null,
      lastReadDate: lastByMeter.get(r.meterId)?.toISOString() ?? null,
    })),
    meta: {
      total: outstanding,
      page: query.page,
      limit: query.limit,
      pages: Math.ceil(outstanding / query.limit),
    },
  };
}
