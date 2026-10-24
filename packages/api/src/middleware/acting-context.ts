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
 * **Two hooks, at two different points, and the split is forced.**
 *
 * `authorizationMiddleware` reads the database itself — `getUserRole`,
 * `getTenantModules` and `getUtilityStatus` all query tenant tables — so
 * a tenant's scope has to exist *before* it runs, or the request dies in
 * that middleware and never reaches a handler at all. That is exactly
 * what happened: every tenant route answered 400 while platform routes
 * answered 200, because `cis_user` is nullif-guarded and readable
 * without a tenant while `user_role` and `utility_module` are not.
 *
 * But which requests are the platform's is only known *after* that same
 * middleware runs, since `request.platformActor` is what it establishes.
 *
 * So: the tenant scope goes in immediately after `authMiddleware`, which
 * is what sets `request.user`; the platform scope goes in after
 * authorization, once the actor is a proven row rather than a claim. The
 * two nest harmlessly — a platform request has no `utility_id` to scope
 * by, so the first hook is a no-op for it.
 *
 * Deriving the platform scope from the token's `platform: true` claim
 * instead would collapse them into one hook, and was rejected: it would
 * hand a connection holding BYPASSRLS to anything that merely *claims*
 * to be the platform, for the duration of the lookup that decides
 * whether it is.
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
export function platformScopeMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  if (request.platformActor) {
    enterScope({ kind: "platform" }, done);
    return;
  }
  done();
}

/** The tenant's scope, established before anything reads the database. */
export function tenantScopeMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
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
