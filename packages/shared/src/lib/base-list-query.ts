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
 *     .extend({ includeInactive: z.coerce.boolean().optional() })
 *     .strict();
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
