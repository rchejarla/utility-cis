import type { FastifyInstance } from "fastify";
import {
  createNotificationTemplateSchema,
  updateNotificationTemplateSchema,
  notificationTemplateQuerySchema,
  notificationQuerySchema,
  manualSendSchema,
  previewSchema,
} from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { paginatedTenantList } from "../lib/pagination.js";
import { sendNotification, previewTemplate } from "../services/notification.service.js";

export async function notificationRoutes(app: FastifyInstance) {
  // ─── Template CRUD ─────────────────────────────────────────────

  app.get(
    "/api/v1/notification-templates",
    { config: { module: "settings", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = notificationTemplateQuerySchema.parse(request.query);

      const where: Record<string, unknown> = { utilityId };
      if (query.eventType) where.eventType = query.eventType;
      if (query.isActive !== undefined) where.isActive = query.isActive;

      return reply.send(
        await paginatedTenantList(prisma.notificationTemplate, where, query),
      );
    },
  );

  app.post(
    "/api/v1/notification-templates",
    { config: { module: "settings", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const data = createNotificationTemplateSchema.parse(request.body);

      const template = await prisma.notificationTemplate.create({
        data: {
          utilityId,
          name: data.name,
          eventType: data.eventType,
          description: data.description,
          channels: data.channels as object,
          variables: data.variables as object[],
          isActive: data.isActive,
        },
      });

      return reply.status(201).send(template);
    },
  );

  app.get(
    "/api/v1/notification-templates/:id",
    { config: { module: "settings", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = request.params as { id: string };

      const template = await prisma.notificationTemplate.findFirst({
        where: { id, utilityId },
      });

      if (!template) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "Template not found" },
        });
      }

      return reply.send(template);
    },
  );

  app.patch(
    "/api/v1/notification-templates/:id",
    { config: { module: "settings", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = request.params as { id: string };
      const data = updateNotificationTemplateSchema.parse(request.body);

      const updateData: Record<string, unknown> = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.description !== undefined) updateData.description = data.description;
      if (data.channels !== undefined) updateData.channels = data.channels as object;
      if (data.variables !== undefined) updateData.variables = data.variables as object[];
      if (data.isActive !== undefined) updateData.isActive = data.isActive;

      const template = await prisma.notificationTemplate.update({
        where: { id, utilityId },
        data: updateData,
      });

      return reply.send(template);
    },
  );

  app.delete(
    "/api/v1/notification-templates/:id",
    { config: { module: "settings", permission: "DELETE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = request.params as { id: string };

      await prisma.notificationTemplate.update({
        where: { id, utilityId },
        data: { isActive: false },
      });

      return reply.status(204).send();
    },
  );

  // ─── Preview ───────────────────────────────────────────────────

  app.post(
    "/api/v1/notification-templates/:id/preview",
    { config: { module: "settings", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = request.params as { id: string };
      const { sampleContext } = previewSchema.parse(request.body ?? {});

      const result = await previewTemplate(utilityId, id, sampleContext);
      if (!result) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "Template not found or has no channel content" },
        });
      }

      return reply.send(result);
    },
  );

  // ─── Send log ──────────────────────────────────────────────────

  app.get(
    "/api/v1/notifications",
    { config: { module: "settings", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = notificationQuerySchema.parse(request.query);

      const where: Record<string, unknown> = { utilityId };
      if (query.status) where.status = query.status;
      if (query.channel) where.channel = query.channel;
      if (query.customerId) where.customerId = query.customerId;
      if (query.eventType) where.eventType = query.eventType;

      return reply.send(
        await paginatedTenantList(prisma.notification, where, query, {
          include: { template: { select: { name: true, eventType: true } } },
        }),
      );
    },
  );

  app.get(
    "/api/v1/notifications/:id",
    { config: { module: "settings", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = request.params as { id: string };

      const notification = await prisma.notification.findFirst({
        where: { id, utilityId },
        include: { template: { select: { name: true, eventType: true } } },
      });

      if (!notification) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "Notification not found" },
        });
      }

      return reply.send(notification);
    },
  );

  // ─── Manual send ───────────────────────────────────────────────

  app.post(
    "/api/v1/notifications/send",
    { config: { module: "settings", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const data = manualSendSchema.parse(request.body);

      const notificationId = await sendNotification(utilityId, {
        eventType: data.eventType,
        channel: data.channel,
        recipientId: data.recipientId,
        context: data.context,
      });

      if (!notificationId) {
        return reply.status(400).send({
          error: {
            code: "SEND_FAILED",
            message: "Template not found, inactive, or missing channel content for the requested channel",
          },
        });
      }

      return reply.status(201).send({ notificationId });
    },
  );
}
