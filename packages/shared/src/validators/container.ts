import { z } from "zod";

export const containerTypeEnum = z.enum([
  "CART_GARBAGE",
  "CART_RECYCLING",
  "CART_ORGANICS",
  "CART_YARD_WASTE",
  "DUMPSTER",
  "ROLL_OFF",
]);

export const containerStatusEnum = z.enum([
  "ACTIVE",
  "SUSPENDED",
  "RETURNED",
  "LOST",
  "DAMAGED",
]);

export const containerSortFields = [
  "createdAt",
  "deliveryDate",
  "status",
  "sizeGallons",
  "containerType",
] as const;

export const createContainerSchema = z.object({
  premiseId: z.string().uuid(),
  serviceAgreementId: z.string().uuid().optional(),
  containerType: containerTypeEnum,
  sizeGallons: z.number().int().positive(),
  quantity: z.number().int().positive().default(1),
  serialNumber: z.string().max(100).optional(),
  rfidTag: z.string().max(100).optional(),
  deliveryDate: z.string().date(),
  ramsContainerId: z.string().max(100).optional(),
  locationNotes: z.string().max(500).optional(),
}).strict();

export const updateContainerSchema = createContainerSchema
  .omit({ premiseId: true })
  .partial()
  .extend({
    status: containerStatusEnum.optional(),
    removalDate: z.string().date().optional(),
  });

/** Container swap: records an upgrade or downgrade of container size. */
export const swapContainerSchema = z.object({
  newSizeGallons: z.number().int().positive(),
  newContainerType: containerTypeEnum.optional(),
  swapDate: z.string().date(),
  reason: z.string().max(500).optional(),
}).strict();

export const containerQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(containerSortFields).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  premiseId: z.string().uuid().optional(),
  serviceAgreementId: z.string().uuid().optional(),
  containerType: containerTypeEnum.optional(),
  status: containerStatusEnum.optional(),
  search: z.string().optional(),
}).strict();

export type ContainerType = z.infer<typeof containerTypeEnum>;
export type ContainerStatus = z.infer<typeof containerStatusEnum>;
export type CreateContainerInput = z.infer<typeof createContainerSchema>;
export type UpdateContainerInput = z.infer<typeof updateContainerSchema>;
export type SwapContainerInput = z.infer<typeof swapContainerSchema>;
export type ContainerQuery = z.infer<typeof containerQuerySchema>;
