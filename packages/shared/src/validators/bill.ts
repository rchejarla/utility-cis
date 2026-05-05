import { z } from "zod";

/**
 * Slice 5a — bill creation request.
 *
 * The route extracts saId from the URL params; the body carries only
 * the period range. Both endpoints use ISO date strings (YYYY-MM-DD)
 * — the bill is keyed on a calendar day range, not a timestamp.
 */
export const createBillSchema = z
  .object({
    periodStart: z.string().date(),
    periodEnd: z.string().date(),
  })
  .strict();

export type CreateBillInput = z.infer<typeof createBillSchema>;
