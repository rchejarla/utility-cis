import { describe, it, expect, vi } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { errorHandler } from "../error-handler.js";

/**
 * What a 409 tells the person who hit it.
 *
 * "A record with these values already exists" names no field, and the
 * fields were only ever put in `details` — which is dropped entirely
 * when Prisma reports no `target`. Creating a rate schedule under a
 * code that already existed therefore said nothing at all about the
 * code, and there is no way to guess from the message which of a
 * model's constraints fired.
 *
 * `target`'s shape is not ours to choose: under the driver adapter
 * Postgres hands back a constraint *name* where the Rust engine handed
 * back a field list, so this takes a string, an array, or nothing, and
 * the string case is the one that used to throw `target.join is not a
 * function` inside the error handler — turning a 409 into a 500.
 */

function replyDouble() {
  const sent: unknown[] = [];
  const reply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn((body: unknown) => {
      sent.push(body);
      return reply;
    }),
  };
  return { reply: reply as unknown as FastifyReply, sent };
}

const request = {
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
} as unknown as FastifyRequest;

function p2002(meta: Record<string, unknown> | undefined) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "7.0.0",
    meta,
  });
}

type ErrorBody = {
  error: { code: string; message: string; details?: { field?: string; message?: string }[] };
};

describe("a unique-constraint violation", () => {
  it("names the fields in the message, not only in details", () => {
    const { reply, sent } = replyDouble();

    errorHandler(p2002({ target: ["utility_id", "code", "version"] }), request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    const body = sent[0] as ErrorBody;
    expect(body.error.code).toBe("UNIQUE_CONSTRAINT");
    // The message is the only part the web client is guaranteed to show.
    expect(body.error.message).toMatch(/code/);
    expect(body.error.message).toMatch(/version/);
    // Not also in `details`: api-client.ts appends details to the
    // message it shows, so sending both printed the field list twice
    // in one sentence.
    expect(body.error.details).toBeUndefined();
  });

  it("reports the constraint when the adapter names one instead of fields", () => {
    const { reply, sent } = replyDouble();

    errorHandler(p2002({ target: "rate_schedule_utility_id_code_version_key" }), request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    const body = sent[0] as ErrorBody;
    expect(body.error.message).toMatch(/rate_schedule_utility_id_code_version_key/);
  });

  it("still answers 409 when Prisma reports no target at all", () => {
    const { reply, sent } = replyDouble();

    errorHandler(p2002(undefined), request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    const body = sent[0] as ErrorBody;
    expect(body.error.code).toBe("UNIQUE_CONSTRAINT");
    expect(body.error.message).toMatch(/already exists/);
  });
});
