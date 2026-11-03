import type { ZodSchema } from "zod";
import type { VariableKey, VariableValue } from "../rate-engine/types.js";

export interface Loader {
  capabilities(): LoaderCapability[];
  load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>>;
}

export interface LoaderCapability {
  pattern: string; // e.g. "meter:reads:<meter_id>"
  paramTypes?: Record<string, ZodSchema>;
  returns?: ZodSchema;
  scope: "per_sa" | "per_tenant" | "global";
  description: string;
  /**
   * Declared so the registry routes the key, but the loader raises
   * rather than answering it.
   *
   * It exists to give a recognised key a clear error instead of "no
   * registered loader", which reads as a typo. Marked rather than
   * inferred, because the one thing that must never happen is the
   * rate-schedule editor offering an author a variable that always
   * fails: `grammar-introspection.test.ts` requires every *other*
   * capability to be documented in `VARIABLE_NAMESPACES`, and skips
   * these.
   */
  unsupported?: true;
}

export class UnsupportedInSlice4Error extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented in Slice 4 of the variable loaders`);
    this.name = "UnsupportedInSlice4Error";
  }
}
