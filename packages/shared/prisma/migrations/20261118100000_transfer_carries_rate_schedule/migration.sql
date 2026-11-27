-- Does a transfer of service carry the source agreement's in-force
-- rate-schedule assignments onto the new agreement? See spec 05's
-- transfer section and spec 18's storage rule.
--
-- A column default rather than a backfill: `DEFAULT true` applies to the
-- rows that exist now AND to every row written afterwards, so a tenant
-- provisioned next month gets the same answer as one provisioned last
-- month. A `FROM "utility"` backfill would have reached only the tenants
-- alive when this ran.
--
-- A tenant with no `utility_config` row at all reads as all-defaults in
-- `tenant-config.service.ts`, so the service layer defaults this to true
-- as well. Both doors have to agree.
ALTER TABLE "utility_config"
  ADD COLUMN "transfer_carries_rate_schedule" BOOLEAN NOT NULL DEFAULT true;
