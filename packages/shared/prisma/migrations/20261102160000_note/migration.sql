-- A note is a dated remark a staff member attaches to a record.
--
-- Polymorphic on (entity_type, entity_id), exactly as `attachment`
-- already is, so one table serves every entity rather than a `notes`
-- column appearing on each in turn. The alternative — a text column per
-- entity — was rejected on the usual grounds: it holds one note, has no
-- author, has no date, and the second note overwrites the first.
-- `meter.notes` is that column, and it is why this table exists.
--
-- **Not an overlay feature, though spec 28 is what forced it.** OVL-T-3
-- makes a mirrored entity read-only to staff, because the next overlay
-- import would silently overwrite an edit — and a read-only record with
-- nowhere to write "customer says this phone number is wrong" just
-- moves the note onto paper. But a CSR wanting to record that they
-- spoke to an owner about a leak is not an overlay concern, so notes
-- are writable in both operating modes and carry no mode gate.
--
-- **Append-only, deliberately.** No update, no delete. A note is a
-- record that somebody observed something at a time, and an editable
-- note is a record of nothing in particular — the later reader cannot
-- tell whether what they are reading is what was written. That also
-- means no `updated_at`: there is no second state for one to describe.
-- A mistaken note is corrected by adding another, which is how a
-- paper file works and for the same reason.
--
-- The author is a `cis_user` id, and the name is **copied** rather than
-- joined. A note outlives the staff member who wrote it — a leaver's
-- row may be deactivated or, in a later purge, removed — and "who said
-- this" has to survive that. The id stays for the cases where the live
-- user matters.

CREATE TABLE "note" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "entity_type" VARCHAR(100) NOT NULL,
    "entity_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "author_id" UUID NOT NULL,
    "author_name" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "note"
  ADD CONSTRAINT "note_utility_id_fkey"
  FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT;

-- No foreign key to the subject row, because there is no one table to
-- point at — the same reason `attachment` has none. A note whose
-- subject is deleted is orphaned rather than cascaded, and nothing in
-- this product hard-deletes a customer, premise, meter, account or
-- agreement: they move to a terminal status (the soft-delete rule in
-- the data-model overview).

-- An empty note is not a note. Trimmed, so whitespace does not pass.
ALTER TABLE "note"
  ADD CONSTRAINT "note_body_not_blank"
  CHECK (length(btrim("body")) > 0);

-- The one read this table has: a record's notes, newest first. Covers
-- the policy's `utility_id` lookup in the same index.
CREATE INDEX "note_subject_idx"
  ON "note" ("utility_id", "entity_type", "entity_id", "created_at" DESC);

-- The author's own notes, for "what did I record today".
CREATE INDEX "note_author_idx" ON "note" ("utility_id", "author_id", "created_at" DESC);

-- One-argument `current_setting`, deliberately: with no tenant set this
-- raises 22023 rather than returning nothing. An empty list of notes
-- reads as "nobody has recorded anything", which is a claim.
ALTER TABLE "note" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "note"
  USING ("utility_id" = (current_setting('app.current_utility_id'))::uuid);
