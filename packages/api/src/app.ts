import Fastify from "fastify";
import cors from "@fastify/cors";
import { authMiddleware } from "./middleware/auth.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { errorHandler } from "./middleware/error-handler.js";
import { startAuditWriter } from "./events/audit-writer.js";

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

  startAuditWriter();

  return app;
}
