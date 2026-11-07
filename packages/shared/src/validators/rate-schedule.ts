import { z } from "zod";

// v2: rate_type / rate_config are gone from the RateSchedule. Pricing
// logic now lives on RateComponent rows (see rate-component.ts in
// task 4) and assignment metadata on SAScheduleAssignment (task 6).
// This module is reduced to schedule-level metadata + the revise flow.

export const createRateScheduleSchema = z
  .object({
    name: z.string().min(1).max(255),
    code: z.string().min(1).max(50),
    commodityId: z.string().uuid(),
    effectiveDate: z.string().date(),
    expirationDate: z.string().date().optional(),
    description: z.string().optional(),
    regulatoryRef: z.string().max(100).optional(),
    /**
     * The TOU calendar this tariff's peak hours come from (spec 26,
     * TOU-UI-3) — on the schedule, not on each component, because the
     * components of one tariff share one set of peak hours.
     *
     * Optional here because most tariffs are not TOU, and a TOU one
     * may name its calendar after its charges: `publishRateSchedule`
     * is where it becomes required, and where TOU-CAL-5 refuses a
     * draft calendar.
     */
    touCalendarId: z.string().uuid().optional(),
  })
  .strict();

// Revising a rate schedule forks it forward. The route copies all
// non-supplied fields from the predecessor; the only required input
// is the new effective date. Optional overrides let the operator
// adjust description / regulatoryRef without leaving the dialog.
export const reviseRateScheduleSchema = z.object({
  effectiveDate: z.string().date(),
  expirationDate: z.string().date().optional(),
  description: z.string().optional(),
  regulatoryRef: z.string().max(100).optional(),
  /**
   * Omitted keeps the predecessor's calendar, which is right for a
   * revision that only reprices. `null` clears it; a uuid re-points
   * the new version at new hours — the usual reason a TOU tariff is
   * revised at all, since a published schedule cannot follow a
   * calendar republished with different hours.
   */
  touCalendarId: z.string().uuid().nullable().optional(),
});

/**
 * Naming (or clearing) the calendar of a schedule that already exists.
 *
 * Its own endpoint rather than a PATCH, because a rate schedule has
 * none: it is immutable by design and changes go through `revise`.
 * This one field is the exception, and only while the schedule is a
 * draft — a published tariff's hours are exactly what must not move.
 */
export const assignTouCalendarSchema = z
  .object({
    touCalendarId: z.string().uuid().nullable(),
  })
  .strict();

export type AssignTouCalendarInput = z.infer<typeof assignTouCalendarSchema>;

export type ReviseRateScheduleInput = z.infer<typeof reviseRateScheduleSchema>;

export const rateScheduleSortFields = [
  "createdAt",
  "updatedAt",
  "effectiveDate",
  "expirationDate",
  "name",
  "code",
  "version",
] as const;

export const rateScheduleQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(rateScheduleSortFields).default("effectiveDate"),
  order: z.enum(["asc", "desc"]).default("desc"),
  commodityId: z.string().uuid().optional(),
  /**
   * The lifecycle, which is what the list shows and what decides
   * whether a schedule can price a bill.
   *
   * This replaced `active: z.coerce.boolean()`, which was wrong twice
   * over: the service translated it to "has no expiration date", so the
   * label promised something the query never asked, and
   * `z.coerce.boolean()` is `Boolean(input)` — the string "false" that a
   * select box sends parses as **true**, so the Inactive option returned
   * the active set. The states are mutually exclusive and defined
   * exactly as the badge derives them, supersession first, so the filter
   * and the column cannot disagree about a row.
   */
  status: z.enum(["draft", "published", "superseded"]).optional(),
}).strict();

export type CreateRateScheduleInput = z.infer<typeof createRateScheduleSchema>;
export type RateScheduleQuery = z.infer<typeof rateScheduleQuerySchema>;
