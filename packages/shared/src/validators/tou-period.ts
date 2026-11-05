import { z } from "zod";

/**
 * A tenant's TOU periods — its price tiers (spec 26, TOU-CAL-1).
 *
 * `off_peak`, `mid_peak`, `peak`, `super_off_peak`: the names are the
 * tenant's, which is what TOU-CAL-1 always said. Until 2026-11-04 they
 * were declared on each calendar, which stored one fact twice — every
 * `meter_register`, `meter_read` and rate component already carried the
 * code as a plain string.
 *
 * **A calendar's own periods are derived**, not declared: the distinct
 * codes its hours use. So a four-code tenant may have a two-period
 * tariff, and nothing requires a calendar to use them all.
 *
 * Ordinary per-row CRUD rather than the whole-list replacement the
 * other collections here use. That discipline exists for lists whose
 * invariants no row can see — hours tiling a day, weekdays claimed
 * once — and this list has none left: a unique code per tenant, which
 * an index keeps.
 */

/**
 * The code that travels: into a calendar's hours, a rate component's
 * `quantitySource.peak_code`, a meter register and a meter read. Lower
 * snake case, because it is an identifier a person types once and reads
 * in a dozen places.
 */
const peakCode = z
  .string()
  .min(1)
  .max(50)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "Use lower-case letters, digits and underscores, starting with a letter — e.g. super_off_peak",
  );

/**
 * What a tenant is provisioned with: the three tiers nearly every TOU
 * tariff has.
 *
 * Declared here, beside the schema that validates them, and read by
 * `provisioning.service.ts`, the dev seed and the integration
 * fixtures — three doors into a tenant's existence that must all leave
 * it able to price an hour, since `tou_slot.peak_code` keys to this
 * list.
 *
 * A tenant with a super-off-peak tier adds it. A tenant with a flat
 * two-period tariff simply never assigns hours to mid-peak, which is
 * not a fault: a calendar's periods are the codes its hours use.
 */
export const DEFAULT_TOU_PERIODS = [
  { peakCode: "off_peak", label: "Off-peak" },
  { peakCode: "mid_peak", label: "Mid-peak" },
  { peakCode: "peak", label: "On-peak" },
] as const;

export const createTouPeriodSchema = z
  .object({
    peakCode,
    label: z.string().min(1).max(100),
    /** Display order: the strip's legend and its colours follow it. */
    sortOrder: z.number().int().min(0).max(100).optional(),
  })
  .strict();

/**
 * The label and the order only.
 *
 * The code itself is immutable, and not by omission: it is the key the
 * calendars' hours reference, and it has been copied into rate
 * components and meter registers that know nothing about this row.
 * Renaming it would leave all of them pricing a code that no longer
 * exists. `tou_slot_peak_code_fkey` refuses it at the database too.
 */
export const updateTouPeriodSchema = z
  .object({
    label: z.string().min(1).max(100).optional(),
    sortOrder: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const touPeriodSortFields = ["sortOrder", "peakCode", "label"] as const;

export const touPeriodQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(500).default(100),
    sort: z.enum(touPeriodSortFields).default("sortOrder"),
    order: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();

export type CreateTouPeriodInput = z.infer<typeof createTouPeriodSchema>;
export type UpdateTouPeriodInput = z.infer<typeof updateTouPeriodSchema>;
export type TouPeriodQuery = z.infer<typeof touPeriodQuerySchema>;
