-- Two live agreements may not both serve one premise for one commodity
-- over the same days.
--
-- ## What this replaces
--
-- Spec 05 and `schema.prisma` have both claimed since April that a
-- partial GIST exclusion named `no_overlapping_active_sa` enforced this.
-- It is not in the database: `pg_constraint` on `service_agreement` holds
-- two CHECKs, four FKs, the PK and one unique key, there is no GIST index
-- on the table, and no migration on disk mentions `btree_gist` for it.
-- The 2026-10-18 squash appears to have dropped it, leaving the generated
-- `effective_range` column maintained for a constraint that was gone.
-- Verified 2026-11-18. So two accounts could each hold a live water
-- service at one address, which is two bills for one supply.
--
-- ## Why a trigger and not the exclusion constraint
--
-- **The exclusion constraint cannot be written.** It is single-table, and
-- the key spans two: `premise_id` lives on `service_point`,
-- `commodity_id` on `service_agreement`. (The key spec 05 described —
-- `(utility_id, account_id, premise_id, commodity_id)` on
-- `service_agreement` — was never constructible for exactly this reason;
-- that table has no premise.) Making it expressible means denormalising
-- `commodity_id` onto `service_point` with a composite FK to keep it from
-- drifting, a generated range column, and `btree_gist` — a new column on
-- a hot table, a regenerated client, and four create paths to update,
-- all to say something a trigger says by joining.
--
-- **And a trigger can be added over data that already violates it.** It
-- judges writes, not rows, so the three live electric agreements sitting
-- at one premise in the dev database today are left exactly as they are.
-- An exclusion constraint would have refused to be created at all until
-- somebody decided what to do with them. Spec 05 already states this
-- principle for the constraints that landed in April: pre-existing data
-- is not rejected, only new violations are blocked.
--
-- The simpler alternative is a check in each service that opens a service
-- point. There are four — `createServiceAgreement`, the bulk importer,
-- move-in and transfer — reached through two unrelated modules, and the
-- cost it pays is concrete rather than tidiness: spec 05 records that the
-- importer already re-implements `METER_ALREADY_ASSIGNED` because it does
-- not share a path with the API, so a fifth path, or a check added to one
-- of the four and not the others, is how this rule would quietly stop
-- holding. A trigger also closes the window between two CSRs committing
-- move-ins at the same address in the same second, which no application
-- check can.
--
-- ## What it does not cover
--
-- **Only PENDING and ACTIVE agreements take part**, on both sides. A
-- terminal agreement is history, and a successor may validly cover the
-- same window — the April design said so too. The gap that leaves: an
-- agreement closed with a *future* end date is FINAL now while still
-- delivering service until then, so a new agreement starting before that
-- date is accepted and the two overlap. Closing it means deciding whether
-- a terminal agreement with a future end date is still serving, which is
-- a product question and not one a migration should answer. Narrowing the
-- rule this way means it refuses nothing legitimate, which is the
-- property worth having first.
--
-- It also does not re-check when an agreement's status changes. Nothing
-- offers FINAL → ACTIVE (`enforce_sa_lifecycle_invariants` and the
-- service layer own transitions), so a conflict cannot be resurrected
-- that way today.
--
-- No new index: `service_point_premise_id_idx` already covers the lookup.
CREATE FUNCTION enforce_one_live_service_per_premise() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_commodity uuid;
  v_status    text;
  v_conflict  text;
BEGIN
  -- The commodity is the parent's, which is why this is a trigger and
  -- not a constraint. The status decides whether this row takes part at
  -- all: a point being added to a FINAL agreement is history being
  -- recorded, not a service being opened.
  -- Scoped on the tenant as well as the id. `id` is unique, so the
  -- filter changes no result — but this function must not depend on RLS
  -- being on to be reading the right row. It runs as the invoking role,
  -- which is `cis_app` for a request and the BYPASSRLS `cis_platform`
  -- for a cross-tenant job, so the two see different things through the
  -- same statement; a trigger whose correctness varies with that is a
  -- trigger nobody can reason about. (Deliberately not SECURITY
  -- DEFINER, which would make every caller the bypassing one.)
  SELECT commodity_id, status::text
    INTO v_commodity, v_status
  FROM service_agreement
  WHERE id = NEW.service_agreement_id
    AND utility_id = NEW.utility_id;

  IF v_status IS NULL OR v_status NOT IN ('PENDING', 'ACTIVE') THEN
    RETURN NEW;
  END IF;

  -- Half-open overlap, written as comparisons rather than with
  -- `daterange(...) &&`.
  --
  -- Equivalent, and it cannot fail: `daterange` raises 22000 ("range
  -- lower bound must be less than or equal to range upper bound") on a
  -- row whose end precedes its start, and **`service_point` has no
  -- date-ordering CHECK** — `pg_constraint` on it holds none at all,
  -- unlike `service_agreement` (`chk_sa_end_ge_start`). A BEFORE ROW
  -- trigger also runs before CHECK constraints, so adding one would not
  -- have protected this. With ranges, one malformed row would turn a
  -- clear refusal into an opaque Postgres error on an unrelated write.
  --
  -- NULL end means unbounded, hence the two IS NULL arms. `>` rather
  -- than `>=`, so a point ending on the day the next one starts is a
  -- clean hand-over and not an overlap — the `[)` convention
  -- `effective_range` already uses.
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
      -- `check_violation`, not `unique_violation`, and that is not
      -- cosmetic: Prisma recognises 23505 and replaces the message with
      -- its own "Unique constraint failed", so the sentence naming the
      -- conflicting agreement never reaches the caller. 23514 passes
      -- through, which is why `enforce_sa_lifecycle_invariants` uses it
      -- and why its marker is greppable in a test.
      USING ERRCODE = 'check_violation',
            HINT = 'Close or transfer the existing agreement before opening another at this premise.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER before_one_live_service_per_premise
  BEFORE INSERT OR UPDATE ON service_point
  FOR EACH ROW EXECUTE FUNCTION enforce_one_live_service_per_premise();
