import { z } from "zod";

/**
 * Bill messages — the text a tenant prints on bills (Bozeman #137).
 *
 * `activeFrom` is required rather than defaulted to today: a message
 * with no start date would begin appearing on bills the moment it was
 * saved, which is never what an operator drafting next quarter's notice
 * intends. Making them state the date is the cheap guard.
 */

const windowRefinement = {
  check: (v: { activeFrom?: Date | null; activeTo?: Date | null }) =>
    !v.activeFrom || !v.activeTo || v.activeTo >= v.activeFrom,
  message: "activeTo must be on or after activeFrom",
  path: ["activeTo"] as const,
};

export const billMessageCreateSchema = z
  .object({
    label: z.string().min(1).max(255),
    body: z.string().min(1).max(4000),
    accountTypeDefId: z.string().uuid().nullish(),
    commodityId: z.string().uuid().nullish(),
    priority: z.number().int().min(0).max(10_000).default(100),
    activeFrom: z.coerce.date(),
    activeTo: z.coerce.date().nullish(),
  })
  .strict()
  .refine(windowRefinement.check, {
    message: windowRefinement.message,
    path: [...windowRefinement.path],
  });

export const billMessageUpdateSchema = z
  .object({
    label: z.string().min(1).max(255).optional(),
    body: z.string().min(1).max(4000).optional(),
    accountTypeDefId: z.string().uuid().nullish(),
    commodityId: z.string().uuid().nullish(),
    priority: z.number().int().min(0).max(10_000).optional(),
    activeFrom: z.coerce.date().optional(),
    activeTo: z.coerce.date().nullish(),
  })
  .strict()
  .refine(windowRefinement.check, {
    message: windowRefinement.message,
    path: [...windowRefinement.path],
  });

export type BillMessageCreate = z.infer<typeof billMessageCreateSchema>;
export type BillMessageUpdate = z.infer<typeof billMessageUpdateSchema>;
