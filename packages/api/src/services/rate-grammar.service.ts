/**
 * Rate-grammar registry service. Composes the closed-grammar atoms
 * (pricing types, predicate ops, quantity sources, transforms,
 * selector ops, variable namespaces) with the tenant-resolved kinds
 * and roles, returning a single payload the configurator UI can hang
 * every dropdown off without further round-trips.
 */
import {
  PRICING_TYPES,
  PREDICATE_OPS,
  QUANTITY_SOURCES,
  TRANSFORMS,
  SELECTOR_OPS,
  VARIABLE_NAMESPACES,
} from "../lib/rate-engine/grammar-introspection.js";
import { listRateComponentKinds } from "./rate-component-kind.service.js";
import { listRateAssignmentRoles } from "./rate-assignment-role.service.js";

export async function getRegisteredGrammar(utilityId: string) {
  const [kinds, roles] = await Promise.all([
    listRateComponentKinds(utilityId),
    listRateAssignmentRoles(utilityId),
  ]);

  return {
    kinds,
    roles,
    pricingTypes: [...PRICING_TYPES],
    predicateOps: [...PREDICATE_OPS],
    quantitySources: [...QUANTITY_SOURCES],
    transforms: [...TRANSFORMS],
    selectorOps: [...SELECTOR_OPS],
    variables: [...VARIABLE_NAMESPACES],
  };
}
