import type { FastifyRequest, FastifyReply, FastifyError } from "fastify";
import { ZodError } from "zod";

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  if (error instanceof ZodError) {
    reply.status(400).send({
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        details: error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      },
    });
    return;
  }

  const statusCode = (error as FastifyError).statusCode;
  if (statusCode) {
    reply.status(statusCode).send({
      error: {
        code: error.name || "ERROR",
        message: error.message,
      },
    });
    return;
  }

  request.log.error(error);
  reply.status(500).send({
    error: {
      code: "INTERNAL_ERROR",
      message: "An internal server error occurred",
    },
  });
}
