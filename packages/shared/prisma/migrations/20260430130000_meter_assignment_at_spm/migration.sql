-- Rewrite meter_assignment_at to walk service_point_meter (SPM) →
-- service_point (SP) → service_agreement (SA) instead of the dropped
-- service_agreement_meter (SAM) table. The Slice 1 SP migration
-- (20260430120000) dropped SAM but didn't update this point-in-time
-- helper, leaving it referencing a non-existent table.
--
-- Function signature is unchanged: same params, same RETURNS shape.

CREATE OR REPLACE FUNCTION meter_assignment_at(
  p_meter_id uuid,
  p_as_of_date date
) RETURNS TABLE(service_agreement_id uuid, account_id uuid, premise_id uuid)
  LANGUAGE sql STABLE SECURITY INVOKER AS $$
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
