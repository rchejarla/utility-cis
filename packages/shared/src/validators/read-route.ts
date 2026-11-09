import { z } from "zod";
import { baseListQuerySchema, paginationMetaSchema, queryBoolean } from "../lib/base-list-query";

/**
 * A read route: the ordered walk a meter reader makes (spec 08, read
 * routes design §5.1).
 *
 * `origin` says who owns the route's contents. A LOCAL route is built
 * here, stop by stop. An EXTERNAL one was named by a vendor's reading
 * system and arrived as a code on an imported read — it exists as a row
 * so reads can point at it, and starts with no stops because the vendor,
 * not this system, decides what is on it.
 */
export const READ_ROUTE_ORIGINS = ["LOCAL", "EXTERNAL"] as const;
export type ReadRouteOrigin = (typeof READ_ROUTE_ORIGINS)[number];

export const readRouteInputSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(255),
  billingCycleId: z.string().uuid(),
  origin: z.enum(READ_ROUTE_ORIGINS).default("LOCAL"),
  active: z.boolean().default(true),
});
export type ReadRouteInput = z.infer<typeof readRouteInputSchema>;

export const readRouteSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  billingCycleId: z.string().uuid(),
  origin: z.enum(READ_ROUTE_ORIGINS),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ReadRoute = z.infer<typeof readRouteSchema>;

export const readRouteSummarySchema = readRouteSchema.extend({
  stopCount: z.number().int().nonnegative(),
  cycleCode: z.string(),
});
export type ReadRouteSummary = z.infer<typeof readRouteSummarySchema>;

export const readRouteQuerySchema = baseListQuerySchema.extend({
  billingCycleId: z.string().uuid().optional(),
  origin: z.enum(READ_ROUTE_ORIGINS).optional(),
  active: queryBoolean.optional(),
});
export type ReadRouteQuery = z.infer<typeof readRouteQuerySchema>;

export const readRouteListResponseSchema = z.object({
  data: z.array(readRouteSummarySchema),
  meta: paginationMetaSchema,
});
export type ReadRouteListResponse = z.infer<typeof readRouteListResponseSchema>;
