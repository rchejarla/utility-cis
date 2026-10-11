-- The rendered artifact for one bill: a pointer, never the bytes. The
-- object lives in the tenant's own store, reached through
-- apptor-connect's files plane, which holds the credential. No URL is
-- stored; a capability link is minted per access and discarded.
--
-- byte_size and sha256 are nullable because the row is claimed before
-- the upload runs: the unique constraint on (bill_id, document_type) is
-- what decides which of two concurrent renders proceeds, and a row
-- without a size or hash means "claimed, not yet stored".
--
-- document_type is VARCHAR rather than an enum: PRINT_EXPORT and
-- EMAIL_HTML are not designed yet, and Postgres cannot remove an enum
-- value once it has been added.
CREATE TABLE "bill_document" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"          UUID         NOT NULL,
  "bill_id"             UUID         NOT NULL,
  "document_type"       VARCHAR(20)  NOT NULL,
  "storage_integration" VARCHAR(100) NOT NULL,
  "storage_connection"  VARCHAR(100),
  "object_key"          VARCHAR(500) NOT NULL,
  "byte_size"           INTEGER,
  "sha256"              CHAR(64),
  "template_key"        VARCHAR(100) NOT NULL,
  "generated_at"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "is_paperless"        BOOLEAN      NOT NULL,
  CONSTRAINT "bill_document_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bill_document_bill_id_fkey" FOREIGN KEY ("bill_id")
    REFERENCES "bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "bill_document_bill_id_document_type_key"
  ON "bill_document" ("bill_id", "document_type");

CREATE INDEX "bill_document_utility_id_generated_at_idx"
  ON "bill_document" ("utility_id", "generated_at");

ALTER TABLE "bill_document" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "bill_document"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);
