-- A mirrored row remembers which legacy row it came from, so a re-sent
-- export updates it instead of duplicating it (spec 28, OVL-IN-5).
--
-- The overlay runs a utility's existing CIS alongside this one and
-- re-imports its export **every cycle**. Every import handler was
-- create-only, which is right for a one-shot migration and fatal here:
-- the second cycle's file would report DUPLICATE_ACCOUNT,
-- DUPLICATE_METER and DUPLICATE_AGREEMENT on effectively every row, and
-- the mirror would never advance past its first load.
--
-- Why a column rather than matching on the business number we already
-- have. Three of the five mirrored tables do carry a unique one —
-- account_number, meter_number, agreement_number — so matching on those
-- would need no migration at all. It was rejected for three reasons:
--
--   * premise and customer have no unique business key. An address is
--     not unique (the import reports PREMISE_AMBIGUOUS precisely
--     because two premises can share one), and customer.email is
--     nullable and shared by households. So a column was needed for
--     those two regardless, and two matching rules — "this entity by
--     its number, that one by a column" — is worse than one rule.
--   * a business number is not a stable handle. A connector pack
--     reformats the legacy system's account number into ours, and a
--     utility renumbers accounts during a billing-system change, which
--     is exactly when an overlay is running. The legacy id does not
--     move.
--   * OVL-IN-5 asks for the legacy *identifier* to be stored. Deriving
--     it from a field that also means something else would make
--     "which legacy row is this" unanswerable the moment the two
--     disagree.
--
-- Nullable, because nothing but an overlay import sets it: a tenant
-- that never ran one has NULL in every row, and a row created through
-- the UI or any other import keeps NULL forever.
--
-- Uniqueness is therefore **partial**. A plain unique index on
-- (utility_id, legacy_key) would in fact tolerate the NULLs — Postgres
-- treats them as distinct — but the predicate states the intent rather
-- than relying on that, and keeps the index to the rows that have a
-- key. Prisma cannot express a partial unique index, so these live here
-- and the column is a bare scalar in schema.prisma; `migrate dev`
-- would propose dropping them, which is one more reason never to run
-- it against this schema.
--
-- varchar(255) matches cis_user.external_id, the one legacy-identifier
-- column that already existed.

ALTER TABLE "customer"          ADD COLUMN "legacy_key" varchar(255);
ALTER TABLE "premise"           ADD COLUMN "legacy_key" varchar(255);
ALTER TABLE "meter"             ADD COLUMN "legacy_key" varchar(255);
ALTER TABLE "account"           ADD COLUMN "legacy_key" varchar(255);
ALTER TABLE "service_agreement" ADD COLUMN "legacy_key" varchar(255);

CREATE UNIQUE INDEX "customer_legacy_key_per_tenant"
  ON "customer" USING btree ("utility_id", "legacy_key")
  WHERE ("legacy_key" IS NOT NULL);

CREATE UNIQUE INDEX "premise_legacy_key_per_tenant"
  ON "premise" USING btree ("utility_id", "legacy_key")
  WHERE ("legacy_key" IS NOT NULL);

CREATE UNIQUE INDEX "meter_legacy_key_per_tenant"
  ON "meter" USING btree ("utility_id", "legacy_key")
  WHERE ("legacy_key" IS NOT NULL);

CREATE UNIQUE INDEX "account_legacy_key_per_tenant"
  ON "account" USING btree ("utility_id", "legacy_key")
  WHERE ("legacy_key" IS NOT NULL);

CREATE UNIQUE INDEX "service_agreement_legacy_key_per_tenant"
  ON "service_agreement" USING btree ("utility_id", "legacy_key")
  WHERE ("legacy_key" IS NOT NULL);
