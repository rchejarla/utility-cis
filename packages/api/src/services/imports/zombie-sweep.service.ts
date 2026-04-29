import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";

/**
 * Finds ImportBatch rows in PROCESSING whose lastProgressAt is older
 * than ZOMBIE_THRESHOLD_MS (5 minutes — well above the 50-row
 * heartbeat cadence under realistic per-row timing). Flips them back
 * to PENDING and returns the affected ids so the caller can re-enqueue.
 *
 * Idempotent. Run once on worker boot.
 */
export const ZOMBIE_THRESHOLD_MS = 5 * 60 * 1000;

export async function reclaimZombieBatches(now: Date): Promise<string[]> {
  const cutoff = new Date(now.getTime() - ZOMBIE_THRESHOLD_MS);
  const zombies = await prisma.importBatch.findMany({
    where: {
      status: "PROCESSING",
      lastProgressAt: { lt: cutoff },
    },
    select: { id: true },
  });
  if (zombies.length === 0) return [];
  await prisma.importBatch.updateMany({
    where: { id: { in: zombies.map((z) => z.id) } },
    data: { status: "PENDING" },
  });
  logger.info(
    { component: "imports-zombie-sweep", reclaimed: zombies.length },
    "Reclaimed zombie import batches",
  );
  return zombies.map((z) => z.id);
}
