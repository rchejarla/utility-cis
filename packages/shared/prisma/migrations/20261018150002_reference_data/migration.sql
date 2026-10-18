-- Global reference rows: the codes every tenant reads and none may edit
-- (§1.3 of docs/superpowers/specs/2026-10-17-tenancy-and-platform-admin-design.md).
-- They carry utility_id IS NULL and a tenant may shadow one by adding its
-- own row with the same code.
--
-- These were INSERTed by migrations, and a baseline generated from
-- schema.prisma contains no INSERT at all — `prisma migrate diff` emits
-- DDL, never data. Losing them does not fail loudly: it fails in
-- `prisma/seed.ts:69`, which looks up a measure type with the comment
-- "seeded by migration", and in six integration files that run that seed.
--
-- Deliberately NOT carried over: three migrations whose INSERTs were
-- backfills over existing rows — user_role, service_point /
-- service_point_meter, and the ledger deposit backfill. Each is an
-- INSERT ... SELECT that finds nothing on an empty database, which the
-- reference confirms: all four tables hold zero rows there. Reseeding
-- rather than migrating is the rule for this product in development.

INSERT INTO "measure_type_def"
  ("id", "utility_id", "code", "label", "description", "sort_order", "is_active", "created_at", "updated_at")
VALUES
  ('00000000-0000-4000-8000-0000000aaa01', NULL, 'USAGE',       'Usage',          'Total consumption over a period (e.g. kWh, gallons, therms).',    10, true, NOW(), NOW()),
  ('00000000-0000-4000-8000-0000000aaa02', NULL, 'DEMAND',      'Demand',         'Instantaneous or peak draw over an interval (e.g. kW).',          20, true, NOW(), NOW()),
  ('00000000-0000-4000-8000-0000000aaa03', NULL, 'TOU_PEAK',    'TOU — Peak',     'Time-of-use consumption during peak periods.',                    30, true, NOW(), NOW()),
  ('00000000-0000-4000-8000-0000000aaa04', NULL, 'TOU_OFFPEAK', 'TOU — Off-peak', 'Time-of-use consumption during off-peak periods.',                40, true, NOW(), NOW()),
  ('00000000-0000-4000-8000-0000000aaa05', NULL, 'REACTIVE',    'Reactive',       'Reactive power (kVARh) — typically only on large accounts.',     50, true, NOW(), NOW()),
  ('00000000-0000-4000-8000-0000000aaa06', NULL, 'OTHER',       'Other',          'Escape hatch for unusual measurement types.',                     900, true, NOW(), NOW());

INSERT INTO premise_type_def (utility_id, code, label, sort_order) VALUES
  (NULL, 'RESIDENTIAL',  'Residential',  10),
  (NULL, 'MULTI_FAMILY', 'Multi-Family', 15),
  (NULL, 'COMMERCIAL',   'Commercial',   20),
  (NULL, 'INDUSTRIAL',   'Industrial',   30),
  (NULL, 'MUNICIPAL',    'Municipal',    40);

INSERT INTO account_type_def (utility_id, code, label, sort_order) VALUES
  (NULL, 'RESIDENTIAL', 'Residential', 10),
  (NULL, 'COMMERCIAL',  'Commercial',  20),
  (NULL, 'INDUSTRIAL',  'Industrial',  30),
  (NULL, 'MUNICIPAL',   'Municipal',   40),
  (NULL, 'GOVERNMENT',  'Government',  50);

INSERT INTO rate_component_kind (id, utility_id, code, label, sort_order) VALUES
  (gen_random_uuid(), NULL, 'service_charge',      'Service Charge',       10),
  (gen_random_uuid(), NULL, 'consumption',         'Consumption',          20),
  (gen_random_uuid(), NULL, 'derived_consumption', 'Derived Consumption',  25),
  (gen_random_uuid(), NULL, 'non_meter',           'Non-Meter Charge',     30),
  (gen_random_uuid(), NULL, 'item_price',          'Item Price',           40),
  (gen_random_uuid(), NULL, 'one_time_fee',        'One-Time Fee',         50),
  (gen_random_uuid(), NULL, 'surcharge',           'Surcharge',            60),
  (gen_random_uuid(), NULL, 'tax',                 'Tax',                  70),
  (gen_random_uuid(), NULL, 'credit',              'Credit',               80),
  (gen_random_uuid(), NULL, 'reservation_charge',  'Reservation Charge',   90),
  (gen_random_uuid(), NULL, 'minimum_bill',        'Minimum Bill',        100);

INSERT INTO rate_assignment_role (id, utility_id, code, label, sort_order) VALUES
  (gen_random_uuid(), NULL, 'primary',  'Primary',           10),
  (gen_random_uuid(), NULL, 'delivery', 'Delivery',          20),
  (gen_random_uuid(), NULL, 'supply',   'Supply',            30),
  (gen_random_uuid(), NULL, 'rider',    'Rider / Surcharge', 40),
  (gen_random_uuid(), NULL, 'opt_in',   'Opt-In Program',    50);
