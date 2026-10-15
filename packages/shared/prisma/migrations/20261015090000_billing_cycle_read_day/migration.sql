-- The day a cycle's meter reads are expected to be complete by.
--
-- Promised and never built: `read_day_of_month` has been in the design
-- doc's billing_cycle table, the data model overview, spec 07 and
-- BR-BC-001 since Phase 1, including a CHECK that did not exist. This
-- adds the column and the CHECK the documents already describe.
--
-- Nullable rather than defaulted: a cycle created before this column has
-- no declared read day, and picking one for it would be inventing an
-- operational fact. A null read day means "not declared", not "day one".
--
-- The CHECK is the calendar floor (1-31, matching bill_day_of_month);
-- Zod tightens to 1-28 at the API boundary to avoid month-end ambiguity,
-- and enforces that the read day precedes the bill day. Those are
-- business rules, and they are layered deliberately — see the data model
-- overview.
ALTER TABLE "billing_cycle"
  ADD COLUMN "read_day_of_month" INTEGER;

ALTER TABLE "billing_cycle"
  ADD CONSTRAINT "billing_cycle_read_day_valid"
  CHECK ("read_day_of_month" IS NULL
         OR ("read_day_of_month" >= 1 AND "read_day_of_month" <= 31));
