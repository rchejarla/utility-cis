import { z } from "zod";

/**
 * Holiday lists and the rules in them (spec 26, TOU-CAL-4, TOU-UI-2).
 *
 * **Rules, not dates.** A list of dates would have to be re-entered
 * every year and says nothing about *why* a day is a holiday — and the
 * observance is the part that moves a peak day: 4 July 2026 is a
 * Saturday, so a utility observing it on the nearest weekday makes
 * Friday 3 July off-peak. A date list cannot express that; a rule can,
 * and the editor shows the dates it produces.
 *
 * **A list is shared across calendars** of a tenant (TOU-UI-2a), since
 * a utility's holidays do not vary by tariff. Adding a holiday to three
 * calendars separately is how one gets missed.
 */

const month = z.number().int().min(1).max(12);

/**
 * How a holiday falling at a weekend is treated. The names say what
 * happens, because "observance rule" alone tells an operator nothing:
 *   NONE             — observed on the day it falls, whatever day that is
 *   NEAREST_WEEKDAY  — Saturday → the Friday before; Sunday → the Monday after
 *   FOLLOWING_MONDAY — either weekend day → the following Monday
 */
export const holidayObservances = ["NONE", "NEAREST_WEEKDAY", "FOLLOWING_MONDAY"] as const;

/**
 * A fixed date, or the nth weekday of a month.
 *
 * Each kind carries its own fields and not the other's — the database
 * CHECK says the same. A FIXED rule with a stray `nth` reads as meaning
 * something it does not, and the resolver ignores the wrong one, so the
 * row would look configured and resolve elsewhere.
 */
const fixedRule = z
  .object({
    code: z.string().min(1).max(50),
    label: z.string().min(1).max(100),
    kind: z.literal("FIXED"),
    month,
    /** 1–31. February 30th is refused by the resolver, which says so. */
    day: z.number().int().min(1).max(31),
    observance: z.enum(holidayObservances).default("NONE"),
  })
  .strict();

const nthWeekdayRule = z
  .object({
    code: z.string().min(1).max(50),
    label: z.string().min(1).max(100),
    kind: z.literal("NTH_WEEKDAY"),
    month,
    /** ISO weekday: 1 = Monday … 7 = Sunday. */
    weekday: z.number().int().min(1).max(7),
    /** 1–5, or -1 for the last in the month ("last Monday in May"). */
    nth: z
      .number()
      .int()
      .refine((n) => (n >= 1 && n <= 5) || n === -1, {
        message: "Must be 1 to 5, or -1 for the last in the month",
      }),
    observance: z.enum(holidayObservances).default("NONE"),
  })
  .strict();

export const touHolidayRuleSchema = z.discriminatedUnion("kind", [fixedRule, nthWeekdayRule]);

export const createTouHolidayListSchema = z
  .object({ name: z.string().min(1).max(100) })
  .strict();

export const updateTouHolidayListSchema = createTouHolidayListSchema.partial().strict();

/**
 * The rules are replaced whole, like every other collection here: a
 * list is read as a set — "these are our holidays" — and a per-row save
 * would make every intermediate state a different answer to that.
 */
export const putTouHolidayRulesSchema = z
  .object({ rules: z.array(touHolidayRuleSchema).default([]) })
  .strict();

export const touHolidayListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(500).default(100),
    sort: z.enum(["name", "createdAt"]).default("name"),
    order: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();

export type TouHolidayRuleInput = z.infer<typeof touHolidayRuleSchema>;
export type CreateTouHolidayListInput = z.infer<typeof createTouHolidayListSchema>;
export type UpdateTouHolidayListInput = z.infer<typeof updateTouHolidayListSchema>;
export type PutTouHolidayRulesInput = z.infer<typeof putTouHolidayRulesSchema>;
export type TouHolidayListQuery = z.infer<typeof touHolidayListQuerySchema>;
