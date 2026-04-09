import { z } from "zod";
import { MODULES, PERMISSIONS } from "../modules/constants";

const permissionEnum = z.enum(PERMISSIONS);
const moduleEnum = z.enum(MODULES);

const permissionMapSchema = z.record(
  moduleEnum,
  z.array(permissionEnum)
).refine(
  (map) => {
    // BR-RB-004: CREATE/EDIT/DELETE require VIEW
    for (const [, perms] of Object.entries(map)) {
      if ((perms.includes("CREATE") || perms.includes("EDIT") || perms.includes("DELETE")) && !perms.includes("VIEW")) {
        return false;
      }
    }
    return true;
  },
  { message: "CREATE, EDIT, DELETE require VIEW permission (BR-RB-004)" }
);

export const createRoleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  permissions: permissionMapSchema,
});

export const updateRoleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  permissions: permissionMapSchema.optional(),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
