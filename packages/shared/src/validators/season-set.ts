import { z } from "zod";

/**
 * Season sets (spec 26, §1).
 *
 * A set must cover every day of the year exactly once, which is a
 * property of the whole set — so no CHECK constraint can express it and
 * the seasons are saved as one list. `validateSeasons` is the rule, and
 * publishing is where it is enforced.
 *
 * Versioned and published like a rate schedule: a season boundary
 * decides which price applies, so moving one changes bills. A published
 * set is immutable.
 */

const month = z.number().int().min(1).max(12);
/**
 * 1–31 and not checked against the month here. February 30th is
 * refused, but by `validateSeasons`, which says "ends on 30 February,
 * which is not a date" — a sentence, next to the other problems with
 * the set, rather than a field error that cannot mention the month.
 */
const dayOfMonth = z.number().int().min(1).max(31);

/**
 * What a tenant is provisioned with: the seasons the rate engine used to
 * hard-code for every utility on earth.
 *
 * Published, and dated at the epoch of this system, so it is in force
 * for any period a bill could cover — including a backdated import or a
 * legacy overlay's history.
 *
 * It exists because a tenant with no published set rates nothing
 * seasonal: `seasonOf()` was deleted when seasons became configuration,
 * so a `season` predicate resolves to no season and a TOU calendar
 * cannot be created at all, its spans being keyed on a set's codes. The
 * `season_sets` migration seeded this for every tenant that existed in
 * 2026-11-02; a tenant provisioned after it needs the same thing, and a
 * migration cannot reach forward in time to give it one.
 *
 * Summer 1 May – 31 October, winter the rest, which is the behaviour
 * every `bozeman-*` golden test is written against. A tenant whose
 * climate disagrees publishes its own set; that correction is the
 * tenant's to make, and this is only a floor.
 */
export const DEFAULT_SEASON_SET = {
  name: "Default",
  effectiveDate: "2000-01-01",
  seasons: [
    { seasonCode: "summer", label: "Summer", startMonth: 5, startDay: 1, endMonth: 10, endDay: 31 },
    { seasonCode: "winter", label: "Winter", startMonth: 11, startDay: 1, endMonth: 4, endDay: 30 },
  ],
} as const;

export const createSeasonSetSchema = z
  .object({
    name: z.string().min(1).max(100),
    effectiveDate: z.string().date(),
    /**
     * How a non-TOU period spanning two seasons is decided (TOU-SEA-5).
     * Only START_DATE is implemented — today's behaviour — and the
     * others exist so adopting one is not a migration.
     */
    spanRule: z.enum(["START_DATE", "MAJORITY", "PRORATE"]).default("START_DATE"),
  })
  .strict();

export const updateSeasonSetSchema = createSeasonSetSchema.partial().strict();

export const seasonSetSortFields = ["name", "effectiveDate", "createdAt"] as const;

export const seasonSetQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(500).default(100),
    sort: z.enum(seasonSetSortFields).default("effectiveDate"),
    order: z.enum(["asc", "desc"]).default("desc"),
    status: z.enum(["draft", "published"]).optional(),
  })
  .strict();

export const putSeasonsSchema = z
  .object({
    seasons: z
      .array(
        z
          .object({
            seasonCode: z.string().min(1).max(50),
            label: z.string().min(1).max(100),
            startMonth: month,
            startDay: dayOfMonth,
            endMonth: month,
            endDay: dayOfMonth,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type CreateSeasonSetInput = z.infer<typeof createSeasonSetSchema>;
export type UpdateSeasonSetInput = z.infer<typeof updateSeasonSetSchema>;
export type SeasonSetQuery = z.infer<typeof seasonSetQuerySchema>;
export type PutSeasonsInput = z.infer<typeof putSeasonsSchema>;
