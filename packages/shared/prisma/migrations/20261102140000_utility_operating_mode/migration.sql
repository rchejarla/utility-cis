-- A tenant says whether this system is its system of record
-- (spec 28, OVL-T-1).
--
-- The overlay offer runs a utility's existing CIS alongside this one:
-- we mirror its data each cycle, shadow-rate its pre-bill register and
-- report the variance, while **it** keeps billing the customers. The
-- danger that makes this a column rather than a convention is
-- straightforward — an overlay tenant with a billing cycle configured
-- and a worker attached will bill. Two systems would then bill the same
-- customer for the same period, and the second bill is the one with our
-- name on it.
--
-- So the mode is a column on `utility`, not a setting in
-- `utility_config.settings`: spec 18's rule is that a value every
-- utility has is a column, and every utility has a mode. It is also
-- read on **every authenticated request**, in the same pass that
-- checks suspension and enabled modules, which is the other half of the
-- same rule — a value filtered on in SQL and read on the hot path does
-- not belong in jsonb.
--
-- Separate from `status` on purpose. Suspension is "this tenant may not
-- use the system at all", a commercial state; overlay is "this tenant
-- uses the system, and the legacy one owns the money", an operating
-- state. A tenant is routinely ACTIVE and OVERLAY at once, which one
-- column could not say.
--
-- An enum, unlike `account_type` which became a code string validated
-- against a reference table. Account types are a tenant's own
-- vocabulary and tenants invent them; there are exactly two operating
-- modes and code branches on both, so the set is code-known and closed.
-- Worth stating because PostgreSQL cannot remove an enum value, so a
-- third mode would be an addition and never a correction.
--
-- Defaults to FULL, which is what every existing tenant is: nothing has
-- ever been mirrored, so the backfill is the default and no UPDATE is
-- needed.

CREATE TYPE "utility_operating_mode" AS ENUM ('FULL', 'OVERLAY');

ALTER TABLE "utility"
  ADD COLUMN "operating_mode" "utility_operating_mode" NOT NULL DEFAULT 'FULL';

-- Partial, because the interesting set is the small one. A deployment
-- has few overlay tenants and many full ones, and every query that
-- cares asks "which tenants are mirrored" — `tenantsForScheduler`
-- excluding them from billing and delinquency, and the platform console
-- listing them. Indexing the common value would earn nothing.
CREATE INDEX "utility_overlay_mode_idx"
  ON "utility" USING btree ("operating_mode")
  WHERE ("operating_mode" = 'OVERLAY');
