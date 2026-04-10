import type { FastifyInstance } from "fastify";
import { createPremiseSchema, updatePremiseSchema, premiseQuerySchema } from "@utility-cis/shared";
import {
  listPremises,
  getPremise,
  getPremisesGeo,
  createPremise,
  updatePremise,
} from "../services/premise.service.js";

export async function premiseRoutes(app: FastifyInstance) {
  app.get("/api/v1/premises", { config: { module: "premises", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const query = premiseQuerySchema.parse(request.query);
    const result = await listPremises(utilityId, query);
    return reply.send(result);
  });

  app.get("/api/v1/premises/geo", { config: { module: "premises", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const geoJson = await getPremisesGeo(utilityId);
    return reply.send(geoJson);
  });

  app.get("/api/v1/premises/:id", { config: { module: "premises", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = request.params as { id: string };
    const premise = await getPremise(id, utilityId);
    return reply.send(premise);
  });

  app.post("/api/v1/premises", { config: { module: "premises", permission: "CREATE" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const data = createPremiseSchema.parse(request.body);
    const premise = await createPremise(utilityId, actorId, actorName, data);
    return reply.status(201).send(premise);
  });

  app.patch("/api/v1/premises/:id", { config: { module: "premises", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = request.params as { id: string };
    const data = updatePremiseSchema.parse(request.body);
    const premise = await updatePremise(utilityId, actorId, actorName, id, data);
    return reply.send(premise);
  });
}
