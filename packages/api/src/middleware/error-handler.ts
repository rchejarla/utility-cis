import type { FastifyRequest, FastifyReply, FastifyError } from "fastify";
import { ZodError } from "zod";
import { Prisma } from "@utility-cis/shared/src/generated/prisma";

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  // Zod validation errors
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

  // Prisma known request errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case "P2002": {
        // Unique constraint violation
        const target = (error.meta?.target as string[] | undefined) ?? [];
        reply.status(409).send({
          error: {
            code: "UNIQUE_CONSTRAINT",
            message: "A record with these values already exists",
            details: target.length ? [{ field: target.join(","), message: "must be unique" }] : undefined,
          },
        });
        return;
      }
      case "P2025": {
        // Record not found
        reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Record not found",
          },
        });
        return;
      }
      case "P2003": {
        // Foreign key constraint failed
        reply.status(400).send({
          error: {
            code: "FOREIGN_KEY_VIOLATION",
            message: "Referenced record does not exist or is in use",
          },
        });
        return;
      }
      case "P2014": {
        reply.status(400).send({
          error: {
            code: "INVALID_RELATION",
            message: "The change would violate a required relation",
          },
        });
        return;
      }
      default: {
        request.log.error({ prismaCode: error.code, meta: error.meta }, "Prisma error");
        reply.status(400).send({
          error: {
            code: `PRISMA_${error.code}`,
            message: "Database error",
          },
        });
        return;
      }
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    request.log.error(error, "Prisma validation error");
    reply.status(400).send({
      error: {
        code: "PRISMA_VALIDATION",
        message: "Invalid query parameters",
      },
    });
    return;
  }

  // Custom errors with statusCode/code attached
  const statusCode = (error as FastifyError).statusCode;
  if (statusCode) {
    const code = (error as FastifyError & { code?: string }).code;
    reply.status(statusCode).send({
      error: {
        code: code || error.name || "ERROR",
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
