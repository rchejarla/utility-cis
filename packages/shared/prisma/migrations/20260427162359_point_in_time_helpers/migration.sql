-- Point-in-time query helpers (FR-EFF-020 / Slice 1 Task 7).
--
-- Two SQL functions answering "who/what was responsible at date X?".
-- Surfaced through the API at GET /premises/:id/responsible-account
-- and GET /meters/:id/assignment, and used by the history-timeline UI
-- on the premise + meter detail pages.
--
-- Why STABLE SECURITY INVOKER:
--
--   * STABLE — these are pure reads with no side effects, and within a
--     single statement the result is determined by the input arguments
--     and the snapshot. Postgres can hoist them out of inner loops.
--   * SECURITY INVOKER — execute as the caller's role, so RLS policies
--     and `current_setting('app.current_utility_id')` are evaluated in
--     the calling session's context. The application sets the GUC at
--     request start; these functions read it like any other tenant-
--     scoped query path.
--
-- Why `current_setting(...)::uuid` instead of relying solely on RLS:
-- the functions are called via raw $queryRaw which doesn't always
-- arrive on a fully-RLS-policied path (the API uses the bypass role
-- inside withTenant). Filtering by the GUC inside the function body
-- is the belt that complements RLS's suspenders — same scope as RLS
-- would enforce, just inlined.
--
-- Why include FINAL in `responsible_account_at`: a FINAL SA was the
-- responsible party until its end_date. "Who was responsible on
-- 2024-03-15?" must return the FINAL SA whose date range contains
-- that date — not skip it just because the SA later went terminal.
-- CLOSED is excluded because a CLOSED SA represents a fully-resolved
-- relationship that no longer attests to past responsibility (it's
-- the cancelled-not-fulfilled case).

CREATE OR REPLACE FUNCTION responsible_account_at(
  p_premise_id uuid,
  p_commodity_id uuid,
  p_as_of_date date
) RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT account_id FROM service_agreement
  WHERE premise_id = p_premise_id
    AND commodity_id = p_commodity_id
    AND start_date <= p_as_of_date
    AND (end_date IS NULL OR end_date >= p_as_of_date)
    AND status IN ('ACTIVE', 'PENDING', 'FINAL')
    AND utility_id = current_setting('app.current_utility_id')::uuid
  ORDER BY start_date DESC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION meter_assignment_at(
  p_meter_id uuid,
  p_as_of_date date
) RETURNS TABLE(service_agreement_id uuid, account_id uuid, premise_id uuid)
  LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT sam.service_agreement_id, sa.account_id, sa.premise_id
  FROM service_agreement_meter sam
  JOIN service_agreement sa ON sa.id = sam.service_agreement_id
  WHERE sam.meter_id = p_meter_id
    AND sam.added_date <= p_as_of_date
    AND (sam.removed_date IS NULL OR sam.removed_date >= p_as_of_date)
    AND sam.utility_id = current_setting('app.current_utility_id')::uuid
  ORDER BY sam.added_date DESC
  LIMIT 1
$$;
