/**
 * Read-route scenario data, for a database the base seed has already filled.
 *
 * Run: `cd packages/api && npx tsx --env-file=.env scripts/seed-read-route-scenarios.ts`
 *      (`--utility-id <uuid>` for a tenant other than the dev one)
 *
 * **Why this exists at all.** `seed.js` has no read-route data: no route,
 * no stop, no skip, and no read carrying a route. So on a freshly seeded
 * database every screen this feature adds is empty, and an empty screen
 * cannot be told apart from a broken one — which is the failure the
 * exception-code note in `seed.js` records having already happened once to
 * the Meter Reads screen.
 *
 * **Additive and idempotent, not a wipe.** `seed.js` deletes before it
 * inserts, which makes it useless for adding a scenario to a database
 * somebody is already working in. Every row here is found-or-created on a
 * natural key, so a second run reports zeros and a run against a
 * part-seeded database fills in only what is missing. Two things converge
 * rather than being left alone, and both say so where they are written:
 * EM-003's meter type, and the closed assignment at stop 400.
 *
 * **One route, whose stops each state one fact.** A fixture that stacks
 * three facts onto a stop cannot be asserted on: when the sheet prints a
 * line too few, there is no telling which clause did it.
 *
 *   100  12 N Willson Ave   one active register, and three months of
 *                           history to compare a typed number against
 *   200  18 N Willson Ave   read off-route earlier in this window, so a
 *                           skip here is refused and has to be corrected
 *   300  24 N Willson Ave   a read in this window that is already billed
 *   400  30 N Willson Ave   an assignment closed the day before this
 *                           window opened, so the stop prints nothing on
 *                           any day of it
 *   500  36 N Willson Ave   two meters at one address: one locked gate
 *                           writes two skip rows (design §5.3)
 *   600  350 Fifth Avenue   EM-003's two registers print two lines, and
 *                           WM-003 is AMI on this route's own cycle and
 *                           prints none
 *   700  4059 Mt Lee Dr     WM-005 prints; EM-005 has no open assignment
 *                           and so does not, though its premise is a stop
 *   800  1060 W Addison St  an account on R02, not the route's cycle,
 *                           which prints anyway (design §5.1)
 *
 * The first five are this script's own premises. The last three are the
 * base seed's, reused rather than copied: a route is an itinerary over
 * premises that already exist, and inventing a parallel set of addresses
 * would make the demo data lie about what a route is.
 *
 * **The tenant's first-created premise is deliberately not a stop**, which
 * on a base-seeded database is 742 Evergreen Terrace — the obvious
 * candidate, with two register-less meters at one address and twelve
 * months of reads on one of them. `seed/tou-service.js:138` attaches
 * `TOU-REG-001` and `TOU-REG-002` to `orderBy: { createdAt: "asc" }`,
 * whichever premise that is, and both are `AMR` with four active registers
 * each. So the predicate yields **ten** rows at that one address, eight of
 * them TOU dials, and the rule is about creation order rather than about
 * the address: change the seed's premise order and the hazard moves with
 * it.
 *
 * Two things follow and both are bad here. The sheet becomes ten lines at
 * one stop out of nineteen, which buries every other row shape this
 * fixture exists to show. And typing numbers into those dials through
 * route entry would write new reads over the TOU reconciliation fixture,
 * whose whole point is that one meter's dials sum to its total and the
 * other's fall 15 kWh short. A fixture for one feature must not quietly
 * rewrite another's. The sheet itself would be right — a reader standing
 * at an address with two four-dial meters really must read eight dials —
 * so this is a rule about fixtures, not a limitation of routes.
 *
 * **It flips EM-003 from AMI to AMR, and that is the only existing row it
 * changes outside stop 400.** `EM-003` is the base seed's only
 * two-register meter, and the row shape most likely to surprise whoever
 * builds the sheet — §5.12 prints one line per active register, so a
 * two-register stop is not one line per address. But the seed made it AMI,
 * and an AMI meter is excluded from every sheet by design, so the fixture
 * could never appear on one. AMR is the honest fix rather than a
 * workaround: design §5.12 puts AMR on routes explicitly ("drive-by and
 * does belong on a route"), and an industrial electric meter with an
 * energy and a demand register read from the kerb is an ordinary thing. It
 * also makes the base seed match its own stated purpose: `seed.js:814`
 * calls EM-003 "the multi-register test fixture", and a fixture that can
 * never appear on a sheet is not one.
 *
 * `readable-rows.ts:77` is the only place in `packages/api/src` that
 * *filters* on `meterType`, so the flip changes what prints on a sheet and
 * no behaviour anywhere else. Three other readers display it and will now
 * say AMR for this meter: `notification.service.ts:167` (as the template
 * variable `meter.meterType`), `customer-graph.service.ts:319` (node
 * subtext) and `portal-api.ts:154`. Cycle-wide reading progress is
 * unmoved: it excludes meters that have *intervals*, never a type, and
 * EM-003 has none either way. Six AMI meters remain in the seed, WM-003
 * among them — which is the one stop 600 leans on.
 *
 * **Dates come from the window, not from a constant.** Every date-bound
 * fact here — the off-route read, the billed read, the closed assignment,
 * and the history that must stay *out* of the window — has to land on the
 * right side of the window `windowContaining` puts today in for the
 * route's cycle, or it states nothing. A literal would be right on the day
 * it was written and silently wrong a month later, which is how
 * `seed.js`'s flat 15th came to produce nine unbillable days a month.
 */
import type { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../src/lib/prisma.js";
import { runAsTenant } from "../src/lib/tenant-context.js";
import { windowContaining } from "../src/services/billing-run/window.js";
import {
  addStop,
  createReadRoute,
  listStops,
  upsertExternalRoute,
} from "../src/services/read-route.service.js";
import { readableRowsForPremises } from "../src/services/read-route/readable-rows.js";

const DEV_UTILITY_ID = "00000000-0000-4000-8000-000000000001";

/**
 * The seeded System Admin, who owns the audit rows this script writes.
 *
 * Not `script:seed-read-route-scenarios` in the audit `source` column,
 * which is that column's convention for a CLI run: `createReadRoute` and
 * `addStop` build their own `AuditContext` and expose no `source`. Writing
 * the rows by hand to get the label right would mean restating the gapped
 * sequencing and the one-route-per-premise guard, so the route is created
 * the way the screens create it and its audit rows read as this user's
 * work.
 */
const ACTOR = { id: "00000000-0000-4000-8000-000000000091", name: "Sarah Mitchell" };

/** The seeded Field Technician, standing in for whoever walked the route. */
const READER_ID = "00000000-0000-4000-8000-000000000094";

/** The cycle the route reads for: R01, which reads on the 8th and bills on the 10th. */
const ROUTE_CYCLE_CODE = "R01";
const ROUTE_CODE = "W-04";
const ROUTE_NAME = "North Willson";

/**
 * A route whose itinerary nobody here owns, so the list page has one of
 * each origin to show and the sheet's refusal has something to refuse.
 * Created through `upsertExternalRoute` — the importer's own function —
 * rather than by asking `createReadRoute` for `origin: "EXTERNAL"`, so the
 * row is made the only way a vendor's route is ever really made.
 *
 * It gets no stops (the vendor decides those) and no reads. An external
 * route in its first cycle has no prior reads to learn its membership from
 * and reports received-only, which is the honest state design §5.4
 * describes rather than a gap in this fixture.
 */
const VENDOR_ROUTE_CODE = "V-12";

/**
 * Deterministic ids, in a block nothing else uses, for the same reason the
 * base seed's accounts have them: a developer bookmarks a premise, and a
 * random id per run turns every open tab into a Prisma P2025. `e` for e2e;
 * the next digit is the kind, the last the stop.
 */
const id = {
  premise: (n: number) => `00000000-0000-4000-8000-00000000e10${n}`,
  account: (n: number) => `00000000-0000-4000-8000-00000000e20${n}`,
  agreement: (n: number) => `00000000-0000-4000-8000-00000000e30${n}`,
  servicePoint: (n: number) => `00000000-0000-4000-8000-00000000e40${n}`,
  meter: (n: number) => `00000000-0000-4000-8000-00000000e50${n}`,
  extraMeter: (n: number) => `00000000-0000-4000-8000-00000000e60${n}`,
};

/**
 * The window-bound fact a stop is here to demonstrate. The row *shapes* —
 * how many registers, how many meters, whether there is history — are
 * declared as fields instead, because they are properties of the fixture
 * rather than of today's date.
 */
type Fact = "NONE" | "READ_OFF_ROUTE" | "ALREADY_BILLED" | "AGREEMENT_ENDED";

interface ScenarioPremise {
  n: number;
  address: string;
  geoLat: number;
  geoLng: number;
  accountNumber: string;
  agreementNumber: string;
  meterNumber: string;
  /**
   * Active registers on the meter. Zero is the common case in real data
   * and prints one line with no register label; one is its own shape,
   * because the read then carries a `register_id` and the sheet has to
   * match a register-less read to it.
   */
  registers: 0 | 1;
  /**
   * A second meter at the same address, on the **same** service point — a
   * domestic meter and an irrigation sub-meter, which is why both are
   * water and both resolve to the one agreement. It is what makes a stop
   * two lines from two meters rather than from two registers, and what
   * makes one locked gate write two skip rows.
   */
  extraMeterNumber?: string;
  /**
   * Three monthly reads ending just before the window, from this opening
   * figure. Without them the sheet's last-reading column is blank on every
   * row and the entry screen's outlier band has nothing to be an opinion
   * about — which is goal 4 of the design and the main thing the screen
   * buys over paper.
   */
  historyFrom?: number;
  fact: Fact;
  /** The dial before this stop's in-window read, when it has one. */
  inWindowRead?: { priorReading: number; consumption: number };
  /** Printed in the run's summary, so the console says what each stop is for. */
  shows: string;
}

const SCENARIO: ScenarioPremise[] = [
  {
    n: 1,
    address: "12 N Willson Ave",
    geoLat: 45.6812,
    geoLng: -111.0409,
    accountNumber: "0001100-00",
    agreementNumber: "SA-1100",
    meterNumber: "WM-101",
    registers: 1,
    historyFrom: 118_400,
    fact: "NONE",
    shows: "one active register, three months of history: the row a reading is typed into",
  },
  {
    n: 2,
    address: "18 N Willson Ave",
    geoLat: 45.6815,
    geoLng: -111.041,
    accountNumber: "0001101-00",
    agreementNumber: "SA-1101",
    meterNumber: "WM-102",
    registers: 0,
    fact: "READ_OFF_ROUTE",
    inWindowRead: { priorReading: 184_200, consumption: 3_850 },
    shows: "already read off-route in this window: a skip here is refused (METER_ALREADY_READ)",
  },
  {
    n: 3,
    address: "24 N Willson Ave",
    geoLat: 45.6818,
    geoLng: -111.0411,
    accountNumber: "0001102-00",
    agreementNumber: "SA-1102",
    meterNumber: "WM-103",
    registers: 0,
    fact: "ALREADY_BILLED",
    inWindowRead: { priorReading: 97_600, consumption: 3_500 },
    shows: "its read in this window is billed: a number typed here is refused (READ_BILLED)",
  },
  {
    n: 4,
    address: "30 N Willson Ave",
    geoLat: 45.6821,
    geoLng: -111.0412,
    accountNumber: "0001103-00",
    agreementNumber: "SA-1103",
    meterNumber: "WM-104",
    registers: 0,
    fact: "AGREEMENT_ENDED",
    shows: "service closed before this window: the stop prints nothing on every day of it, and is reported",
  },
  {
    n: 5,
    address: "36 N Willson Ave",
    geoLat: 45.6824,
    geoLng: -111.0413,
    accountNumber: "0001104-00",
    agreementNumber: "SA-1104",
    meterNumber: "WM-105",
    extraMeterNumber: "WM-106",
    registers: 0,
    historyFrom: 64_900,
    fact: "NONE",
    shows: "two meters at one address: one locked gate writes two skip rows",
  },
];

/**
 * The base seed's premises this route also walks, in walking order, each
 * with what it is here to show. Matched on `address_line1`, which is not a
 * unique key in the schema but is one in that fixture; a missing one stops
 * the script rather than quietly shortening the route.
 */
const REUSED_PREMISES: { addressLine1: string; shows: string }[] = [
  {
    addressLine1: "350 Fifth Avenue",
    shows: "EM-003 prints a line per register; WM-003 is AMI, on this route's cycle, and prints none",
  },
  {
    addressLine1: "4059 Mt Lee Dr",
    shows: "WM-005 prints; EM-005 has no open assignment and so does not",
  },
  {
    addressLine1: "1060 W Addison St",
    shows: "its account bills on R02, not this route's cycle, and the stop prints anyway",
  },
];

/** The base seed's two-register meter, which has to be visitable to be visible. */
const TWO_REGISTER_METER = "EM-003";

const SERVICE_START = new Date("2025-01-01T00:00:00Z");
const INSTALL_DATE = new Date("2024-06-01T00:00:00Z");

/**
 * A month's water for a single-family house, three times over, so the
 * three history reads differ. All one figure would leave an outlier band
 * computed from them with no width, and a band with no width either holds
 * every number or none.
 */
const HISTORY_CONSUMPTION = [3_420, 3_860, 3_610];

const utcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

function fail(message: string): never {
  throw new Error(message);
}

function utilityIdFromArgv(): string {
  const i = process.argv.indexOf("--utility-id");
  if (i === -1) return DEV_UTILITY_ID;
  const value = process.argv[i + 1];
  if (!value) fail("--utility-id needs a uuid");
  return value;
}

/**
 * Which database is about to be written to, before anything is.
 *
 * A shell carrying another project's `DATABASE_URL` overrides
 * `--env-file`, and this script writes rows; a line naming the database it
 * is about to write to is the cheapest guard against finding that out
 * afterwards. The password is not printed.
 */
function announceDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL is not set — run with `npx tsx --env-file=.env`");
  const parsed = new URL(url);
  console.log(`Database: ${parsed.pathname.replace(/^\//, "")} on ${parsed.host}`);
}

interface Window {
  periodStart: Date;
  periodEnd: Date;
}

interface References {
  cycle: {
    id: string;
    cycleCode: string;
    billDayOfMonth: number;
    readDayOfMonth: number;
    frequency: string;
  };
  waterCommodityId: string;
  gallonsUomId: string;
  usageMeasureTypeId: string;
  serviceClassId: string;
  rateScheduleId: string;
}

/**
 * Everything the base seed must already have put there. Each miss names
 * what is absent and what would have created it, because the likeliest
 * reason to be here is a database that was never seeded, and
 * "findFirstOrThrow failed" does not say so.
 */
async function loadReferences(utilityId: string): Promise<References> {
  const utility = await prisma.utility.findFirst({
    where: { id: utilityId },
    select: { name: true },
  });
  if (!utility) {
    fail(`No utility ${utilityId}. Provision the tenant first (scripts/provision-tenant.ts).`);
  }

  const cycle = await prisma.billingCycle.findFirst({
    where: { utilityId, cycleCode: ROUTE_CYCLE_CODE },
    select: {
      id: true,
      cycleCode: true,
      billDayOfMonth: true,
      readDayOfMonth: true,
      frequency: true,
    },
  });
  if (!cycle) fail(`No billing cycle ${ROUTE_CYCLE_CODE} for this tenant. Run seed_db.bat first.`);

  const water = await prisma.commodity.findFirst({
    where: { utilityId, code: "WATER" },
    select: { id: true },
  });
  if (!water) fail("No WATER commodity for this tenant. Run seed_db.bat first.");

  // Two UOMs are coded GAL — water's and sewer's — so the commodity is
  // part of the lookup, not a tiebreak.
  const gal = await prisma.unitOfMeasure.findFirst({
    where: { utilityId, code: "GAL", commodityId: water.id },
    select: { id: true },
  });
  if (!gal) fail("No GAL unit for water. Run seed_db.bat first.");

  const usage = await prisma.measureTypeDef.findFirst({
    where: { code: "USAGE", utilityId: null },
    select: { id: true },
  });
  if (!usage) {
    fail("No global USAGE measure type — it is seeded by migration; is this database migrated?");
  }

  const serviceClass = await prisma.rateServiceClass.findFirst({
    where: { utilityId, commodityId: water.id, code: "single_family" },
    select: { id: true },
  });
  if (!serviceClass) fail("No single_family water service class. Run seed_db.bat first.");

  /*
   * The scenario's agreements get the same published water tariff as their
   * neighbours. Not decoration: without an assignment they would be five
   * more accounts that fail every billing run on this database, and a
   * fixture for one feature should not leave a mess in another's screens.
   */
  const schedule = await prisma.rateSchedule.findFirst({
    where: { utilityId, code: "BZN-WATER" },
    select: { id: true },
  });
  if (!schedule) fail("No BZN-WATER rate schedule. Run seed_db.bat first.");

  console.log(`Tenant: ${utility.name} (${utilityId})`);
  return {
    cycle,
    waterCommodityId: water.id,
    gallonsUomId: gal.id,
    usageMeasureTypeId: usage.id,
    serviceClassId: serviceClass.id,
    rateScheduleId: schedule.id,
  };
}

interface Counts {
  premises: number;
  accounts: number;
  agreements: number;
  meters: number;
  registers: number;
  reads: number;
  stops: number;
  routes: number;
  changed: string[];
}

interface ServiceGraph {
  premiseId: string;
  servicePointId: string;
  agreementId: string;
  /** The stop's meters in the order they were made: the primary, then the sub-meter if there is one. */
  meters: { id: string; meterNumber: string; registerId: string | null }[];
}

/** One meter at a stop, and its assignment to the stop's service point. */
async function ensureMeter(
  utilityId: string,
  refs: References,
  args: {
    meterId: string;
    meterNumber: string;
    premiseId: string;
    servicePointId: string;
  },
  counts: Counts,
): Promise<void> {
  const before = await prisma.meter.findFirst({ where: { id: args.meterId }, select: { id: true } });
  await prisma.meter.upsert({
    where: { id: args.meterId },
    update: {},
    create: {
      id: args.meterId,
      utilityId,
      premiseId: args.premiseId,
      meterNumber: args.meterNumber,
      commodityId: refs.waterCommodityId,
      uomId: refs.gallonsUomId,
      meterType: "MANUAL",
      status: "ACTIVE",
      installDate: INSTALL_DATE,
      // Bozeman's water service charge is priced by meter size and the
      // component throws rather than guess one, so a meter without this
      // does not bill.
      customFields: { size: '5/8"' },
    },
  });
  if (!before) counts.meters += 1;

  const assigned = await prisma.servicePointMeter.findFirst({
    where: { utilityId, servicePointId: args.servicePointId, meterId: args.meterId },
    select: { id: true },
  });
  if (!assigned) {
    await prisma.servicePointMeter.create({
      data: {
        utilityId,
        servicePointId: args.servicePointId,
        meterId: args.meterId,
        addedDate: SERVICE_START,
      },
    });
  }
}

/**
 * The service graph behind one scenario stop: premise, account, agreement,
 * service point, its meters, and the assignments that join them.
 *
 * `ServicePointMeter → ServicePoint` is the only path
 * `readableRowsForPremises` walks, so a meter here without an open
 * assignment is a meter that never prints — a fact stop 700 demonstrates
 * on purpose and every stop here must avoid.
 */
async function ensureServiceGraph(
  utilityId: string,
  refs: References,
  s: ScenarioPremise,
  counts: Counts,
): Promise<ServiceGraph> {
  const premiseId = id.premise(s.n);
  const premiseBefore = await prisma.premise.findFirst({
    where: { id: premiseId },
    select: { id: true },
  });
  await prisma.premise.upsert({
    where: { id: premiseId },
    // Left exactly as it is on a re-run: somebody may have edited this
    // premise while working, and a seeder is not a licence to undo that.
    update: {},
    create: {
      id: premiseId,
      utilityId,
      addressLine1: s.address,
      city: "Bozeman",
      state: "MT",
      zip: "59715",
      geoLat: s.geoLat,
      geoLng: s.geoLng,
      premiseType: "RESIDENTIAL",
      commodityIds: [refs.waterCommodityId],
      eruCount: 1,
      status: "ACTIVE",
    },
  });
  if (!premiseBefore) counts.premises += 1;

  const accountId = id.account(s.n);
  const accountBefore = await prisma.account.findFirst({
    where: { id: accountId },
    select: { id: true },
  });
  await prisma.account.upsert({
    where: { id: accountId },
    update: {},
    create: {
      id: accountId,
      utilityId,
      accountNumber: s.accountNumber,
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      creditRating: "GOOD",
      billingCycleId: refs.cycle.id,
      // Backdated for the reason the base seed backdates its accounts:
      // `computeBillPeriod` clamps a window's start to the account's
      // creation date, so an account created today has a window that
      // starts after it ends.
      createdAt: SERVICE_START,
    },
  });
  if (!accountBefore) counts.accounts += 1;

  const agreementId = id.agreement(s.n);
  const agreementBefore = await prisma.serviceAgreement.findFirst({
    where: { id: agreementId },
    select: { id: true },
  });
  await prisma.serviceAgreement.upsert({
    where: { id: agreementId },
    update: {},
    create: {
      id: agreementId,
      utilityId,
      agreementNumber: s.agreementNumber,
      accountId,
      commodityId: refs.waterCommodityId,
      rateServiceClassId: refs.serviceClassId,
      startDate: SERVICE_START,
      status: "ACTIVE",
    },
  });
  if (!agreementBefore) counts.agreements += 1;

  const assignment = await prisma.sAScheduleAssignment.findFirst({
    where: { utilityId, serviceAgreementId: agreementId, rateScheduleId: refs.rateScheduleId },
    select: { id: true },
  });
  if (!assignment) {
    await prisma.sAScheduleAssignment.create({
      data: {
        utilityId,
        serviceAgreementId: agreementId,
        rateScheduleId: refs.rateScheduleId,
        roleCode: "primary",
        effectiveDate: SERVICE_START,
      },
    });
  }

  const servicePointId = id.servicePoint(s.n);
  await prisma.servicePoint.upsert({
    where: { id: servicePointId },
    update: {},
    create: {
      id: servicePointId,
      utilityId,
      serviceAgreementId: agreementId,
      premiseId,
      type: "METERED",
      status: "ACTIVE",
      startDate: SERVICE_START,
    },
  });

  const meterId = id.meter(s.n);
  await ensureMeter(
    utilityId,
    refs,
    { meterId, meterNumber: s.meterNumber, premiseId, servicePointId },
    counts,
  );
  const registerId = s.registers === 1 ? await ensureOneRegister(utilityId, refs, meterId, counts) : null;
  const meters = [{ id: meterId, meterNumber: s.meterNumber, registerId }];

  if (s.extraMeterNumber) {
    const extraId = id.extraMeter(s.n);
    await ensureMeter(
      utilityId,
      refs,
      { meterId: extraId, meterNumber: s.extraMeterNumber, premiseId, servicePointId },
      counts,
    );
    meters.push({ id: extraId, meterNumber: s.extraMeterNumber, registerId: null });
  }

  return { premiseId, servicePointId, agreementId, meters };
}

/** Exactly one active register, which is its own row shape on a sheet. Returns its id. */
async function ensureOneRegister(
  utilityId: string,
  refs: References,
  meterId: string,
  counts: Counts,
): Promise<string> {
  const before = await prisma.meterRegister.findFirst({
    where: { meterId, registerNumber: 1 },
    select: { id: true },
  });
  const register = await prisma.meterRegister.upsert({
    where: { meterId_registerNumber: { meterId, registerNumber: 1 } },
    update: {},
    create: {
      utilityId,
      meterId,
      registerNumber: 1,
      description: "Consumption",
      uomId: refs.gallonsUomId,
      measureTypeId: refs.usageMeasureTypeId,
      multiplier: 1,
      isActive: true,
    },
    select: { id: true },
  });
  if (!before) counts.registers += 1;
  return register.id;
}

/**
 * A read inside the window, if the meter has none there already.
 *
 * Keyed on the window rather than on a date, which is what makes a re-run
 * on a later day a no-op instead of a second read: what every consumer
 * asks is "does this meter have a read in the window", so that is what is
 * checked. `billed` is applied to an existing unbilled read too, since the
 * scenario's claim is about the period being frozen, not about which run
 * froze it.
 */
async function ensureReadInWindow(
  utilityId: string,
  s: ScenarioPremise,
  graph: ServiceGraph,
  refs: References,
  window: Window,
  readOn: Date,
  billed: boolean,
  counts: Counts,
): Promise<void> {
  const meter = graph.meters[0]!;
  const figures = s.inWindowRead ?? fail(`${s.meterNumber} needs inWindowRead for fact ${s.fact}`);
  const existing = await prisma.meterRead.findFirst({
    where: {
      utilityId,
      meterId: meter.id,
      readDate: { gte: window.periodStart, lte: window.periodEnd },
    },
    select: { id: true, readDatetime: true, billedAt: true },
  });
  if (existing) {
    if (billed && !existing.billedAt) {
      // `updateMany` with the id, as every other writer of this table
      // does: `meter_read` is a hypertable whose primary key is
      // `(id, read_datetime)`, and a bare `update` cannot name it.
      await prisma.meterRead.updateMany({
        where: { id: existing.id, utilityId, readDatetime: existing.readDatetime },
        data: { billedAt: new Date() },
      });
      counts.changed.push(`${s.meterNumber}: stamped its read in this window as billed`);
    }
    return;
  }

  await prisma.meterRead.create({
    data: {
      utilityId,
      meterId: meter.id,
      serviceAgreementId: graph.agreementId,
      registerId: meter.registerId,
      uomId: refs.gallonsUomId,
      readDate: readOn,
      readDatetime: new Date(readOn.getTime() + 10 * 3_600_000),
      reading: figures.priorReading + figures.consumption,
      priorReading: figures.priorReading,
      consumption: figures.consumption,
      readType: "ACTUAL",
      readSource: "MANUAL",
      readerId: READER_ID,
      // Null on purpose: this is the read that arrived from somewhere other
      // than a route sheet, which is what gives the skip refusal something
      // to refuse.
      routeId: null,
      /*
       * Stamped billed with no `Bill` row behind it. `billed_at` is what
       * freezes a read, and nothing in the read-route path joins a read to
       * its bill, so this reaches the frozen-read refusal without running
       * a billing run over the fixture — which would also post a
       * receivable and pull the ledger into a reading fixture.
       */
      billedAt: billed ? new Date() : null,
    },
  });
  counts.reads += 1;
}

/**
 * Three monthly reads ending just **before** the window.
 *
 * Before it, not in it, and that is the whole subtlety: a read inside the
 * window would make the stop "already read", refuse a skip on it and
 * change the progress count — turning a stop that exists to be typed into
 * a second copy of stop 200. The newest lands three days before the window
 * opens, so the arithmetic cannot drift into it whatever day this runs.
 */
async function ensureHistory(
  utilityId: string,
  s: ScenarioPremise,
  graph: ServiceGraph,
  refs: References,
  window: Window,
  counts: Counts,
): Promise<void> {
  if (s.historyFrom === undefined) return;
  const meter = graph.meters[0]!;
  const newest = addDays(window.periodStart, -3);
  let reading = s.historyFrom;

  for (const [i, consumption] of HISTORY_CONSUMPTION.entries()) {
    const readOn = addDays(newest, -30 * (HISTORY_CONSUMPTION.length - 1 - i));
    const prior = reading;
    reading += consumption;
    const already = await prisma.meterRead.findFirst({
      where: { utilityId, meterId: meter.id, readDate: readOn },
      select: { id: true },
    });
    if (already) continue;
    await prisma.meterRead.create({
      data: {
        utilityId,
        meterId: meter.id,
        serviceAgreementId: graph.agreementId,
        registerId: meter.registerId,
        uomId: refs.gallonsUomId,
        readDate: readOn,
        readDatetime: new Date(readOn.getTime() + 10 * 3_600_000),
        reading,
        priorReading: prior,
        consumption,
        readType: "ACTUAL",
        readSource: "MANUAL",
        readerId: READER_ID,
        routeId: null,
      },
    });
    counts.reads += 1;
  }
}

/**
 * Close the meter's assignment, and the service behind it, **the day
 * before the window opens**.
 *
 * It used to close it inside the window, which is what "ended mid-cycle"
 * literally asks for, and that made the fixture mean different things on
 * different days. `readableRowsForPremises` treats removal as **inclusive**
 * (`removedDate >= onDate` is open), so a stop closed on the 16th still
 * produces a row on every day up to and including the 16th and only
 * vanishes from the 17th. The ui stream measured it: ten rows on the 11th
 * and the 16th, nine on the 17th. A fixture whose row count depends on
 * which day it is read for cannot carry an assertion about either.
 *
 * Closing it the day before the window opens makes "this stop produces no
 * row" true on **every** day of the window, which is the behaviour the stop
 * exists to show — a stop on the route that the sheet cannot print and must
 * report rather than drop (design §5.1). Nothing about the read-route path
 * distinguishes a service that ended just before the window from one that
 * ended inside it; both are simply a stop with nothing to read.
 *
 * **Converges rather than leaving an existing value alone.** Any stored
 * date at or after the window's start would put a row back on the sheet, so
 * it is moved; an earlier one is left exactly where it is.
 */
async function ensureAssignmentEnded(
  utilityId: string,
  s: ScenarioPremise,
  graph: ServiceGraph,
  window: Window,
  endedOn: Date,
  counts: Counts,
): Promise<void> {
  const meter = graph.meters[0]!;
  const spm = await prisma.servicePointMeter.findFirst({
    where: { utilityId, servicePointId: graph.servicePointId, meterId: meter.id },
    select: { id: true, removedDate: true },
  });
  if (!spm) fail(`${s.meterNumber} has no assignment to end — ensureServiceGraph should have made one`);

  const closedBeforeTheWindow = spm.removedDate !== null && spm.removedDate < window.periodStart;
  if (closedBeforeTheWindow) return;

  await prisma.servicePointMeter.update({ where: { id: spm.id }, data: { removedDate: endedOn } });
  await prisma.servicePoint.update({
    where: { id: graph.servicePointId },
    data: { status: "CLOSED", endDate: endedOn },
  });
  await prisma.serviceAgreement.update({
    where: { id: graph.agreementId },
    data: { status: "CLOSED", endDate: endedOn },
  });
  /*
   * The account stays ACTIVE. Its final bill has not run, which is the
   * state a utility is actually in while a route sheet still carries the
   * address, and closing it here would pull three other screens into a
   * fixture about reading.
   */
  counts.changed.push(
    `${s.agreementNumber} closed and ${s.meterNumber}'s assignment removed on ${isoDay(endedOn)}`,
  );
}

/** See the header: AMI is excluded from every sheet, so the fixture could never appear on one. */
async function makeTwoRegisterMeterVisitable(utilityId: string, counts: Counts): Promise<void> {
  const meter = await prisma.meter.findFirst({
    where: { utilityId, meterNumber: TWO_REGISTER_METER },
    select: {
      id: true,
      meterType: true,
      registers: { where: { isActive: true }, select: { id: true } },
    },
  });
  if (!meter) {
    console.log(
      `  ! ${TWO_REGISTER_METER} is not in this database; the two-register stop will print nothing`,
    );
    return;
  }
  if (meter.registers.length < 2) {
    console.log(`  ! ${TWO_REGISTER_METER} has ${meter.registers.length} active register(s), not 2`);
  }
  if (meter.meterType === "AMI") {
    await prisma.meter.update({ where: { id: meter.id }, data: { meterType: "AMR" } });
    counts.changed.push(`${TWO_REGISTER_METER} meter_type AMI -> AMR, so its two registers can print`);
  }
}

/**
 * The route, and its stops in order.
 *
 * Through `createReadRoute` and `addStop` rather than by inserting rows:
 * those own the gapped sequencing and the one-route-per-premise rule, and a
 * fixture that writes its own stops is a fixture that can produce a route
 * the screens could not have produced.
 */
async function ensureRoute(
  utilityId: string,
  refs: References,
  premiseIdsInOrder: string[],
  counts: Counts,
): Promise<string> {
  let route = await prisma.readRoute.findFirst({
    where: { utilityId, code: ROUTE_CODE },
    select: { id: true, origin: true },
  });
  if (!route) {
    const created = await createReadRoute(utilityId, ACTOR, {
      code: ROUTE_CODE,
      name: ROUTE_NAME,
      billingCycleId: refs.cycle.id,
      origin: "LOCAL",
      active: true,
    });
    route = { id: created.id, origin: created.origin };
    counts.routes += 1;
  }
  if (route.origin !== "LOCAL") {
    fail(
      `Route ${ROUTE_CODE} exists with origin ${route.origin}, so it cannot carry stops. Rename or remove it.`,
    );
  }

  const already = new Set((await listStops(utilityId, route.id)).map((s) => s.premiseId));
  for (const premiseId of premiseIdsInOrder) {
    if (already.has(premiseId)) continue;
    try {
      // No `afterSequence`: appended in the order given, which is the order
      // of this file.
      await addStop(utilityId, ACTOR, route.id, { premiseId });
      counts.stops += 1;
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "PREMISE_ALREADY_ON_ROUTE") {
        // A premise is a stop on at most one route, so one already placed
        // elsewhere is a decision somebody made: reported, not overruled.
        console.log(`  ! premise ${premiseId} is already a stop on another route — left there`);
        continue;
      }
      throw err;
    }
  }

  return route.id;
}

async function main(): Promise<void> {
  const utilityId = utilityIdFromArgv();
  announceDatabase();

  const counts: Counts = {
    premises: 0,
    accounts: 0,
    agreements: 0,
    meters: 0,
    registers: 0,
    reads: 0,
    stops: 0,
    routes: 0,
    changed: [],
  };

  const summary = await runAsTenant(utilityId, async () => {
    const refs = await loadReferences(utilityId);

    /*
     * The window today falls in for the route's cycle — the same call
     * `recordSkips`, the sheet header and per-route progress all make, so a
     * fact placed inside it is a fact every one of them agrees about.
     */
    const today = utcDay(new Date());
    const window = windowContaining(refs.cycle, today);
    /*
     * Yesterday, or the window's first day when this runs on it. On that
     * one day a month "earlier in this window" and "before today" cannot
     * both hold, and being inside the window is the half the already-read
     * and frozen-read refusals actually test.
     */
    const readOn = addDays(today, -1) >= window.periodStart ? addDays(today, -1) : window.periodStart;

    console.log(
      `Window containing today for ${refs.cycle.cycleCode}: ` +
        `${isoDay(window.periodStart)} .. ${isoDay(window.periodEnd)}`,
    );

    await makeTwoRegisterMeterVisitable(utilityId, counts);

    const scenarioPremiseIds: string[] = [];
    for (const s of SCENARIO) {
      const graph = await ensureServiceGraph(utilityId, refs, s, counts);
      scenarioPremiseIds.push(graph.premiseId);
      await ensureHistory(utilityId, s, graph, refs, window, counts);
      switch (s.fact) {
        case "READ_OFF_ROUTE":
          await ensureReadInWindow(utilityId, s, graph, refs, window, readOn, false, counts);
          break;
        case "ALREADY_BILLED":
          await ensureReadInWindow(utilityId, s, graph, refs, window, readOn, true, counts);
          break;
        case "AGREEMENT_ENDED":
          // The day before the window opens, not `readOn`: see the function.
          await ensureAssignmentEnded(
            utilityId,
            s,
            graph,
            window,
            addDays(window.periodStart, -1),
            counts,
          );
          break;
        case "NONE":
          break;
      }
    }

    const reusedPremiseIds: string[] = [];
    for (const r of REUSED_PREMISES) {
      const premise = await prisma.premise.findFirst({
        where: { utilityId, addressLine1: r.addressLine1 },
        select: { id: true },
      });
      if (!premise) {
        fail(
          `No premise "${r.addressLine1}" in this tenant. This route reuses the base seed's premises; run seed_db.bat.`,
        );
      }
      reusedPremiseIds.push(premise.id);
    }

    const routeId = await ensureRoute(
      utilityId,
      refs,
      [...scenarioPremiseIds, ...reusedPremiseIds],
      counts,
    );

    const vendorRouteId = await prisma.$transaction((tx: Prisma.TransactionClient) =>
      upsertExternalRoute(tx, utilityId, VENDOR_ROUTE_CODE, refs.cycle.id),
    );

    /*
     * What the stops actually produce, through the predicate the sheet, the
     * entry screen and per-route progress share. Printed rather than
     * asserted: this is a seeder, and the counts are what somebody needs
     * before they go looking at a screen. A stop printing nothing is
     * marked, because exactly one of them is supposed to.
     */
    const stops = await listStops(utilityId, routeId);
    const rows = await readableRowsForPremises(
      utilityId,
      stops.map((s) => s.premiseId),
      today,
    );
    const addresses = new Map(
      (
        await prisma.premise.findMany({
          where: { utilityId, id: { in: stops.map((s) => s.premiseId) } },
          select: { id: true, addressLine1: true },
        })
      ).map((p) => [p.id, p.addressLine1]),
    );
    const shows = new Map<string, string>();
    for (const s of SCENARIO) shows.set(id.premise(s.n), s.shows);
    for (let i = 0; i < REUSED_PREMISES.length; i += 1) {
      shows.set(reusedPremiseIds[i]!, REUSED_PREMISES[i]!.shows);
    }

    const lines: string[] = [];
    for (const stop of stops) {
      const mine = rows.filter((r) => r.premiseId === stop.premiseId);
      const what = mine.length
        ? mine
            .map((r) => `${r.meterNumber}${r.registerNumber ? `/r${r.registerNumber}` : ""}`)
            .join(", ")
        : "nothing to read";
      lines.push(
        `  ${String(stop.sequence).padStart(4)}  ` +
          `${(addresses.get(stop.premiseId) ?? "?").padEnd(22)}  ` +
          `${String(mine.length).padStart(2)} row(s)  ${what}`,
      );
      lines.push(`        ${shows.get(stop.premiseId) ?? ""}`);
    }

    return {
      routeId,
      vendorRouteId,
      stopCount: stops.length,
      rowCount: rows.length,
      lines,
      readDate: isoDay(today),
    };
  });

  console.log("");
  console.log(`Route ${ROUTE_CODE} "${ROUTE_NAME}" (${summary.routeId})`);
  console.log(`  ${summary.stopCount} stops, ${summary.rowCount} sheet rows for ${summary.readDate}`);
  console.log(`Vendor route ${VENDOR_ROUTE_CODE} (${summary.vendorRouteId}) — EXTERNAL, no stops`);
  console.log("");
  console.log(summary.lines.join("\n"));
  console.log("");
  console.log(
    `Created: ${counts.routes} route(s), ${counts.stops} stop(s), ${counts.premises} premise(s), ` +
      `${counts.accounts} account(s), ${counts.agreements} agreement(s), ${counts.meters} meter(s), ` +
      `${counts.registers} register(s), ${counts.reads} read(s)`,
  );
  if (counts.changed.length) {
    console.log("Changed existing rows:");
    for (const c of counts.changed) console.log(`  - ${c}`);
  } else {
    console.log("Changed existing rows: none");
  }
  await prisma.$disconnect();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("FAILED:", err);
    process.exit(1);
  },
);
