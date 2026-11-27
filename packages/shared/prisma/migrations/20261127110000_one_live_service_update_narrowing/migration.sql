-- The one-live-service trigger stops refusing updates that cannot create
-- an overlap.
--
-- It fired on every UPDATE of a live service_point and re-ran the whole
-- check. The migration that added it (20261118110000) left pre-existing
-- overlaps in place on purpose — a trigger judges writes, not rows — but
-- that made those rows untouchable: any edit to one of them, even one that
-- only shortens it toward resolving the overlap, met the overlap that was
-- already there and was refused with a 409.
--
-- The rule now: an UPDATE that keeps the same agreement and premise and
-- whose dates stay inside the old ones (start no earlier, end no later,
-- NULL end meaning unbounded) is let through unchecked. Such a row overlaps
-- nothing it did not overlap before, so no check can find a conflict the
-- row did not already have. Anything else — a widened range, a moved
-- premise, a different agreement, and every INSERT — is checked as before,
-- under the advisory lock from 20261127090000. The case
-- one-live-service-per-premise.integration.test.ts pins ("a closed point
-- cannot be reopened into a conflict") widens the end, so it is still
-- refused.
--
-- The simpler alternative, firing only on INSERT, would let an UPDATE
-- reopen a closed point into a conflict — the case above — so the
-- narrowing test is the smallest thing that keeps that and frees the rest.
--
-- Forward-only: a replacement of the function; the trigger is unchanged.
CREATE OR REPLACE FUNCTION enforce_one_live_service_per_premise() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_commodity uuid;
  v_status    text;
  v_conflict  text;
BEGIN
  -- An UPDATE that only keeps or narrows the row's own dates, at the same
  -- premise on the same agreement, cannot add an overlap.
  IF TG_OP = 'UPDATE'
     AND NEW.service_agreement_id = OLD.service_agreement_id
     AND NEW.premise_id = OLD.premise_id
     AND NEW.start_date >= OLD.start_date
     AND (OLD.end_date IS NULL OR (NEW.end_date IS NOT NULL AND NEW.end_date <= OLD.end_date))
  THEN
    RETURN NEW;
  END IF;

  SELECT commodity_id, status::text
    INTO v_commodity, v_status
  FROM service_agreement
  WHERE id = NEW.service_agreement_id
    AND utility_id = NEW.utility_id;

  IF v_status IS NULL OR v_status NOT IN ('PENDING', 'ACTIVE') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.utility_id::text || '|' || NEW.premise_id::text || '|' || v_commodity::text, 0)
  );

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
