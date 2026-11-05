/**
 * Two time-of-use services, one of each kind.
 *
 * A TOU calendar on its own demonstrates nothing — it is the hours a
 * tariff prices against, and until something is priced against it the
 * screens are a configuration exercise. These are the two services
 * that make it real, and there are two on purpose, because a TOU
 * bucket comes to exist in two completely different ways:
 *
 *   TOU-REG-001  a register meter. Three dials; the meter's own clock
 *                routes consumption into one of them by its programmed
 *                switch times. The *device* did the bucketing, and the
 *                utility's register mapping says which dial means what.
 *
 *   TOU-AMI-001  an interval meter. One number an hour, each with its
 *                own timestamp, and no notion of a period at all. The
 *                published calendar classifies them, and the roll-up
 *                sums each period.
 *
 * Both end as `meter_read` rows carrying a `peak_code`, which is what
 * the rate engine reads. That is the whole point of seeding both: the
 * engine prices one shape and must never learn which kind of meter
 * produced it. If the two ever diverge, this is where it shows.
 *
 * **Registers are not required for TOU.** It is worth seeing that: an
 * interval meter has no TOU registers and is not programmed with a
 * calendar, and it bills correctly all the same — ours is the only
 * classification involved.
 *
 * Written with Prisma rather than by calling the services, like every
 * other section of the seed (`seed.js` runs as plain `node` and cannot
 * import the TypeScript). One consequence: the register sample stamps
 * `peak_code` onto its reads here, which is what `createMeterReadEvent`
 * does from the register mapping for a read taken through the API. The
 * interval sample does *not* classify anything here — `seed.js` shells
 * out to `scripts/roll-up-intervals.ts` so the real classifier runs. A
 * second classifier in a seed is how demo data ends up showing a split
 * the engine would not produce.
 */

const SCHEDULE_CODE = "RES-TOU-E";
const SCHEDULE_NAME = "Residential Electric Time-of-Use";

/**
 * The month the samples cover: the last complete one.
 *
 * Complete, because a half month of intervals is indistinguishable
 * from a meter that stopped reporting, and TOU-GAP-1 refuses to bill
 * that — the sample would seed its own exception.
 */
function lastFullMonth(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start, end, fromDate: iso(start), toDate: iso(end) };
}

/**
 * A day's hourly shape, in kWh.
 *
 * Not flat: a flat profile splits by the clock alone, so every period
 * would show the same rate per hour and the sample would say nothing
 * about why a TOU tariff exists. This is a household — low overnight,
 * a daytime plateau, a cooking-and-laundry evening that lands squarely
 * in the 5–8pm peak.
 */
const HOURLY_PROFILE = [
  0.4, 0.3, 0.3, 0.3, 0.3, 0.5, 0.9, 1.1, 0.9, 0.7, 0.7, 0.8,
  0.8, 0.8, 0.9, 1.0, 1.4, 2.3, 2.6, 2.1, 1.5, 1.0, 0.7, 0.5,
];

/** Local midnight in `zone`, as a UTC instant. Two passes settle the offset. */
function localMidnight(date, zone) {
  const utc = new Date(`${date}T00:00:00.000Z`);
  const offsetAt = (instant) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(instant);
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
    return (asUtc - instant.getTime()) / 60000;
  };
  const guess = new Date(utc.getTime() - offsetAt(utc) * 60000);
  return new Date(utc.getTime() - offsetAt(guess) * 60000);
}

async function seedTouService({ p, utilityId, calendarId, timeZone }) {
  if (!calendarId) return { skipped: "no TOU calendar was seeded" };

  const existing = await p.rateSchedule.findFirst({
    where: { utilityId, code: SCHEDULE_CODE },
    select: { id: true },
  });
  if (existing) return { skipped: `"${SCHEDULE_CODE}" already exists` };

  const electric = await p.commodity.findFirst({ where: { utilityId, code: "ELECTRIC" } });
  const kwh = await p.unitOfMeasure.findFirst({ where: { utilityId, code: "KWH" } });
  const measureUsage = await p.measureTypeDef.findFirst({ where: { code: "USAGE" } });
  if (!electric || !kwh || !measureUsage) {
    return { skipped: "no ELECTRIC commodity, KWH unit or USAGE measure type" };
  }

  const account = await p.account.findFirst({ where: { utilityId }, orderBy: { accountNumber: "asc" } });
  const premise = await p.premise.findFirst({ where: { utilityId }, orderBy: { createdAt: "asc" } });
  if (!account || !premise) return { skipped: "no account or premise to attach a service to" };

  const month = lastFullMonth();

  /*
   * The tariff. Three charges, one per period, which is how a TOU
   * tariff is written and how the bill reads — not one charge with a
   * time filter. `publishRateSchedule` refuses to publish unless every
   * period the calendar uses is priced, so these three are not a
   * choice: the calendar has summer mid-peak hours.
   */
  const schedule = await p.rateSchedule.create({
    data: {
      utilityId,
      name: SCHEDULE_NAME,
      code: SCHEDULE_CODE,
      commodityId: electric.id,
      effectiveDate: new Date(Date.UTC(2026, 0, 1)),
      version: 1,
      publishedAt: new Date(),
      touCalendarId: calendarId,
      description:
        "Time-of-use electric. Peak hours are the calendar's; each period has its own charge.",
    },
  });

  const PRICES = [
    { peakCode: "off_peak", label: "Off-peak energy", rate: 0.0741, sortOrder: 20 },
    { peakCode: "mid_peak", label: "Mid-peak energy", rate: 0.1385, sortOrder: 21 },
    { peakCode: "peak", label: "On-peak energy", rate: 0.2648, sortOrder: 22 },
  ];
  await p.rateComponent.createMany({
    data: [
      {
        utilityId,
        rateScheduleId: schedule.id,
        kindCode: "service_charge",
        label: "Electric Service Charge",
        sortOrder: 10,
        effectiveDate: new Date(Date.UTC(2026, 0, 1)),
        predicate: {},
        quantitySource: { base: "fixed" },
        pricing: { type: "flat", rate: 14.5, unit: "MONTH" },
      },
      ...PRICES.map((price) => ({
        utilityId,
        rateScheduleId: schedule.id,
        kindCode: "consumption",
        label: price.label,
        sortOrder: price.sortOrder,
        effectiveDate: new Date(Date.UTC(2026, 0, 1)),
        predicate: {},
        // The TOU quantity source: this charge prices one period's
        // usage, read from `meter:tou:<meter>:<peak_code>`.
        quantitySource: { base: "tou_period", peak_code: price.peakCode },
        pricing: { type: "flat", rate: price.rate, unit: "KWH" },
      })),
    ],
  });

  /** One agreement, one service point, one meter — the usual chain. */
  async function makeService({ meterNumber, agreementNumber, meterType, programmedCalendarId }) {
    const agreement = await p.serviceAgreement.create({
      data: {
        utilityId,
        agreementNumber,
        accountId: account.id,
        commodityId: electric.id,
        startDate: new Date(Date.UTC(2026, 0, 1)),
        status: "ACTIVE",
      },
    });
    const meter = await p.meter.create({
      data: {
        utilityId,
        meterNumber,
        // The device kind, not the commodity: an AMR meter is read by
        // drive-by and reports its dials, an AMI meter reports
        // intervals. The sample's whole point is the difference.
        meterType,
        status: "ACTIVE",
        premiseId: premise.id,
        commodityId: electric.id,
        uomId: kwh.id,
        installDate: new Date(Date.UTC(2026, 0, 1)),
        // Only the register meter is programmed with a calendar: it is
        // the one whose own clock does the splitting. Recorded so a
        // mismatch with the tariff's calendar can be flagged
        // (TOU-REG-2); it never decides pricing.
        touCalendarId: programmedCalendarId ?? null,
      },
    });
    const servicePoint = await p.servicePoint.create({
      data: {
        utilityId,
        serviceAgreementId: agreement.id,
        premiseId: premise.id,
        startDate: new Date(Date.UTC(2026, 0, 1)),
      },
    });
    await p.servicePointMeter.create({
      data: {
        utilityId,
        servicePointId: servicePoint.id,
        meterId: meter.id,
        addedDate: new Date(Date.UTC(2026, 0, 1)),
      },
    });
    await p.sAScheduleAssignment.create({
      data: {
        utilityId,
        serviceAgreementId: agreement.id,
        rateScheduleId: schedule.id,
        roleCode: "primary",
        effectiveDate: new Date(Date.UTC(2026, 0, 1)),
      },
    });
    return { agreement, meter };
  }

  // ─── Sample A: the register meter ──────────────────────────────
  const reg = await makeService({
    meterNumber: "TOU-REG-001",
    agreementNumber: "SA-TOU-REG-001",
    meterType: "AMR",
    programmedCalendarId: calendarId,
  });

  const REGISTERS = [
    { registerNumber: 1, peakCode: "peak", description: "On-peak kWh", prior: 4180, now: 4312 },
    { registerNumber: 2, peakCode: "mid_peak", description: "Mid-peak kWh", prior: 3050, now: 3139 },
    { registerNumber: 3, peakCode: "off_peak", description: "Off-peak kWh", prior: 9120, now: 9522 },
  ];
  const readDatetime = new Date(month.end.getTime() - 1);
  const readEventId = require("node:crypto").randomUUID();

  for (const r of REGISTERS) {
    const register = await p.meterRegister.create({
      data: {
        utilityId,
        meterId: reg.meter.id,
        registerNumber: r.registerNumber,
        description: r.description,
        uomId: kwh.id,
        measureTypeId: measureUsage.id,
        multiplier: 1.0,
        isActive: true,
        peakCode: r.peakCode,
      },
    });
    /*
     * One row per register on one read event, zero consumption
     * included — the contract the importer owes (TOU-REG-1). Writing
     * only the non-zero ones would make an unused period
     * indistinguishable from an absent register, and stop a bill that
     * should have shown a zero.
     */
    await p.meterRead.create({
      data: {
        utilityId,
        meterId: reg.meter.id,
        serviceAgreementId: reg.agreement.id,
        registerId: register.id,
        readEventId,
        uomId: kwh.id,
        readDate: new Date(readDatetime.toISOString().slice(0, 10)),
        readDatetime,
        reading: r.now,
        priorReading: r.prior,
        consumption: r.now - r.prior,
        // What the whole sample turns on. Taken from the register,
        // because the device did the bucketing.
        peakCode: r.peakCode,
        readType: "ACTUAL",
        readSource: "AMR",
      },
    });
  }

  // ─── Sample B: the interval meter ──────────────────────────────
  const ami = await makeService({
    meterNumber: "TOU-AMI-001",
    agreementNumber: "SA-TOU-AMI-001",
    meterType: "AMI",
    programmedCalendarId: null,
  });

  const periodStart = localMidnight(month.fromDate, timeZone);
  const periodEnd = localMidnight(month.toDate, timeZone);
  const intervals = [];
  for (
    let at = periodStart.getTime();
    at < periodEnd.getTime();
    at += 3_600_000
  ) {
    const instant = new Date(at);
    /*
     * The profile is indexed by the *local* hour, because a household's
     * evening is an evening wherever the clock is. Reading it by UTC
     * hour would put the peak at lunchtime and the sample would still
     * look plausible.
     */
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, hour: "2-digit" })
        .format(instant)
        .replace("24", "00"),
    );
    intervals.push({
      utilityId,
      meterId: ami.meter.id,
      uomId: kwh.id,
      intervalStart: instant,
      lengthMinutes: 60,
      quantity: HOURLY_PROFILE[localHour].toFixed(6),
      quality: "actual",
    });
  }
  await p.meterReadInterval.createMany({ data: intervals });

  return {
    scheduleName: SCHEDULE_NAME,
    scheduleCode: SCHEDULE_CODE,
    prices: PRICES.map((x) => `${x.peakCode} ${x.rate}`),
    registerMeter: "TOU-REG-001",
    registerBuckets: REGISTERS.map((r) => `${r.peakCode} ${r.now - r.prior}`),
    intervalMeter: "TOU-AMI-001",
    intervals: intervals.length,
    fromDate: month.fromDate,
    toDate: month.toDate,
  };
}

module.exports = { seedTouService };
