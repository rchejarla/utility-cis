import { pino, type LoggerOptions } from "pino";
import { config } from "../config.js";

/**
 * Shared pino configuration used by both API and worker processes.
 *
 * The API process passes `loggerOptions` to `Fastify({ logger })` — Fastify
 * internally constructs its own pino instance from this config so request
 * logging integrates with route handlers and middleware.
 *
 * The worker process imports the `logger` instance directly — it has no
 * Fastify and needs structured logging from process start.
 *
 * Both processes have separate pino instances but emit through identical
 * configuration, so log output looks the same across services.
 *
 * `redact` strips Authorization / Cookie headers from request logs so
 * tokens don't end up in log aggregators. Pino's redact runs at write
 * time and is cheap.
 */
export const loggerOptions: LoggerOptions = {
  level: config.LOG_LEVEL,
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie"],
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

export const logger = pino(loggerOptions);
