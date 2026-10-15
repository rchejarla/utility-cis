import { z } from "zod";

/**
 * Starting a billing run.
 *
 * `windowEnd` is the scheduling bound — normally the cycle's bill day,
 * and defaulted to it when omitted. It is not the service period: what
 * each bill covers is read to read and resolved per account. Naming it
 * `windowEnd` rather than `periodEnd` is the point, since the first
 * draft of this design conflated the two.
 *
 * `billDate` and `dueDate` are the utility's own dates and are identical
 * across the run. Defaulted from the window and the cycle's terms when
 * not given, so the ordinary call is just a cycle id.
 */
export const createBillingRunSchema = z
  .object({
    billingCycleId: z.string().uuid(),
    windowEnd: z.string().date().optional(),
    billDate: z.string().date().optional(),
    dueDate: z.string().date().optional(),
  })
  .strict();

/**
 * The run's item list, which is how an exception is found.
 *
 * `status` narrows to the work: FAILED is what somebody has to act on,
 * SKIPPED is noise worth separating from it.
 */
export const billingRunItemQuerySchema = z
  .object({
    status: z.enum(["PENDING", "BILLED", "SKIPPED", "FAILED"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type CreateBillingRunInput = z.infer<typeof createBillingRunSchema>;
export type BillingRunItemQuery = z.infer<typeof billingRunItemQuerySchema>;
