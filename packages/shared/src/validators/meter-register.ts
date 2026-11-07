import { z } from "zod";

/**
 * Mapping a register to a TOU period (spec 26, TOU-REG-1 / TOU-UI-4).
 *
 * `null` unmaps it — the register is a total register, or the meter
 * does not split by time. The code is checked against the tenant's own
 * periods rather than against a calendar's: peak codes belong to the
 * utility, and which periods a *meter* counts is a fact about the
 * device that no tariff version gets to decide.
 */
export const assignTouPeriodSchema = z
  .object({
    peakCode: z.string().min(1).max(50).nullable(),
  })
  .strict();

export type AssignTouPeriodInput = z.infer<typeof assignTouPeriodSchema>;
