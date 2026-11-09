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
/** The parsed shape: defaults live in the schema alone, so callers parse before calling the service. */
export type ReadRouteInput = z.infer<typeof readRouteInputSchema>;

/**
 * What an update may change. `origin` is not here on purpose: it is
 * decided at creation (LOCAL by hand, EXTERNAL by the importer) and
 * changing it reassigns who owns the itinerary. Claiming a vendor route
 * as local is a deliberate operation with its own endpoint and audit
 * event, not a PATCH field.
 */
export const readRouteUpdateSchema = readRouteInputSchema.omit({ origin: true }).partial();
export type ReadRouteUpdate = z.infer<typeof readRouteUpdateSchema>;

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

/** Ordered by code, always: `sort` and `order` are omitted so the contract says what it does. */
export const readRouteQuerySchema = baseListQuerySchema.omit({ sort: true, order: true }).extend({
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

/**
 * Where a stop goes. Omitted `afterSequence` appends; `0` inserts at the
 * front; otherwise the stop lands between the one at that sequence and
 * whatever follows it. The caller names a position by the number it can
 * see on screen, not by an id, because the sequence is what it sorts by.
 */
export const readRouteStopInputSchema = z.object({
  premiseId: z.string().uuid(),
  afterSequence: z.number().int().nonnegative().optional(),
});
export type ReadRouteStopInput = z.infer<typeof readRouteStopInputSchema>;

/** A stop is a premise on a route; sequences are gapped integers (step 100), so only their order means anything. */
export const readRouteStopSchema = z.object({
  id: z.string().uuid(),
  readRouteId: z.string().uuid(),
  premiseId: z.string().uuid(),
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
});
export type ReadRouteStop = z.infer<typeof readRouteStopSchema>;

/** The tray's filter: ordered by address, always, so `sort` and `order` are omitted. */
export const unsequencedPremiseQuerySchema = baseListQuerySchema.omit({ sort: true, order: true });
export type UnsequencedPremiseQuery = z.infer<typeof unsequencedPremiseQuerySchema>;

/** Enough of a premise to recognise it in the tray; not the whole row. */
export const premiseSummarySchema = z.object({
  id: z.string().uuid(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  premiseType: z.string(),
});
export type PremiseSummary = z.infer<typeof premiseSummarySchema>;

export const unsequencedPremiseListResponseSchema = z.object({
  data: z.array(premiseSummarySchema),
  meta: paginationMetaSchema,
});
export type UnsequencedPremiseListResponse = z.infer<typeof unsequencedPremiseListResponseSchema>;
