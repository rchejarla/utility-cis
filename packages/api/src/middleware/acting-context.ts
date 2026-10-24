import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from "fastify";
import { enterScope } from "../lib/tenant-context.js";

/**
 * Put the rest of the request inside the scope it should act under.
 *
 * Row-level security binds to a setting on the connection a query runs
 * on, and `lib/prisma.ts` applies it at checkout from this context. So
 * this hook is what connects an authenticated request to the authority
 * its queries will carry — without it every handler runs with no scope
 * at all, and a tenant table refuses them.
 *
 * Registered **after** `authorizationMiddleware`, because that is what
 * establishes which of the two a request is: `request.platformActor` for
 * the 24 routes declaring `{ platform: true }`, `request.user` for
 * everything else. The middleware refuses each kind on the other's
 * routes, so exactly one of them is set.
 *
 * Callback form, deliberately. An async hook would unwind its own
 * AsyncLocalStorage scope on return, before the handler ever ran;
 * calling `done()` from inside `run` is what makes the handler inherit
 * it. That is an assumption about Fastify's lifecycle rather than a
 * documented guarantee, so it is pinned by an integration test that
 * drives a real platform route — if it were wrong, those would fail
 * while every direct `runAsPlatform` call kept passing.
 *
 * A request with neither — an unauthenticated route, or one the auth
 * middleware let through — gets no scope and therefore no tenant. That
 * is the safe default: its queries are refused rather than served from
 * whichever tenant happened to be last.
 */
export function actingContextMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  if (request.platformActor) {
    enterScope({ kind: "platform" }, done);
    return;
  }
  const utilityId = request.user?.utilityId;
  if (utilityId) {
    try {
      enterScope({ kind: "tenant", utilityId }, done);
      return;
    } catch (err) {
      /*
       * `enterScope` refuses a tenant id that is not a uuid, because the
       * value is interpolated into a `SET` that cannot be
       * parameterised. Letting that throw out of a hook turns a
       * malformed claim into a 500 with no code, which is a bad way to
       * report it — and deciding what to do about one is not a scope
       * helper's business.
       *
       * So the request proceeds with no scope, which is fail-closed:
       * nothing is interpolated, and under an enforcing policy a tenant
       * table refuses the query rather than serving another tenant's
       * rows. Logged rather than swallowed, because a malformed tenant
       * reaching this point is still a defect — just one belonging to
       * whatever minted the token, not to this hook.
       */
      request.log.warn(
        { err, component: "acting-context", utilityId },
        "Token carried a tenant id that is not a uuid; running with no tenant scope",
      );
    }
  }
  done();
}
