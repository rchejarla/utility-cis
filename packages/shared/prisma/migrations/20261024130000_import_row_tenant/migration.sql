-- import_row carries the tenant whose data it holds.
--
-- It was the one tenant-bearing table with no `utility_id`, no policy,
-- and row-level security not even enabled. `raw_data` is the imported
-- CSV — customer names, addresses, meter readings — and the table
-- reached a tenant only through `import_batch_id`.
--
-- It was not leaking: every read derives from a batch whose ownership
-- the caller proved first (`imports.service.ts` does
-- `findFirstOrThrow({ id: batchId, utilityId })` before filtering by
-- `importBatchId`). But that is caller discipline, which is the thing
-- RLS exists to stop being the only defence, and without a column on
-- the row no policy could back it up.
--
-- Denormalised rather than policied through a join. A subquery in a
-- USING clause is evaluated per row, and this table holds one row per
-- line of an imported CSV — a 12,000-row batch would mean 12,000
-- subqueries per scan.

-- Nullable first, so the backfill has somewhere to land.
ALTER TABLE "import_row" ADD COLUMN "utility_id" UUID;

UPDATE "import_row" r
   SET "utility_id" = b."utility_id"
  FROM "import_batch" b
 WHERE b."id" = r."import_batch_id";

-- Every row belongs to a batch (FK, ON DELETE CASCADE), and every batch
-- names a tenant, so the backfill cannot leave a NULL behind.
ALTER TABLE "import_row" ALTER COLUMN "utility_id" SET NOT NULL;

ALTER TABLE "import_row"
  ADD CONSTRAINT "import_row_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

-- The index the policy will be read through, and the one a tenant-wide
-- sweep of import rows would want.
CREATE INDEX "import_row_utility_id_idx" ON "import_row" ("utility_id");

-- One-argument `current_setting`, deliberately: with no tenant set this
-- raises 22023 rather than returning nothing. An empty result from a
-- table of import errors reads as "the import was clean".
ALTER TABLE "import_row" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_row" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "import_row"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);
