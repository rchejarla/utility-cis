import { z } from "zod";

export const userSortFields = [
  "createdAt",
  "updatedAt",
  "name",
  "email",
  "isActive",
] as const;

export const createUserSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(255),
  roleId: z.string().uuid(),
  externalId: z.string().max(255).optional(),
  customerId: z.string().uuid().optional(),
  isActive: z.boolean().default(true),
}).strict();

// Update schemas intentionally strip unknown keys (forgiving PATCH semantics).
export const updateUserSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  roleId: z.string().uuid().optional(),
  isActive: z.boolean().optional(),
});

export const userQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  sort: z.enum(userSortFields).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  search: z.string().optional(),
  roleId: z.string().uuid().optional(),
  isActive: z.coerce.boolean().optional(),
}).strict();

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UserQuery = z.infer<typeof userQuerySchema>;
