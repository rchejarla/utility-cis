-- Migration: 01_check_constraints (idempotent — safe to re-run)
-- Database-level invariants that must hold regardless of which service
-- (or ad-hoc psql session) writes the data. Zod/Prisma enforce these
-- at the API boundary, but a bug in a migration, a future service, or
-- a direct SQL fix would otherwise bypass them. CHECK constraints move
-- the rules into the only layer all writers share.
--
-- Every constraint is added via DROP IF EXISTS + ADD to stay idempotent.

-- ─── Non-negative / positive numerics ────────────────────────────────────────

ALTER TABLE account DROP CONSTRAINT IF EXISTS account_deposit_amount_nonneg;
ALTER TABLE account ADD CONSTRAINT account_deposit_amount_nonneg
  CHECK (deposit_amount >= 0);

ALTER TABLE unit_of_measure DROP CONSTRAINT IF EXISTS uom_conversion_factor_positive;
ALTER TABLE unit_of_measure ADD CONSTRAINT uom_conversion_factor_positive
  CHECK (conversion_factor > 0);

ALTER TABLE meter DROP CONSTRAINT IF EXISTS meter_multiplier_positive;
ALTER TABLE meter ADD CONSTRAINT meter_multiplier_positive
  CHECK (multiplier > 0);

ALTER TABLE meter DROP CONSTRAINT IF EXISTS meter_dial_count_positive;
ALTER TABLE meter ADD CONSTRAINT meter_dial_count_positive
  CHECK (dial_count IS NULL OR dial_count > 0);

ALTER TABLE commodity DROP CONSTRAINT IF EXISTS commodity_display_order_nonneg;
ALTER TABLE commodity ADD CONSTRAINT commodity_display_order_nonneg
  CHECK (display_order >= 0);

ALTER TABLE rate_schedule DROP CONSTRAINT IF EXISTS rate_schedule_version_positive;
ALTER TABLE rate_schedule ADD CONSTRAINT rate_schedule_version_positive
  CHECK (version >= 1);

-- ─── Date ordering ───────────────────────────────────────────────────────────
-- End/expiration dates must be NULL or come after (or on) their start dates.
-- Prevents e.g. a rate schedule that expires before it takes effect.

ALTER TABLE rate_schedule DROP CONSTRAINT IF EXISTS rate_schedule_dates_ordered;
ALTER TABLE rate_schedule ADD CONSTRAINT rate_schedule_dates_ordered
  CHECK (expiration_date IS NULL OR expiration_date > effective_date);

ALTER TABLE service_agreement DROP CONSTRAINT IF EXISTS service_agreement_dates_ordered;
ALTER TABLE service_agreement ADD CONSTRAINT service_agreement_dates_ordered
  CHECK (end_date IS NULL OR end_date >= start_date);

ALTER TABLE meter DROP CONSTRAINT IF EXISTS meter_install_removal_ordered;
ALTER TABLE meter ADD CONSTRAINT meter_install_removal_ordered
  CHECK (removal_date IS NULL OR removal_date >= install_date);

ALTER TABLE service_agreement_meter DROP CONSTRAINT IF EXISTS sam_added_removed_ordered;
ALTER TABLE service_agreement_meter ADD CONSTRAINT sam_added_removed_ordered
  CHECK (removed_date IS NULL OR removed_date >= added_date);

-- ─── Day-of-month bounds ─────────────────────────────────────────────────────
-- Postgres would technically allow 0 or 99; the billing cycle is only
-- meaningful if the day lives inside a real month.

ALTER TABLE billing_cycle DROP CONSTRAINT IF EXISTS billing_cycle_read_day_valid;
ALTER TABLE billing_cycle ADD CONSTRAINT billing_cycle_read_day_valid
  CHECK (read_day_of_month BETWEEN 1 AND 31);

ALTER TABLE billing_cycle DROP CONSTRAINT IF EXISTS billing_cycle_bill_day_valid;
ALTER TABLE billing_cycle ADD CONSTRAINT billing_cycle_bill_day_valid
  CHECK (bill_day_of_month BETWEEN 1 AND 31);

-- ─── Basic format checks ─────────────────────────────────────────────────────
-- Deliberately loose: we catch empty strings, whitespace-only, and the
-- obviously-malformed without stepping on legitimate variations (e.g.
-- international names that don't parse as "First Last"). Tighter format
-- rules still live in Zod where they can return nice error messages.

-- Email: require an @ with something on both sides, and a dot after.
-- Null is permitted because several email columns are optional.
ALTER TABLE customer DROP CONSTRAINT IF EXISTS customer_email_format;
ALTER TABLE customer ADD CONSTRAINT customer_email_format
  CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

ALTER TABLE contact DROP CONSTRAINT IF EXISTS contact_email_format;
ALTER TABLE contact ADD CONSTRAINT contact_email_format
  CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

ALTER TABLE cis_user DROP CONSTRAINT IF EXISTS cis_user_email_format;
ALTER TABLE cis_user ADD CONSTRAINT cis_user_email_format
  CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

-- Language preference: IETF tag shape like "en-US" (2 lowercase, dash,
-- 2 uppercase). Default value "en-US" satisfies this.
ALTER TABLE account DROP CONSTRAINT IF EXISTS account_language_pref_format;
ALTER TABLE account ADD CONSTRAINT account_language_pref_format
  CHECK (language_pref ~ '^[a-z]{2}-[A-Z]{2}$');

-- ─── Non-empty string guards ─────────────────────────────────────────────────
-- Prevent blank identifiers that would otherwise satisfy NOT NULL but
-- break UI layouts and URL routing.

ALTER TABLE account DROP CONSTRAINT IF EXISTS account_number_nonempty;
ALTER TABLE account ADD CONSTRAINT account_number_nonempty
  CHECK (char_length(trim(account_number)) > 0);

ALTER TABLE meter DROP CONSTRAINT IF EXISTS meter_number_nonempty;
ALTER TABLE meter ADD CONSTRAINT meter_number_nonempty
  CHECK (char_length(trim(meter_number)) > 0);

ALTER TABLE service_agreement DROP CONSTRAINT IF EXISTS service_agreement_number_nonempty;
ALTER TABLE service_agreement ADD CONSTRAINT service_agreement_number_nonempty
  CHECK (char_length(trim(agreement_number)) > 0);

ALTER TABLE commodity DROP CONSTRAINT IF EXISTS commodity_code_nonempty;
ALTER TABLE commodity ADD CONSTRAINT commodity_code_nonempty
  CHECK (char_length(trim(code)) > 0);

ALTER TABLE unit_of_measure DROP CONSTRAINT IF EXISTS uom_code_nonempty;
ALTER TABLE unit_of_measure ADD CONSTRAINT uom_code_nonempty
  CHECK (char_length(trim(code)) > 0);

ALTER TABLE billing_cycle DROP CONSTRAINT IF EXISTS billing_cycle_code_nonempty;
ALTER TABLE billing_cycle ADD CONSTRAINT billing_cycle_code_nonempty
  CHECK (char_length(trim(cycle_code)) > 0);

ALTER TABLE rate_schedule DROP CONSTRAINT IF EXISTS rate_schedule_code_nonempty;
ALTER TABLE rate_schedule ADD CONSTRAINT rate_schedule_code_nonempty
  CHECK (char_length(trim(code)) > 0);
