import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseTemplate } from "@utility-cis/shared";
import { getTenantConfig, updateTenantConfig } from "../services/tenant-config.service.js";

// Per-entity number-format config. Validated via the shared template
// engine so an invalid template (missing seq token, bad width, etc.)
// is rejected at save time instead of blowing up at generation time.
const numberFormatSchema = z
  .object({
    template: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (t) => {
          try {
            parseTemplate(t);
            return true;
          } catch {
            return false;
          }
        },
        { message: "Invalid template (missing {seq} token or bad format)" },
      ),
    startAt: z.number().int().nonnegative().default(1),
  })
  .strict();

const numberFormatsSchema = z
  .object({
    agreement: numberFormatSchema.optional(),
    account: numberFormatSchema.optional(),
  })
  .strict();

const updateBodySchema = z
  .object({
    requireHoldApproval: z.boolean().optional(),
    numberFormats: numberFormatsSchema.optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .strict();

export async function tenantConfigRoutes(app: FastifyInstance) {
  // GET is authenticated-any — the web detail page reads this to decide
  // whether to show the Approve button. It carries no sensitive data.
  app.get("/api/v1/tenant-config", async (request, reply) => {
    const { utilityId } = request.user;
    return reply.send(await getTenantConfig(utilityId));
  });

  app.patch(
    "/api/v1/tenant-config",
    { config: { module: "settings", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const patch = updateBodySchema.parse(request.body);

      // numberFormats lives inside the settings jsonb bucket so the
      // TenantConfig Prisma model doesn't need per-format columns.
      // Merge it into the existing settings so unrelated keys aren't
      // clobbered by a format-only patch.
      const merged: Parameters<typeof updateTenantConfig>[1] = {
        requireHoldApproval: patch.requireHoldApproval,
      };
      if (patch.numberFormats || patch.settings) {
        const current = await getTenantConfig(utilityId);
        merged.settings = {
          ...current.settings,
          ...(patch.settings ?? {}),
          ...(patch.numberFormats !== undefined
            ? { numberFormats: patch.numberFormats }
            : {}),
        };
      }

      return reply.send(await updateTenantConfig(utilityId, merged));
    },
  );
}
