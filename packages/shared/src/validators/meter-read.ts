import { z } from "zod";
import { paginationMetaSchema, queryBoolean } from "../lib/base-list-query";

/**
 * What a read is, in the one place that defines it.
 *
 * Four values, and every one of them answers the same question: is this
 * figure measured, and if not, what stands in its place. `AMI` was a
 * fifth until 2026-11-06 and answered a different question — where the
 * read came from — which `readSourceEnum` below says beside it. Nothing
 * ever wrote it and no row carried it, which is itself the evidence: the
 * roll-up, the only producer of AMI reads here, needed a `read_type` and
 * wrote the *source* word again rather than ACTUAL or ESTIMATED. The one
 * column that could tell a customer their on-peak charge rests on an
 * estimate therefore said nothing, and TOU-GAP-2 had nothing to read.
 *
 * Exported as a list because the vocabulary had four hand-kept copies —
 * this enum, the meter-read import handler, and the two meter-read
 * screens. A `Record<ReadType, …>` on the label map keeps a fifth from
 * being added to one of them and nowhere else.
 */
export const READ_TYPES = ["ACTUAL", "ESTIMATED", "CORRECTED", "FINAL"] as const;

export const readTypeEnum = z.enum(READ_TYPES);

/** Where a read came from. `AMI` is a source, and belongs only here. */
export const READ_SOURCES = ["MANUAL", "AMR", "AMI", "CUSTOMER_SELF", "SYSTEM"] as const;

export const readSourceEnum = z.enum(READ_SOURCES);

export const EXCEPTION_CODES = [
  "HIGH_USAGE",
  "LOW_USAGE",
  "ZERO_USAGE",
  "METER_DEFECT",
  "REVERSE_FLOW",
  "ROLLOVER",
  "CONSECUTIVE_ESTIMATE",
] as const;

export const exceptionCodeEnum = z.enum(EXCEPTION_CODES);

/**
 * What each one means, in words a column can hold.
 *
 * The screens printed the constant itself, and `CONSECUTIVE_ESTIMATE`
 * is twenty upper-case characters — wider than the column it sits in,
 * so the table clipped it to `CONSECUTIVE_ESTIMA…`. The fault was not
 * the width: a cell that shouts a database constant at somebody asking
 * what is wrong with a read has already failed, and the longest of
 * these labels is five characters shorter than the shortest clipped
 * code.
 *
 * A `Record`, so a code added to the enum fails to compile until it has
 * a label. Readers still fall back to the raw value, because an
 * unlabelled code must show something true rather than an empty cell.
 */
export const EXCEPTION_CODE_LABELS: Record<ExceptionCode, string> = {
  HIGH_USAGE: "High usage",
  LOW_USAGE: "Low usage",
  ZERO_USAGE: "Zero usage",
  METER_DEFECT: "Meter defect",
  REVERSE_FLOW: "Reverse flow",
  ROLLOVER: "Rollover",
  CONSECUTIVE_ESTIMATE: "Repeat estimate",
};

export const meterReadSortFields = [
  "readDatetime",
  "readDate",
  "createdAt",
  "consumption",
  "reading",
] as const;

/**
 * Creating a single meter read.
 *
 * The service is responsible for computing `priorReading` and
 * `consumption` from the meter history — callers must not supply them
 * directly. `billed_at` is managed by the billing
 * engine in Phase 3 and are not exposed.
 *
 * `serviceAgreementId` is optional because the service will resolve
 * it from the `ServiceAgreementMeter` junction table using the meter
 * id and read date: at any given date there's at most one active
 * meter assignment per meter, so the agreement is deterministic.
 * Callers CAN still supply it explicitly (e.g. for bulk import where
 * the file has both), in which case the supplied value wins. If
 * neither is provided and no active assignment exists at the read
 * date, the service raises a clear 400.
 */
export const createMeterReadSchema = z.object({
  meterId: z.string().uuid(),
  serviceAgreementId: z.string().uuid().optional(),
  registerId: z.string().uuid().optional(),
  readDate: z.string().date(),
  readDatetime: z.string().datetime(),
  reading: z.number().nonnegative(),
  readType: readTypeEnum.default("ACTUAL"),
  readSource: readSourceEnum.default("MANUAL"),
  exceptionCode: exceptionCodeEnum.optional(),
  exceptionNotes: z.string().optional(),
}).strict();

/**
 * Multi-register read event. A single meter visit captures readings for
 * every active register on the meter at one `read_datetime`. The service
 * writes one `MeterRead` row per register sharing one generated
 * `read_event_id`, and records a `MeterEvent` for any register the
 * operator explicitly skipped (broken demand register, inaccessible sub-
 * meter, etc.). See `docs/specs/08-meter-reading.md` § Multi-Register
 * Reads for the full rules.
 */
export const registerSkipReasonEnum = z.enum([
  "OUT_OF_SERVICE",
  "INACCESSIBLE",
  "DEFECTIVE",
]);

export const registerReadingSchema = z.object({
  registerId: z.string().uuid(),
  reading: z.number().nonnegative(),
  exceptionNotes: z.string().max(2000).optional(),
}).strict();

export const registerSkipSchema = z.object({
  registerId: z.string().uuid(),
  skipReason: registerSkipReasonEnum,
  notes: z.string().max(2000).optional(),
}).strict();

export const createMeterReadEventSchema = z.object({
  meterId: z.string().uuid(),
  serviceAgreementId: z.string().uuid().optional(),
  readDate: z.string().date(),
  readDatetime: z.string().datetime(),
  readings: z.array(registerReadingSchema).min(1),
  skips: z.array(registerSkipSchema).default([]),
  readType: readTypeEnum.default("ACTUAL"),
  readSource: readSourceEnum.default("MANUAL"),
}).strict().refine(
  (v) => {
    const ids = [...v.readings.map((r) => r.registerId), ...v.skips.map((s) => s.registerId)];
    return new Set(ids).size === ids.length;
  },
  { message: "A register cannot appear in both readings and skips, or twice in either list" },
);

/**
 * Correcting an existing read produces a NEW read with read_type=CORRECTED
 * and corrects_read_id pointing at the original. This schema covers the
 * correction request payload.
 */
export const correctMeterReadSchema = z.object({
  reading: z.number().nonnegative(),
  readDate: z.string().date().optional(),
  readDatetime: z.string().datetime().optional(),
  exceptionNotes: z.string().min(1).max(2000),
}).strict();

/** Exception-resolution payload. */
export const resolveExceptionSchema = z.object({
  resolution: z.enum(["APPROVE", "REPLACE_WITH_ESTIMATE", "CORRECT", "HOLD_FOR_REREAD"]),
  correctedReading: z.number().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
}).strict();

export const meterReadQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(meterReadSortFields).default("readDatetime"),
  order: z.enum(["asc", "desc"]).default("desc"),
  meterId: z.string().uuid().optional(),
  serviceAgreementId: z.string().uuid().optional(),
  readEventId: z.string().uuid().optional(),
  /**
   * The meter number or the agreement number, case-insensitively, by
   * substring.
   *
   * The screen had no search at all until 2026-11-07, and at ten
   * thousand meters that made it unusable for the commonest question
   * anybody brings to it — *this* meter's reads. Twenty rows of
   * whatever arrived most recently, out of six figures a year, with no
   * way to name the one you want.
   *
   * Those two numbers and nothing else: they are what the screen's own
   * columns show, and what a CSR reads off a work order. Searching the
   * premise address or the customer's name would be a different
   * screen's question, answered better from the account.
   */
  search: z.string().trim().min(1).optional(),
  /**
   * The cycle whose reads to show, through the account that owns the
   * agreement.
   *
   * The dimension a meter-reading operation is actually organised by: a
   * reader walks a route, and the route is the cycle. Nothing could ask
   * this before, so "is route 1 in yet" had no answer on the one screen
   * that lists reads.
   */
  billingCycleId: z.string().uuid().optional(),
  /**
   * One month of reads, as `YYYY-MM`, by read date.
   *
   * Beside `fromDate`/`toDate` rather than instead of them: an operator
   * asks for a month, which is two dates they would otherwise have to
   * get right, and a month is what a cycle reads in. Arbitrary ranges
   * stay available for anything else.
   */
  readMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "readMonth must be YYYY-MM")
    .optional(),
  readType: readTypeEnum.optional(),
  readSource: readSourceEnum.optional(),
  exceptionCode: exceptionCodeEnum.optional(),
  hasException: queryBoolean.optional(),
  /**
   * Billed, or not — by `billed_at`, which is the column that says so.
   *
   * It was `isFrozen` until 2026-11-07, against `meter_read.is_frozen`:
   * a column **nothing in the codebase ever wrote**. So "Frozen
   * (billed)" could only ever return nothing and "Unbilled" returned
   * every read including the billed ones, and the guards that read the
   * same flag — no deleting or resolving an exception on a billed read
   * — could not fire at all. The column is gone; `billed_at` carried
   * the fact all along.
   */
  billed: queryBoolean.optional(),
  fromDate: z.string().date().optional(),
  toDate: z.string().date().optional(),
}).strict();

/**
 * Asking how far along a cycle's reading is.
 *
 * `asOf` exists so the answer can be asked of a date rather than only
 * of today — a biller checking on the 9th wants the window that is
 * about to close, and a test wants a window it chose. It names the
 * *window*, not a filter on reads: `computeBillPeriod` derives the
 * period in force on that date from the cycle's own bill day.
 */
export const meterReadingProgressQuerySchema = z
  .object({
    billingCycleId: z.string().uuid(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(500).default(50),
    asOf: z.string().date().optional(),
  })
  .strict();

export type MeterReadingProgressQuery = z.infer<typeof meterReadingProgressQuerySchema>;

/*
 * ─── What the API sends back ──────────────────────────────────────────
 *
 * Response shapes, so the screens stop describing them by hand.
 *
 * The web package had 169 of its own interfaces for API responses, and
 * every one of its tests mocks the client — so nothing anywhere
 * compared the two. The read log's own interface never declared
 * `billedAt`, which is why its ❄ column could not have worked even
 * after the flag it read got a writer; and `response-contracts.
 * integration.test.ts` parses a real HTTP body through these, so a
 * field the UI needs and the API stops sending fails there.
 *
 * Timestamps and decimals are **strings**: that is what a JSON body
 * carries, whatever the column's type. A `Date` here would be a lie
 * about the wire, and the lie is what lets `new Date(x)` work in one
 * place and `x.toISOString()` throw in another.
 */

/** A row of the read log, as `GET /api/v1/meter-reads` sends it. */
export const meterReadRowSchema = z.object({
  id: z.string().uuid(),
  readDate: z.string(),
  readDatetime: z.string(),
  /**
   * Nullable, and the nullability is the point.
   *
   * A dial read has a `reading` and a `priorReading`; an
   * interval-derived TOU bucket is a **sum** and has neither — the
   * roll-up writes nulls there rather than inventing a cumulative
   * number that matches nothing on the device. `consumption` is NOT
   * NULL, because that is the figure every read exists to carry.
   *
   * The read log declared all three as plain `string`, so it rendered
   * `Number(null)` as `0.00` for every TOU bucket row: a reading of
   * zero where there is no reading at all.
   */
  reading: z.string().nullable(),
  priorReading: z.string().nullable(),
  consumption: z.string(),
  readType: readTypeEnum,
  readSource: readSourceEnum,
  exceptionCode: z.string().nullable(),
  /** Set once billed, and the one thing that locks the read. */
  billedAt: z.string().nullable(),
  meter: z
    .object({
      id: z.string().uuid(),
      meterNumber: z.string(),
      commodityId: z.string().uuid().nullable(),
      multiplier: z.string().nullable(),
    })
    .nullable(),
  /**
   * The read's own unit, not the meter's — a register read carries its
   * register's, which is how one meter logs kW beside kWh.
   */
  uom: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }).nullable(),
  serviceAgreement: z
    .object({ id: z.string().uuid(), agreementNumber: z.string() })
    .nullable(),
});

export type MeterReadRow = z.infer<typeof meterReadRowSchema>;

/** One service a cycle still owes a read for. */
export const outstandingReadSchema = z.object({
  meterId: z.string().uuid(),
  meterNumber: z.string(),
  agreementNumber: z.string(),
  accountNumber: z.string(),
  premise: z.string().nullable(),
  /** Null when the meter has never been read at all. */
  lastReadDate: z.string().nullable(),
});

export type OutstandingRead = z.infer<typeof outstandingReadSchema>;

/**
 * How far along a cycle's reading is.
 *
 * The service **builds** this rather than handing back database rows,
 * so its return type is this schema's type and the compiler checks the
 * producing side as well as the reading side.
 */
export const readingProgressSchema = z.object({
  billingCycleId: z.string().uuid(),
  cycleCode: z.string(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  expected: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  outstanding: z.number().int().nonnegative(),
  data: z.array(outstandingReadSchema),
  meta: paginationMetaSchema,
});

export type ReadingProgress = z.infer<typeof readingProgressSchema>;

/**
 * One meter's interval series, as `GET /api/v1/meters/:id/intervals`
 * sends it.
 *
 * **Where the gaps come from matters.** They are
 * `findCoverageProblems`' output — the same tiling the roll-up refuses
 * on and the nightly sweep opens exceptions for — so a hole drawn here
 * is the hole that stops a bill. A screen computing its own would be
 * worse than no screen.
 *
 * Note the rule these response schemas follow, since two of them look
 * different: **a schema describes the wire**, so timestamps are
 * strings. A service may hold `Date`s internally; where it builds its
 * whole response by hand it may adopt the wire type instead and get
 * the compiler to check what it produces, which `getReadingProgress`
 * does and this one does not.
 */
export const intervalPointSchema = z.object({
  intervalStart: z.string(),
  lengthMinutes: z.number().int().positive(),
  quantity: z.string(),
  /** actual | estimated | missing | edited — a VARCHAR with a CHECK. */
  quality: z.string(),
});

export const meterIntervalSeriesSchema = z.object({
  meterId: z.string().uuid(),
  meterNumber: z.string(),
  uomCode: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  /**
   * The zone the days are measured in and the series reads in — the
   * tenant's own. Not UTC, which drew a household's evening peak at
   * midnight until somebody looked at the chart.
   */
  timeZone: z.string(),
  /** Has this meter ever reported one? A water meter never will. */
  reportsIntervals: z.boolean(),
  intervals: z.array(intervalPointSchema),
  summary: z.object({
    count: z.number().int().nonnegative(),
    total: z.string(),
    byQuality: z.record(z.number().int().nonnegative()),
    minutesCovered: z.number().int().nonnegative(),
    minutesInRange: z.number().int().positive(),
    gaps: z.array(
      z.object({ startsAt: z.string(), minutes: z.number().int().positive() }),
    ),
  }),
});

export type IntervalPoint = z.infer<typeof intervalPointSchema>;
export type MeterIntervalSeries = z.infer<typeof meterIntervalSeriesSchema>;

/** Both days or neither; the service defaults to the newest day. */
export const meterIntervalSeriesQuerySchema = z
  .object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  })
  .strict();

export type MeterIntervalSeriesQuery = z.infer<typeof meterIntervalSeriesQuerySchema>;

// Bulk import has moved to the generic /api/v1/imports endpoint with
// kind-aware handlers (see spec 22). The kind handler defines its own
// per-row Zod-style validation in `parseRow`; there's no longer a
// shared bulk-payload schema here.

export type ReadType = z.infer<typeof readTypeEnum>;
export type ReadSource = z.infer<typeof readSourceEnum>;
export type ExceptionCode = z.infer<typeof exceptionCodeEnum>;
export type CreateMeterReadInput = z.infer<typeof createMeterReadSchema>;
export type CreateMeterReadEventInput = z.infer<typeof createMeterReadEventSchema>;
export type RegisterSkipReason = z.infer<typeof registerSkipReasonEnum>;
export type CorrectMeterReadInput = z.infer<typeof correctMeterReadSchema>;
export type ResolveExceptionInput = z.infer<typeof resolveExceptionSchema>;
export type MeterReadQuery = z.infer<typeof meterReadQuerySchema>;
