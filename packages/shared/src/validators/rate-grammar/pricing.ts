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
  })
  .strict();

const lookupSchema = z
  .object({
    type: z.literal("lookup"),
    by: z.string().min(1),
    table: z.record(z.string(), z.number()),
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
