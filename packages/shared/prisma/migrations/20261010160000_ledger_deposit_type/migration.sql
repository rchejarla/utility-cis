-- A deposit becomes a ledger entry.
--
-- The money moved, so it belongs where every other movement is recorded.
-- Spec 04 used to say deposits were "not managed in CIS financials --
-- SaaSLogic tracks actual payment"; module 23 replaced that boundary,
-- because a deposit paid in cash or by cheque never touches SaaSLogic and
-- so SaaSLogic cannot be the record of one.
--
-- Split across two migrations on purpose: PostgreSQL will not let a value
-- added to an enum be USED in the transaction that adds it, and Prisma
-- runs each migration in one. The backfill is the next migration.

ALTER TYPE "LedgerEntryType" ADD VALUE 'DEPOSIT';
