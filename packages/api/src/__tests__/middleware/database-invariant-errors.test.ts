import { describe, it, expect, vi } from "vitest";
import { errorHandler } from "../../middleware/error-handler.js";

/**
 * A rule the database refuses has to reach the operator as a reason.
 *
 * Two invariants in this product are plpgsql triggers rather than
 * constraints, because each spans two tables:
 * `enforce_sa_lifecycle_invariants` and, from 2026-11-18,
 * `enforce_one_live_service_per_premise`. Both `RAISE` with a marker and
 * a sentence written for a person.
 *
 * Before the mapping these tests cover, that sentence went nowhere. A
 * trigger exception is not a Prisma error code, so it fell through the
 * handler's Prisma arms to either a 400 "Database error" or a 500 "An
 * internal server error occurred" — and the web client shows the
 * server's message, so a CSR who picked the wrong premise was told the
 * system had broken. The lifecycle trigger has been doing that since
 * April.
 *
 * Driven by calling the handler, not through a route: the mapping is
 * entirely about the shape of a message, and the integration suite
 * (`one-live-service-per-premise.integration.test.ts`) is what proves a
 * real trigger produces that shape.
 */

function invoke(error: Error) {
  const send = vi.fn();
  const reply = { status: vi.fn().mockReturnValue({ send }), send };
  const request = { log: { warn: vi.fn(), error: vi.fn() } };
  // The handler's signature is Fastify's; these fakes carry the only
  // parts the branch under test touches.
  errorHandler(error, request as never, reply as never);
  return {
    status: reply.status.mock.calls[0]?.[0] as number | undefined,
    body: send.mock.calls[0]?.[0] as
      | { error: { code: string; message: string } }
      | undefined,
    warned: request.log.warn.mock.calls.length,
  };
}

/** What Prisma wraps a trigger's `RAISE` in, framing and all. */
const PRISMA_WRAPPED = `
Invalid \`prisma.servicePoint.create()\` invocation in
/app/packages/api/src/services/workflows.service.ts:167:41

Raw query failed. Code: \`23514\`. Message: \`ERROR: ONE_LIVE_SERVICE_PER_PREMISE: agreement SA-1104 already serves this premise for this commodity over the same dates\`
`.trim();

describe("database invariants reaching the caller", () => {
  it("answers 409 and names the conflicting agreement", () => {
    const { status, body } = invoke(new Error(PRISMA_WRAPPED));

    expect(status).toBe(409);
    expect(body?.error.code).toBe("ONE_LIVE_SERVICE_PER_PREMISE");
    // The sentence, not the framing: no "Invalid prisma.servicePoint",
    // no file path, no error code.
    expect(body?.error.message).toContain("SA-1104 already serves this premise");
    expect(body?.error.message).not.toContain("prisma.servicePoint");
    expect(body?.error.message).not.toContain("23514");
    // The marker is the `code`; repeating it in the prose is noise.
    expect(body?.error.message).not.toContain("ONE_LIVE_SERVICE_PER_PREMISE");
  });

  it("handles a bare RAISE with no wrapper", () => {
    const { status, body } = invoke(
      new Error(
        "ONE_LIVE_SERVICE_PER_PREMISE: agreement SA-7 already serves this premise for this commodity over the same dates",
      ),
    );

    expect(status).toBe(409);
    expect(body?.error.message).toBe(
      "agreement SA-7 already serves this premise for this commodity over the same dates",
    );
  });

  it("covers the lifecycle trigger, which had the same problem", () => {
    const { status, body } = invoke(
      new Error(
        "Raw query failed. Message: `ERROR: SA_LIFECYCLE_INVARIANT_VIOLATION: status FINAL requires end_date to be set`",
      ),
    );

    expect(status).toBe(409);
    expect(body?.error.code).toBe("SA_LIFECYCLE_INVARIANT_VIOLATION");
    expect(body?.error.message).toBe("status FINAL requires end_date to be set");
  });

  it("logs the refusal as a warning, not an error", () => {
    // It is the database declining a write for a stated reason, which is
    // the system working. Logged at error level it pages somebody.
    const { warned } = invoke(new Error(PRISMA_WRAPPED));
    expect(warned).toBe(1);
  });

  it("leaves an ordinary error alone", () => {
    const { status, body } = invoke(new Error("something actually broke"));
    expect(status).toBe(500);
    expect(body?.error.code).toBe("INTERNAL_ERROR");
  });

  it("does not fire on a message that merely mentions a premise", () => {
    const { status } = invoke(new Error("could not load the premise list"));
    expect(status).toBe(500);
  });
});
