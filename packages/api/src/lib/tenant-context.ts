import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who the current work is acting for.
 *
 * Row-level security binds to `app.current_utility_id`, which is a
 * setting on the connection a query runs on — and the pool chooses that
 * connection at the moment of the query, not at the moment of the
 * request. Middleware cannot pin one to the other, which is why the
 * previous `setTenantContext` both failed to reach its own queries and
 * left the tenant behind on the connection that did receive it
 * (architecture §7.1).
 *
 * So the tenant travels with the *execution* instead, and
 * `lib/prisma.ts` reads it when a connection is checked out. That is
 * what makes this work without rewriting 432 query sites: a service
 * keeps importing `prisma` and keeps calling it the same way.
 *
 * Two shapes, not one, because "no tenant" and "every tenant" are
 * different claims and conflating them is how a cross-tenant read gets
 * mistaken for an empty one:
 *
 *   `tenant`    — a tenant's own work. The connection gets its id and
 *                 the policies apply.
 *   `platform`  — work that crosses tenants by design: the 24 platform
 *                 routes and the 6 all-tenants queues. The connection is
 *                 made as a role that holds BYPASSRLS, so nothing is set
 *                 at all.
 *
 * Absent means absent. Work outside any scope sets nothing, and a tenant
 * table then refuses it loudly rather than answering with no rows.
 */

export type ActingAs =
  | { kind: "tenant"; utilityId: string }
  | { kind: "platform" };

const store = new AsyncLocalStorage<ActingAs>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` as one tenant.
 *
 * The id is checked here rather than where it is used, because where it
 * is used is a `SET` statement and a `SET` cannot be parameterised — the
 * value is interpolated into SQL. This is the gate that makes that safe,
 * and it is at the entrance so there is one of it.
 */
export function runAsTenant<T>(utilityId: string, fn: () => Promise<T>): Promise<T> {
  if (typeof utilityId !== "string" || !UUID_RE.test(utilityId)) {
    // Rejected, not thrown. The signature says `Promise<T>`, and a
    // function that sometimes throws synchronously and sometimes
    // rejects makes every caller handle both or miss one.
    return Promise.reject(new Error(`Invalid utility id: ${JSON.stringify(utilityId)}`));
  }
  return store.run({ kind: "tenant", utilityId }, fn);
}

/**
 * Run `fn` as the platform — across every tenant, deliberately.
 *
 * Used only by routes declaring `{ config: { platform: true } }` and by
 * the handlers of queues marked `all-tenants`. It is not a convenience
 * for a query that is awkward to scope: a sweep that returns zero rows
 * reports success, so widening the authority to make a query work is how
 * a missing predicate becomes a permanent hole.
 */
export function runAsPlatform<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ kind: "platform" }, fn);
}

/** Who the calling code is acting for, or null outside any scope. */
export function currentTenant(): ActingAs | null {
  return store.getStore() ?? null;
}
