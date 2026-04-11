import { z } from "zod";

export const customerTypeEnum = z.enum(["INDIVIDUAL", "ORGANIZATION"]);
export const customerStatusEnum = z.enum(["ACTIVE", "INACTIVE"]);

const customerBaseSchema = z.object({
  customerType: customerTypeEnum,
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  organizationName: z.string().max(255).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(20).optional(),
  altPhone: z.string().max(20).optional(),
  dateOfBirth: z.string().date().optional(),
  driversLicense: z.string().max(50).optional(),
  taxId: z.string().max(50).optional(),
  status: customerStatusEnum.default("ACTIVE"),
  // Passthrough bucket for tenant-configurable custom fields. The
  // per-field shape is validated at the service layer by
  // validateCustomFields against the tenant's custom_field_schema
  // row — not here, because this static Zod schema has no knowledge
  // of what fields the tenant has configured.
  customFields: z.record(z.unknown()).optional(),
});

export const customerSortFields = [
  "createdAt",
  "updatedAt",
  "lastName",
  "organizationName",
  "status",
  "customerType",
] as const;

export const createCustomerSchema = customerBaseSchema.strict().refine(
  (data) => {
    if (data.customerType === "INDIVIDUAL") return !!data.firstName && !!data.lastName;
    if (data.customerType === "ORGANIZATION") return !!data.organizationName;
    return true;
  },
  { message: "Individual requires firstName+lastName; Organization requires organizationName" }
);

// Note: update schemas intentionally strip unknown keys instead of rejecting
// them. This gives PATCH callers forgiving semantics — e.g. a client that
// POSTs back the full object after editing one field won't 400 on fields
// it doesn't own (like customerType or id). Create schemas stay strict.
export const updateCustomerSchema = customerBaseSchema
  .partial()
  .omit({ customerType: true });

export const customerQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(customerSortFields).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  customerType: customerTypeEnum.optional(),
  status: customerStatusEnum.optional(),
  search: z.string().optional(),
}).strict();

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type CustomerQuery = z.infer<typeof customerQuerySchema>;
