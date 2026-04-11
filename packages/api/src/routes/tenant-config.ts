import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  parseTemplate,
  brandingSettingsSchema,
  notificationSettingsSchema,
  retentionSettingsSchema,
  billingIntegrationSettingsSchema,
} from "@utility-cis/shared";
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

// Top-level PATCH body. In addition to the existing `requireHoldApproval`,
// `numberFormats`, and generic `settings` passthrough, each of the new
// settings-page namespaces (branding, notifications, retention, billing)
// can be patched independently. Each namespace is shallow-merged into
// `settings.<namespace>` so unrelated keys are preserved.
const updateBodySchema = z
  .object({
    requireHoldApproval: z.boolean().optional(),
    numberFormats: numberFormatsSchema.optional(),
    settings: z.record(z.unknown()).optional(),
    branding: brandingSettingsSchema.optional(),
    notifications: notificationSettingsSchema.optional(),
    retention: retentionSettingsSchema.optional(),
    billing: billingIntegrationSettingsSchema.optional(),
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

      // Namespaces all live inside the `settings` jsonb bucket so the
      // TenantConfig Prisma model doesn't need per-namespace columns.
      // Merge each patched namespace into its slot in the existing
      // settings object so unrelated keys stay intact.
      const merged: Parameters<typeof updateTenantConfig>[1] = {
        requireHoldApproval: patch.requireHoldApproval,
      };
      const touchesSettings =
        patch.numberFormats !== undefined ||
        patch.settings !== undefined ||
        patch.branding !== undefined ||
        patch.notifications !== undefined ||
        patch.retention !== undefined ||
        patch.billing !== undefined;

      if (touchesSettings) {
        const current = await getTenantConfig(utilityId);
        const nextSettings: Record<string, unknown> = {
          ...current.settings,
          ...(patch.settings ?? {}),
        };
        if (patch.numberFormats !== undefined) {
          nextSettings.numberFormats = patch.numberFormats;
        }
        if (patch.branding !== undefined) {
          nextSettings.branding = {
            ...(current.settings.branding as Record<string, unknown> | undefined),
            ...patch.branding,
          };
        }
        if (patch.notifications !== undefined) {
          nextSettings.notifications = {
            ...(current.settings.notifications as Record<string, unknown> | undefined),
            ...patch.notifications,
          };
        }
        if (patch.retention !== undefined) {
          nextSettings.retention = {
            ...(current.settings.retention as Record<string, unknown> | undefined),
            ...patch.retention,
          };
        }
        if (patch.billing !== undefined) {
          nextSettings.billing = {
            ...(current.settings.billing as Record<string, unknown> | undefined),
            ...patch.billing,
          };
        }
        merged.settings = nextSettings;
      }

      return reply.send(await updateTenantConfig(utilityId, merged));
    },
  );
}
