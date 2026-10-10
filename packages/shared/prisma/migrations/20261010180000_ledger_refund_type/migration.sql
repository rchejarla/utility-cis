-- Money can leave again.
--
-- A credit balance -- an overpayment, an adjustment credit, a waiver that
-- exceeded the charge it named (spec 23 §6.5) -- or a security deposit,
-- could be recorded but never paid out. On an active account that was
-- harmless: §6.1 step 4 has the next bill absorb an open credit, so it
-- resolves itself. On a CLOSED account there is no next bill, and
-- `/workflows/move-out` already ships and closes accounts without
-- touching either figure. A live workflow with no ending.
--
-- Split across two migrations because PostgreSQL will not let a value
-- added to an enum be USED in the transaction that adds it, and Prisma
-- runs each migration in one. Constraints and backfill are next.

ALTER TYPE "LedgerEntryType" ADD VALUE 'REFUND';
