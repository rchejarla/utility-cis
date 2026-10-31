-- ============================================================
-- DO NOT RUN `prisma migrate dev` AGAINST THIS SCHEMA.
--
-- Everything in this file is invisible to schema.prisma, so Prisma
-- compares the database against the model, finds 35 CHECK constraints,
-- 6 generated columns, 62 policies, a hypertable, a trigger, an
-- exclusion constraint and 6 partial indexes that the model does not
-- describe — and generates a migration REVERTING them. It will look
-- like a routine drift fix and will silently remove the ledger's
-- invariants and full-text search.
--
-- Use `prisma migrate deploy`. To change the schema, write the
-- migration by hand, or generate one with `migrate diff` and then read
-- it line by line before keeping it. CLAUDE.md records the recreate
-- procedure for a database that has fallen behind.
-- ============================================================

-- Everything `schema.prisma` cannot express, and which a baseline
-- generated from it therefore omits. Extracted from a database built
-- from the 51 migrations this pair replaces, so the expressions here are
-- the ones that were actually running, not a transcription of them.
--
-- Order matters: extensions, then the hypertable, then the generated
-- columns (the baseline creates them as plain columns, and a column
-- cannot be converted in place), then the indexes and the exclusion
-- constraint that depend on them, then the trigger, then RLS.

-- ─── Extensions ──────────────────────────────────────────────────
-- btree_gist is required by the exclusion constraint below;
-- timescaledb by the hypertable. The timescale/timescaledb image
-- preloads the latter — this call is defensive for plain Postgres.
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "timescaledb";

-- ─── Hypertable ──────────────────────────────────────────────────
-- meter_read is the highest-volume table in the system: one row per
-- meter per read period, forever. Partitioned by month so a billing
-- period reads one or two chunks instead of scanning years. Must run
-- while the table is empty. Its composite primary key (id,
-- read_datetime) is in schema.prisma precisely because TimescaleDB
-- requires the partitioning column in every unique constraint.
SELECT create_hypertable(
  'meter_read',
  'read_datetime',
  chunk_time_interval => INTERVAL '1 month'
);

-- ─── Generated columns ───────────────────────────────────────────
-- schema.prisma carries these as Unsupported("tsvector") /
-- Unsupported("tsrange"), which the baseline emits as plain, always-null
-- columns. Left that way, full-text search returns nothing for every
-- customer and the exclusion constraint below has nothing to compare —
-- both failing silently, with every test that does not search still
-- passing. Postgres cannot convert a column in place, so each is
-- dropped and re-added.
ALTER TABLE "account" DROP COLUMN "search_vector";
ALTER TABLE "account" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, (COALESCE(account_number, ''::character varying))::text), 'A'::"char")) STORED;
ALTER TABLE "customer" DROP COLUMN "search_vector";
ALTER TABLE "customer" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (((((setweight(to_tsvector('simple'::regconfig, (COALESCE(organization_name, ''::character varying))::text), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, (((COALESCE(first_name, ''::character varying))::text || ' '::text) || (COALESCE(last_name, ''::character varying))::text)), 'A'::"char")) || setweight(to_tsvector('simple'::regconfig, (COALESCE(email, ''::character varying))::text), 'B'::"char")) || setweight(to_tsvector('simple'::regconfig, (COALESCE(phone, ''::character varying))::text), 'C'::"char")) || setweight(to_tsvector('simple'::regconfig, (COALESCE(alt_phone, ''::character varying))::text), 'C'::"char"))) STORED;
ALTER TABLE "meter" DROP COLUMN "search_vector";
ALTER TABLE "meter" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, (COALESCE(meter_number, ''::character varying))::text), 'A'::"char")) STORED;
ALTER TABLE "premise" DROP COLUMN "search_vector";
ALTER TABLE "premise" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (((setweight(to_tsvector('simple'::regconfig, (COALESCE(address_line1, ''::character varying))::text), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, (COALESCE(address_line2, ''::character varying))::text), 'B'::"char")) || setweight(to_tsvector('simple'::regconfig, (((((COALESCE(city, ''::character varying))::text || ' '::text) || (COALESCE(state, ''::bpchar))::text) || ' '::text) || (COALESCE(zip, ''::character varying))::text)), 'B'::"char"))) STORED;
ALTER TABLE "service_agreement" DROP COLUMN "effective_range";
ALTER TABLE "service_agreement" ADD COLUMN "effective_range" tsrange GENERATED ALWAYS AS (tsrange((start_date)::timestamp without time zone, COALESCE((end_date)::timestamp without time zone, 'infinity'::timestamp without time zone), '[)'::text)) STORED;
ALTER TABLE "service_point_meter" DROP COLUMN "effective_range";
ALTER TABLE "service_point_meter" ADD COLUMN "effective_range" tsrange GENERATED ALWAYS AS (tsrange((added_date)::timestamp without time zone, COALESCE((removed_date)::timestamp without time zone, 'infinity'::timestamp without time zone), '[)'::text)) STORED;

-- ─── Indexes and constraints on those columns ────────────────────
CREATE INDEX account_search_gin ON account USING gin (search_vector);
CREATE INDEX customer_search_gin ON customer USING gin (search_vector);
CREATE INDEX meter_search_gin ON meter USING gin (search_vector);
CREATE INDEX premise_search_gin ON premise USING gin (search_vector);
ALTER TABLE ONLY service_point_meter ADD CONSTRAINT spm_no_double_install EXCLUDE USING gist (meter_id WITH =, effective_range WITH &&);

-- ─── Partial indexes ─────────────────────────────────────────────
-- Prisma cannot express an index with a WHERE clause, so a baseline
-- generated from schema.prisma omits these five entirely. Four are
-- UNIQUE and enforce real invariants — one base unit per commodity and
-- measure type, one BILL_CHARGE per bill, one tenant-wide role per
-- user — which would simply stop being enforced, with no error anywhere.
-- Found by diffing a database built from the 51 migrations against one
-- built from this pair: 236 indexes against 231.
CREATE UNIQUE INDEX ledger_entry_bill_charge_key ON ledger_entry USING btree (utility_id, bill_id) WHERE (type = 'BILL_CHARGE'::"LedgerEntryType");
CREATE INDEX ledger_entry_open_debits_idx ON ledger_entry USING btree (utility_id, due_date) WHERE ((open_amount > (0)::numeric) AND (due_date IS NOT NULL));
CREATE INDEX service_request_sla_due_at_open_idx ON service_request USING btree (utility_id, sla_due_at) WHERE (status <> ALL (ARRAY['COMPLETED'::"ServiceRequestStatus", 'CANCELLED'::"ServiceRequestStatus", 'FAILED'::"ServiceRequestStatus"]));
CREATE UNIQUE INDEX unit_of_measure_base_unit_per_group_idx ON unit_of_measure USING btree (utility_id, commodity_id, measure_type_id) WHERE (is_base_unit = true);
CREATE UNIQUE INDEX user_role_one_tenant_wide_per_user ON user_role USING btree (user_id) WHERE (account_id IS NULL);

-- One more that Prisma renders without its predicate rather than
-- omitting: schema.prisma declares @@index([utilityId, readEventId]),
-- so the baseline creates it as a full index over every meter read.
-- The original is partial, which is the point — read_event_id is null
-- for most rows, and a full index over millions of nulls is the cost
-- this avoids.
DROP INDEX meter_read_utility_id_read_event_id_idx;
CREATE INDEX meter_read_utility_id_read_event_id_idx ON meter_read USING btree (utility_id, read_event_id) WHERE (read_event_id IS NOT NULL);

-- ─── Functions and trigger ───────────────────────────────────────
CREATE FUNCTION enforce_sa_lifecycle_invariants() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Rule 1: terminal status must carry an end_date.
  IF NEW.status IN ('FINAL', 'CLOSED') AND NEW.end_date IS NULL THEN
    RAISE EXCEPTION 'SA_LIFECYCLE_INVARIANT_VIOLATION: status % requires end_date to be set', NEW.status
      USING ERRCODE = 'check_violation',
            HINT = 'Use the close-service-agreement endpoint to bundle end_date + status atomically.';
  END IF;

  -- Rule 2: cannot set end_date on an open SA without simultaneously
  -- moving status to terminal. Only relevant on UPDATE — INSERT can
  -- legitimately set end_date with PENDING/ACTIVE if the SA is being
  -- created with a known end (e.g., short-term construction water).
  IF TG_OP = 'UPDATE' THEN
    IF OLD.end_date IS NULL
       AND NEW.end_date IS NOT NULL
       AND NEW.status IN ('PENDING', 'ACTIVE')
       AND OLD.status IN ('PENDING', 'ACTIVE') THEN
      RAISE EXCEPTION 'SA_LIFECYCLE_INVARIANT_VIOLATION: cannot set end_date on a still-active SA without also moving status to FINAL/CLOSED'
        USING ERRCODE = 'check_violation',
              HINT = 'Use the close-service-agreement endpoint instead of a generic UPDATE.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION meter_assignment_at(p_meter_id uuid, p_as_of_date date) RETURNS TABLE(service_agreement_id uuid, account_id uuid, premise_id uuid)
    LANGUAGE sql STABLE
    AS $$
  SELECT sa.id AS service_agreement_id, sa.account_id, sp.premise_id
  FROM service_point_meter spm
  JOIN service_point sp ON sp.id = spm.service_point_id
  JOIN service_agreement sa ON sa.id = sp.service_agreement_id
  WHERE spm.meter_id = p_meter_id
    AND spm.added_date <= p_as_of_date
    AND (spm.removed_date IS NULL OR spm.removed_date >= p_as_of_date)
    AND spm.utility_id = current_setting('app.current_utility_id')::uuid
  ORDER BY spm.added_date DESC
  LIMIT 1
$$;

CREATE FUNCTION responsible_account_at(p_premise_id uuid, p_commodity_id uuid, p_as_of_date date) RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT sa.account_id
  FROM service_point sp
  JOIN service_agreement sa ON sa.id = sp.service_agreement_id
  WHERE sp.premise_id = p_premise_id
    AND sa.commodity_id = p_commodity_id
    AND sp.start_date <= p_as_of_date
    AND (sp.end_date IS NULL OR sp.end_date >= p_as_of_date)
    AND sa.status IN ('ACTIVE', 'PENDING', 'FINAL')
    AND sp.utility_id = current_setting('app.current_utility_id')::uuid
  ORDER BY sp.start_date DESC
  LIMIT 1
$$;

CREATE TRIGGER before_sa_lifecycle_invariants BEFORE INSERT OR UPDATE ON service_agreement FOR EACH ROW EXECUTE FUNCTION enforce_sa_lifecycle_invariants();

-- ─── Database-level defaults ─────────────────────────────────────
-- Prisma's @default(uuid()) and @updatedAt are generated client-side,
-- so a baseline from schema.prisma emits no DEFAULT for these columns.
-- The hand-written migrations set them in the database as well, and
-- that difference is load-bearing for anything writing SQL directly
-- rather than through the client — an INSERT omitting id or updated_at
-- succeeds against the old schema and fails with a not-null violation
-- against a diff-generated one.
--
-- 25 id columns and 13 updated_at, found by diffing a database built
-- from the 51 migrations against one built from this pair.
ALTER TABLE account_type_def ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE account_type_def ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE bill ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE bill_document ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE bill_message ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE bill_message ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE bill_segment ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE bill_segment_line ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE billing_run ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE billing_run_item ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE import_row ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE in_app_notification ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE ledger_application ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE ledger_entry ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE ledger_reason_def ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE ledger_reason_def ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE premise_type_def ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE premise_type_def ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE rate_assignment_role ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE rate_assignment_role ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE rate_component ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE rate_component ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE rate_component_kind ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE rate_component_kind ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE rate_index ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE rate_index ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE rate_service_class ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE rate_service_class ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE sa_rate_schedule_assignment ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE sa_rate_schedule_assignment ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE service_point ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE service_point ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE service_point_meter ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE user_role ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE user_role ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE rate_variable ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE rate_variable ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE wqa_value ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- ─── Check constraints ───────────────────────────────────────────
-- Prisma cannot express a CHECK constraint, so a baseline generated from
-- schema.prisma has none of these 35 — and losing them is not a
-- performance matter, it is the ledger's invariants going unenforced: a
-- BILL_CHARGE with no bill, a PAYMENT with a positive amount, a
-- WRITE_OFF with no reason all become insertable.
--
-- Caught by the integration suite, not by my own comparison: I had
-- compared indexes, policies, generated columns, triggers, hypertables,
-- foreign keys and defaults, and never thought to compare pg_constraint
-- by type. Nine tests asserting "this write is rejected" reported the
-- promise resolving instead.
ALTER TABLE account ADD CONSTRAINT account_deposit_amount_nonneg CHECK ((deposit_amount >= (0)::numeric));
ALTER TABLE account ADD CONSTRAINT account_language_pref_format CHECK ((language_pref ~ '^[a-z]{2}-[A-Z]{2}$'::text));
ALTER TABLE account ADD CONSTRAINT account_number_nonempty CHECK ((char_length(TRIM(BOTH FROM account_number)) > 0));
ALTER TABLE billing_cycle ADD CONSTRAINT billing_cycle_bill_day_valid CHECK (((bill_day_of_month >= 1) AND (bill_day_of_month <= 31)));
ALTER TABLE billing_cycle ADD CONSTRAINT billing_cycle_code_nonempty CHECK ((char_length(TRIM(BOTH FROM cycle_code)) > 0));
ALTER TABLE billing_cycle ADD CONSTRAINT billing_cycle_read_day_valid CHECK (((read_day_of_month >= 1) AND (read_day_of_month <= 31)));
ALTER TABLE billing_run ADD CONSTRAINT billing_run_due_after_bill CHECK ((due_date >= bill_date));
ALTER TABLE billing_run ADD CONSTRAINT billing_run_window_ordered CHECK ((window_end >= window_start));
ALTER TABLE billing_run_item ADD CONSTRAINT billing_run_item_period_ordered CHECK (((service_period_end IS NULL) OR (service_period_start IS NULL) OR (service_period_end >= service_period_start)));
ALTER TABLE cis_user ADD CONSTRAINT cis_user_email_format CHECK (((email)::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'::text));
ALTER TABLE commodity ADD CONSTRAINT commodity_code_nonempty CHECK ((char_length(TRIM(BOTH FROM code)) > 0));
ALTER TABLE commodity ADD CONSTRAINT commodity_display_order_nonneg CHECK ((display_order >= 0));
ALTER TABLE contact ADD CONSTRAINT contact_email_format CHECK (((email IS NULL) OR ((email)::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'::text)));
ALTER TABLE customer ADD CONSTRAINT customer_email_format CHECK (((email IS NULL) OR ((email)::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'::text)));
ALTER TABLE ledger_application ADD CONSTRAINT ledger_application_amount_positive CHECK ((amount > (0)::numeric));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_amount_nonzero CHECK ((amount <> (0)::numeric));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_assessed_on_only_fee CHECK (((assessed_on_id IS NULL) OR (type = 'FEE'::"LedgerEntryType")));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_bill_charge_has_bill CHECK (((type <> 'BILL_CHARGE'::"LedgerEntryType") OR (bill_id IS NOT NULL)));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_open_sign CHECK (((open_amount = (0)::numeric) OR (sign(open_amount) = sign(amount))));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_open_within_amount CHECK ((abs(open_amount) <= abs(amount)));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_reason_required CHECK (((type <> ALL (ARRAY['FEE'::"LedgerEntryType", 'ADJUSTMENT_DEBIT'::"LedgerEntryType", 'ADJUSTMENT_CREDIT'::"LedgerEntryType", 'WRITE_OFF'::"LedgerEntryType"])) OR (reason_id IS NOT NULL) OR (bill_id IS NOT NULL)));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_tender_only_payment CHECK (((tender IS NULL) OR (type = ANY (ARRAY['PAYMENT'::"LedgerEntryType", 'DEPOSIT'::"LedgerEntryType", 'REFUND'::"LedgerEntryType"]))));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_type_sign CHECK ((((type = ANY (ARRAY['BILL_CHARGE'::"LedgerEntryType", 'FEE'::"LedgerEntryType", 'ADJUSTMENT_DEBIT'::"LedgerEntryType", 'REFUND'::"LedgerEntryType"])) AND (amount > (0)::numeric)) OR ((type = ANY (ARRAY['PAYMENT'::"LedgerEntryType", 'ADJUSTMENT_CREDIT'::"LedgerEntryType", 'WRITE_OFF'::"LedgerEntryType", 'DEPOSIT'::"LedgerEntryType"])) AND (amount < (0)::numeric)) OR ((type = 'REVERSAL'::"LedgerEntryType") AND (reverses_id IS NOT NULL))));
ALTER TABLE meter ADD CONSTRAINT meter_dial_count_positive CHECK (((dial_count IS NULL) OR (dial_count > 0)));
ALTER TABLE meter ADD CONSTRAINT meter_install_removal_ordered CHECK (((removal_date IS NULL) OR (removal_date >= install_date)));
ALTER TABLE meter ADD CONSTRAINT meter_multiplier_positive CHECK ((multiplier > (0)::numeric));
ALTER TABLE meter ADD CONSTRAINT meter_number_nonempty CHECK ((char_length(TRIM(BOTH FROM meter_number)) > 0));
ALTER TABLE rate_schedule ADD CONSTRAINT rate_schedule_code_nonempty CHECK ((char_length(TRIM(BOTH FROM code)) > 0));
ALTER TABLE rate_schedule ADD CONSTRAINT rate_schedule_dates_ordered CHECK (((expiration_date IS NULL) OR (expiration_date > effective_date)));
ALTER TABLE rate_schedule ADD CONSTRAINT rate_schedule_version_positive CHECK ((version >= 1));
ALTER TABLE service_agreement ADD CONSTRAINT chk_sa_end_ge_start CHECK (((end_date IS NULL) OR (end_date >= start_date)));
ALTER TABLE service_agreement ADD CONSTRAINT service_agreement_dates_ordered CHECK (((end_date IS NULL) OR (end_date >= start_date)));
ALTER TABLE service_agreement ADD CONSTRAINT service_agreement_number_nonempty CHECK ((char_length(TRIM(BOTH FROM agreement_number)) > 0));
ALTER TABLE unit_of_measure ADD CONSTRAINT uom_code_nonempty CHECK ((char_length(TRIM(BOTH FROM code)) > 0));
ALTER TABLE unit_of_measure ADD CONSTRAINT uom_conversion_factor_positive CHECK ((conversion_factor > (0)::numeric));

-- ─── Row-level security ──────────────────────────────────────────
-- Inert while the application role is a superuser that owns the
-- tables (§1.7 of the tenancy design note), and kept so the day that
-- changes the policies are already in place.
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_type_def ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_segment ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_segment_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_address ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_cycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_run_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE cis_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE commodity ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE container ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_schema ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE delinquency_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE delinquency_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batch ENABLE ROW LEVEL SECURITY;
-- in_app_notification was the one tenant-scoped table with neither RLS
-- nor a policy: 62 tables carry a tenant and only 61 were covered. The
-- gap predates the squash — the hand-written chain never had it either —
-- but this file is the first place all 62 are enumerated together, and
-- the rows hold a title, body and link per user.
ALTER TABLE in_app_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_reason_def ENABLE ROW LEVEL SECURITY;
ALTER TABLE measure_type_def ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_read ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise_type_def ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_assignment_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_component ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_component_kind ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_service_class ENABLE ROW LEVEL SECURITY;
ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE sa_rate_schedule_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_agreement ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_point ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_point_meter ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_request_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_request_type_def ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_suspension ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla ENABLE ROW LEVEL SECURITY;
ALTER TABLE suspension_type_def ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_of_measure ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduler_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility_module ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_variable ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility_theme ENABLE ROW LEVEL SECURITY;
ALTER TABLE wqa_value ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON account USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON account_type_def USING (((utility_id IS NULL) OR (utility_id = (current_setting('app.current_utility_id'::text, true))::uuid)));
CREATE POLICY tenant_isolation ON attachment USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON audit_log USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON bill USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON bill_document USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON bill_message USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON bill_segment USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON bill_segment_line USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON billing_address USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON billing_cycle USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON billing_run USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON billing_run_item USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON cis_user USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON commodity USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON contact USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON container USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON custom_field_schema USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON customer USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON delinquency_action USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON delinquency_rule USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON import_batch USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON in_app_notification USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON ledger_application USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON ledger_entry USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON ledger_reason_def USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON measure_type_def USING (((utility_id IS NULL) OR (utility_id = (current_setting('app.current_utility_id'::text, true))::uuid)));
CREATE POLICY tenant_isolation ON meter USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON meter_event USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON meter_read USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON meter_register USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON notification USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON notification_template USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON premise USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON premise_type_def USING (((utility_id IS NULL) OR (utility_id = (current_setting('app.current_utility_id'::text, true))::uuid)));
CREATE POLICY tenant_isolation ON rate_assignment_role USING (((utility_id IS NULL) OR (utility_id = (current_setting('app.current_utility_id'::text, true))::uuid)));
CREATE POLICY tenant_isolation ON rate_component USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON rate_component_kind USING (((utility_id IS NULL) OR (utility_id = (current_setting('app.current_utility_id'::text, true))::uuid)));
CREATE POLICY tenant_isolation ON rate_index USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON rate_schedule USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON rate_service_class USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON role USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON sa_rate_schedule_assignment USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON service_agreement USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON service_event USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON service_point USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON service_point_meter USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON service_request USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON service_request_counter USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON service_request_type_def USING (((utility_id IS NULL) OR (utility_id = (current_setting('app.current_utility_id'::text))::uuid)));
CREATE POLICY tenant_isolation ON service_suspension USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON sla USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON suspension_type_def USING (((utility_id IS NULL) OR (utility_id = (current_setting('app.current_utility_id'::text))::uuid)));
CREATE POLICY tenant_isolation ON unit_of_measure USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON user_preference USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON user_role USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON utility USING ((id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON utility_config USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON utility_module USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON rate_variable USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
CREATE POLICY tenant_isolation ON scheduler_config USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON utility_theme USING ((utility_id = (current_setting('app.current_utility_id'::text))::uuid));
CREATE POLICY tenant_isolation ON wqa_value USING ((utility_id = (current_setting('app.current_utility_id'::text, true))::uuid));
