import { z } from "zod";

/**
 * Bodies for the payment plan endpoints.
 *
 * The instalment count is bounded here only by what any tenant could
 * conceivably set; the tenant's own minimum and maximum are checked in
 * `createPaymentPlan` against the terms it reads. Two places would be
 * two answers, and the one that matters is the one the customer was
 * quoted.
 */

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a calendar date, YYYY-MM-DD");

const money = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "must be a positive amount with at most two decimals");

export const agreePaymentPlanSchema = z
  .object({
    /**
     * The debits the customer is agreeing a schedule for. At least one:
     * a plan over nothing would be created and complete on the very
     * next sweep, having collected a down payment against no debt.
     */
    entryIds: z.array(z.string().uuid()).min(1).max(200),

    /**
     * Omitted means the tenant's percentage of the frozen balance. Zero
     * is allowed — some utilities agree a plan with nothing down — and
     * the figure may be below the policy percentage, which is a proposal
     * rather than a floor ("lower it if the customer cannot manage it").
     */
    downPayment: money.optional(),

    installmentCount: z.number().int().min(1).max(60),
    startDate: calendarDate,
    notes: z.string().max(2000).optional(),
  })
  .strict();

export type AgreePaymentPlanInput = z.infer<typeof agreePaymentPlanSchema>;

export const cancelPaymentPlanSchema = z
  .object({ notes: z.string().max(2000).optional() })
  .strict();

export type CancelPaymentPlanInput = z.infer<typeof cancelPaymentPlanSchema>;
