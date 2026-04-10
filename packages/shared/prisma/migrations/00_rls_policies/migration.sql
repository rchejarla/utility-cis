-- Migration: 00_rls_policies (idempotent — safe to run multiple times)
-- Enable Row Level Security on all entity tables,
-- create tenant isolation policies, and configure
-- meter_read as a TimescaleDB hypertable.

-- ─── Helper: Drop + recreate policy pattern ─────────────────────────────────
-- Using DROP IF EXISTS + CREATE to make this idempotent

-- ─── Enable RLS on all tables ─────────────────────────────────────────────────

ALTER TABLE commodity ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_of_measure ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter ENABLE ROW LEVEL SECURITY;
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_agreement ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_agreement_meter ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_cycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_read ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_theme ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_address ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE cis_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_module ENABLE ROW LEVEL SECURITY;

-- ─── Tenant Isolation Policies (drop first if exists) ────────────────────────

DROP POLICY IF EXISTS tenant_isolation ON commodity;
CREATE POLICY tenant_isolation ON commodity
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON unit_of_measure;
CREATE POLICY tenant_isolation ON unit_of_measure
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON premise;
CREATE POLICY tenant_isolation ON premise
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON meter;
CREATE POLICY tenant_isolation ON meter
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON account;
CREATE POLICY tenant_isolation ON account
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON service_agreement;
CREATE POLICY tenant_isolation ON service_agreement
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON service_agreement_meter;
CREATE POLICY tenant_isolation ON service_agreement_meter
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON rate_schedule;
CREATE POLICY tenant_isolation ON rate_schedule
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON billing_cycle;
CREATE POLICY tenant_isolation ON billing_cycle
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON meter_read;
CREATE POLICY tenant_isolation ON meter_read
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON audit_log;
CREATE POLICY tenant_isolation ON audit_log
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON tenant_theme;
CREATE POLICY tenant_isolation ON tenant_theme
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON user_preference;
CREATE POLICY tenant_isolation ON user_preference
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON customer;
CREATE POLICY tenant_isolation ON customer
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON contact;
CREATE POLICY tenant_isolation ON contact
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON billing_address;
CREATE POLICY tenant_isolation ON billing_address
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON meter_register;
CREATE POLICY tenant_isolation ON meter_register
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON attachment;
CREATE POLICY tenant_isolation ON attachment
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON cis_user;
CREATE POLICY tenant_isolation ON cis_user
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON role;
CREATE POLICY tenant_isolation ON role
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON tenant_module;
CREATE POLICY tenant_isolation ON tenant_module
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

-- ─── TimescaleDB Hypertable ───────────────────────────────────────────────────

-- Only create if not already a hypertable (idempotent check)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables
    WHERE hypertable_name = 'meter_read'
  ) THEN
    PERFORM create_hypertable('meter_read', 'read_datetime', migrate_data => true);
  END IF;
END
$$;
