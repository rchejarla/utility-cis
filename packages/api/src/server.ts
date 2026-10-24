import { buildApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { config } from "./config.js";
import { assertRlsEnforced } from "./lib/prisma.js";

const PORT = config.PORT;

async function main() {
  /*
   * Before anything is served. The check is here rather than in
   * `buildApp` because it is about this deployment's database
   * credentials, not about constructing a Fastify instance — and
   * `buildApp` is what the integration suites call, where the roles are
   * the test's business.
   *
   * In production this throws and the process exits non-zero, which is
   * the intent: a replica that cannot isolate tenants should fail its
   * deploy rather than serve.
   */
  await assertRlsEnforced();

  const app = await buildApp();
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    logger.info({ port: PORT }, "Server listening");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main().catch((err) => {
  logger.fatal({ err }, "Startup failed");
  process.exit(1);
});
