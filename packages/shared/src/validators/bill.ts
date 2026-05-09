import { z } from "zod";

/**
 * Slice 5b.2 — generate-Bill request body.
 *
 * Account id comes from the URL params; the body carries an optional
 * `asOfDate` to override the auto-derived period (defaults server-side
 * to today). The service layer reads the account's BillCycle to compute
 * periodStart/periodEnd from that anchor.
 */
export const generateBillSchema = z
  .object({
    asOfDate: z.string().date().optional(),
  })
  .strict();

export type GenerateBillInput = z.infer<typeof generateBillSchema>;
