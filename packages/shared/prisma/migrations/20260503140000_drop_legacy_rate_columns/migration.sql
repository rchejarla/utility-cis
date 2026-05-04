-- Slice 1 Task 3: drop legacy v1 rate columns.
--
-- Wipes rate_schedule rows in dev (no production data; user
-- explicitly said "we are still in development"). Drops
-- ServiceAgreement.rate_schedule_id FK + index, the rate_type
-- column, the rate_config JSONB column, and the rate_type enum.
-- Component-based pricing replaces rate_type/rate_config in
-- subsequent tasks (4-5); a SAScheduleAssignment join replaces
-- the SA→RateSchedule FK in tasks 6/9.

-- Wipe legacy rate-schedule rows so the column drops succeed.
-- service_agreement.rate_schedule_id is NOT NULL with a RESTRICT
-- FK, so SAs must go first. SAs have RESTRICT/NO ACTION FKs from
-- meter_read, container, service_event, service_request, etc.
-- TRUNCATE CASCADE blasts through them; this is dev only and seed
-- repopulates everything on the next seed_db.bat.
TRUNCATE TABLE
  meter_read,
  container,
  service_event,
  service_request,
  service_suspension,
  service_point_meter,
  service_point,
  service_agreement,
  rate_schedule
CASCADE;

-- Drop FK + index + column from service_agreement.
ALTER TABLE "service_agreement" DROP CONSTRAINT "service_agreement_rate_schedule_id_fkey";
DROP INDEX "service_agreement_rate_schedule_id_idx";
ALTER TABLE "service_agreement" DROP COLUMN "rate_schedule_id";

-- Drop legacy columns from rate_schedule.
ALTER TABLE "rate_schedule" DROP COLUMN "rate_type";
ALTER TABLE "rate_schedule" DROP COLUMN "rate_config";

-- Drop the rate_type enum (no other table references it).
DROP TYPE "rate_type";
