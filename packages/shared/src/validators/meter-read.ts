import { z } from "zod";

export const readTypeEnum = z.enum([
  "ACTUAL",
  "ESTIMATED",
  "CORRECTED",
  "FINAL",
  "AMI",
]);

export const readSourceEnum = z.enum([
  "MANUAL",
  "AMR",
  "AMI",
  "CUSTOMER_SELF",
  "SYSTEM",
]);

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
  readType: readTypeEnum.optional(),
  readSource: readSourceEnum.optional(),
  exceptionCode: exceptionCodeEnum.optional(),
  hasException: z.coerce.boolean().optional(),
  isFrozen: z.coerce.boolean().optional(),
  fromDate: z.string().date().optional(),
  toDate: z.string().date().optional(),
}).strict();

/**
 * Bulk-import payload. Accepts either a file via multipart (handled by
 * the route layer) or an inline JSON array for smaller batches.
 */
export const importMeterReadsSchema = z.object({
  source: z.enum(["AMR", "AMI", "MANUAL_UPLOAD", "API"]).default("API"),
  fileName: z.string().max(500).optional(),
  reads: z.array(
    z.object({
      meterNumber: z.string().min(1).max(100),
      registerNumber: z.string().optional(),
      readDatetime: z.string().datetime(),
      reading: z.number().nonnegative(),
      readType: readTypeEnum.optional(),
      readSource: readSourceEnum.optional(),
    }).strict(),
  ).min(1).max(10000),
}).strict();

export type ReadType = z.infer<typeof readTypeEnum>;
export type ReadSource = z.infer<typeof readSourceEnum>;
export type ExceptionCode = z.infer<typeof exceptionCodeEnum>;
export type CreateMeterReadInput = z.infer<typeof createMeterReadSchema>;
export type CorrectMeterReadInput = z.infer<typeof correctMeterReadSchema>;
export type ResolveExceptionInput = z.infer<typeof resolveExceptionSchema>;
export type MeterReadQuery = z.infer<typeof meterReadQuerySchema>;
export type ImportMeterReadsInput = z.infer<typeof importMeterReadsSchema>;
