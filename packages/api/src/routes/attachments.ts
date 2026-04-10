import type { FastifyInstance } from "fastify";
import * as attachmentService from "../services/attachment.service.js";

export async function attachmentRoutes(app: FastifyInstance) {
  // List attachments for an entity
  app.get("/api/v1/attachments", { config: { module: "attachments", permission: "VIEW" } }, async (request) => {
    const { utilityId } = request.user;
    const { entityType, entityId } = request.query as { entityType: string; entityId: string };
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

    const entityTypeVal = getField("entityType");
    const entityIdVal = getField("entityId");
    const descVal = getField("description");

    if (!entityTypeVal || !entityIdVal) {
      reply.status(400).send({ error: { code: "MISSING_FIELDS", message: "entityType and entityId are required" } });
      return;
    }

    const buffer = await data.toBuffer();

    const attachment = await attachmentService.uploadAttachment(
      utilityId,
      actorId,
      entityTypeVal,
      entityIdVal,
      data.filename,
      data.mimetype,
      buffer,
      descVal || undefined
    );

    reply.status(201).send(attachment);
  });

  // Download attachment
  app.get("/api/v1/attachments/:id/download", { config: { module: "attachments", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = request.params as { id: string };
    const { attachment, buffer } = await attachmentService.getAttachmentFile(id, utilityId);

    reply
      .header("Content-Type", attachment.fileType)
      .header("Content-Disposition", `attachment; filename="${attachment.fileName}"`)
      .send(buffer);
  });

  // Delete attachment
  app.delete("/api/v1/attachments/:id", { config: { module: "attachments", permission: "DELETE" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = request.params as { id: string };
    await attachmentService.deleteAttachment(id, utilityId);
    reply.status(204).send();
  });
}
