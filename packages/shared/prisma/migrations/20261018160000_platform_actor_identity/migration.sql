-- The platform actor's identity: a cis_user that belongs to no tenant.
--
-- Tenancy design note Q2, answered 2026-10-18. A null utility_id means
-- "not a tenant's user", which is exactly what an actor above tenants
-- is, and it needs no second user model. The foreign key to utility(id)
-- stays and simply admits NULL, the same shape the seven global
-- reference tables already use.
--
-- The two partial indexes are not optional and are not tidying.
-- cis_user has @@unique([utility_id, email]) and
-- @@unique([utility_id, external_id]); Postgres treats NULLs as
-- distinct, so both stop constraining the moment utility_id is NULL —
-- without these, two platform actors could share an email address, and
-- an apptorID subject could be claimed twice. Prisma cannot express a
-- partial index, so schema.prisma cannot carry them and `migrate dev`
-- would propose dropping them. Never run it against this schema; see
-- CLAUDE.md.
--
-- external_id is partial on NOT NULL as well, because nothing has an
-- apptorID subject yet: a plain unique index over a column of NULLs
-- would be fine in Postgres, but pairing the two predicates keeps the
-- index's meaning exact — "one platform actor per external identity,
-- among those that have one".

ALTER TABLE "cis_user" ALTER COLUMN "utility_id" DROP NOT NULL;

CREATE UNIQUE INDEX "cis_user_platform_email_key"
  ON "cis_user" ("email")
  WHERE "utility_id" IS NULL;

CREATE UNIQUE INDEX "cis_user_platform_external_id_key"
  ON "cis_user" ("external_id")
  WHERE "utility_id" IS NULL AND "external_id" IS NOT NULL;
