// Quantity-source grammar — describes the variable that feeds pricing.
//
// `base` picks the raw input (metered consumption, water-quality
// adjustment, premise attribute, linked commodity, item count, peak
// demand, or a fixed value). `transforms` are applied left-to-right and
// can ratchet, clamp, net, prorate, subtract a linked commodity, filter
// by TOU window, threshold by power factor, divide by load factor, or
// floor.

import { z } from "zod";

/**
 * Every variable a charge can be measured by.
 *
 * Exported as a list, not only as a Zod enum, because the rate-schedule
 * editor offers a second hand-maintained list of the same bases
 * (`QUANTITY_SOURCES` in the api's `grammar-introspection.ts`, which
 * carries each one's label and whether the engine supports it yet).
 * They drift silently in both directions — a base the editor never
 * offers is built and unreachable, which is exactly what happened to
 * `tou_period` — so a test pins them to each other.
 *
 * `tou_period` is one TOU period's consumption (spec 26, TOU-ENG-1): a
 * base rather than a transform on `metered`, because on-peak kWh
 * cannot be derived from total kWh. The quantity *is* that period's
 * usage, read from the meter's register for it, and each period is its
 * own component with its own price and its own bill line — which is
 * how tariffs are written and how bills read. The `tou_window_filter`
 * transform below is the earlier idea and is declared unsupported: it
 * filters a metered quantity by a hardcoded window name, which cannot
 * mean anything now that peak codes are the tenant's to name.
 */
export const QUANTITY_BASES = [
  "metered",
  "tou_period",
  "wqa",
  "premise_attribute",
  "linked_commodity",
  "item_count",
  "peak_demand",
  "fixed",
] as const;

const baseSchema = z.enum(QUANTITY_BASES);

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
    /**
     * `tou_period` only: which of the tenant's periods this charge
     * prices. Checked against the schedule's calendar at publish
     * (`validateTouPricing`), which is the only place the set of real
     * codes is known.
     */
    peak_code: z.string().min(1).max(50).optional(),
  })
  .strict()
  .superRefine((qs, ctx) => {
    if (qs.base === "tou_period" && !qs.peak_code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["peak_code"],
        message: "A tou_period charge must name the period it prices, e.g. \"off_peak\".",
      });
    }
    /*
     * The other direction matters more, because it fails silently.
     * `metered` with a `peak_code` reads as a TOU charge: the engine
     * ignores the key and bills total consumption, and the publish
     * gate counts only `tou_period` components — so the schedule looks
     * complete while every kWh is charged at the on-peak price.
     */
    if (qs.base !== "tou_period" && qs.peak_code !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["peak_code"],
        message: `A ${qs.base} charge prices no single period, so peak_code would be ignored. Use the TOU period source to price one.`,
      });
    }
  });

export type QuantitySource = z.infer<typeof quantitySourceSchema>;
