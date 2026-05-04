// Quantity-source grammar — describes the variable that feeds pricing.
//
// `base` picks the raw input (metered consumption, water-quality
// adjustment, premise attribute, linked commodity, item count, peak
// demand, or a fixed value). `transforms` are applied left-to-right and
// can ratchet, clamp, net, prorate, subtract a linked commodity, filter
// by TOU window, threshold by power factor, divide by load factor, or
// floor.

import { z } from "zod";

const baseSchema = z.enum([
  "metered",
  "wqa",
  "premise_attribute",
  "linked_commodity",
  "item_count",
  "peak_demand",
  "fixed",
]);

const transformSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ratchet"),
      percent: z.number().nonnegative(),
      lookback_months: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("clamp"),
      min: z.number().optional(),
      max: z.number().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("net"), subtract: z.string().min(1) })
    .strict(),
  z
    .object({ type: z.literal("prorate"), standard_days: z.number().int().positive() })
    .strict(),
  z
    .object({
      type: z.literal("subtract_linked_commodity"),
      commodity_id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tou_window_filter"),
      window: z.enum(["peak", "off_peak", "shoulder", "super_off_peak"]),
    })
    .strict(),
  z
    .object({ type: z.literal("power_factor"), threshold: z.number() })
    .strict(),
  z.object({ type: z.literal("load_factor") }).strict(),
  z.object({ type: z.literal("floor"), min: z.number() }).strict(),
]);

export const quantitySourceSchema = z
  .object({
    base: baseSchema,
    var: z.string().optional(),
    transforms: z.array(transformSchema).default([]),
    interval_minutes: z.number().int().positive().optional(),
    aggregation: z.enum(["max", "sum", "avg"]).optional(),
    source_attr: z.string().optional(),
  })
  .strict();

export type QuantitySource = z.infer<typeof quantitySourceSchema>;
