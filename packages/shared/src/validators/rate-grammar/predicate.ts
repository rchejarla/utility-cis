// Closed-grammar predicate DSL for rate components.
//
// Each operator below has a deterministic evaluator implemented by the
// rate engine in slice 3. The grammar is intentionally closed — tenants
// can author predicates in this language but cannot introduce new
// operators (the engine has no behavior for unknown ones, and Zod
// rejects them at the API boundary).

import { z } from "zod";

const varRefSchema = z.object({ var: z.string().min(1) }).strict();
const literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const valueOrVarSchema = z.union([literalSchema, varRefSchema]);

type Predicate =
  | Record<string, never>
  | { and: Predicate[] }
  | { or: Predicate[] }
  | { not: Predicate }
  | { eq: { left: unknown; right: unknown } }
  | { ne: { left: unknown; right: unknown } }
  | { in: { value: unknown; set: unknown[] } }
  | { class: string }
  | { class_in: string[] }
  | { meter_size: string }
  | { meter_size_in: string[] }
  | { season: string }
  | { tou_window: string }
  | { drought_stage_active: boolean }
  | { premise_attr: { attr: string; eq?: unknown; ne?: unknown } }
  | { meter_role: { eq?: string; ne?: string } }
  | { qty_gte: { var: string; value: number } }
  | { qty_lte: { var: string; value: number } }
  | { customer_attr: { attr: string; eq?: unknown } }
  | { period: { from?: string; to?: string } };

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({}).strict(), // empty = always true
    z.object({ and: z.array(predicateSchema).min(1) }).strict(),
    z.object({ or: z.array(predicateSchema).min(1) }).strict(),
    z.object({ not: predicateSchema }).strict(),
    z.object({
      eq: z.object({ left: valueOrVarSchema, right: valueOrVarSchema }).strict(),
    }).strict(),
    z.object({
      ne: z.object({ left: valueOrVarSchema, right: valueOrVarSchema }).strict(),
    }).strict(),
    z.object({
      in: z.object({ value: valueOrVarSchema, set: z.array(literalSchema) }).strict(),
    }).strict(),
    z.object({ class: z.string().min(1) }).strict(),
    z.object({ class_in: z.array(z.string().min(1)).min(1) }).strict(),
    z.object({ meter_size: z.string().min(1) }).strict(),
    z.object({ meter_size_in: z.array(z.string().min(1)).min(1) }).strict(),
    z.object({
      season: z.enum(["summer", "winter", "shoulder", "irrigation", "non_irrigation"]),
    }).strict(),
    z.object({
      tou_window: z.enum(["peak", "off_peak", "shoulder", "super_off_peak"]),
    }).strict(),
    z.object({ drought_stage_active: z.boolean() }).strict(),
    z.object({
      premise_attr: z
        .object({
          attr: z.string().min(1),
          eq: literalSchema.optional(),
          ne: literalSchema.optional(),
        })
        .strict(),
    }).strict(),
    z.object({
      meter_role: z
        .object({ eq: z.string().optional(), ne: z.string().optional() })
        .strict(),
    }).strict(),
    z.object({
      qty_gte: z.object({ var: z.string().min(1), value: z.number() }).strict(),
    }).strict(),
    z.object({
      qty_lte: z.object({ var: z.string().min(1), value: z.number() }).strict(),
    }).strict(),
    z.object({
      customer_attr: z
        .object({ attr: z.string().min(1), eq: literalSchema.optional() })
        .strict(),
    }).strict(),
    z.object({
      period: z
        .object({ from: z.string().date().optional(), to: z.string().date().optional() })
        .strict(),
    }).strict(),
  ]),
);

export type RatePredicate = Predicate;
