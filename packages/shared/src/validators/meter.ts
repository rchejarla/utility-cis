import { z } from "zod";

/**
 * The kinds of meter, in the one place that defines them.
 *
 * `SMART` was removed on 2026-11-06: it said nothing `AMI` did not, and
 * spec 03 admitted it ("used interchangeably with AMI in some
 * contexts"). Two values for one idea is two answers to "what is this
 * meter", and nothing in the API branches on `meter_type` at all — so
 * the ambiguity's only cost was paid by whoever had to pick one on a
 * form, and by anyone who later tried to mean something by the answer.
 *
 * Exported as a list because there were **five** hand-kept copies — this
 * enum, the meter import handler, and three web forms, one of which
 * offered `OTHER`, a value the API would have refused. A vocabulary the
 * database constrains should have one statement in TypeScript.
 */
export const METER_TYPES = ["AMR", "AMI", "MANUAL"] as const;

export const meterTypeEnum = z.enum(METER_TYPES);

/**
 * A meter's lifecycle state, exported for the same reason.
 *
 * The meter detail page offered `INACTIVE` and `FAULTY` — neither of
 * which has ever existed — while `DEFECTIVE` and `PENDING_INSTALL`,
 * which do, were missing from it. A dropdown of values the API refuses
 * is a form that cannot be saved, and the reason is never on the screen.
 */
export const METER_STATUSES = ["ACTIVE", "REMOVED", "DEFECTIVE", "PENDING_INSTALL"] as const;

export const meterStatusEnum = z.enum(METER_STATUSES);

export const meterSortFields = [
  "createdAt",
  "updatedAt",
  "meterNumber",
  "installDate",
  "status",
  "meterType",
] as const;

export const createMeterSchema = z.object({
  premiseId: z.string().uuid(),
  meterNumber: z.string().min(1).max(100),
  commodityId: z.string().uuid(),
  meterType: meterTypeEnum,
  uomId: z.string().uuid(),
  dialCount: z.number().int().positive().optional(),
  multiplier: z.number().positive().default(1.0),
  installDate: z.string().date(),
  // `removalDate` set when the Remove Meter action runs
  // (status → REMOVED). Nullable so it can be cleared if a meter is
  // un-removed; optional at create time since most meters are
  // commissioned with no removal date.
  removalDate: z.string().date().nullable().optional(),
  status: meterStatusEnum.default("ACTIVE"),
  notes: z.string().optional(),
  // Tenant-configurable custom fields. Validated server-side.
  customFields: z.record(z.unknown()).optional(),
}).strict();

// Update schemas intentionally strip unknown keys (forgiving PATCH semantics).
export const updateMeterSchema = createMeterSchema
  .omit({ premiseId: true, meterNumber: true })
  .partial();

export const meterQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(meterSortFields).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  status: meterStatusEnum.optional(),
  meterType: meterTypeEnum.optional(),
  premiseId: z.string().uuid().optional(),
  commodityId: z.string().uuid().optional(),
  /**
   * Substring match against meter_number. Used by the searchable
   * entity picker so operators can find a meter by typing its number
   * instead of scrolling through thousands of rows.
   */
  search: z.string().optional(),
}).strict();

export type MeterType = z.infer<typeof meterTypeEnum>;
export type MeterStatus = z.infer<typeof meterStatusEnum>;
export type CreateMeterInput = z.infer<typeof createMeterSchema>;
export type UpdateMeterInput = z.infer<typeof updateMeterSchema>;
export type MeterQuery = z.infer<typeof meterQuerySchema>;
