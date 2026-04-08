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
} from "../services/service-agreement.service.js";

export async function serviceAgreementRoutes(app: FastifyInstance) {
  app.get("/api/v1/service-agreements", async (request, reply) => {
    const { utilityId } = request.user;
    const query = serviceAgreementQuerySchema.parse(request.query);
    const result = await listServiceAgreements(utilityId, query);
    return reply.send(result);
  });

  app.get("/api/v1/service-agreements/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agreement = await getServiceAgreement(id);
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
}
