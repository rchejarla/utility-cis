-- `season.code` becomes `season.season_code`.
--
-- The schema already draws a distinction and this column was on the
-- wrong side of it. Thirteen tables carry a bare `code` — commodity,
-- unit_of_measure, rate_schedule — and in each the value is a local
-- identifier whose table always supplies the context. Eight carry a
-- qualified one — `cycle_code`, `kind_code`, `role_code`, `module_key`,
-- `account_number`, `meter_number`, `agreement_number` — and in each the
-- value **travels**: it is compared against a registered constant, named
-- in another table's row, or matched by an importer.
--
-- A season code travels. It is compared in the rate engine's `season`
-- predicate, it will be named on every `tou_slot` row, and a TOU
-- calendar resolves three of these vocabularies at once — season, day
-- type and period. In the database each is unambiguous inside its own
-- table; in the pure resolver all three are bare strings, and passing
-- one where another belongs would compile, run, and classify every
-- interval wrong with no error anywhere. That is the same failure shape
-- the spec already guards against for interval timestamp bases:
-- plausible output, nothing raised.
--
-- So the name carries what the schema was carrying, and the calendar
-- tables that follow will use `day_type_code` and `period_code` for the
-- same reason.
--
-- Renamed rather than left alone because it shipped an hour ago and
-- nothing outside this codebase reads it yet. The cost of the
-- convention only rises.

ALTER TABLE "season" RENAME COLUMN "code" TO "season_code";

-- The index names the column, so it is rebuilt rather than left
-- describing something that no longer exists.
ALTER INDEX "season_code_per_set" RENAME TO "season_season_code_per_set";
