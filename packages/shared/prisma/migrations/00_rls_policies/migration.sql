-- Migration: 00_rls_policies
-- Enable Row Level Security on all 13 entity tables,
-- create tenant isolation policies, and configure
-- meter_read as a TimescaleDB hypertable.

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

-- ─── Tenant Isolation Policies ────────────────────────────────────────────────

CREATE POLICY tenant_isolation ON commodity
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON unit_of_measure
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON premise
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON meter
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON account
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON service_agreement
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON service_agreement_meter
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON rate_schedule
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON billing_cycle
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON meter_read
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON audit_log
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON tenant_theme
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE POLICY tenant_isolation ON user_preference
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

-- New tables (added for Customer, Contact, BillingAddress, MeterRegister)
ALTER TABLE customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_address ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_register ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON customer
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON contact
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON billing_address
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON meter_register
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

ALTER TABLE attachment ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON attachment
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

-- ─── TimescaleDB Hypertable ───────────────────────────────────────────────────

-- Convert meter_read to a TimescaleDB hypertable partitioned by read_datetime.
-- Requires the TimescaleDB extension to be installed and enabled.
SELECT create_hypertable('meter_read', 'read_datetime', migrate_data => true);

-- RBAC tables
ALTER TABLE cis_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_module ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON cis_user
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON role
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON tenant_module
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
