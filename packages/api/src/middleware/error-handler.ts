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
        /*
         * Unique constraint violation.
         *
         * `target` is a field list under the Rust engine and a
         * constraint *name* under the driver adapter, so it arrives as
         * an array, a string, or not at all. It used to be cast to
         * `string[]` unconditionally — and a string has a truthy
         * `.length` with no `.join`, so that cast threw inside the
         * error handler and turned the 409 into a 500.
         *
         * Whatever it names goes in `message`, not only in `details`:
         * the web client always shows the message and appends details
         * only when present, so a P2002 reporting no target said
         * nothing identifiable at all — the same sentence for every
         * constraint on every model. A service that can name the
         * conflict should still refuse before reaching the database;
         * this is the backstop, and it has to be legible on its own.
         */
        const raw = error.meta?.target;
        const fields = Array.isArray(raw)
          ? raw.map(String)
          : typeof raw === "string" && raw
            ? [raw]
            : [];
        reply.status(409).send({
          error: {
            code: "UNIQUE_CONSTRAINT",
            message: fields.length
              ? `A record with these values already exists: ${fields.join(", ")}`
              : "A record with these values already exists",
            /*
             * No `details` here, unlike the Zod branch. It carried
             * exactly these field names, and `api-client.ts` appends
             * details to the message it shows — so sending both
             * printed the field list twice in one sentence. The Zod
             * branch keeps its details because there each entry is a
             * *different* field with its own message.
             */
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
        // Misleading legacy message ("Invalid query parameters") was
        // confusing — these errors are about the data shape sent to
        // Prisma (e.g. a string where a Date was expected), not the
        // query string. Keep the message specific so the next
        // operator who hits this knows where to look.
        message: "Database client rejected the input shape",
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
