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
import { meterReadRoutes } from "./routes/meter-reads.js";
import { meterEventRoutes } from "./routes/meter-events.js";
import { containerRoutes } from "./routes/containers.js";
import { serviceSuspensionRoutes } from "./routes/service-suspensions.js";
import { suspensionTypeDefRoutes } from "./routes/suspension-type-defs.js";
import { tenantConfigRoutes } from "./routes/tenant-config.js";
import { customFieldSchemaRoutes } from "./routes/custom-field-schemas.js";
import { serviceEventRoutes } from "./routes/service-events.js";
import { startSuspensionScheduler } from "./schedulers/suspension-scheduler.js";
import { startNotificationSendJob } from "./services/notification.service.js";
import { startDelinquencyScheduler } from "./services/delinquency.service.js";
import { workflowRoutes } from "./routes/workflows.js";
import { notificationRoutes } from "./routes/notifications.js";
import { delinquencyRoutes } from "./routes/delinquency.js";
import { serviceRequestTypeRoutes } from "./routes/service-request-types.js";
import { portalAuthRoutes } from "./routes/portal-auth.js";
import { portalApiRoutes } from "./routes/portal-api.js";
import { buildOpenApiDocument } from "./lib/openapi.js";

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

  // Public OpenAPI document — generated from Zod validators so the spec
  // is always in sync with the runtime contract. Unauthenticated so
  // clients can pull it before provisioning credentials.
  app.get("/api/v1/openapi.json", { config: { skipAuth: true } }, async (_request, reply) => {
    return reply.send(buildOpenApiDocument());
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
  await app.register(meterReadRoutes);
  await app.register(meterEventRoutes);
  await app.register(containerRoutes);
  await app.register(serviceSuspensionRoutes);
  await app.register(suspensionTypeDefRoutes);
  await app.register(tenantConfigRoutes);
  await app.register(customFieldSchemaRoutes);
  await app.register(serviceEventRoutes);
  await app.register(workflowRoutes);
  await app.register(notificationRoutes);
  await app.register(delinquencyRoutes);
  await app.register(serviceRequestTypeRoutes);
  await app.register(portalAuthRoutes);
  await app.register(portalApiRoutes);

  startAuditWriter();

  // Background schedulers. The suspension scheduler flips holds from
  // PENDING → ACTIVE at startDate and ACTIVE → COMPLETED at endDate.
  // In-process setInterval, single-instance only. Set DISABLE_SCHEDULERS
  // in tests and any worker process that shouldn't run side effects.
  if (process.env.DISABLE_SCHEDULERS !== "true") {
    startSuspensionScheduler(app.log);
    startNotificationSendJob(app.log);
    startDelinquencyScheduler(app.log);
  }

  return app;
}
