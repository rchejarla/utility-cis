import { renderToBuffer } from "@react-pdf/renderer";
import { prisma } from "../../lib/prisma.js";
import { billDayIn } from "../bill.service.js";
import { windowContaining } from "../billing-run/window.js";
import { listStops } from "../read-route.service.js";
import { readableRowsForPremises } from "./readable-rows.js";
import { RouteSheetTemplate } from "./route-sheet-template.js";

/**
 * The paper a meter reader carries: a route's stops in walking order, the
 * last reading beside each meter, and a legend of the codes for a stop
 * that produced no number (read routes design §5.6).
 *
 * **The sheet is not persisted.** It is scrap paper, reprintable from the
 * stops at any time; the reads that come back are the record. A bill is
 * stored because it is a financial document; this is not one, so there is
 * no storage key and no attachment row.
 *
 * The layout is `route-sheet-template.tsx`. It is invoked as a plain
 * function, as `generateBillPdf` invokes its template, because
 * `renderToBuffer` types its argument as the `Document` element itself.
 * The react-pdf import is the same one `generate-bill-pdf.ts` makes, and
 * is the reason `patches/@react-pdf__hyphenate` exists; the account of
 * what breaks at startup without it is there. This adds no second path to
 * the stack.
 */

export interface SheetStop {
  sequence: number;
  address: string;
  accountNumber: string;
  meterNumber: string;
  /** A label, not a count. Null for a meter with no active register. */
  registerNumber: string | null;
  lastReading: string | null;
  /** YYYY-MM-DD. */
  lastReadDate: string | null;
}

export interface RouteSheet {
  routeCode: string;
  routeName: string;
  cycleCode: string;
  /**
   * YYYY-MM-DD: the cycle's read day, in the month of the window the sheet's
   * date is in. Null for a cycle whose frequency has no window yet: the
   * header is the only part that needs one, so the stops still print.
   */
  readsDueOn: string | null;
  /** YYYY-MM-DD: the day the sheet was built for. */
  forDate: string;
  stops: SheetStop[];
  /**
   * Stops on the route that produced no line, because their premise has no
   * readable meter. Kept off the paper (a reader sent to an address with
   * nothing to read is worse) but returned, because a stop that vanishes
   * from a sheet without a trace is the silent failure §5.1 forbids. Whoever
   * serves the sheet is expected to surface it.
   */
  stopsWithNothingToRead: { sequence: number; address: string }[];
}

function httpError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The cycle's read day as a date. There is no read *window* in this
 * system, only a day the reads are due by, so the sheet says "due 15 Jan".
 *
 * The month is the one the containing window ends in: a read day precedes
 * the bill day (BR-BC-001), so it falls in the month of the period's end.
 * `billDayIn` clamps a day the month lacks, as the bill day does: a read
 * day of 31 is the 28th in February.
 */
function readsDueOn(
  cycle: { billDayOfMonth: number; readDayOfMonth: number; frequency: string },
  onDate: Date,
): string | null {
  let periodEnd: Date;
  try {
    ({ periodEnd } = windowContaining(cycle, onDate));
  } catch (err) {
    // `computeBillPeriod` windows MONTHLY only. That is a fact about bills,
    // and no reason to refuse a sheet whose stops do not depend on it.
    if ((err as { code?: string }).code === "UNSUPPORTED_FREQUENCY") return null;
    throw err;
  }
  const y = periodEnd.getUTCFullYear();
  const m = periodEnd.getUTCMonth();
  return isoDay(new Date(Date.UTC(y, m, billDayIn(y, m, cycle.readDayOfMonth))));
}

interface LastRead {
  reading: string;
  readDate: Date;
}

/**
 * The most recent reading for each (meter, register) before `onDate`.
 * "Before" so a sheet reprinted after some stops were read still shows
 * what the reader is comparing against, not what they just wrote down.
 * One round trip: `DISTINCT ON` treats a null register as a value, which
 * is what separates a register-less meter's reads from its registers'.
 */
async function lastReadings(
  utilityId: string,
  meterIds: string[],
  onDate: Date,
): Promise<Map<string, LastRead>> {
  const out = new Map<string, LastRead>();
  if (meterIds.length === 0) return out;
  const rows = await prisma.$queryRaw<
    { meter_id: string; register_id: string | null; reading: unknown; read_date: Date }[]
  >`
    SELECT DISTINCT ON (meter_id, register_id) meter_id, register_id, reading, read_date
    FROM meter_read
    WHERE utility_id = ${utilityId}::uuid
      AND meter_id = ANY(${meterIds}::uuid[])
      AND reading IS NOT NULL
      -- As 'YYYY-MM-DD' text, not a JS Date: a Date binds as timestamptz,
      -- and its ::date depends on the session's time zone.
      AND read_date < ${isoDay(onDate)}::date
    ORDER BY meter_id, register_id, read_date DESC, read_datetime DESC`;
  for (const r of rows) {
    out.set(`${r.meter_id}|${r.register_id ?? ""}`, { reading: String(r.reading), readDate: r.read_date });
  }
  return out;
}

export async function buildRouteSheet(
  utilityId: string,
  routeId: string,
  onDateInput: Date,
): Promise<RouteSheet> {
  const onDate = new Date(
    Date.UTC(onDateInput.getUTCFullYear(), onDateInput.getUTCMonth(), onDateInput.getUTCDate()),
  );

  const route = await prisma.readRoute.findFirst({
    where: { id: routeId, utilityId },
    select: {
      code: true,
      name: true,
      origin: true,
      billingCycle: {
        select: { cycleCode: true, readDayOfMonth: true, billDayOfMonth: true, frequency: true },
      },
    },
  });
  if (!route) throw httpError(404, "ROUTE_NOT_FOUND", `Read route ${routeId} not found`);
  // `listStops` answers [] here, which is right for a screen; a sheet for a
  // route whose itinerary a vendor owns would print as an empty page.
  if (route.origin !== "LOCAL") {
    throw httpError(
      400,
      "ROUTE_IS_EXTERNAL",
      `Route ${routeId} belongs to a vendor's reading system; there is no sheet to print`,
    );
  }

  const stops = await listStops(utilityId, routeId);
  const premiseIds = stops.map((s) => s.premiseId);

  /*
   * Every stop prints, whatever cycle its account is on (§5.1). The route
   * names the walk; a stop filtered off it is a meter nobody visits, and
   * the one outcome here that nothing reports.
   */
  const [rows, premises] = await Promise.all([
    readableRowsForPremises(utilityId, premiseIds, onDate),
    prisma.premise.findMany({
      where: { utilityId, id: { in: premiseIds } },
      select: { id: true, addressLine1: true, city: true },
    }),
  ]);
  const address = new Map(premises.map((p) => [p.id, `${p.addressLine1}, ${p.city}`]));
  const reads = await lastReadings(utilityId, [...new Set(rows.map((r) => r.meterId))], onDate);

  const rowsByPremise = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = rowsByPremise.get(r.premiseId) ?? [];
    list.push(r);
    rowsByPremise.set(r.premiseId, list);
  }
  // Meters with exactly one register row: a read of theirs may name no
  // register (`createMeterRead` allows it), so those reads belong to it.
  const registerCount = new Map<string, number>();
  for (const r of rows) {
    if (r.registerId) registerCount.set(r.meterId, (registerCount.get(r.meterId) ?? 0) + 1);
  }

  const stopsWithNothingToRead = stops
    .filter((s) => !rowsByPremise.has(s.premiseId))
    .map((s) => ({ sequence: s.sequence, address: address.get(s.premiseId) ?? "" }));

  const sheetStops: SheetStop[] = [];
  // Walking order is the stops', not the rows': the rows are sorted by premise id.
  for (const stop of stops) {
    for (const row of rowsByPremise.get(stop.premiseId) ?? []) {
      let last = reads.get(`${row.meterId}|${row.registerId ?? ""}`);
      if (row.registerId && registerCount.get(row.meterId) === 1) {
        const unnamed = reads.get(`${row.meterId}|`);
        if (unnamed && (!last || unnamed.readDate > last.readDate)) last = unnamed;
      }
      sheetStops.push({
        sequence: stop.sequence,
        address: address.get(stop.premiseId) ?? "",
        accountNumber: row.accountNumber,
        meterNumber: row.meterNumber,
        registerNumber: row.registerNumber,
        lastReading: last?.reading ?? null,
        lastReadDate: last ? isoDay(last.readDate) : null,
      });
    }
  }

  return {
    routeCode: route.code,
    routeName: route.name,
    cycleCode: route.billingCycle.cycleCode,
    readsDueOn: readsDueOn(route.billingCycle, onDate),
    forDate: isoDay(onDate),
    stops: sheetStops,
    stopsWithNothingToRead,
  };
}

export async function renderRouteSheetPdf(sheet: RouteSheet): Promise<Buffer> {
  return renderToBuffer(RouteSheetTemplate({ sheet }));
}
