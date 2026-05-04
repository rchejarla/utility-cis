-- Rate Model v2 — Slice 1, Task 8
-- Extend Container, Premise, ServiceAgreement with attribute columns the new
-- rate components consult. All new columns are nullable or have defaults so
-- existing rows are valid; Task 10's seed populates them.

-- Container: solid-waste catalog lookup attributes.
ALTER TABLE "container"
  ADD COLUMN "size" VARCHAR(20),
  ADD COLUMN "frequency" VARCHAR(20),
  ADD COLUMN "item_type" VARCHAR(50);

-- Premise: stormwater pricing attributes.
ALTER TABLE "premise"
  ADD COLUMN "eru_count" DECIMAL(8, 2),
  ADD COLUMN "impervious_sqft" INTEGER,
  ADD COLUMN "has_stormwater_infra" BOOLEAN NOT NULL DEFAULT false;

-- ServiceAgreement: optional FK to rate_service_class. Nullable for now;
-- the seed will populate every SA in Task 10.
ALTER TABLE "service_agreement"
  ADD COLUMN "rate_service_class_id" UUID;

ALTER TABLE "service_agreement"
  ADD CONSTRAINT "service_agreement_rate_service_class_id_fkey"
  FOREIGN KEY ("rate_service_class_id")
  REFERENCES "rate_service_class"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "service_agreement_rate_service_class_id_idx"
  ON "service_agreement"("rate_service_class_id");
