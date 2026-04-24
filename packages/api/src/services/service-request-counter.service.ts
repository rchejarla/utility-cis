import { prisma } from "../lib/prisma.js";

/**
 * Per-(tenant, year) monotonic counter for service-request numbers.
 * The single atomic upsert-with-increment returns the pre-increment
 * value, ensuring no two concurrent SRs can ever share a number
 * without contending on the service_request table itself.
 *
 * Format: SR-YYYY-NNNNNN (zero-padded to six digits).
 */
export async function nextRequestNumber(
  utilityId: string,
  year: number,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    // Insert a fresh counter row on first use for the tenant-year pair
    // (seeded at 2 so the first caller gets 1), otherwise increment the
    // existing one. RETURNING next_value - 1 yields the number the
    // caller should use.
    const rows = await tx.$queryRaw<Array<{ next_value: bigint }>>`
      INSERT INTO service_request_counter (utility_id, year, next_value)
      VALUES (${utilityId}::uuid, ${year}, 2)
      ON CONFLICT (utility_id, year)
      DO UPDATE SET next_value = service_request_counter.next_value + 1
      RETURNING next_value - 1 AS next_value
    `;
    const n = Number(rows[0].next_value);
    return `SR-${year}-${String(n).padStart(6, "0")}`;
  });
}
