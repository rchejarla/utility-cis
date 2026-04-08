import type { FastifyInstance } from "fastify";
import { updateThemeSchema } from "@utility-cis/shared";
import { getTheme, updateTheme, resetTheme } from "../services/theme.service.js";

export async function themeRoutes(app: FastifyInstance) {
  app.get("/api/v1/theme", async (request, reply) => {
    const { utilityId } = request.user;
    const theme = await getTheme(utilityId);
    return reply.send(theme);
  });

  app.put("/api/v1/theme", async (request, reply) => {
    const { utilityId } = request.user;
    const data = updateThemeSchema.parse(request.body);
    const theme = await updateTheme(utilityId, data);
    return reply.send(theme);
  });

  app.post("/api/v1/theme/reset", async (request, reply) => {
    const { utilityId } = request.user;
    const theme = await resetTheme(utilityId);
    return reply.send(theme);
  });
}
