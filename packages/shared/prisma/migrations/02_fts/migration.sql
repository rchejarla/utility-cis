-- Migration: 02_fts (idempotent — safe to re-run)
-- Full-text search across the three entities the global search bar hits:
-- customers, premises, and accounts. Each table gets a GENERATED tsvector
-- column kept in sync by Postgres itself (no trigger, no application code
-- to forget) plus a GIN index for fast ranked ILIKE-style searches.
--
-- The application queries these columns via raw SQL from the search
-- service. Prisma doesn't need to know about the tsvector columns — they
-- exist only at the database layer, which keeps the Prisma model files
-- clean.
--
-- Every DDL statement uses DROP IF EXISTS + ADD so re-running the script
-- against an already-migrated database is a no-op.

-- ─── Customer ─────────────────────────────────────────────────────────
-- Weighted field ordering: organization/name get the highest rank, email
-- and phone lower. coalesce(...) is required because tsvector can't
-- contain NULL.

ALTER TABLE customer DROP COLUMN IF EXISTS search_vector;
ALTER TABLE customer ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(organization_name, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(first_name, '') || ' ' || coalesce(last_name, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(email, '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(phone, '')), 'C') ||
  setweight(to_tsvector('simple', coalesce(alt_phone, '')), 'C')
) STORED;

DROP INDEX IF EXISTS customer_search_gin;
CREATE INDEX customer_search_gin ON customer USING GIN (search_vector);

-- ─── Premise ──────────────────────────────────────────────────────────

ALTER TABLE premise DROP COLUMN IF EXISTS search_vector;
ALTER TABLE premise ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(address_line1, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(address_line2, '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(city, '') || ' ' || coalesce(state, '') || ' ' || coalesce(zip, '')), 'B')
) STORED;

DROP INDEX IF EXISTS premise_search_gin;
CREATE INDEX premise_search_gin ON premise USING GIN (search_vector);

-- ─── Account ──────────────────────────────────────────────────────────
-- Accounts have almost nothing to index beyond the account number, but
-- the GIN index still beats sequential scans at scale and keeps the
-- search endpoint shape consistent (same query against all three tables).

ALTER TABLE account DROP COLUMN IF EXISTS search_vector;
ALTER TABLE account ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(account_number, '')), 'A')
) STORED;

DROP INDEX IF EXISTS account_search_gin;
CREATE INDEX account_search_gin ON account USING GIN (search_vector);

-- ─── Meter ────────────────────────────────────────────────────────────
-- Global search also hits meter numbers (operators search by the number
-- printed on a physical meter all the time).

ALTER TABLE meter DROP COLUMN IF EXISTS search_vector;
ALTER TABLE meter ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(meter_number, '')), 'A')
) STORED;

DROP INDEX IF EXISTS meter_search_gin;
CREATE INDEX meter_search_gin ON meter USING GIN (search_vector);
