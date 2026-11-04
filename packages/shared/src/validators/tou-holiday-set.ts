import { z } from "zod";

/**
 * Holiday sets (spec 26, TOU-CAL-4 and TOU-UI-2).
 *
 * **Explicit dates, not rules.** A rule — "4 July, nearest weekday" —
 * is a computation nobody checked: it does not say that 2026 lands on a
 * Saturday and moves the holiday to Friday the 3rd, a weekday whose
 * peak hours disappear. A date is the fact, and the observance is
 * applied by the person who knows it, when they type it.
 *
 * **Versioned and published like a season set**, so a published
 * calendar names a published version and editing a set cannot change
 * which days got holiday hours on bills already issued.
 *
 * **Shared across calendars**, because a utility's holidays do not vary
 * by tariff — per calendar, adding one means editing three and missing
 * one.
 */

export const createTouHolidaySetSchema = z
  .object({
    name: z.string().min(1).max(100),
    effectiveDate: z.string().date(),
  })
  .strict();

/** Drafts only. A published set is immutable. */
export const updateTouHolidaySetSchema = createTouHolidaySetSchema.partial().strict();

/**
 * Named rather than inline, so the service's `allowedSorts` and this
 * schema cannot drift: an `orderBy` key outside the list would reach
 * Prisma from the query string.
 */
export const touHolidaySetSortFields = ["name", "effectiveDate", "createdAt"] as const;

export const touHolidaySetQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(500).default(100),
    sort: z.enum(touHolidaySetSortFields).default("effectiveDate"),
    order: z.enum(["asc", "desc"]).default("desc"),
    status: z.enum(["draft", "published"]).optional(),
  })
  .strict();

/**
 * The dates, replaced whole like every other collection here: a set is
 * read as one answer to "which days are holidays", and a per-row save
 * would make every intermediate state a different answer.
 */
export const putTouHolidaysSchema = z
  .object({
    holidays: z
      .array(
        z
          .object({
            date: z.string().date(),
            name: z.string().min(1).max(100),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type CreateTouHolidaySetInput = z.infer<typeof createTouHolidaySetSchema>;
export type UpdateTouHolidaySetInput = z.infer<typeof updateTouHolidaySetSchema>;
export type TouHolidaySetQuery = z.infer<typeof touHolidaySetQuerySchema>;
export type PutTouHolidaysInput = z.infer<typeof putTouHolidaysSchema>;
