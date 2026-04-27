import { buildApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { config } from "./config.js";

const PORT = config.PORT;

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    logger.info({ port: PORT }, "Server listening");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
