import type { FastifyInstance } from "fastify";
import {
  createServiceAgreementSchema,
  updateServiceAgreementSchema,
  serviceAgreementQuerySchema,
  addMeterToAgreementSchema,
  closeServiceAgreementSchema,
  removeMeterFromAgreementSchema,
  swapMeterSchema,
} from "@utility-cis/shared";
import { z } from "zod";
import { idParamSchema } from "../lib/route-schemas.js";

const meterIdParamSchema = z.object({
  id: z.string().uuid(),
  meterId: z.string().uuid(),
});
import {
  listServiceAgreements,
  getServiceAgreement,
  createServiceAgreement,
  updateServiceAgreement,
  addMeterToAgreement,
} from "../services/service-agreement.service.js";
import {
  closeServiceAgreement,
  removeMeterFromAgreement,
  swapMeter,
} from "../services/effective-dating.service.js";

export async function serviceAgreementRoutes(app: FastifyInstance) {
  app.get("/api/v1/service-agreements", { config: { module: "agreements", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const query = serviceAgreementQuerySchema.parse(request.query);
    const result = await listServiceAgreements(utilityId, query);
    return reply.send(result);
  });

  app.get("/api/v1/service-agreements/:id", { config: { module: "agreements", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const agreement = await getServiceAgreement(id, utilityId);
    return reply.send(agreement);
  });

  app.post("/api/v1/service-agreements", { config: { module: "agreements", permission: "CREATE" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const data = createServiceAgreementSchema.parse(request.body);
    const agreement = await createServiceAgreement(utilityId, actorId, actorName, data);
    return reply.status(201).send(agreement);
  });

  app.patch("/api/v1/service-agreements/:id", { config: { module: "agreements", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = updateServiceAgreementSchema.parse(request.body);
    const agreement = await updateServiceAgreement(utilityId, actorId, actorName, id, data);
    return reply.send(agreement);
  });

  // Cascading close: terminal-status the SA AND set removed_date on
  // every still-open meter assignment, in one transaction. Replaces
  // the now-rejected lifecycle fields on PATCH.
  app.post(
    "/api/v1/service-agreements/:id/close",
    { config: { module: "agreements", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = closeServiceAgreementSchema.parse(request.body);
      const result = await closeServiceAgreement(utilityId, actorId, actorName, {
        saId: id,
        endDate: new Date(data.endDate),
        status: data.status,
        reason: data.reason,
      });
      return reply.send(result);
    },
  );

  // Add meter to agreement
  app.post("/api/v1/service-agreements/:id/meters", { config: { module: "agreements", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const { meterId } = addMeterToAgreementSchema.parse(request.body);
    const sam = await addMeterToAgreement(utilityId, id, meterId);
    return reply.status(201).send(sam);
  });

  // Remove meter from agreement: closes the assignment by setting
  // removed_date. Audit-emitting variant; replaces the prior
  // PATCH /:id/meters/:samId route which silently dropped audit rows.
  app.post(
    "/api/v1/service-agreements/:id/meters/:meterId/remove",
    { config: { module: "agreements", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id, meterId } = meterIdParamSchema.parse(request.params);
      const data = removeMeterFromAgreementSchema.parse(request.body);
      const sam = await removeMeterFromAgreement(utilityId, actorId, actorName, {
        saId: id,
        meterId,
        removedDate: new Date(data.removedDate),
        reason: data.reason,
      });
      return reply.send(sam);
    },
  );

  // Atomic swap: closes the old SAM and opens a new one in the same
  // transaction with `added_date == removed_date == swapDate`.
  app.post(
    "/api/v1/service-agreements/:id/meters/swap",
    { config: { module: "agreements", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = swapMeterSchema.parse(request.body);
      const result = await swapMeter(utilityId, actorId, actorName, {
        saId: id,
        oldMeterId: data.oldMeterId,
        newMeterId: data.newMeterId,
        swapDate: new Date(data.swapDate),
        reason: data.reason,
      });
      return reply.send(result);
    },
  );
}
