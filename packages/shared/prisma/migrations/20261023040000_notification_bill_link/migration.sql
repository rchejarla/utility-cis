-- Which bill a notification delivered, where it delivered one.
--
-- Bill delivery (Bozeman #132) needs a record per attempt: the channel,
-- the address it went to, whether it arrived, the provider's id for it,
-- and the error if it did not. `notification` already is that record —
-- status, provider, provider_message_id, attempts, sent_at, error — with
-- a queue draining it, retry, quiet hours and templates on top. A
-- parallel `bill_delivery` table would restate eight of those columns to
-- gain nothing.
--
-- What it lacked was the link. The context JSON could have carried a
-- bill id, but "has this bill been sent, and what happened" is a
-- question the bills list asks for every row on the page, and a JSON
-- predicate per row is not an index. So: a real column, a real foreign
-- key, and an index that answers it.
--
-- Nullable, because almost no notification is about a bill — a
-- delinquency notice, a portal welcome, a high-usage alert carry NULL —
-- and the column exists for the ones that are.
--
-- ON DELETE SET NULL, matching `template_id` and `customer_id` on this
-- table: a notification is evidence that something was sent, and that
-- fact outlives the row it was about. Deleting a bill must not delete
-- the record of having sent it, and must not be blocked by it either.

ALTER TABLE "notification"
  ADD COLUMN "bill_id" UUID NULL
  REFERENCES "bill"("id") ON UPDATE CASCADE ON DELETE SET NULL;

-- Ordered so "the latest attempt for this bill" is the first row read.
CREATE INDEX "notification_bill_id_created_at_idx"
  ON "notification" ("bill_id", "created_at" DESC)
  WHERE "bill_id" IS NOT NULL;
