import { PrismaClient } from "@utility-cis/shared/src/generated/prisma";

export const prisma = new PrismaClient();

// Warm up connection pool on import
prisma.$connect().catch((err) => console.error("[prisma] Failed to connect:", err));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function setTenantContext(utilityId: string): Promise<void> {
  if (!UUID_RE.test(utilityId)) {
    throw new Error("Invalid utility ID format");
  }
  await prisma.$executeRawUnsafe(
    `SET app.current_utility_id = '${utilityId}'`
  );
}

/**
 * Preferred pattern for tenant-scoped operations.
 * Wraps all queries in an interactive transaction so the SET and queries
 * run on the same connection, preventing RLS context leaks between requests.
 */
export async function withTenant<T>(
  utilityId: string,
  fn: (tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => Promise<T>
): Promise<T> {
  if (!UUID_RE.test(utilityId)) {
    throw new Error("Invalid utility ID format");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET app.current_utility_id = '${utilityId}'`);
    return fn(tx);
  });
}
