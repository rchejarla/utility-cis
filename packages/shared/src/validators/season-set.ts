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
