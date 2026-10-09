import { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { logger } from "./logger.js";

export const prisma = new PrismaClient();

// Warm up connection pool on import
prisma.$connect().catch((err) => logger.error({ err, component: "prisma" }, "Failed to connect"));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUtilityId(utilityId: string): void {
  if (typeof utilityId !== "string" || !UUID_RE.test(utilityId)) {
    throw new Error("Invalid utility ID format");
  }
}

/**
 * The ONLY way to put a tenant into `app.current_utility_id`.
 *
 * Both halves matter and neither is optional:
 *
 *   - **One transaction**, so the `set_config` and the queries that rely
 *     on it run on the same pooled connection. A bare `set_config`
 *     statement lands on whichever connection the pool hands out, and
 *     the queries after it may get a different one, so the setting
 *     simply isn't there.
 *   - **`true`** on the third argument, so the value is scoped to this
 *     transaction and is gone on commit or rollback. With `false` it is
 *     session-scoped and stays on that connection after the work ends,
 *     where the next request to be handed that connection inherits it.
 *
 * That second failure is why the previous `setTenantContext` was removed
 * rather than fixed: it was a bare, session-scoped statement, so it both
 * failed to reach its own queries and left another tenant's id behind.
 * The RLS policies read this setting, so residue is a cross-tenant read
 * that raises no error — inert only for as long as the application role
 * stays a superuser and bypasses RLS entirely.
 *
 * Nothing depended on it: every reader of the setting establishes it
 * itself, inside its own transaction — `audit-wrap.ts`'s `writeAuditRow`,
 * the two `effective-dating-queries.ts` handlers, and this function.
 *
 * Tenant separation today rests on the explicit `utility_id` predicates
 * in queries. Turning RLS on for real means routing tenant-scoped reads
 * through here; see docs/design/utility-cis-architecture.md §7.1.
 */
export async function withTenant<T>(
  utilityId: string,
  fn: (tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => Promise<T>
): Promise<T> {
  assertUtilityId(utilityId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_utility_id', ${utilityId}, true)`;
    return fn(tx);
  });
}
