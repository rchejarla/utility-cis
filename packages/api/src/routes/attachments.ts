import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ATTACHMENT_ENTITY_TYPES } from "@utility-cis/shared";
import { idParamSchema } from "../lib/route-schemas.js";
import * as attachmentService from "../services/attachment.service.js";

const attachmentQuerySchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityId: z.string().uuid(),
}).strict();

const attachmentUploadFieldsSchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityId: z.string().uuid(),
  description: z.string().max(500).optional(),
});

export async function attachmentRoutes(app: FastifyInstance) {
  // List attachments for an entity
  app.get("/api/v1/attachments", { config: { module: "attachments", permission: "VIEW" } }, async (request) => {
    const { utilityId } = request.user;
    const { entityType, entityId } = attachmentQuerySchema.parse(request.query);
    return attachmentService.listAttachments(utilityId, entityType, entityId);
  });

  // Upload attachment
  app.post("/api/v1/attachments", { config: { module: "attachments", permission: "CREATE" } }, async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const data = await request.file();
    if (!data) {
      reply.status(400).send({ error: { code: "NO_FILE", message: "No file uploaded" } });
      return;
    }

    const fields = data.fields as Record<string, any>;

    // @fastify/multipart returns fields as { value: string } objects
    const getField = (name: string): string | undefined => {
      const f = fields[name];
      if (!f) return undefined;
      if (typeof f === "string") return f;
      if (f && typeof f === "object" && "value" in f) return f.value;
      return String(f);
    };

    const parsedFields = attachmentUploadFieldsSchema.safeParse({
      entityType: getField("entityType"),
      entityId: getField("entityId"),
      description: getField("description"),
    });
    if (!parsedFields.success) {
      reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid upload fields",
          details: parsedFields.error.errors.map((e) => ({
            field: e.path.join("."),
            message: e.message,
          })),
        },
      });
      return;
    }

    const buffer = await data.toBuffer();

    const attachment = await attachmentService.uploadAttachment(
      utilityId,
      actorId,
      parsedFields.data.entityType,
      parsedFields.data.entityId,
      data.filename,
      data.mimetype,
      buffer,
      parsedFields.data.description
    );

    reply.status(201).send(attachment);
  });

  // Download attachment
  app.get("/api/v1/attachments/:id/download", { config: { module: "attachments", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const { attachment, buffer } = await attachmentService.getAttachmentFile(id, utilityId);

    reply
      .header("Content-Type", attachment.fileType)
      .header("Content-Disposition", `attachment; filename="${attachment.fileName}"`)
      .send(buffer);
  });

  // Delete attachment
  app.delete("/api/v1/attachments/:id", { config: { module: "attachments", permission: "DELETE" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    await attachmentService.deleteAttachment(id, utilityId);
    reply.status(204).send();
  });
}
