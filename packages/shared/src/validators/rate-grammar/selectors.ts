// Selector grammar — used by `pricing.percent_of` and `pricing.floor`
// to identify other components in the same evaluation context. The
// engine resolves selectors against the assembled component set for a
// given service agreement at evaluation time.

import { z } from "zod";
import {
  RATE_COMPONENT_KIND_CODES,
  RATE_ASSIGNMENT_ROLE_CODES,
} from "./registered-codes";

const kindEnum = z.enum([...RATE_COMPONENT_KIND_CODES] as [string, ...string[]]);
const roleEnum = z.enum([...RATE_ASSIGNMENT_ROLE_CODES] as [string, ...string[]]);

type Selector =
  | { component_id: string }
  | { kind: string }
  | { kind_in: string[] }
  | { exclude_kind: string[] }
  | { source_schedule_id: string }
  | { source_schedule_role: string }
  | { has_label_prefix: string }
  | { and: Selector[] }
  | { or: Selector[] };

export const selectorSchema: z.ZodType<Selector> = z.lazy(() =>
  z.union([
    z.object({ component_id: z.string().uuid() }).strict(),
    z.object({ kind: kindEnum }).strict(),
    z.object({ kind_in: z.array(kindEnum).min(1) }).strict(),
    z.object({ exclude_kind: z.array(kindEnum).min(1) }).strict(),
    z.object({ source_schedule_id: z.string().uuid() }).strict(),
    z.object({ source_schedule_role: roleEnum }).strict(),
    z.object({ has_label_prefix: z.string().min(1) }).strict(),
    z.object({ and: z.array(selectorSchema).min(1) }).strict(),
    z.object({ or: z.array(selectorSchema).min(1) }).strict(),
  ]),
);

export type ComponentSelector = Selector;
