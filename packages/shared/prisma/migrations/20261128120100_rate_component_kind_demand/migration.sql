-- Spec 31 (demand charges), slice 2.
--
-- A charge per kW of peak demand is its own kind. Filed under
-- `consumption` it would print as usage, and a selector such as
-- `kind: consumption` — an energy-only discount or tax — would sweep it in
-- without anyone having asked. Sorted between consumption (20) and
-- derived consumption (25), which is where it sits on a bill.
INSERT INTO rate_component_kind (id, utility_id, code, label, description, sort_order)
VALUES (
  gen_random_uuid(), NULL, 'demand', 'Demand Charge',
  'Priced per kW of peak demand (spec 31): the period''s measured peak, optionally held at a ratchet.',
  22
)
ON CONFLICT DO NOTHING;
