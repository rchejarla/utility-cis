import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createImport,
  errorsAsCsv,
  getErrorSummary,
  getImport,
  getImportRows,
  listImports,
} from "../services/imports.service.js";
import { getKindHandler, listKinds } from "../imports/registry.js";
import { idParamSchema } from "../lib/route-schemas.js";
import { getUserRole, getTenantModules } from "../services/rbac.service.js";

/**
 * Generic import routes (spec 22). The kind handler resolves at
 * request time via `getKindHandler`, which means permission has to be
 * checked dynamically — the static `route.config.module/permission`
 * doesn't work because the kind isn't known until we read the body.
 *
 * For listing/detail/rows endpoints, the gate is the new `imports`
 * tenant module + an `imports.VIEW` permission that the seeded admin
 * role inherits.
 */

// ─── Helpers ────────────────────────────────────────────────────────

async function checkKindPermission(
  utilityId: string,
  userId: string,
  kindModule: string,
  kindPermission: "CREATE" | "EDIT",
): Promise<void> {
  const enabledModules = await getTenantModules(utilityId);
  if (!enabledModules.includes(kindModule)) {
    throw Object.assign(
      new Error(`Module "${kindModule}" is not enabled for this tenant`),
      { statusCode: 403, code: "MODULE_DISABLED" },
    );
  }
  const userRole = await getUserRole(userId, utilityId);
  if (!userRole) return; // backwards-compat fallback (matches authorization middleware)
  if (!userRole.isActive) {
    throw Object.assign(new Error("User account is deactivated"), {
      statusCode: 403,
      code: "USER_INACTIVE",
    });
  }
  const modulePerms = (userRole.permissions as Record<string, string[]>)[kindModule] ?? [];
  if (!modulePerms.includes(kindPermission)) {
    throw Object.assign(
      new Error(`Insufficient permissions: requires ${kindModule}:${kindPermission}`),
      { statusCode: 403, code: "FORBIDDEN" },
    );
  }
}

// Multipart fields are returned by @fastify/multipart as `{ value }`.
function readField(fields: Record<string, unknown>, name: string): string | undefined {
  const f = fields[name];
  if (!f) return undefined;
  if (typeof f === "string") return f;
  if (typeof f === "object" && "value" in (f as Record<string, unknown>)) {
    return String((f as Record<string, unknown>).value);
  }
  return String(f);
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  kind: z.string().optional(),
  status: z.enum(["PENDING", "PROCESSING", "COMPLETE", "FAILED", "PARTIAL", "CANCELLED"]).optional(),
  source: z.enum(["AMR", "AMI", "MANUAL_UPLOAD", "API"]).optional(),
  createdBy: z.string().uuid().optional(),
});

const rowsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  status: z.enum(["PENDING", "IMPORTED", "ERROR", "SKIPPED"]).optional(),
});

const kindParamSchema = z.object({ kind: z.string().min(1) });

// ─── Routes ─────────────────────────────────────────────────────────

export async function importRoutes(app: FastifyInstance) {
  // Kind metadata — drives the wizard's mapping UI.
  app.get(
    "/api/v1/imports/kinds",
    { config: { module: "imports", permission: "VIEW" } },
    async () => {
      return listKinds();
    },
  );

  app.get(
    "/api/v1/imports/kinds/:kind/fields",
    { config: { module: "imports", permission: "VIEW" } },
    async (request, reply) => {
      const { kind } = kindParamSchema.parse(request.params);
      try {
        const handler = getKindHandler(kind);
        return reply.send({
          kind: handler.kind,
          label: handler.label,
          canonicalFields: handler.canonicalFields,
        });
      } catch (err) {
        if (err && typeof err === "object" && "statusCode" in err) throw err;
        throw err;
      }
    },
  );

  // Template CSV — skipAuth so an <a href download> works without
  // attaching the Authorization header.
  app.get(
    "/api/v1/imports/kinds/:kind/template.csv",
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { kind } = kindParamSchema.parse(request.params);
      const handler = getKindHandler(kind);
      const headers = handler.canonicalFields.map((f) => f.name);
      const escape = (s: string) =>
        s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      const lines = [
        headers.map(escape).join(","),
        ...handler.templateRows.map((row) =>
          headers.map((h) => escape(row[h] ?? "")).join(","),
        ),
      ];
      reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="${handler.kind}-template.csv"`,
        )
        .send(lines.join("\n") + "\n");
    },
  );

  // Multipart create. Kind comes from the body so permission has to
  // be checked here, not via the route's static config.
  app.post(
    "/api/v1/imports",
    { config: { module: "imports", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;

      const data = await request.file();
      if (!data) {
        reply.status(400).send({ error: { code: "NO_FILE", message: "No file uploaded" } });
        return;
      }

      const fields = data.fields as Record<string, unknown>;
      const kind = readField(fields, "kind");
      const source = readField(fields, "source");
      const fileName = readField(fields, "fileName") ?? data.filename;
      const mappingRaw = readField(fields, "mapping");

      if (!kind || !source || !mappingRaw) {
        reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "kind, source, and mapping are required form fields",
          },
        });
        return;
      }

      let mapping: Record<string, string>;
      try {
        mapping = JSON.parse(mappingRaw);
      } catch {
        reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "mapping must be valid JSON" },
        });
        return;
      }

      // Kind-specific permission gate.
      const handler = getKindHandler(kind);
      await checkKindPermission(utilityId, actorId, handler.module, handler.permission);

      const buffer = await data.toBuffer();

      const result = await createImport(utilityId, actorId, actorName, {
        kind,
        source: source as "AMR" | "AMI" | "MANUAL_UPLOAD" | "API",
        fileName: fileName ?? "import.csv",
        fileType: data.mimetype,
        fileBuffer: buffer,
        mapping,
      });

      return reply.status(result.status === "FAILED" ? 200 : 200).send(result);
    },
  );

  // List
  app.get(
    "/api/v1/imports",
    { config: { module: "imports", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = listQuerySchema.parse(request.query);
      const result = await listImports(utilityId, query);
      return reply.send(result);
    },
  );

  // Detail
  app.get(
    "/api/v1/imports/:id",
    { config: { module: "imports", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const result = await getImport(utilityId, id);
      return reply.send(result);
    },
  );

  // Rows
  app.get(
    "/api/v1/imports/:id/rows",
    { config: { module: "imports", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const query = rowsQuerySchema.parse(request.query);
      const result = await getImportRows(utilityId, id, query);
      return reply.send(result);
    },
  );

  // Error summary
  app.get(
    "/api/v1/imports/:id/error-summary",
    { config: { module: "imports", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const result = await getErrorSummary(utilityId, id);
      return reply.send(result);
    },
  );

  // Errors as CSV
  app.get(
    "/api/v1/imports/:id/errors.csv",
    { config: { module: "imports", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const csv = await errorsAsCsv(utilityId, id);
      reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="import-${id}-errors.csv"`,
        )
        .send(csv);
    },
  );
}
