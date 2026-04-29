-- Migrate PremiseType and AccountType enums to global+tenant-shadow
-- reference tables. Same pattern as measure_type_def: utility_id NULL
-- = global standard (read-only), utility_id NOT NULL = tenant-specific.
--
-- Existing premise.premise_type and account.account_type columns
-- become VARCHAR(50) holding the code string. Validation moves from
-- the enum type to app-level lookup against the ref table.
--
-- The two enum types (premise_type, account_type) are dropped at the
-- end. No data is lost: every row's existing enum value is preserved
-- as the new string code, and that code matches a seeded global row.

-- ─── 1. Reference tables ──────────────────────────────────────────────

CREATE TABLE premise_type_def (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id  UUID,
  code        VARCHAR(50) NOT NULL,
  label       VARCHAR(100) NOT NULL,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT premise_type_def_utility_code_uq UNIQUE (utility_id, code)
);
CREATE INDEX premise_type_def_active_sort_idx
  ON premise_type_def (is_active, sort_order);

CREATE TABLE account_type_def (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id  UUID,
  code        VARCHAR(50) NOT NULL,
  label       VARCHAR(100) NOT NULL,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_type_def_utility_code_uq UNIQUE (utility_id, code)
);
CREATE INDEX account_type_def_active_sort_idx
  ON account_type_def (is_active, sort_order);

-- ─── 2. Seed global rows ──────────────────────────────────────────────
-- utility_id NULL means "system-defined; every tenant sees these and
-- they cannot be edited." Includes RFP-required MULTI_FAMILY (premise)
-- and GOVERNMENT (account) values that didn't exist in the old enum.

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

-- ─── 3. Convert premise.premise_type from enum to VARCHAR(50) ─────────
-- Two-step rename so existing data is preserved exactly. Postgres
-- stores enums as text under the hood, so the cast is lossless.

ALTER TABLE premise
  ADD COLUMN premise_type_new VARCHAR(50);
UPDATE premise SET premise_type_new = premise_type::text;
ALTER TABLE premise
  ALTER COLUMN premise_type_new SET NOT NULL;
ALTER TABLE premise DROP COLUMN premise_type;
ALTER TABLE premise RENAME COLUMN premise_type_new TO premise_type;

-- ─── 4. Same conversion for account.account_type ──────────────────────

ALTER TABLE account
  ADD COLUMN account_type_new VARCHAR(50);
UPDATE account SET account_type_new = account_type::text;
ALTER TABLE account
  ALTER COLUMN account_type_new SET NOT NULL;
ALTER TABLE account DROP COLUMN account_type;
ALTER TABLE account RENAME COLUMN account_type_new TO account_type;

-- ─── 5. delinquency_rule.account_type — same conversion ───────────────
-- Nullable on this table (a rule that applies to all account types
-- has account_type IS NULL), and there's a (utility, account_type,
-- tier) unique index that references the column.

ALTER TABLE delinquency_rule
  DROP CONSTRAINT IF EXISTS delinquency_rule_utility_id_account_type_tier_key;
ALTER TABLE delinquency_rule
  ADD COLUMN account_type_new VARCHAR(50);
UPDATE delinquency_rule SET account_type_new = account_type::text WHERE account_type IS NOT NULL;
ALTER TABLE delinquency_rule DROP COLUMN account_type;
ALTER TABLE delinquency_rule RENAME COLUMN account_type_new TO account_type;
ALTER TABLE delinquency_rule
  ADD CONSTRAINT delinquency_rule_utility_id_account_type_tier_key
  UNIQUE (utility_id, account_type, tier);

-- ─── 6. Drop the old enum types ───────────────────────────────────────

DROP TYPE premise_type;
DROP TYPE account_type;

-- ─── 7. RLS for the new tables ────────────────────────────────────────
-- Global rows (utility_id IS NULL) are visible to all tenants;
-- tenant rows isolated to their own utility. Mirrors measure_type_def.

ALTER TABLE premise_type_def ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON premise_type_def
  USING (
    utility_id IS NULL
    OR utility_id = current_setting('app.current_utility_id', true)::uuid
  );

ALTER TABLE account_type_def ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON account_type_def
  USING (
    utility_id IS NULL
    OR utility_id = current_setting('app.current_utility_id', true)::uuid
  );
