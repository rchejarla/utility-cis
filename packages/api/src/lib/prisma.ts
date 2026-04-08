import { PrismaClient } from "@utility-cis/shared/src/generated/prisma";

export const prisma = new PrismaClient();

export async function setTenantContext(utilityId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `SET app.current_utility_id = '${utilityId}'`
  );
}
