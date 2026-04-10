import type { FastifyInstance } from "fastify";
import {
  createServiceAgreementSchema,
  updateServiceAgreementSchema,
  serviceAgreementQuerySchema,
  addMeterToAgreementSchema,
} from "@utility-cis/shared";
import { z } from "zod";
import { idParamSchema } from "../lib/route-schemas.js";

const samParamSchema = z.object({
  id: z.string().uuid(),
  samId: z.string().uuid(),
});
import {
  listServiceAgreements,
  getServiceAgreement,
  createServiceAgreement,
  updateServiceAgreement,
  addMeterToAgreement,
  removeMeterFromAgreement,
} from "../services/service-agreement.service.js";

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

  // Add meter to agreement
  app.post("/api/v1/service-agreements/:id/meters", { config: { module: "agreements", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const { meterId } = addMeterToAgreementSchema.parse(request.body);
    const sam = await addMeterToAgreement(utilityId, id, meterId);
    return reply.status(201).send(sam);
  });

  // Remove meter from agreement (set removedDate)
  app.patch("/api/v1/service-agreements/:id/meters/:samId", { config: { module: "agreements", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { samId } = samParamSchema.parse(request.params);
    const sam = await removeMeterFromAgreement(utilityId, samId);
    return reply.send(sam);
  });
}
