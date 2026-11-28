-- The shadow bill's comparison is chosen by staff when they ask (decided
-- 2026-11-28), not stored on the tariff. It priced nothing, so it never
-- belonged on an immutable, versioned schedule: there it could only be set
-- by revising, and bills priced on earlier versions could never be compared.
ALTER TABLE "rate_schedule" DROP COLUMN "comparison_schedule_code";
