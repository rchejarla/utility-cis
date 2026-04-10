import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { authMiddleware } from "./middleware/auth.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { authorizationMiddleware } from "./middleware/authorization.js";
import { errorHandler } from "./middleware/error-handler.js";
import { startAuditWriter } from "./events/audit-writer.js";
import { commodityRoutes } from "./routes/commodities.js";
import { uomRoutes } from "./routes/uom.js";
import { premiseRoutes } from "./routes/premises.js";
import { meterRoutes } from "./routes/meters.js";
import { accountRoutes } from "./routes/accounts.js";
import { billingCycleRoutes } from "./routes/billing-cycles.js";
import { serviceAgreementRoutes } from "./routes/service-agreements.js";
import { rateScheduleRoutes } from "./routes/rate-schedules.js";
import { themeRoutes } from "./routes/theme.js";
import { auditLogRoutes } from "./routes/audit-log.js";
import { customerRoutes } from "./routes/customers.js";
import { contactRoutes } from "./routes/contacts.js";
import { billingAddressRoutes } from "./routes/billing-addresses.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { roleRoutes } from "./routes/roles.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  // Security headers (CSP, X-Frame-Options, X-Content-Type-Options, etc.).
  // We disable CSP here because this is a JSON API; the web app owns its own CSP.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  await app.register(cors, {
    origin: process.env.WEB_URL || "http://localhost:3000",
    credentials: true,
  });

  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

  app.setErrorHandler(errorHandler);

  app.addHook("onRequest", authMiddleware);
  app.addHook("onRequest", tenantMiddleware);
  app.addHook("onRequest", authorizationMiddleware);

  app.get("/health", { config: { skipAuth: true } }, async (_request, reply) => {
    return reply.send({ status: "ok" });
  });

  await app.register(commodityRoutes);
  await app.register(uomRoutes);
  await app.register(premiseRoutes);
  await app.register(meterRoutes);
  await app.register(accountRoutes);
  await app.register(billingCycleRoutes);
  await app.register(serviceAgreementRoutes);
  await app.register(rateScheduleRoutes);
  await app.register(themeRoutes);
  await app.register(auditLogRoutes);
  await app.register(customerRoutes);
  await app.register(contactRoutes);
  await app.register(billingAddressRoutes);
  await app.register(attachmentRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(roleRoutes);

  startAuditWriter();

  return app;
}
