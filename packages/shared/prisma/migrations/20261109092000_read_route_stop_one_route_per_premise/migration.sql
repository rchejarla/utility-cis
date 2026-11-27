-- A premise is a stop on at most one route.
--
-- One reader visits one address. A premise on two routes means two
-- readers walk to it and produce two reads for one meter in one
-- window, and `meter_read` has no unique that would stop the second.
-- So the guarantee lives here, where a direct insert meets it, rather
-- than in the tray query that merely declines to offer such a premise.
--
-- `read_route_stop_premise_key` (utility_id, read_route_id, premise_id)
-- is now implied by this one. It is kept, not dropped: it is already
-- applied and named by tests, and an applied migration is not edited.
--
-- The one future that wants a premise on two routes is the commodity
-- scoping deferred in design §5.1 (a water route and a gas route over
-- the same address). That change alters route and stop uniqueness
-- together, so this constraint is not meant to survive it.
--
-- Prisma expresses this one (`@@unique`), so `migrate dev` agrees with
-- it; the migration is hand-written all the same, as every one here is.

ALTER TABLE "read_route_stop"
  ADD CONSTRAINT "read_route_stop_one_route_per_premise_key"
  UNIQUE ("utility_id", "premise_id");
