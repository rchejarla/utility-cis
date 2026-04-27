-- btree_gist enables tstzrange + scalar columns to be combined inside a
-- GIST exclusion constraint. Required by the upcoming SA + SAM
-- effective-range exclusion constraints (Slice 1 Tasks 1-2).
--
-- Idempotent: IF NOT EXISTS guards re-runs against pre-existing
-- environments where someone manually enabled the extension. CREATE
-- EXTENSION needs SUPERUSER or the rds_superuser role on managed
-- Postgres; production deploys may require an out-of-band step if the
-- migration role lacks privileges.
CREATE EXTENSION IF NOT EXISTS btree_gist;
