import { buildApp } from "./app.js";
import { logger } from "./lib/logger.js";

const PORT = Number(process.env.PORT) || 3001;

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
