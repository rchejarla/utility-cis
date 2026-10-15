import { z } from "zod";

export const billingFrequencyEnum = z.enum(["MONTHLY", "BIMONTHLY", "QUARTERLY"]);

/**
 * BR-BC-001: 1–28 on both day fields, because days 29–31 do not exist in
 * every month and a cycle whose day silently moves is worse than one
 * that cannot be configured. The database's CHECK allows 1–31 as the
 * calendar floor; this is the business rule above it.
 */
const dayOfMonth = z.number().int().min(1).max(28);

export const createBillingCycleSchema = z
  .object({
    name: z.string().min(1).max(255),
    cycleCode: z.string().min(1).max(20),
    /**
     * When reads are expected to be complete, not when the reader sets
     * out: the only thing that consumes this is the question "are the
     * reads in yet?". The actual spread of a reading pass lives on the
     * `MeterRead` rows, and belongs to read routes when those exist.
     *
     * Required, like the bill day. A cycle is a read-and-bill calendar;
     * one that declares only half of it cannot be billed safely.
     */
    readDayOfMonth: dayOfMonth,
    billDayOfMonth: dayOfMonth,
    frequency: billingFrequencyEnum.default("MONTHLY"),
    active: z.boolean().default(true),
  })
  .refine(
    (c) => c.readDayOfMonth < c.billDayOfMonth,
    {
      // Spec 07 rule 9. Billing a cycle before its reads are in is the
      // zero-usage bill followed by a double one, so the ordering is a
      // rule rather than a convention.
      message: "readDayOfMonth must be before billDayOfMonth, so reads are in before bills generate",
      path: ["readDayOfMonth"],
    },
  );

/**
 * Partial, so a caller changing only the name sends only the name — and
 * so the read-before-bill rule cannot be checked here, because the
 * payload may carry one day and the row the other. The service checks it
 * against the merged state; see `assertReadPrecedesBill`.
 */
export const updateBillingCycleSchema = createBillingCycleSchema
  .innerType()
  .omit({ cycleCode: true })
  .partial();

export type BillingFrequency = z.infer<typeof billingFrequencyEnum>;
export type CreateBillingCycleInput = z.infer<typeof createBillingCycleSchema>;
export type UpdateBillingCycleInput = z.infer<typeof updateBillingCycleSchema>;
