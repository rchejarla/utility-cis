-- Module 14 (Service Requests) — Slice B schema
--
-- Adds five enums (ServiceRequestStatus/Priority/Source/ExternalSystem/
-- BillingAction), the reference table `service_request_type_def`
-- (utility_id NULL = global row), the SLA policy table, the per-
-- tenant/year counter used to mint SR-YYYY-NNNNNN request numbers, and
-- the main `service_request` table with its relational FKs back to
-- account / premise / service_agreement / sla / cis_user (assignee +
-- creator) / delinquency_action.
--
-- A partial index on (utility_id, sla_due_at) covers only open
-- requests; closed requests (COMPLETED / CANCELLED / FAILED) no longer
-- need fast due-date scanning. This is appended below the Prisma-
-- generated section because Prisma's schema language can't express
-- partial indexes.
--
-- As in prior migrations (see 20260423022743_add_read_event_id), the
-- auto-generated diff included shadow-DB drift artifacts from Prisma
-- not being able to model tsvector FTS columns and partial indexes —
-- those DROP INDEX / DROP DEFAULT statements have been stripped so we
-- don't accidentally undo the FTS migration or the read-event-id
-- partial index on every new migration.

-- CreateEnum
CREATE TYPE "ServiceRequestStatus" AS ENUM ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_FIELD', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "ServiceRequestPriority" AS ENUM ('EMERGENCY', 'HIGH', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "ServiceRequestSource" AS ENUM ('CSR', 'PORTAL', 'API', 'SYSTEM', 'DELINQUENCY_WORKFLOW');

-- CreateEnum
CREATE TYPE "ServiceRequestExternalSystem" AS ENUM ('RAMS', 'WORK_MANAGEMENT', 'APPTORFLOW');

-- CreateEnum
CREATE TYPE "ServiceRequestBillingAction" AS ENUM ('FEE_APPLIED', 'CREDIT_APPLIED', 'NO_ACTION');

-- CreateTable
CREATE TABLE "service_request_type_def" (
    "id" UUID NOT NULL,
    "utility_id" UUID,
    "code" VARCHAR(100) NOT NULL,
    "label" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(50),
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "service_request_type_def_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "request_type" VARCHAR(100) NOT NULL,
    "priority" "ServiceRequestPriority" NOT NULL,
    "response_hours" DECIMAL(5,2) NOT NULL,
    "resolution_hours" DECIMAL(5,2) NOT NULL,
    "escalation_hours" DECIMAL(5,2),
    "escalation_user_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sla_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_request_counter" (
    "utility_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "next_value" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "service_request_counter_pkey" PRIMARY KEY ("utility_id","year")
);

-- CreateTable
CREATE TABLE "service_request" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "request_number" VARCHAR(50) NOT NULL,
    "account_id" UUID,
    "premise_id" UUID,
    "service_agreement_id" UUID,
    "request_type" VARCHAR(100) NOT NULL,
    "request_subtype" VARCHAR(100),
    "priority" "ServiceRequestPriority" NOT NULL,
    "status" "ServiceRequestStatus" NOT NULL DEFAULT 'NEW',
    "source" "ServiceRequestSource" NOT NULL DEFAULT 'CSR',
    "description" TEXT NOT NULL,
    "resolution_notes" TEXT,
    "sla_id" UUID,
    "sla_due_at" TIMESTAMPTZ,
    "sla_breached" BOOLEAN NOT NULL DEFAULT false,
    "assigned_to" UUID,
    "assigned_team" VARCHAR(100),
    "external_system" "ServiceRequestExternalSystem",
    "external_request_id" VARCHAR(200),
    "external_status" VARCHAR(100),
    "delinquency_action_id" UUID,
    "billing_action" "ServiceRequestBillingAction",
    "adhoc_charge_id" UUID,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,

    CONSTRAINT "service_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_request_type_def_is_active_sort_order_idx" ON "service_request_type_def"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "service_request_type_def_utility_id_code_key" ON "service_request_type_def"("utility_id", "code");

-- CreateIndex
CREATE INDEX "sla_utility_id_is_active_idx" ON "sla"("utility_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "sla_utility_id_request_type_priority_key" ON "sla"("utility_id", "request_type", "priority");

-- CreateIndex
CREATE INDEX "service_request_utility_id_account_id_status_idx" ON "service_request"("utility_id", "account_id", "status");

-- CreateIndex
CREATE INDEX "service_request_utility_id_request_type_status_idx" ON "service_request"("utility_id", "request_type", "status");

-- CreateIndex
CREATE INDEX "service_request_utility_id_assigned_to_status_idx" ON "service_request"("utility_id", "assigned_to", "status");

-- CreateIndex
CREATE UNIQUE INDEX "service_request_utility_id_request_number_key" ON "service_request"("utility_id", "request_number");

-- AddForeignKey
ALTER TABLE "sla" ADD CONSTRAINT "sla_escalation_user_id_fkey" FOREIGN KEY ("escalation_user_id") REFERENCES "cis_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_premise_id_fkey" FOREIGN KEY ("premise_id") REFERENCES "premise"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_sla_id_fkey" FOREIGN KEY ("sla_id") REFERENCES "sla"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "cis_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "cis_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_delinquency_action_id_fkey" FOREIGN KEY ("delinquency_action_id") REFERENCES "delinquency_action"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial index — only open requests need fast SLA-due-at scanning.
-- Used by the `/service-requests?slaStatus=...` filter and (in a later
-- slice) the SLA breach sweep job. Prisma's schema DSL can't express
-- partial indexes, so it lives here rather than in schema.prisma.
CREATE INDEX "service_request_sla_due_at_open_idx"
  ON "service_request" ("utility_id", "sla_due_at")
  WHERE "status" NOT IN ('COMPLETED', 'CANCELLED', 'FAILED');
