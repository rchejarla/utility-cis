-- Let a route be resequenced in one statement.
--
-- When no integer fits between two stops, the recovery is a bulk
-- resequence: `UPDATE read_route_stop SET sequence = sequence + 1 WHERE
-- read_route_id = $1 AND sequence >= $2`. A per-row unique refuses that
-- mid-statement, on a duplicate that the end state does not contain.
--
-- DEFERRABLE INITIALLY IMMEDIATE behaves exactly as before until a
-- transaction says `SET CONSTRAINTS "read_route_stop_sequence_key"
-- DEFERRED`, then is checked at commit.
--
-- The trade, known rather than discovered later: a DEFERRABLE
-- constraint cannot back `ON CONFLICT`. Nothing upserts on this key
-- (`upsertExternalRoute` targets `read_route_utility_id_code_key`, on a
-- different table).
--
-- Only the sequence key. `read_route_stop_premise_key` stays immediate:
-- one address twice on a route is never a legal intermediate state.
-- Prisma cannot express DEFERRABLE, so `migrate dev` would propose
-- reverting it.

ALTER TABLE "read_route_stop" DROP CONSTRAINT "read_route_stop_sequence_key";
ALTER TABLE "read_route_stop"
  ADD CONSTRAINT "read_route_stop_sequence_key"
  UNIQUE ("utility_id", "read_route_id", "sequence") DEFERRABLE INITIALLY IMMEDIATE;
