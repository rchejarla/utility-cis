-- Configurable text printed on bills (Bozeman #137).
--
-- Targeting is nullable on both sides: a null account_type_def_id or
-- commodity_id means the message applies to all of them. Selection is
-- evaluated against the bill's own bill_date rather than now(), so a
-- reprint of an old bill reproduces the messages it originally carried.
CREATE TABLE "bill_message" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"          UUID         NOT NULL,
  "label"               VARCHAR(255) NOT NULL,
  "body"                TEXT         NOT NULL,
  "account_type_def_id" UUID,
  "commodity_id"        UUID,
  "priority"            INTEGER      NOT NULL DEFAULT 100,
  "active_from"         DATE         NOT NULL,
  "active_to"           DATE,
  "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "bill_message_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bill_message_account_type_def_id_fkey" FOREIGN KEY ("account_type_def_id")
    REFERENCES "account_type_def"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "bill_message_commodity_id_fkey" FOREIGN KEY ("commodity_id")
    REFERENCES "commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "bill_message_utility_id_active_from_idx"
  ON "bill_message" ("utility_id", "active_from");

ALTER TABLE "bill_message" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "bill_message"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);
