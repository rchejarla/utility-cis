import Fastify from "fastify";
import cors from "@fastify/cors";
import { authMiddleware } from "./middleware/auth.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { errorHandler } from "./middleware/error-handler.js";
import { startAuditWriter } from "./events/audit-writer.js";
import { commodityRoutes } from "./routes/commodities.js";
import { uomRoutes } from "./routes/uom.js";
import { premiseRoutes } from "./routes/premises.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.WEB_URL || "http://localhost:3000",
  });

  app.setErrorHandler(errorHandler);

  app.addHook("onRequest", authMiddleware);
  app.addHook("onRequest", tenantMiddleware);

  app.get("/health", { config: { skipAuth: true } }, async (_request, reply) => {
    return reply.send({ status: "ok" });
  });

  await app.register(commodityRoutes);
  await app.register(uomRoutes);
  await app.register(premiseRoutes);

  startAuditWriter();

  return app;
}
