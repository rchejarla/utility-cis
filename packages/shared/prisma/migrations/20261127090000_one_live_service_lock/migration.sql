-- The one-live-service trigger takes a lock, so two concurrent openings
-- at one premise cannot both pass it.
--
-- 20261118110000_one_live_service_per_premise claimed the trigger "closes
-- the window between two CSRs committing move-ins at the same address in
-- the same second". It did not. Its conflict check is a plain SELECT, and
-- under READ COMMITTED each transaction's SELECT cannot see the other's
-- uncommitted service_point, so both pass and both commit: two live
-- agreements for one supply, which is the case it was written to stop.
--
-- The simple alternative — SERIALIZABLE for every path that opens a
-- service point — would push a retry loop into four unrelated callers
-- (createServiceAgreement, the bulk importer, move-in, transfer) for a
-- rule that only needs the two writers at *one* premise and commodity to
-- take turns. A transaction-scoped advisory lock on exactly that key does
-- this, and only those writers ever wait on it.
--
-- Why it works under READ COMMITTED: a PL/pgSQL statement in a VOLATILE
-- function takes a fresh snapshot, so the conflict SELECT that follows the
-- lock sees whatever the transaction it waited on committed. The lock is
-- released at commit or rollback, never held past the transaction.
--
-- Forward-only, so a replacement rather than an edit to the migration
-- that is already applied. The trigger itself is unchanged and keeps
-- pointing at this function.
CREATE OR REPLACE FUNCTION enforce_one_live_service_per_premise() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_commodity uuid;
  v_status    text;
  v_conflict  text;
BEGIN
  -- Unchanged from 20261118110000: the commodity is the parent's, and the
  -- status decides whether this row takes part at all. Scoped on the
  -- tenant as well as the id so the result does not depend on RLS.
  SELECT commodity_id, status::text
    INTO v_commodity, v_status
  FROM service_agreement
  WHERE id = NEW.service_agreement_id
    AND utility_id = NEW.utility_id;

  IF v_status IS NULL OR v_status NOT IN ('PENDING', 'ACTIVE') THEN
    RETURN NEW;
  END IF;

  -- Serialise the writers of one (tenant, premise, commodity). A 64-bit
  -- hash, so an unrelated key colliding costs a wait, never a wrong answer.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.utility_id::text || '|' || NEW.premise_id::text || '|' || v_commodity::text, 0)
  );

  -- Half-open overlap, NULL end unbounded — see 20261118110000 for why
  -- comparisons rather than daterange.
  SELECT sa.agreement_number
    INTO v_conflict
  FROM service_point sp
  JOIN service_agreement sa ON sa.id = sp.service_agreement_id
  WHERE sp.utility_id = NEW.utility_id
    AND sp.premise_id = NEW.premise_id
    AND sp.id IS DISTINCT FROM NEW.id
    AND sa.commodity_id = v_commodity
    AND sa.status IN ('PENDING', 'ACTIVE')
    AND (sp.end_date IS NULL OR sp.end_date > NEW.start_date)
    AND (NEW.end_date IS NULL OR NEW.end_date > sp.start_date)
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION
      'ONE_LIVE_SERVICE_PER_PREMISE: agreement % already serves this premise for this commodity over the same dates', v_conflict
      USING ERRCODE = 'check_violation',
            HINT = 'Close or transfer the existing agreement before opening another at this premise.';
  END IF;

  RETURN NEW;
END;
$$;
