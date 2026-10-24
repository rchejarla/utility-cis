// Pricing grammar — discriminated union over the supported pricing
// shapes. Each shape's evaluation rule is fixed and lives in the rate
// engine (slice 3). New pricing shapes require a code change.

import { z } from "zod";
import { selectorSchema } from "./selectors";

const flatSchema = z
  .object({
    type: z.literal("flat"),
    rate: z.number(),
    unit: z.string().optional(),
  })
  .strict();

const tieredSchema = z
  .object({
    type: z.literal("tiered"),
    tiers: z
      .array(
        z
          .object({
            to: z.number().nullable(),
            rate: z.number(),
          })
          .strict(),
      )
      .min(1),
    /**
     * The period length the thresholds were written for, in days
     * (Bozeman Req 138). Present, each tier's `to` is scaled by the days
     * actually billed, so a long interval gets a proportionate
     * allowance instead of a month's. Absent, thresholds are absolute
     * and the component prices as it always has — which is why this is
     * opt-in: the engine is handed an interval and never told what a
     * normal one looks like, so only the tariff can say.
     */
    standard_days: z.number().int().positive().optional(),
    /**
     * What one unit of the priced quantity is called, for the bill line
     * — "HCF", "MONTH", "kWh". `rate.ts` copies it onto the emitted
     * line, which is the only reason it exists: without it a bill says
     * a quantity and never what was counted.
     */
    unit: z.string().optional(),
  })
  .strict();

const lookupSchema = z
  .object({
    type: z.literal("lookup"),
    by: z.string().min(1),
    table: z.record(z.string(), z.number()),
    /**
     * What one unit of the priced quantity is called, for the bill line
     * — "HCF", "MONTH", "kWh". `rate.ts` copies it onto the emitted
     * line, which is the only reason it exists: without it a bill says
     * a quantity and never what was counted.
     */
    unit: z.string().optional(),
  })
  .strict();

const catalogSchema = z
  .object({
    type: z.literal("catalog"),
    by: z.array(z.string().min(1)).min(1),
    table: z.record(z.string(), z.number()),
  })
  .strict();

const perUnitSchema = z
  .object({
    type: z.literal("per_unit"),
    rate: z.number(),
    unit: z.string().optional(),
  })
  .strict();

const percentOfSchema = z
  .object({
    type: z.literal("percent_of"),
    selector: selectorSchema,
    percent: z.number(),
  })
  .strict();

const indexedSchema = z
  .object({
    type: z.literal("indexed"),
    index_name: z.string().min(1),
    period_resolver: z.enum([
      "current_quarter",
      "current_month",
      "current_year",
      "fixed",
    ]),
    fixed_period: z.string().optional(),
    unit: z.string().optional(),
    multiplier: z.number().default(1),
  })
  .strict();

const floorSchema = z
  .object({
    type: z.literal("floor"),
    amount: z.number(),
    selector: selectorSchema.optional(),
    applies_to_subtotal: z.boolean().default(false),
  })
  .strict();

export const pricingSchema = z.discriminatedUnion("type", [
  flatSchema,
  tieredSchema,
  lookupSchema,
  catalogSchema,
  perUnitSchema,
  percentOfSchema,
  indexedSchema,
  floorSchema,
]);

export type RatePricing = z.infer<typeof pricingSchema>;
