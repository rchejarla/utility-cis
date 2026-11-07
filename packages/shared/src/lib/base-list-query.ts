import { z } from "zod";

/**
 * Shared base shape for every list endpoint's query validator.
 *
 * Why this exists: `SearchableEntitySelect` (and any other picker
 * component) always attaches `limit`, `page`, and `search` parameters
 * to its fetch, regardless of whether the target endpoint pages or
 * searches. If a list route defines its query validator with
 * `.strict()` and omits these keys, the picker gets a 400 the moment
 * it mounts — even against small reference-table routes where
 * pagination is irrelevant.
 *
 * By defining the base once and having every list route extend it,
 * the picker's standard parameters are always accepted (and ignored
 * when they're not meaningful). Each route adds its own entity-
 * specific filters on top and keeps `.strict()` so truly unknown
 * keys still get rejected.
 *
 * Usage:
 *
 *   import { baseListQuerySchema } from "@utility-cis/shared";
 *
 *   export const suspensionTypeDefQuerySchema = baseListQuerySchema
 *     .extend({ includeInactive: queryBoolean.optional() })
 *     .strict();
 *
 * Note `queryBoolean` and **not** `z.coerce.boolean()`, which this
 * example recommended until 2026-11-07 — see below.
 *
 * Don't extend this for endpoints that are conceptually single-value
 * reads (e.g. `/api/v1/tenant-config`) — there's no list to page. Only
 * use it on routes that return a collection.
 */
export const baseListQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  search: z.string().optional(),
  sort: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

export type BaseListQuery = z.infer<typeof baseListQuerySchema>;

/**
 * A boolean filter that survives a URL.
 *
 * **Never `z.coerce.boolean()` for anything that arrives as a string.**
 * That is `Boolean(input)`, and a query string carries strings:
 * `Boolean("false")` is `true`. A two-option filter written that way
 * answers "yes" to both of its options, so the option that looks broken
 * returns the other one's rows and the option that looks fine was never
 * tested against its opposite.
 *
 * It cost a real bug twice. The rate-schedule list's Inactive option
 * returned the active set, which is in that file's comment; and the
 * Meter Reads screen's Exceptions and Billed pills showed rows only
 * with no filter applied, reported 2026-11-07 — both of their options
 * asked for reads *with* an exception, and a seeded database has none,
 * so a filter that had never worked looked like an empty table. On a
 * list screen, a filter that returns nothing reads as "there is
 * nothing", which is why this class of fault survives.
 *
 * Accepts a real boolean as well, since the same validators parse JSON
 * bodies, and **refuses everything else** rather than mapping it to
 * `true` or `false`. A lenient version would keep the fault alive in a
 * quieter form: there would still be no wrong answer to see, only a
 * list that looked complete.
 */
export const queryBoolean = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((v) => v === "true"),
]);
