-- One noun for the thing. `utility_id` names the tenant on 61 tables;
-- these four named the architecture instead, in the same schema. What
-- they hold is a utility's theme, modules, config and settings.
--
-- Postgres carries indexes, constraints and RLS policies through a table
-- rename, so nothing else is restated here.
ALTER TABLE tenant_theme   RENAME TO utility_theme;
ALTER TABLE tenant_module  RENAME TO utility_module;
ALTER TABLE tenant_config  RENAME TO utility_config;
ALTER TABLE tenant_setting RENAME TO utility_setting;
