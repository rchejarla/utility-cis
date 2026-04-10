import { z } from "zod";

/**
 * Shared Zod schemas for route params, queries, and common payload shapes.
 * Every route that takes an :id path param should import `idParamSchema`
 * rather than redeclaring it, so that the UUID validation rule lives in one
 * place and any tightening (e.g. requiring UUID v7) propagates automatically.
 */

export const idParamSchema = z.object({
  id: z.string().uuid(),
});

export type IdParam = z.infer<typeof idParamSchema>;

/**
 * Parses req.params as {id: UUID} and returns the id. Throws a ZodError
 * on failure, which the global error handler maps to 400 VALIDATION_ERROR.
 */
export function parseIdParam(params: unknown): string {
  return idParamSchema.parse(params).id;
}
