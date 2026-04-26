import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { loggerOptions } from "./lib/logger.js";
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
import { measureTypeDefRoutes } from "./routes/measure-type-defs.js";
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
import { slaRoutes } from "./routes/slas.js";
import { serviceRequestRoutes } from "./routes/service-requests.js";
import { portalAuthRoutes } from "./routes/portal-auth.js";
import { portalApiRoutes } from "./routes/portal-api.js";
import { buildOpenApiDocument } from "./lib/openapi.js";

export async function buildApp() {
  // Pass a config object — Fastify constructs its own pino instance from
  // it. The standalone `logger` export from lib/logger.ts is for the worker
  // process and any non-Fastify call site that needs the same configuration.
  const app = Fastify({ logger: loggerOptions });

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
  await app.register(measureTypeDefRoutes);
  await app.register(tenantConfigRoutes);
  await app.register(customFieldSchemaRoutes);
  await app.register(serviceEventRoutes);
  await app.register(workflowRoutes);
  await app.register(notificationRoutes);
  await app.register(delinquencyRoutes);
  await app.register(serviceRequestTypeRoutes);
  await app.register(slaRoutes);
  await app.register(serviceRequestRoutes);
  await app.register(portalAuthRoutes);
  await app.register(portalApiRoutes);

  startAuditWriter();

  // Legacy in-process schedulers — migration-window fallback only.
  // The replacement is the BullMQ worker process (`packages/api/src/
  // worker.ts`); these are kept callable behind per-job env flags so
  // we can flip back without redeploying if the new path misbehaves.
  // Final cleanup (removal of these branches and the start* exports)
  // lands in plan task 9 after a production soak period.
  //
  // Note: the original block also gated on `DISABLE_SCHEDULERS`; that
  // env var is now owned by the worker process, not the API. We simply
  // don't start anything here unless the migration flag is on.
  if (config.USE_LEGACY_SCHEDULERS_SUSPENSION) {
    app.log.warn(
      "LEGACY scheduler active — USE_LEGACY_SCHEDULERS_SUSPENSION=true. Worker-process suspension-transitions queue should be paused to avoid double-fire.",
    );
    startSuspensionScheduler(app.log);
  }
  if (config.USE_LEGACY_SCHEDULERS_NOTIFICATION) {
    app.log.warn(
      "LEGACY scheduler active — USE_LEGACY_SCHEDULERS_NOTIFICATION=true. Worker-process notification-send queue should be paused to avoid double-fire.",
    );
    startNotificationSendJob(app.log);
  }
  if (config.USE_LEGACY_SCHEDULERS_DELINQUENCY) {
    app.log.warn(
      "LEGACY scheduler active — USE_LEGACY_SCHEDULERS_DELINQUENCY=true. Worker-process delinquency-dispatch queue should be paused to avoid double-fire.",
    );
    startDelinquencyScheduler(app.log);
  }

  return app;
}
