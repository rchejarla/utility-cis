-- Move role assignment off cis_user.role_id onto a new user_role join
-- table. The new table holds (user_id, account_id?, role_id):
--   - account_id NULL  → tenant-wide role (admin staff)
--   - account_id NOT NULL → role applies only when the user is acting
--     on that account (portal contacts; one row per account they have
--     access to, possibly with different roles per account).
--
-- This unblocks the per-account permissions model: the same person can
-- be PRIMARY on their own account and BILLING on a relative's, with
-- different portal capabilities resolved per active account.
--
-- Slice 1 scope: schema + backfill only. The admin app's behavior is
-- preserved exactly — every CisUser ends up with one user_role row
-- where account_id IS NULL, mirroring their current cis_user.role_id.
-- Portal/contacts UI changes ship in Slice 2 + Slice 3.

-- ─── 1. user_role table ───────────────────────────────────────────────

CREATE TABLE user_role (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utility_id  UUID NOT NULL,
  user_id     UUID NOT NULL,
  account_id  UUID,
  role_id     UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_role_user_fk    FOREIGN KEY (user_id)    REFERENCES cis_user(id) ON DELETE CASCADE,
  CONSTRAINT user_role_account_fk FOREIGN KEY (account_id) REFERENCES account(id)  ON DELETE CASCADE,
  CONSTRAINT user_role_role_fk    FOREIGN KEY (role_id)    REFERENCES role(id)     ON DELETE RESTRICT
);

CREATE UNIQUE INDEX user_role_user_account_uq
  ON user_role (user_id, account_id);
CREATE INDEX user_role_account_idx       ON user_role (account_id);
CREATE INDEX user_role_role_idx          ON user_role (role_id);
CREATE INDEX user_role_utility_user_idx  ON user_role (utility_id, user_id);

-- Postgres treats NULL as distinct in unique indexes, so the unique
-- above allows one user to have multiple (user_id, NULL, role_id) rows
-- in principle. A user should have at most one tenant-wide role —
-- enforce that with a partial unique index.
CREATE UNIQUE INDEX user_role_one_tenant_wide_per_user
  ON user_role (user_id) WHERE account_id IS NULL;

-- ─── 2. Backfill from cis_user.role_id ────────────────────────────────
-- Every existing CisUser gets one tenant-wide row (account_id NULL).
-- Admin behavior post-migration is identical: getUserRole resolves
-- the same roleId it did before.

INSERT INTO user_role (utility_id, user_id, account_id, role_id)
SELECT utility_id, id AS user_id, NULL::uuid, role_id
FROM cis_user;

-- ─── 3. Drop the obsolete cis_user.role_id column ─────────────────────

DROP INDEX IF EXISTS "cis_user_role_id_idx";
ALTER TABLE cis_user DROP CONSTRAINT IF EXISTS "cis_user_role_id_fkey";
ALTER TABLE cis_user DROP COLUMN role_id;

-- ─── 4. Strip role + is_primary off contact ───────────────────────────
-- Contact becomes record-only. Anyone with permissions on an account
-- is represented by cis_user + user_role instead.

ALTER TABLE contact DROP COLUMN role;
ALTER TABLE contact DROP COLUMN is_primary;
ALTER TABLE contact ADD COLUMN notes TEXT;

DROP TYPE contact_role;

-- ─── 5. RLS for user_role ─────────────────────────────────────────────

ALTER TABLE user_role ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_role
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);
