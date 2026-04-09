import type { FastifyInstance } from "fastify";
import * as attachmentService from "../services/attachment.service.js";

export async function attachmentRoutes(app: FastifyInstance) {
  // List attachments for an entity
  app.get("/api/v1/attachments", async (request) => {
    const { utilityId } = request.user;
    const { entityType, entityId } = request.query as { entityType: string; entityId: string };
    return attachmentService.listAttachments(utilityId, entityType, entityId);
  });

  // Upload attachment
  app.post("/api/v1/attachments", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const data = await request.file();
    if (!data) {
      reply.status(400).send({ error: { code: "NO_FILE", message: "No file uploaded" } });
      return;
    }

    const { entityType, entityId, description } = data.fields as any;
    const entityTypeVal = typeof entityType === "object" ? entityType.value : entityType;
    const entityIdVal = typeof entityId === "object" ? entityId.value : entityId;
    const descVal = typeof description === "object" ? description.value : description;

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
  app.get("/api/v1/attachments/:id/download", async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = request.params as { id: string };
    const { attachment, buffer } = await attachmentService.getAttachmentFile(id, utilityId);

    reply
      .header("Content-Type", attachment.fileType)
      .header("Content-Disposition", `attachment; filename="${attachment.fileName}"`)
      .send(buffer);
  });

  // Delete attachment
  app.delete("/api/v1/attachments/:id", async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = request.params as { id: string };
    await attachmentService.deleteAttachment(id, utilityId);
    reply.status(204).send();
  });
}
