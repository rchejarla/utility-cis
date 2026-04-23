-- Database-level invariants the API boundary already enforces through
-- Zod/Prisma. Restating them here moves the rules into the only layer
-- every writer shares — a future service, a migration, or an ad-hoc
-- psql session can't bypass them.

-- ─── Non-negative / positive numerics ────────────────────────────────────────

ALTER TABLE account ADD CONSTRAINT account_deposit_amount_nonneg
  CHECK (deposit_amount >= 0);

ALTER TABLE unit_of_measure ADD CONSTRAINT uom_conversion_factor_positive
  CHECK (conversion_factor > 0);

ALTER TABLE meter ADD CONSTRAINT meter_multiplier_positive
  CHECK (multiplier > 0);

ALTER TABLE meter ADD CONSTRAINT meter_dial_count_positive
  CHECK (dial_count IS NULL OR dial_count > 0);

ALTER TABLE commodity ADD CONSTRAINT commodity_display_order_nonneg
  CHECK (display_order >= 0);

ALTER TABLE rate_schedule ADD CONSTRAINT rate_schedule_version_positive
  CHECK (version >= 1);

-- ─── Date ordering ───────────────────────────────────────────────────────────
-- End/expiration dates must be NULL or come after (or on) their start dates.

ALTER TABLE rate_schedule ADD CONSTRAINT rate_schedule_dates_ordered
  CHECK (expiration_date IS NULL OR expiration_date > effective_date);

ALTER TABLE service_agreement ADD CONSTRAINT service_agreement_dates_ordered
  CHECK (end_date IS NULL OR end_date >= start_date);

ALTER TABLE meter ADD CONSTRAINT meter_install_removal_ordered
  CHECK (removal_date IS NULL OR removal_date >= install_date);

ALTER TABLE service_agreement_meter ADD CONSTRAINT sam_added_removed_ordered
  CHECK (removed_date IS NULL OR removed_date >= added_date);

-- ─── Day-of-month bounds ─────────────────────────────────────────────────────

ALTER TABLE billing_cycle ADD CONSTRAINT billing_cycle_read_day_valid
  CHECK (read_day_of_month BETWEEN 1 AND 31);

ALTER TABLE billing_cycle ADD CONSTRAINT billing_cycle_bill_day_valid
  CHECK (bill_day_of_month BETWEEN 1 AND 31);

-- ─── Basic format checks ─────────────────────────────────────────────────────
-- Deliberately loose: catch empty strings and obvious malformations
-- without stepping on legitimate variations. Tighter format rules still
-- live in Zod where they can return nice error messages.

ALTER TABLE customer ADD CONSTRAINT customer_email_format
  CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

ALTER TABLE contact ADD CONSTRAINT contact_email_format
  CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

ALTER TABLE cis_user ADD CONSTRAINT cis_user_email_format
  CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

ALTER TABLE account ADD CONSTRAINT account_language_pref_format
  CHECK (language_pref ~ '^[a-z]{2}-[A-Z]{2}$');

-- ─── Non-empty string guards ─────────────────────────────────────────────────

ALTER TABLE account ADD CONSTRAINT account_number_nonempty
  CHECK (char_length(trim(account_number)) > 0);

ALTER TABLE meter ADD CONSTRAINT meter_number_nonempty
  CHECK (char_length(trim(meter_number)) > 0);

ALTER TABLE service_agreement ADD CONSTRAINT service_agreement_number_nonempty
  CHECK (char_length(trim(agreement_number)) > 0);

ALTER TABLE commodity ADD CONSTRAINT commodity_code_nonempty
  CHECK (char_length(trim(code)) > 0);

ALTER TABLE unit_of_measure ADD CONSTRAINT uom_code_nonempty
  CHECK (char_length(trim(code)) > 0);

ALTER TABLE billing_cycle ADD CONSTRAINT billing_cycle_code_nonempty
  CHECK (char_length(trim(cycle_code)) > 0);

ALTER TABLE rate_schedule ADD CONSTRAINT rate_schedule_code_nonempty
  CHECK (char_length(trim(code)) > 0);
