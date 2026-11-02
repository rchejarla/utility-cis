-- A note can be withdrawn, without being erased.
--
-- The table shipped append-only two hours ago, on the argument that a
-- note records that somebody observed something at a time and an
-- editable note records nothing in particular. That argument holds for
-- *editing* and it does not cover the obvious case Rao asked for: a
-- note on the wrong record, or one that should never have been typed.
-- With no way to withdraw it, the only correction was another note
-- saying "ignore the one above", which is worse than either.
--
-- **Soft, not hard.** Two reasons, and the second is the stronger one:
--
--   * the data-model overview's standing rule is soft deletes only —
--     entities move to a terminal state, nothing is erased;
--   * the whole point of the table is that it is a record of what
--     somebody said at a time. Erasing the row would make "was there
--     ever a note here" unanswerable, which is exactly the question a
--     dispute asks. A withdrawn note is still evidence that it was
--     written and withdrawn, and by whom.
--
-- So `deleted_at` and `deleted_by` rather than a DELETE. There is still
-- no `updated_at`: withdrawing is the only state change a note has, and
-- these two columns describe it completely. The body is never altered.
--
-- The index is replaced so the common read — a record's live notes,
-- newest first — stays a single index scan. Postgres cannot use the old
-- one to skip withdrawn rows, so the predicate goes in the index.

ALTER TABLE "note" ADD COLUMN "deleted_at" TIMESTAMPTZ;
ALTER TABLE "note" ADD COLUMN "deleted_by" UUID;

-- Both or neither. A row with a timestamp and no actor is a withdrawal
-- nobody owns, which is the one shape that would make the column
-- useless for the question it exists to answer.
ALTER TABLE "note"
  ADD CONSTRAINT "note_deletion_is_attributed"
  CHECK (("deleted_at" IS NULL) = ("deleted_by" IS NULL));

DROP INDEX "note_subject_idx";
CREATE INDEX "note_subject_idx"
  ON "note" ("utility_id", "entity_type", "entity_id", "created_at" DESC)
  WHERE ("deleted_at" IS NULL);
