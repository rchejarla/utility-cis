import { PrismaClient } from "@utility-cis/shared/src/generated/prisma";

export const prisma = new PrismaClient();

// Warm up connection pool on import
prisma.$connect().catch((err) => console.error("[prisma] Failed to connect:", err));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUtilityId(utilityId: string): void {
  if (typeof utilityId !== "string" || !UUID_RE.test(utilityId)) {
    throw new Error("Invalid utility ID format");
  }
}

export async function setTenantContext(utilityId: string): Promise<void> {
  assertUtilityId(utilityId);
  // set_config is parameterized; avoids string interpolation into SQL.
  await prisma.$executeRaw`SELECT set_config('app.current_utility_id', ${utilityId}, false)`;
}

/**
 * Preferred pattern for tenant-scoped operations.
 * Wraps all queries in an interactive transaction so the SET and queries
 * run on the same connection, preventing RLS context leaks between requests.
 * The third arg `true` on set_config scopes it to the transaction only.
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
