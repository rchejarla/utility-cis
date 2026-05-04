/**
 * Single source of truth for the closed-grammar atom lists used by
 * the Rate Model v2 configurator UI. The shape exposed here drives
 * dropdowns, structured-vs-JSON editor selection, and per-atom
 * supportedness flags so the UI can dim out atoms that are reserved
 * for future slices (Slice 4+ peak demand, TOU, etc.).
 *
 * Adding a new pricing type / predicate op / quantity source / etc.
 * means: extend the closed list here, ship the matching engine
 * support, and the configurator dropdown picks it up automatically.
 */

export const PRICING_TYPES = [
  { code: "flat", label: "Flat per unit", structuredEditor: true },
  { code: "tiered", label: "Tiered blocks", structuredEditor: true },
  { code: "lookup", label: "Lookup table", structuredEditor: true },
  { code: "catalog", label: "Catalog (multi-key)", structuredEditor: false },
  { code: "per_unit", label: "Per unit", structuredEditor: false },
  { code: "percent_of", label: "Percent of selected lines", structuredEditor: true },
  { code: "indexed", label: "Indexed value", structuredEditor: false },
  { code: "floor", label: "Minimum floor", structuredEditor: false },
] as const;

export const PREDICATE_OPS = [
  { code: "and", label: "AND", structuredEditor: false },
  { code: "or", label: "OR", structuredEditor: false },
  { code: "not", label: "NOT", structuredEditor: false },
  { code: "class", label: "Customer class equals", structuredEditor: true },
  { code: "class_in", label: "Customer class is one of", structuredEditor: true },
  { code: "drought_stage_active", label: "Drought stage is active", structuredEditor: true },
  { code: "premise_attr", label: "Premise attribute", structuredEditor: true },
  { code: "meter_size", label: "Meter size equals", structuredEditor: false },
  { code: "meter_size_in", label: "Meter size is one of", structuredEditor: false },
  { code: "meter_role", label: "Meter role", structuredEditor: false },
  { code: "season", label: "Season", structuredEditor: false },
  { code: "tou_window", label: "TOU window", structuredEditor: false },
  { code: "qty_gte", label: "Quantity ≥", structuredEditor: false },
  { code: "qty_lte", label: "Quantity ≤", structuredEditor: false },
  { code: "customer_attr", label: "Customer attribute", structuredEditor: false },
  { code: "period", label: "Bill period within range", structuredEditor: false },
  { code: "eq", label: "Equals", structuredEditor: false },
  { code: "ne", label: "Not equals", structuredEditor: false },
  { code: "in", label: "In set", structuredEditor: false },
] as const;

export const QUANTITY_SOURCES = [
  { code: "metered", label: "Metered consumption", supported: true },
  { code: "wqa", label: "Winter Quarter Average", supported: true },
  { code: "fixed", label: "Fixed (1)", supported: true },
  { code: "item_count", label: "Count of attached items", supported: true },
  { code: "linked_commodity", label: "Linked commodity quantity", supported: true },
  { code: "premise_attribute", label: "Premise attribute", supported: true },
  { code: "peak_demand", label: "Peak demand (Slice 4+ only)", supported: false },
] as const;

export const TRANSFORMS = [
  { code: "clamp", label: "Clamp (min/max)", supported: true },
  { code: "net", label: "Net (subtract var)", supported: true },
  { code: "prorate", label: "Prorate by days", supported: true },
  { code: "subtract_linked_commodity", label: "Subtract linked commodity", supported: true },
  { code: "floor", label: "Floor (minimum)", supported: true },
  { code: "ratchet", label: "Ratchet (peak-demand-based)", supported: false },
  { code: "tou_window_filter", label: "Filter by TOU window", supported: false },
  { code: "power_factor", label: "Power factor adjustment", supported: false },
  { code: "load_factor", label: "Load factor adjustment", supported: false },
] as const;

export const SELECTOR_OPS = [
  { code: "component_id", label: "Specific component" },
  { code: "kind", label: "By kind" },
  { code: "kind_in", label: "By kinds (multiple)" },
  { code: "exclude_kind", label: "Exclude kinds" },
  { code: "source_schedule_id", label: "From a specific schedule" },
  { code: "source_schedule_role", label: "By schedule role" },
  { code: "has_label_prefix", label: "By label prefix" },
  { code: "and", label: "AND composition" },
  { code: "or", label: "OR composition" },
] as const;

export const VARIABLE_NAMESPACES = [
  { pattern: "account:class", scope: "per_sa", description: "Customer service class for this SA's commodity" },
  { pattern: "account:flag:<flag_name>", scope: "per_sa", description: "Boolean flag on the account" },
  { pattern: "meter:reads:<meter_id>", scope: "per_sa", description: "Aggregated meter consumption for the billing period" },
  { pattern: "meter:size:<meter_id>", scope: "per_sa", description: "Meter size (e.g. 5/8\", 1\")" },
  { pattern: "meter:role:<meter_id>", scope: "per_sa", description: "Meter role (primary, irrigation, etc.)" },
  { pattern: "wqa:current:<sa_id>", scope: "per_sa", description: "Current WQA value (override or computed)" },
  { pattern: "tenant:drought_stage", scope: "per_tenant", description: "Currently declared drought stage" },
  { pattern: "tenant:flags:<flag_name>", scope: "per_tenant", description: "Tenant-level boolean flag" },
  { pattern: "premise:attr:<attr_name>", scope: "per_sa", description: "Premise attribute (eru_count, has_stormwater_infra, etc.)" },
  { pattern: "index:<index_name>:<period>", scope: "global", description: "External rate index value" },
  { pattern: "linked:<commodity_id>:current_period", scope: "per_sa", description: "Aggregated quantity from a sibling SA on the same account+premise" },
  { pattern: "items:<sp_id>:<item_type>", scope: "per_sa", description: "Containers attached to the SA, filtered by item_type" },
] as const;
