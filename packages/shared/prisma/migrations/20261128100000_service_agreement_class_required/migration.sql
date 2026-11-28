-- An agreement's service class is required (decided 2026-11-28).
--
-- Rate charges restricted to a class ("customer class equals residential")
-- apply only to agreements in it, so an agreement with no class silently
-- missed every one of them: water and sewer bills came out without their
-- usage charges, with nothing raised. No screen could set the class, so
-- every agreement created through the app was in that state.

-- 1. Fill the unambiguous blanks: the agreement's commodity has a class
--    whose code is the account's type (a RESIDENTIAL account's electric
--    agreement -> electric "residential").
UPDATE service_agreement sa
SET rate_service_class_id = rsc.id
FROM account a, rate_service_class rsc
WHERE sa.rate_service_class_id IS NULL
  AND a.id = sa.account_id
  AND rsc.utility_id = sa.utility_id
  AND rsc.commodity_id = sa.commodity_id
  AND rsc.is_active
  AND lower(rsc.code) = lower(a.account_type::text);

-- 2. Refuse to guess the rest.
DO $$
DECLARE missing integer;
BEGIN
  SELECT count(*) INTO missing FROM service_agreement WHERE rate_service_class_id IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION '% service agreement(s) have no service class and none could be inferred from the account type. Set one on each (or reseed a dev database) before applying this migration.', missing;
  END IF;
END $$;

-- 3. Required, and a class cannot be deleted out from under an agreement
--    (classes are retired with is_active, never deleted). Still the
--    tenant-scoped composite key every tenant-to-tenant reference uses.
ALTER TABLE service_agreement ALTER COLUMN rate_service_class_id SET NOT NULL;
ALTER TABLE service_agreement DROP CONSTRAINT service_agreement_rate_service_class_id_fkey;
ALTER TABLE service_agreement
  ADD CONSTRAINT service_agreement_rate_service_class_id_fkey
  FOREIGN KEY (utility_id, rate_service_class_id)
  REFERENCES rate_service_class (utility_id, id)
  ON DELETE RESTRICT;
