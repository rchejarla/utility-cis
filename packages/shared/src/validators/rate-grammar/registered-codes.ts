// Single source of truth for the well-known codes the codebase recognizes.
// Migrations seed corresponding global rows in rate_component_kind and
// rate_assignment_role; tenants may add per-utility overrides but cannot
// introduce new codes (the engine has no behavior for unregistered codes).

export const RATE_COMPONENT_KIND_CODES = [
  "service_charge",
  "consumption",
  "derived_consumption",
  "non_meter",
  "item_price",
  "one_time_fee",
  "surcharge",
  "tax",
  "credit",
  "reservation_charge",
  "minimum_bill",
] as const;

export type RateComponentKindCode = (typeof RATE_COMPONENT_KIND_CODES)[number];

export const RATE_ASSIGNMENT_ROLE_CODES = [
  "primary",
  "delivery",
  "supply",
  "rider",
  "opt_in",
] as const;

export type RateAssignmentRoleCode = (typeof RATE_ASSIGNMENT_ROLE_CODES)[number];
