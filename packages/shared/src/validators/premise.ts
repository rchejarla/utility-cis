import { z } from "zod";

export const premiseTypeEnum = z.enum(["RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", "MUNICIPAL"]);
export const premiseStatusEnum = z.enum(["ACTIVE", "INACTIVE", "CONDEMNED"]);

export const premiseSortFields = [
  "createdAt",
  "updatedAt",
  "addressLine1",
  "city",
  "state",
  "zip",
  "premiseType",
  "status",
] as const;

export const createPremiseSchema = z.object({
  addressLine1: z.string().min(1).max(255),
  addressLine2: z.string().max(255).optional(),
  city: z.string().min(1).max(100),
  state: z.string().length(2),
  zip: z.string().min(5).max(10),
  geoLat: z.number().min(-90).max(90).optional(),
  geoLng: z.number().min(-180).max(180).optional(),
  premiseType: premiseTypeEnum,
  commodityIds: z.array(z.string().uuid()).min(1),
  serviceTerritoryId: z.string().uuid().optional(),
  municipalityCode: z.string().max(50).optional(),
  ownerId: z.string().uuid().optional(),
  status: premiseStatusEnum.default("ACTIVE"),
  // Tenant-configurable custom fields. Validated server-side.
  customFields: z.record(z.unknown()).optional(),
}).strict();

// Update schemas intentionally strip unknown keys (forgiving PATCH semantics).
export const updatePremiseSchema = createPremiseSchema.partial();

export const premiseQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(premiseSortFields).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  status: premiseStatusEnum.optional(),
  premiseType: premiseTypeEnum.optional(),
  serviceTerritoryId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  search: z.string().optional(),
}).strict();

export type PremiseType = z.infer<typeof premiseTypeEnum>;
export type PremiseStatus = z.infer<typeof premiseStatusEnum>;
export type CreatePremiseInput = z.infer<typeof createPremiseSchema>;
export type UpdatePremiseInput = z.infer<typeof updatePremiseSchema>;
export type PremiseQuery = z.infer<typeof premiseQuerySchema>;
