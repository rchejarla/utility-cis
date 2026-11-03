import { z } from "zod";

/**
 * Time-of-use calendars (spec 26, §2 and §5).
 *
 * A calendar is versioned and published the way a rate schedule is, and
 * for the same reason: changing which hours are on-peak changes what a
 * bill costs. A draft is editable; a published version is not. There is
 * no `version` column — a version *is* a (name, effectiveDate) pair,
 * which is what `tou_calendar_version_per_tenant` constrains.
 */

/** Minutes past local midnight, on the quarter hour (TOU-CAL-1). */
const minuteOfDay = z
  .number()
  .int()
  .min(0)
  .max(1440)
  .refine((m) => m % 15 === 0, { message: "Must be on the quarter hour" });

/** ISO weekday: 1 = Monday … 7 = Sunday. */
const isoWeekday = z.number().int().min(1).max(7);

/**
 * A wall-clock time typed by a person, for the spot check. No zone is
 * involved: TOU-CAL-7 classifies by the local clock, so "17:15" is the
 * whole input and there is nothing for an offset to change.
 */
const wallClockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Expected HH:MM, 24-hour");

export const createTouCalendarSchema = z
  .object({
    name: z.string().min(1).max(100),
    effectiveDate: z.string().date(),
    seasonSetId: z.string().uuid(),
    /** Omitted by a tenant whose tariff does not distinguish holidays. */
    touHolidayListId: z.string().uuid().nullish(),
    /**
     * An IANA name. Not validated against a list here — the database
     * checks the shape and the service resolves the name through `Intl`,
     * which is the only authority that cannot go stale.
     */
    timeZone: z.string().min(1).max(64),
    clockBasis: z.enum(["prevailing", "standard"]).default("prevailing"),
  })
  .strict();

/** Drafts only. A published calendar is immutable. */
export const updateTouCalendarSchema = createTouCalendarSchema.partial().strict();

export const touCalendarSortFields = ["name", "effectiveDate", "createdAt", "updatedAt"] as const;

export const touCalendarQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(500).default(20),
    sort: z.enum(touCalendarSortFields).default("effectiveDate"),
    order: z.enum(["asc", "desc"]).default("desc"),
    status: z.enum(["draft", "published"]).optional(),
    /** Every version of one calendar, which is what the diff needs. */
    name: z.string().min(1).max(100).optional(),
  })
  .strict();

/*
 * The three child collections are replaced whole rather than edited row
 * by row, because every invariant they carry is a property of the whole
 * list: the periods of a (season, day type) must tile the day exactly
 * once (TOU-CAL-3), and the seven weekdays must be claimed exactly once
 * across the day types (TOU-CAL-2). Saving one row at a time means every
 * intermediate state is invalid, which would reduce validation to
 * advice. A replace also matches how the screen works — a short list in
 * a form, saved when it is right.
 */

export const putTouPeriodsSchema = z
  .object({
    periods: z
      .array(
        z
          .object({
            peakCode: z.string().min(1).max(50),
            label: z.string().min(1).max(100),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const putTouDayTypesSchema = z
  .object({
    dayTypes: z
      .array(
        z
          .object({
            dayTypeCode: z.string().min(1).max(50),
            label: z.string().min(1).max(100),
            /**
             * Why this is a flag and not the code: TOU-CAL-2 leaves the
             * vocabulary open ("at least weekday, weekend and holiday. A
             * tenant may define more"), so no code may be matched in
             * code. A tenant coding theirs `observed_holiday` would
             * otherwise have every holiday classified as an ordinary
             * weekday with nothing raised.
             */
            isHoliday: z.boolean().default(false),
            /** Empty for a holiday day type, which no weekday claims. */
            weekdays: z.array(isoWeekday).default([]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** One (season, day type)'s rows — the input of TOU-UI-1. */
export const putTouSpansSchema = z
  .object({
    seasonCode: z.string().min(1).max(50),
    dayTypeCode: z.string().min(1).max(50),
    spans: z
      .array(
        z
          .object({
            /** Inclusive. */
            startMinute: minuteOfDay,
            /** Exclusive; 1440 is the end of the day. */
            endMinute: minuteOfDay,
            peakCode: z.string().min(1).max(50),
          })
          .strict()
          .refine((s) => s.startMinute < s.endMinute, {
            message: "A span must start before it ends",
          }),
      )
      .default([]),
  })
  .strict();

/**
 * Days that take a day type other than the one their weekday and the
 * holiday list would give them — a one-off closure, a local event.
 * `resolveDayType` already reads these; this is what puts them there.
 */
export const putTouDayOverridesSchema = z
  .object({
    overrides: z
      .array(
        z
          .object({
            date: z.string().date(),
            dayTypeCode: z.string().min(1).max(50),
            reason: z.string().max(200).nullish(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

/** TOU-UI-1c: "Tuesday 3 July, 5:15 pm" — what period, and why. */
export const touSpotCheckQuerySchema = z
  .object({
    date: z.string().date(),
    time: wallClockTime,
  })
  .strict();

/** TOU-UI-1e: a whole day laid out, for checking an observance rule. */
export const touDayPreviewQuerySchema = z.object({ date: z.string().date() }).strict();

export type CreateTouCalendarInput = z.infer<typeof createTouCalendarSchema>;
export type UpdateTouCalendarInput = z.infer<typeof updateTouCalendarSchema>;
export type TouCalendarQuery = z.infer<typeof touCalendarQuerySchema>;
export type PutTouPeriodsInput = z.infer<typeof putTouPeriodsSchema>;
export type PutTouDayTypesInput = z.infer<typeof putTouDayTypesSchema>;
export type PutTouSpansInput = z.infer<typeof putTouSpansSchema>;
export type PutTouDayOverridesInput = z.infer<typeof putTouDayOverridesSchema>;
export type TouSpotCheckQuery = z.infer<typeof touSpotCheckQuerySchema>;
export type TouDayPreviewQuery = z.infer<typeof touDayPreviewQuerySchema>;
