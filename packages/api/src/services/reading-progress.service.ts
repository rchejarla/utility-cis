import type {
  MeterReadingProgressQuery,
  OutstandingRead,
  ReadingProgress,
} from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { computeBillPeriod } from "./bill.service.js";
import { agreementInWindow } from "./billing-run/window.js";
import { readableRowsForPremises } from "./read-route/readable-rows.js";

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
 *
 * **One function, one branch on what the route is** (read routes design
 * §5.9). Without `readRouteId` the expected set is the cycle's own: the
 * assignments on agreements whose account is on the cycle, counted per
 * assignment, in the database. With one, a reading week is being worked
 * route by route, and the only thing that changes is *which meters are
 * expected* - the window, the `agreementInWindow` filter, what counts as
 * read, the last read and the skip reason are the same code. There is
 * deliberately no second implementation: the one that mirrors the run
 * stays the only one.
 *
 * The two expected sets differ in grain, and that is decided rather than
 * accidental. A LOCAL route's is **per register**, from the same
 * predicate the printed sheet uses (`readableRowsForPremises`), so the
 * route's number cannot disagree with the paper in the reader's hand.
 * The cycle-wide one stays per assignment. They are not made to agree.
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
   * - an agreement that ended mid-window was checked for configuration
   * faults and then never billed. That is fixed at the source; the note
   * is kept because this is where it was found, and because the reason
   * for sharing is that a copy drifted once already.
   *
   * One thing still open: neither filters on `status`, so a `PENDING`
   * service with a meter assigned would be attempted. It rarely has
   * one, which is why it has never shown.
   */
  const inWindow = agreementInWindow(window);

  const route = query.readRouteId
    ? await prisma.readRoute.findFirst({
        // On this cycle too: a route is worked inside one cycle's window.
        where: { id: query.readRouteId, utilityId, billingCycleId: cycle.id },
        select: { id: true, code: true, origin: true },
      })
    : null;
  if (query.readRouteId && !route) {
    throw Object.assign(new Error(`Read route ${query.readRouteId} not found on this cycle`), {
      statusCode: 404,
      code: "ROUTE_NOT_FOUND",
    });
  }

  let expected: number;
  let outstanding: number;
  let page: Candidate[];

  if (!route) {
    /** An open assignment of a meter to a service point. */
    const expectedWhere = {
      utilityId,
      removedDate: null,
      servicePoint: { serviceAgreement: { account: { billingCycleId: cycle.id }, ...inWindow } },
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

    [expected, outstanding] = await Promise.all([
      prisma.servicePointMeter.count({ where: expectedWhere }),
      prisma.servicePointMeter.count({ where: outstandingWhere }),
    ]);

    const rows = await prisma.servicePointMeter.findMany({
      where: outstandingWhere,
      orderBy: [{ meter: { meterNumber: "asc" } }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      select: assignmentSelect,
    });
    page = rows.map(candidateFromAssignment);
  } else {
    const units =
      route.origin === "EXTERNAL"
        ? await learnedUnits(utilityId, route.id, cycle, window, inWindow)
        : await stopUnits(utilityId, route.id, window, inWindow);
    const unread = await withoutAReadInWindow(utilityId, units, window.periodStart, windowEnd, intervalEnd);
    expected = units.length;
    outstanding = unread.length;
    page = unread.slice((query.page - 1) * query.limit, query.page * query.limit);
  }

  /*
   * The last read of each meter on this page, in one query rather than
   * one per row. It answers the question an operator asks next — a
   * meter never read is a new service, one last read in July is a
   * meter somebody has stopped reaching.
   */
  const pageMeterIds = [...new Set(page.map((r) => r.meterId))];
  const lastReads = pageMeterIds.length
    ? await prisma.meterRead.groupBy({
        by: ["meterId"],
        where: { utilityId, meterId: { in: pageMeterIds } },
        _max: { readDate: true },
      })
    : [];
  const lastByMeter = new Map(lastReads.map((g) => [g.meterId, g._max.readDate ?? null]));

  /*
   * Why a reader came back without a number, from the meter's open skip
   * in this window. Open means unresolved: a skip heals when the read
   * arrives, and a resolved one is history, not a reason. Asked of both
   * paths, because a locked gate is a fact about the meter and not about
   * which screen is looking; the newest open one wins if there are two.
   */
  const skips = pageMeterIds.length
    ? await prisma.readSkip.findMany({
        where: {
          utilityId,
          meterId: { in: pageMeterIds },
          resolvedAt: null,
          readDate: { gte: windowStart, lte: windowEnd },
        },
        orderBy: [{ createdAt: "desc" }],
        select: { meterId: true, skipReason: true },
      })
    : [];
  const skipByMeter = new Map<string, string>();
  for (const k of skips) if (!skipByMeter.has(k.meterId)) skipByMeter.set(k.meterId, k.skipReason);

  return {
    billingCycleId: cycle.id,
    cycleCode: cycle.cycleCode,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    expected,
    read: expected - outstanding,
    outstanding,
    /*
     * Named key by key rather than spread: a route's rows carry
     * `registerId` internally, and spreading would put an undeclared
     * field on the wire that no type check and no non-strict schema sees.
     */
    data: page.map((r): OutstandingRead => ({
      meterId: r.meterId,
      meterNumber: r.meterNumber,
      registerNumber: r.registerNumber,
      agreementNumber: r.agreementNumber,
      accountNumber: r.accountNumber,
      premise: r.premise,
      lastReadDate: lastByMeter.get(r.meterId)?.toISOString() ?? null,
      // The cycle-wide answer does not know a meter's route; see the schema.
      routeCode: route?.code ?? null,
      skipReason: skipByMeter.get(r.meterId) ?? null,
    })),
    meta: {
      total: outstanding,
      page: query.page,
      limit: query.limit,
      pages: Math.ceil(outstanding / query.limit),
    },
  };
}

/** A row the screen can name, before the last read and skip are attached. */
type Candidate = Omit<OutstandingRead, "lastReadDate" | "routeCode" | "skipReason">;

/** One thing a route expects a number for: a register, or a bare meter. */
interface ExpectedUnit extends Candidate {
  registerId: string | null;
}

const oneDay = 86_400_000;

/**
 * Reads in a window, bounded on `read_datetime` as well as `read_date`:
 * only the former prunes the hypertable's chunks, and stating both keeps
 * every path that asks "was it read in this window" agreeing at the edge.
 */
function readsIn(start: Date, end: Date) {
  return {
    readDate: { gte: start, lte: end },
    readDatetime: { gte: start, lt: new Date(end.getTime() + oneDay) },
  };
}

/**
 * The one place a row the screen names is put together, so the fallbacks
 * and the address format cannot drift between the three ways an expected
 * meter is found - the same reason `agreementInWindow` is shared.
 */
function candidate(p: {
  meterId: string;
  meterNumber: string;
  registerNumber?: string | null;
  agreementNumber?: string | null;
  accountNumber?: string | null;
  premise?: { addressLine1: string; city: string } | null;
}): Candidate {
  return {
    meterId: p.meterId,
    meterNumber: p.meterNumber,
    registerNumber: p.registerNumber ?? null,
    agreementNumber: p.agreementNumber ?? "—",
    accountNumber: p.accountNumber ?? "—",
    premise: p.premise ? `${p.premise.addressLine1}, ${p.premise.city}` : null,
  };
}

/** What both assignment-based finders select, and `candidateFromAssignment` reads. */
const assignmentSelect = {
  meterId: true,
  meter: { select: { meterNumber: true } },
  servicePoint: {
    select: {
      premise: { select: { addressLine1: true, city: true } },
      serviceAgreement: {
        select: { agreementNumber: true, account: { select: { accountNumber: true } } },
      },
    },
  },
} as const;

function candidateFromAssignment(a: {
  meterId: string;
  meter: { meterNumber: string };
  servicePoint: {
    premise: { addressLine1: string; city: string } | null;
    serviceAgreement: { agreementNumber: string; account: { accountNumber: string } | null } | null;
  } | null;
}): Candidate {
  return candidate({
    meterId: a.meterId,
    meterNumber: a.meter.meterNumber,
    agreementNumber: a.servicePoint?.serviceAgreement?.agreementNumber,
    accountNumber: a.servicePoint?.serviceAgreement?.account?.accountNumber,
    premise: a.servicePoint?.premise,
  });
}

/**
 * A LOCAL route expects what its stops produce: the sheet's rows.
 *
 * **It does not ask the account's cycle.** The route names its stops, and
 * the sheet prints every one (§5.1), so a service whose account is on a
 * different cycle is still a line on the paper and must be one in the
 * count. The agreement still has to be in the window, by the run's own
 * filter.
 *
 * `onDate` is the window's last day, because that is the day the reads
 * being waited on are for; `readableRowsForPremises` normalises it to the
 * UTC midnight its `@db.Date` columns compare against.
 */
async function stopUnits(
  utilityId: string,
  routeId: string,
  window: { periodStart: Date; periodEnd: Date },
  inWindow: ReturnType<typeof agreementInWindow>,
): Promise<ExpectedUnit[]> {
  const stops = await prisma.readRouteStop.findMany({
    where: { utilityId, readRouteId: routeId },
    select: { premiseId: true, sequence: true },
  });
  const rows = await readableRowsForPremises(
    utilityId,
    stops.map((s) => s.premiseId),
    window.periodEnd,
  );
  if (rows.length === 0) return [];

  const [agreements, premises] = await Promise.all([
    prisma.serviceAgreement.findMany({
      where: { utilityId, id: { in: [...new Set(rows.map((r) => r.serviceAgreementId))] }, ...inWindow },
      select: { id: true, agreementNumber: true },
    }),
    prisma.premise.findMany({
      where: { utilityId, id: { in: stops.map((s) => s.premiseId) } },
      select: { id: true, addressLine1: true, city: true },
    }),
  ]);
  const agreementNumber = new Map(agreements.map((a) => [a.id, a.agreementNumber]));
  const premise = new Map(premises.map((p) => [p.id, p]));

  /*
   * In the order the route is walked: stop sequence, and within a stop
   * the order `readableRowsForPremises` already gave (meter, register).
   * `sort` is stable, so that inner order survives. Paging this list by
   * meter number instead would make page 2 something other than "the
   * rest of the walk".
   */
  const sequence = new Map(stops.map((s) => [s.premiseId, s.sequence]));
  return rows
    .filter((r) => agreementNumber.has(r.serviceAgreementId))
    .sort((x, y) => sequence.get(x.premiseId)! - sequence.get(y.premiseId)!)
    .map((r) => ({
      ...candidate({
        meterId: r.meterId,
        meterNumber: r.meterNumber,
        registerNumber: r.registerNumber,
        agreementNumber: agreementNumber.get(r.serviceAgreementId),
        accountNumber: r.accountNumber,
        premise: premise.get(r.premiseId),
      }),
      registerId: r.registerId,
    }));
}

/**
 * An EXTERNAL route has no stops - the vendor owns the walk - so what it
 * expects is learned (§5.4): the meters whose **most recent read within
 * the previous window** carried this route.
 *
 * **Bounded to the previous window, on purpose.** "Most recent read of
 * each meter, ever" is a per-meter aggregate over all history of a
 * hypertable partitioned by `read_datetime`; bounded, it is a
 * time-partitioned scan that `meter_read_utility_id_route_id_idx` serves.
 * It is also more right: a meter that moved from route A to route B would
 * otherwise be expected on both for ever, where per window it lands on
 * exactly one. The window is bounded on `read_datetime` as well as
 * `read_date`, because only the former prunes chunks.
 *
 * **A route with no reads in that window at all** - a first-ever one -
 * has nothing to learn from, so it is learned from the current window
 * instead: what has been received is the whole list, `expected` equals
 * `read` and nothing is outstanding. That is received-only, and it keeps
 * `read = expected - outstanding` honest. It is confined to exactly that
 * case: as a fallback on every window, a vendor file arriving mid-window
 * would make `expected` climb as reads landed, and the column would stop
 * meaning work remaining.
 */
async function learnedUnits(
  utilityId: string,
  routeId: string,
  cycle: { billDayOfMonth: number; frequency: string },
  window: { periodStart: Date; periodEnd: Date },
  inWindow: ReturnType<typeof agreementInWindow>,
): Promise<ExpectedUnit[]> {
  // The period that closed the day before this one opened.
  const previous = computeBillPeriod(
    { createdAt: new Date(0), billingCycle: cycle },
    new Date(window.periodStart.getTime() - oneDay),
  );
  const inPrevious = readsIn(previous.periodStart, previous.periodEnd);

  const onRoute = await prisma.meterRead.findMany({
    where: { utilityId, routeId, ...inPrevious },
    distinct: ["meterId"],
    select: { meterId: true },
  });

  const stillOnRoute: string[] = [];
  if (onRoute.length === 0) {
    const received = await prisma.meterRead.findMany({
      where: { utilityId, routeId, ...readsIn(window.periodStart, window.periodEnd) },
      distinct: ["meterId"],
      select: { meterId: true },
    });
    stillOnRoute.push(...received.map((r) => r.meterId));
  } else {
    // Most recent first, so the first row seen for a meter is its latest.
    const latest = await prisma.meterRead.findMany({
      where: { utilityId, meterId: { in: onRoute.map((r) => r.meterId) }, ...inPrevious },
      orderBy: [{ readDatetime: "desc" }],
      select: { meterId: true, routeId: true },
    });
    const seen = new Set<string>();
    for (const r of latest) {
      if (seen.has(r.meterId)) continue;
      seen.add(r.meterId);
      if (r.routeId === routeId) stillOnRoute.push(r.meterId);
    }
  }
  if (stillOnRoute.length === 0) return [];

  const assignments = await prisma.servicePointMeter.findMany({
    where: {
      utilityId,
      meterId: { in: stillOnRoute },
      removedDate: null,
      servicePoint: { serviceAgreement: inWindow },
    },
    orderBy: [{ meter: { meterNumber: "asc" } }],
    select: assignmentSelect,
  });
  const byMeter = new Map<string, ExpectedUnit>();
  for (const a of assignments) {
    if (byMeter.has(a.meterId)) continue;
    byMeter.set(a.meterId, { ...candidateFromAssignment(a), registerId: null });
  }
  return [...byMeter.values()];
}

/**
 * Of these units, the ones with no read in the window - and no intervals,
 * for a meter whose reads are rolled up at billing. A unit with a register
 * is read by a read of that register; a bare meter by any read of it.
 */
async function withoutAReadInWindow(
  utilityId: string,
  units: ExpectedUnit[],
  windowStart: Date,
  windowEnd: Date,
  intervalEnd: Date,
): Promise<ExpectedUnit[]> {
  if (units.length === 0) return [];
  const meterIds = [...new Set(units.map((u) => u.meterId))];
  const [reads, intervals] = await Promise.all([
    prisma.meterRead.findMany({
      where: { utilityId, meterId: { in: meterIds }, ...readsIn(windowStart, windowEnd) },
      select: { meterId: true, registerId: true },
    }),
    prisma.meterReadInterval.findMany({
      where: { utilityId, meterId: { in: meterIds }, intervalStart: { gte: windowStart, lt: intervalEnd } },
      distinct: ["meterId"],
      select: { meterId: true },
    }),
  ]);
  const registersRead = new Map<string, Set<string | null>>();
  for (const r of reads) {
    const held = registersRead.get(r.meterId) ?? new Set();
    held.add(r.registerId);
    registersRead.set(r.meterId, held);
  }
  const hasIntervals = new Set(intervals.map((i) => i.meterId));
  return units.filter((u) => {
    if (hasIntervals.has(u.meterId)) return false;
    const held = registersRead.get(u.meterId);
    if (!held) return true;
    /*
     * A read that names no register satisfies the meter. That is safe
     * because `createMeterRead` refuses a null register on a meter with
     * two or more active registers, so a meter-level read cannot hide an
     * unread second register - and it is necessary because a meter with
     * exactly one register is allowed to omit it, and would otherwise be
     * outstanding for ever.
     */
    if (held.has(null)) return false;
    return u.registerId === null ? false : !held.has(u.registerId);
  });
}
