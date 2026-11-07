import { z } from "zod";
import { queryBoolean } from "../lib/base-list-query";

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

export const exceptionCodeEnum = z.enum([
  "HIGH_USAGE",
  "LOW_USAGE",
  "ZERO_USAGE",
  "METER_DEFECT",
  "REVERSE_FLOW",
  "ROLLOVER",
  "CONSECUTIVE_ESTIMATE",
]);

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
 * directly. `is_frozen` / `billed_at` are managed by the billing
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
  isFrozen: queryBoolean.optional(),
  fromDate: z.string().date().optional(),
  toDate: z.string().date().optional(),
}).strict();

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
