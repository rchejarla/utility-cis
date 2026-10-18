-- A tenant becomes a row. Every other table already carries its id as
-- `utility_id`; this is the row that id refers to. The foreign keys come
-- in a later migration, once the seed and the test fixtures create this
-- row — a constraint is added to data that already satisfies it.

CREATE TYPE utility_status AS ENUM ('ACTIVE', 'SUSPENDED');

CREATE TABLE utility (
    id         UUID           PRIMARY KEY,
    name       VARCHAR(255)   NOT NULL,
    status     utility_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ    NOT NULL
);

-- RLS in the house style, but keyed on `id`: this table's primary key IS
-- the tenant, so there is no `utility_id` column to compare. A tenant
-- therefore sees only its own row. Listing every utility is the platform
-- actor's job and is deferred to build-order step 5.
--
-- Inert today, like every other policy here: the application role is a
-- superuser that owns the tables (§1.7 of the design note). Added for
-- consistency, so the day that changes this table is not the exception.
ALTER TABLE utility ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON utility
    USING (id = current_setting('app.current_utility_id', true)::uuid);
