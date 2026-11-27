import { z } from "zod";
import { baseListQuerySchema, paginationMetaSchema, queryBoolean } from "../lib/base-list-query";

/**
 * A read route: the ordered walk a meter reader makes (spec 08, read
 * routes design §5.1).
 *
 * `origin` says who owns the route's contents. A LOCAL route is built
 * here, stop by stop. An EXTERNAL one was named by a vendor's reading
 * system and arrived as a code on an imported read — it exists as a row
 * so reads can point at it, and starts with no stops because the vendor,
 * not this system, decides what is on it.
 */
export const READ_ROUTE_ORIGINS = ["LOCAL", "EXTERNAL"] as const;
export type ReadRouteOrigin = (typeof READ_ROUTE_ORIGINS)[number];

export const readRouteInputSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(255),
  billingCycleId: z.string().uuid(),
  origin: z.enum(READ_ROUTE_ORIGINS).default("LOCAL"),
  active: z.boolean().default(true),
});
/** The parsed shape: defaults live in the schema alone, so callers parse before calling the service. */
export type ReadRouteInput = z.infer<typeof readRouteInputSchema>;

/**
 * What an update may change. `origin` is not here on purpose: it is
 * decided at creation (LOCAL by hand, EXTERNAL by the importer) and
 * changing it reassigns who owns the itinerary. Claiming a vendor route
 * as local is a deliberate operation with its own endpoint and audit
 * event, not a PATCH field.
 */
export const readRouteUpdateSchema = readRouteInputSchema.omit({ origin: true }).partial();
export type ReadRouteUpdate = z.infer<typeof readRouteUpdateSchema>;

export const readRouteSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  billingCycleId: z.string().uuid(),
  origin: z.enum(READ_ROUTE_ORIGINS),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ReadRoute = z.infer<typeof readRouteSchema>;

export const readRouteSummarySchema = readRouteSchema.extend({
  stopCount: z.number().int().nonnegative(),
  cycleCode: z.string(),
});
export type ReadRouteSummary = z.infer<typeof readRouteSummarySchema>;

/** Ordered by code, always: `sort` and `order` are omitted so the contract says what it does. */
export const readRouteQuerySchema = baseListQuerySchema.omit({ sort: true, order: true }).extend({
  billingCycleId: z.string().uuid().optional(),
  origin: z.enum(READ_ROUTE_ORIGINS).optional(),
  active: queryBoolean.optional(),
});
export type ReadRouteQuery = z.infer<typeof readRouteQuerySchema>;

export const readRouteListResponseSchema = z.object({
  data: z.array(readRouteSummarySchema),
  meta: paginationMetaSchema,
});
export type ReadRouteListResponse = z.infer<typeof readRouteListResponseSchema>;

/**
 * Where a stop goes. Omitted `afterSequence` appends; `0` inserts at the
 * front; otherwise the stop lands between the one at that sequence and
 * whatever follows it. The caller names a position by the number it can
 * see on screen, not by an id, because the sequence is what it sorts by.
 */
export const readRouteStopInputSchema = z.object({
  premiseId: z.string().uuid(),
  afterSequence: z.number().int().nonnegative().optional(),
});
export type ReadRouteStopInput = z.infer<typeof readRouteStopInputSchema>;

/** A stop is a premise on a route; sequences are gapped integers (step 100), so only their order means anything. */
export const readRouteStopSchema = z.object({
  id: z.string().uuid(),
  readRouteId: z.string().uuid(),
  premiseId: z.string().uuid(),
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
});
export type ReadRouteStop = z.infer<typeof readRouteStopSchema>;

/** The tray's filter: ordered by address, always, so `sort` and `order` are omitted. */
export const unsequencedPremiseQuerySchema = baseListQuerySchema.omit({ sort: true, order: true });
export type UnsequencedPremiseQuery = z.infer<typeof unsequencedPremiseQuerySchema>;

/** Enough of a premise to recognise it in the tray; not the whole row. */
export const premiseSummarySchema = z.object({
  id: z.string().uuid(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  // Deliberately a string, not `premiseTypeEnum`: the column is tenant-extensible
  // through `premise_type_def`, so a closed enum would reject a valid global type
  // (MULTI_FAMILY). This differs from premise.ts on purpose; that enum is narrower
  // than its own data.
  premiseType: z.string(),
});
export type PremiseSummary = z.infer<typeof premiseSummarySchema>;

export const unsequencedPremiseListResponseSchema = z.object({
  data: z.array(premiseSummarySchema),
  meta: paginationMetaSchema,
});
export type UnsequencedPremiseListResponse = z.infer<typeof unsequencedPremiseListResponseSchema>;

/**
 * Why a stop produced no number. The list is the CHECK on
 * `read_skip.skip_reason` in the `read_routes` migration, in its order;
 * the database is the arbiter and this is the same list for the callers
 * that would otherwise find out from a constraint error.
 */
/**
 * A stop as the route page shows it: the stop, the address a reader
 * walks to, and the cycles the accounts served there bill on.
 *
 * `accountCycles` is a list of facts, not an "off cycle" flag.
 * `Account.billing_cycle_id` is required and nothing makes it agree with
 * the route's (§5.1), so a stop billing elsewhere is real and still
 * prints — it is a data-quality item, not a validation error. Which
 * means the comparison belongs to the one screen that draws that list,
 * beside the route's own cycle it is comparing against; a boolean here
 * would hide the rule in the API and tell the page nothing it could
 * explain to an operator. Empty when nothing is served at the premise.
 */
export const readRouteStopDetailSchema = readRouteStopSchema.extend({
  premise: premiseSummarySchema,
  accountCycles: z.array(
    z.object({ billingCycleId: z.string().uuid(), cycleCode: z.string() }),
  ),
});
export type ReadRouteStopDetail = z.infer<typeof readRouteStopDetailSchema>;

/**
 * `{ data }` with no `meta`, unlike every list endpoint beside it: a
 * route's stops are a walk somebody does in a morning, so there is no
 * page to be on, and a `meta` block would describe a pagination the
 * endpoint does not do. Same shape as `GET /api/v1/meters/:id/reads`.
 */
export const readRouteStopDetailListSchema = z.object({
  data: z.array(readRouteStopDetailSchema),
});
export type ReadRouteStopDetailList = z.infer<typeof readRouteStopDetailListSchema>;

export const SKIP_REASONS = [
  "LOCKED_GATE",
  "DOG",
  "BURIED",
  "UNREADABLE",
  "OBSTRUCTED",
  "APPEARS_VACANT",
  "NO_METER_FOUND",
] as const;
export const skipReasonSchema = z.enum(SKIP_REASONS);
export type SkipReason = z.infer<typeof skipReasonSchema>;

/**
 * What each code means in words, for the sheet's legend and the entry
 * screen's picker. One list, so the paper a reader carries and the
 * screen somebody types it into cannot drift (plan, Task 8 step 3).
 */
export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  LOCKED_GATE: "Locked gate",
  DOG: "Dog",
  BURIED: "Buried",
  UNREADABLE: "Unreadable",
  OBSTRUCTED: "Obstructed",
  APPEARS_VACANT: "Appears vacant",
  NO_METER_FOUND: "No meter found",
};

/*
 * ─── Entry ─────────────────────────────────────────────────────────────
 *
 * The screen is the sheet, so these describe one line of paper: what the
 * reader is comparing against, what they typed, and what became of it
 * when the route was posted.
 */

/** Opening or reopening entry. One screen per `(route, read date)` (§5.7). */
export const entryOpenSchema = z.object({ readDate: z.string().date() }).strict();
export type EntryOpenInput = z.infer<typeof entryOpenSchema>;

/**
 * Staging one row: a reading, **or** a code for why there is none, or
 * neither — which clears it. Both together is refused by the service
 * (400 `ENTRY_ROW_AMBIGUOUS`) rather than here, because a row carrying
 * both is a mistake worth naming, not a malformed request.
 *
 * `registerId` is explicitly nullable rather than optional: null is
 * which row this is — the meter itself, not one of its registers — and
 * an omitted key would make "the meter's own row" indistinguishable
 * from "I forgot to say".
 */
export const entryRowSaveSchema = z
  .object({
    meterId: z.string().uuid(),
    registerId: z.string().uuid().nullable(),
    reading: z.number().nonnegative().optional(),
    skipReason: skipReasonSchema.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type EntryRowSave = z.infer<typeof entryRowSaveSchema>;

/**
 * The range a meter's next reading is expected to land in, judged from
 * its own recent consumption.
 *
 * **Provisional, and deliberately so** (§5.7). `ExceptionThreshold`
 * (Req 93) is unbuilt and there is no high-usage detection anywhere in
 * the API, so without this a 3× read posts in silence while only a
 * reversed dial stops a row. When Req 93 lands the band comes from
 * there and the rule behind this is deleted — it lives in one file,
 * `services/read-route/reading-band.ts`, so that deletion is one file.
 *
 * Decimal strings, like every other quantity on the wire.
 */
export const entryBandSchema = z.object({
  low: z.string(),
  high: z.string(),
  /**
   * The consumption the bounds are scaled from: the median of the
   * meter's recent ones.
   *
   * The screen has to be able to name this. A hold explained only by the
   * observed range is a hold the range does not account for — 300 on a
   * meter that has seen 28 one month and 500 another is held, and "it has
   * used between 28 and 500" reads as the argument for letting it
   * through.
   */
  typical: z.string(),
  /** The range actually observed, either side of `typical`. */
  typicalLow: z.string(),
  typicalHigh: z.string(),
});
export type EntryBand = z.infer<typeof entryBandSchema>;

/**
 * One line of the sheet on screen.
 *
 * The API service derives its own `EntryRow` from this schema rather
 * than declaring the shape twice — the two would eventually disagree,
 * and the place that shows is a column of blanks nobody can explain.
 */
export const entryRowSchema = z.object({
  rowId: z.string().uuid(),
  /** 1-based, in the route's walking order. */
  rowIndex: z.number().int().positive(),
  sequence: z.number().int(),
  premiseId: z.string().uuid(),
  /** `addressLine1, city` — what the reader is standing in front of. */
  address: z.string(),
  meterId: z.string().uuid(),
  meterNumber: z.string(),
  registerId: z.string().uuid().nullable(),
  /** A label, not a count. */
  registerNumber: z.string().nullable(),
  accountNumber: z.string(),
  /** What this meter last read, before the sheet's date. Null if never read. */
  lastReading: z.string().nullable(),
  /** YYYY-MM-DD. */
  lastReadDate: z.string().nullable(),
  /** Null when the meter has too little history to judge a band from. */
  band: entryBandSchema.nullable(),
  reading: z.string().nullable(),
  skipReason: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.enum(["PENDING", "IMPORTED", "ERROR", "SKIPPED"]),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type EntryRowWire = z.infer<typeof entryRowSchema>;

export const entryOpenResponseSchema = z.object({
  batchId: z.string().uuid(),
  rows: z.array(entryRowSchema),
});
export type EntryOpenResponse = z.infer<typeof entryOpenResponseSchema>;

export const entrySubmitResultSchema = z.object({
  batchId: z.string().uuid(),
  status: z.string(),
  importedCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  skipsRecorded: z.number().int().nonnegative(),
  /** Rows nobody typed anything against, left out of the post. */
  notEntered: z.number().int().nonnegative(),
  /** True when this call wrote nothing because the batch had already posted. */
  alreadySubmitted: z.boolean(),
});
export type EntrySubmitResultWire = z.infer<typeof entrySubmitResultSchema>;

/**
 * Printing a sheet. `format` exists because `buildRouteSheet` returns
 * the stops it could **not** print, and a PDF body cannot carry that
 * warning — a stop that vanishes from a sheet without a trace is the
 * silent failure §5.1 forbids, so the route page asks for the JSON and
 * says so before anyone prints.
 */
export const routeSheetQuerySchema = z
  .object({
    onDate: z.string().date(),
    format: z.enum(["pdf", "json"]).default("pdf"),
  })
  .strict();
export type RouteSheetQuery = z.infer<typeof routeSheetQuerySchema>;

/**
 * Per-route progress. No `billingCycleId`: a route has one, it is
 * required, and asking the caller to repeat it invites the mismatch
 * `meterReadingProgressQuerySchema` would then have to refuse.
 */
export const readRouteProgressQuerySchema = z
  .object({
    asOf: z.string().date().optional(),
    /**
     * **Defaults to `reading`, where `/meter-reads/progress` defaults to
     * `billing`** — the one place the two endpoints differ, and the
     * difference is the question, not an oversight.
     *
     * A route is a walk somebody is doing: asking how far along *this
     * route* is means the window the reads being taken land in. The
     * cycle-wide screen asks whether a run can bill, which is the last
     * period already closed. Both are the same function and the same
     * window code; only the day being asked about differs.
     *
     * Overridable, because "was this route finished before the period we
     * billed" is a fair question on an audit.
     */
    window: z.enum(["billing", "reading"]).default("reading"),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(500).default(50),
  })
  .strict();
export type ReadRouteProgressQuery = z.infer<typeof readRouteProgressQuerySchema>;
