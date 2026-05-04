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
}

export class UnsupportedInSlice4Error extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented in Slice 4 of the variable loaders`);
    this.name = "UnsupportedInSlice4Error";
  }
}
