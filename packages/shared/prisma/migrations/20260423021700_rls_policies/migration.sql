-- Row Level Security — tenant isolation enforced at the database layer.
-- Every entity row carries `utility_id`; the policy checks it against the
-- session-local setting `app.current_utility_id` that the API sets on
-- each request from the JWT claim. This is defence-in-depth: a service-
-- layer bug cannot leak rows cross-tenant because the DB refuses to
-- return them.
--
-- `suspension_type_def` is special — it stores both global codes
-- (utility_id IS NULL, seeded once) and per-tenant overrides. Its policy
-- allows every tenant to SELECT global rows while still isolating their
-- own tenant-specific rows from other tenants.

-- ─── Enable RLS on every tenant-scoped table ─────────────────────────────────

ALTER TABLE commodity               ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_of_measure         ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE account                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_agreement       ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_agreement_meter ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_schedule           ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_cycle           ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_read              ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log               ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_theme            ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preference         ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer                ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_address         ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_register          ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment              ENABLE ROW LEVEL SECURITY;
ALTER TABLE cis_user                ENABLE ROW LEVEL SECURITY;
ALTER TABLE role                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_module           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_config           ENABLE ROW LEVEL SECURITY;
ALTER TABLE suspension_type_def     ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_event             ENABLE ROW LEVEL SECURITY;
ALTER TABLE container               ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_suspension      ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_event           ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batch            ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_schema     ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_template   ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification            ENABLE ROW LEVEL SECURITY;
ALTER TABLE delinquency_rule        ENABLE ROW LEVEL SECURITY;
ALTER TABLE delinquency_action      ENABLE ROW LEVEL SECURITY;

-- ─── Standard tenant-isolation policy ────────────────────────────────────────

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
CREATE POLICY tenant_isolation ON customer
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON contact
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON billing_address
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON meter_register
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON attachment
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON cis_user
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON role
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON tenant_module
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON tenant_config
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON meter_event
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON container
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON service_suspension
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON service_event
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON import_batch
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON custom_field_schema
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON notification_template
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON notification
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON delinquency_rule
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
CREATE POLICY tenant_isolation ON delinquency_action
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

-- ─── Global-or-tenant exception for suspension_type_def ──────────────────────

CREATE POLICY tenant_isolation ON suspension_type_def
  USING (
    utility_id IS NULL
    OR utility_id = current_setting('app.current_utility_id')::uuid
  );
