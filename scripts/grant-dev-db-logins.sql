-- Dev-only: make the application and platform roles connectable.
--
-- The 20261024140000_rls_roles migration creates `cis_app` and
-- `cis_platform` as NOLOGIN with no password, deliberately — credentials
-- are not a migration's business, and the integration tests reach the
-- roles with SET ROLE rather than a connection string.
--
-- Dev needs them connectable, and this cannot live in
-- docker/init-cis-user.sh: that runs once on first init of an empty
-- volume, which is *before* any migration has been applied, so the roles
-- it would alter do not exist yet. setup_db.bat runs this after
-- `migrate deploy` instead.
--
-- Production provisions its own credentials and never runs this.
ALTER ROLE cis_app LOGIN PASSWORD 'cis_dev_password';
ALTER ROLE cis_platform LOGIN PASSWORD 'cis_dev_password';
