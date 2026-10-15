import { z } from "zod";

/**
 * Bill-segment creation request.
 *
 * The route extracts saId from the URL params. ISO date strings
 * (YYYY-MM-DD), because a segment is keyed on a calendar day range
 * rather than a timestamp.
 *
 * Both dates are optional, and an empty body is the ordinary case: the
 * period is then resolved from the meter reads — the day after the last
 * billed read, through the newest unbilled one. Supplying them is for a
 * correction, and supplying one is a mistake the service refuses, since
 * resolving the other half would bill an interval nobody chose.
 */
export const createBillSegmentSchema = z
  .object({
    periodStart: z.string().date().optional(),
    periodEnd: z.string().date().optional(),
  })
  .strict();

export type CreateBillSegmentInput = z.infer<typeof createBillSegmentSchema>;
