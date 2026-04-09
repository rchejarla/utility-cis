import type { FastifyInstance } from "fastify";
import {
  createServiceAgreementSchema,
  updateServiceAgreementSchema,
  serviceAgreementQuerySchema,
} from "@utility-cis/shared";
import {
  listServiceAgreements,
  getServiceAgreement,
  createServiceAgreement,
  updateServiceAgreement,
  addMeterToAgreement,
  removeMeterFromAgreement,
} from "../services/service-agreement.service.js";

export async function serviceAgreementRoutes(app: FastifyInstance) {
  app.get("/api/v1/service-agreements", async (request, reply) => {
    const { utilityId } = request.user;
    const query = serviceAgreementQuerySchema.parse(request.query);
    const result = await listServiceAgreements(utilityId, query);
    return reply.send(result);
  });

  app.get("/api/v1/service-agreements/:id", async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = request.params as { id: string };
    const agreement = await getServiceAgreement(id, utilityId);
    return reply.send(agreement);
  });

  app.post("/api/v1/service-agreements", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const data = createServiceAgreementSchema.parse(request.body);
    const agreement = await createServiceAgreement(utilityId, actorId, data);
    return reply.status(201).send(agreement);
  });

  app.patch("/api/v1/service-agreements/:id", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const { id } = request.params as { id: string };
    const data = updateServiceAgreementSchema.parse(request.body);
    const agreement = await updateServiceAgreement(utilityId, actorId, id, data);
    return reply.send(agreement);
  });

  // Add meter to agreement
  app.post("/api/v1/service-agreements/:id/meters", async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = request.params as { id: string };
    const { meterId } = request.body as { meterId: string };
    const sam = await addMeterToAgreement(utilityId, id, meterId);
    return reply.status(201).send(sam);
  });

  // Remove meter from agreement (set removedDate)
  app.patch("/api/v1/service-agreements/:id/meters/:samId", async (request, reply) => {
    const { utilityId } = request.user;
    const { samId } = request.params as { id: string; samId: string };
    const sam = await removeMeterFromAgreement(utilityId, samId);
    return reply.send(sam);
  });
}
