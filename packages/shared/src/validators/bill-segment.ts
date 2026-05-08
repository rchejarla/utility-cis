import { z } from "zod";

/**
 * Slice 5a — bill-segment creation request.
 *
 * The route extracts saId from the URL params; the body carries only
 * the period range. Both endpoints use ISO date strings (YYYY-MM-DD)
 * — the bill segment is keyed on a calendar day range, not a timestamp.
 */
export const createBillSegmentSchema = z
  .object({
    periodStart: z.string().date(),
    periodEnd: z.string().date(),
  })
  .strict();

export type CreateBillSegmentInput = z.infer<typeof createBillSegmentSchema>;
