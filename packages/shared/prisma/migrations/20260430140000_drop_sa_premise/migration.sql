-- Slice 2 cleanup. Drops:
--   1. no_overlapping_active_sa exclusion constraint — premise_id-based
--      uniqueness for (account, premise, commodity, time-range). Slice 3
--      will reintroduce an equivalent invariant scoped to service_point
--      once multi-SP-per-SA UX exists. Application-level checks in
--      createServiceAgreement still enforce meter uniqueness; the
--      SA-level invariant gap is acknowledged for Slice 3.
--   2. service_agreement.premise_id column — denormalised mirror of
--      service_point.premise_id, retired in favour of SP traversal.
--   3. responsible_account_at function — rewritten to walk
--      service_point → service_agreement instead of reading
--      service_agreement.premise_id directly.
--
-- ServiceAgreementMeter (SAM) model removal: the table was already
-- dropped in 20260430120000_service_point_foundation. The schema.prisma
-- edit alongside this migration removes the now-orphan model.

-- ─── 1. Drop the SA exclusion constraint ──────────────────────────────

ALTER TABLE service_agreement DROP CONSTRAINT no_overlapping_active_sa;

-- ─── 2. Drop premise_id (column) ──────────────────────────────────────

ALTER TABLE service_agreement DROP COLUMN premise_id;

-- ─── 3. Rewrite responsible_account_at to walk SP → SA ────────────────

CREATE OR REPLACE FUNCTION responsible_account_at(
  p_premise_id uuid,
  p_commodity_id uuid,
  p_as_of_date date
) RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER AS $$
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
