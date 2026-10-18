-- Baseline: every table, enum, index and foreign key Prisma models.
--
-- Replaces 54 incremental migrations. The product is in development and
-- no deployment holds data worth preserving, so the chain was collapsed
-- rather than carried: see docs/superpowers/specs/
-- 2026-10-17-tenancy-and-platform-admin-design.md.
--
-- Generated with `prisma migrate diff --from-empty --to-schema-datamodel`.
-- It therefore contains ONLY what schema.prisma can express. Everything
-- else — row-level security, generated columns, the hypertable, the
-- trigger, the exclusion constraint — lives in the migration beside this
-- one, and would have been silently lost had this file been the whole
-- squash.


-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "utility_status" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "premise_status" AS ENUM ('ACTIVE', 'INACTIVE', 'CONDEMNED');

-- CreateEnum
CREATE TYPE "meter_type" AS ENUM ('AMR', 'AMI', 'MANUAL', 'SMART');

-- CreateEnum
CREATE TYPE "meter_status" AS ENUM ('ACTIVE', 'REMOVED', 'DEFECTIVE', 'PENDING_INSTALL');

-- CreateEnum
CREATE TYPE "account_status" AS ENUM ('ACTIVE', 'INACTIVE', 'FINAL', 'CLOSED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "credit_rating" AS ENUM ('EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'UNRATED');

-- CreateEnum
CREATE TYPE "service_agreement_status" AS ENUM ('PENDING', 'ACTIVE', 'FINAL', 'CLOSED');

-- CreateEnum
CREATE TYPE "billing_frequency" AS ENUM ('MONTHLY', 'BIMONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "billing_run_status" AS ENUM ('PENDING', 'RUNNING', 'COMPLETE', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "billing_run_item_status" AS ENUM ('PENDING', 'BILLED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "read_type" AS ENUM ('ACTUAL', 'ESTIMATED', 'CORRECTED', 'FINAL', 'AMI');

-- CreateEnum
CREATE TYPE "read_source" AS ENUM ('MANUAL', 'AMR', 'AMI', 'CUSTOMER_SELF', 'SYSTEM');

-- CreateEnum
CREATE TYPE "audit_action" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateEnum
CREATE TYPE "theme_mode" AS ENUM ('DARK', 'LIGHT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "customer_type" AS ENUM ('INDIVIDUAL', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "customer_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "service_point_type" AS ENUM ('METERED', 'ITEM_BASED', 'NON_BADGED');

-- CreateEnum
CREATE TYPE "service_point_status" AS ENUM ('PENDING', 'ACTIVE', 'FINAL', 'CLOSED');

-- CreateEnum
CREATE TYPE "MeterEventType" AS ENUM ('LEAK', 'TAMPER', 'REVERSE_FLOW', 'HIGH_USAGE', 'NO_SIGNAL', 'BATTERY_LOW', 'COVER_OPEN', 'BURST_PIPE', 'FREEZE', 'OTHER');

-- CreateEnum
CREATE TYPE "MeterEventStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "MeterEventSource" AS ENUM ('AMI', 'FIELD', 'MANUAL', 'RULE');

-- CreateEnum
CREATE TYPE "ContainerType" AS ENUM ('CART_GARBAGE', 'CART_RECYCLING', 'CART_ORGANICS', 'CART_YARD_WASTE', 'DUMPSTER', 'ROLL_OFF');

-- CreateEnum
CREATE TYPE "ContainerStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'RETURNED', 'LOST', 'DAMAGED');

-- CreateEnum
CREATE TYPE "SuspensionStatus" AS ENUM ('PENDING', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ServiceEventType" AS ENUM ('MISSED_COLLECTION', 'CONTAMINATION', 'EXTRA_PICKUP', 'BULKY_ITEM', 'CART_DAMAGED', 'CART_STOLEN', 'CART_SWAP');

-- CreateEnum
CREATE TYPE "ServiceEventSource" AS ENUM ('RAMS', 'MANUAL', 'DRIVER_APP', 'CUSTOMER_REPORT');

-- CreateEnum
CREATE TYPE "ServiceEventStatus" AS ENUM ('RECEIVED', 'REVIEWED', 'ADJUSTMENT_PENDING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ServiceEventBillingAction" AS ENUM ('CREDIT_ISSUED', 'CHARGE_ISSUED', 'NO_ACTION');

-- CreateEnum
CREATE TYPE "ImportBatchSource" AS ENUM ('AMR', 'AMI', 'MANUAL_UPLOAD', 'API');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED', 'PARTIAL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('PENDING', 'IMPORTED', 'ERROR', 'SKIPPED');

-- CreateEnum
CREATE TYPE "InAppNotificationKind" AS ENUM ('IMPORT_COMPLETE', 'IMPORT_FAILED', 'IMPORT_CANCELLED', 'IMPORT_PARTIAL');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "delinquency_action_status" AS ENUM ('PENDING', 'COMPLETED', 'RESOLVED', 'CANCELLED');

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

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('BILL_CHARGE', 'FEE', 'ADJUSTMENT_DEBIT', 'PAYMENT', 'ADJUSTMENT_CREDIT', 'WRITE_OFF', 'REVERSAL', 'DEPOSIT', 'REFUND');

-- CreateEnum
CREATE TYPE "PaymentTender" AS ENUM ('CARD', 'ACH', 'CASH', 'CHECK', 'LOCKBOX');

-- CreateTable
CREATE TABLE "utility" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "status" "utility_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "utility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commodity" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "default_uom_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commodity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_of_measure" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "commodity_id" UUID NOT NULL,
    "measure_type_id" UUID NOT NULL,
    "conversion_factor" DECIMAL(15,8) NOT NULL,
    "is_base_unit" BOOLEAN NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "premise_type_def" (
    "id" UUID NOT NULL,
    "utility_id" UUID,
    "code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "premise_type_def_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_type_def" (
    "id" UUID NOT NULL,
    "utility_id" UUID,
    "code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "account_type_def_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "measure_type_def" (
    "id" UUID NOT NULL,
    "utility_id" UUID,
    "code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "measure_type_def_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "premise" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "address_line1" VARCHAR(255) NOT NULL,
    "address_line2" VARCHAR(255),
    "city" VARCHAR(100) NOT NULL,
    "state" CHAR(2) NOT NULL,
    "zip" VARCHAR(10) NOT NULL,
    "geo_lat" DECIMAL(9,6),
    "geo_lng" DECIMAL(9,6),
    "premise_type" VARCHAR(50) NOT NULL,
    "commodity_ids" UUID[],
    "service_territory_id" UUID,
    "municipality_code" VARCHAR(50),
    "status" "premise_status" NOT NULL DEFAULT 'ACTIVE',
    "owner_id" UUID,
    "eru_count" DECIMAL(8,2),
    "impervious_sqft" INTEGER,
    "has_stormwater_infra" BOOLEAN NOT NULL DEFAULT false,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "search_vector" tsvector,

    CONSTRAINT "premise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "premise_id" UUID NOT NULL,
    "meter_number" VARCHAR(100) NOT NULL,
    "commodity_id" UUID NOT NULL,
    "meter_type" "meter_type" NOT NULL,
    "uom_id" UUID NOT NULL,
    "dial_count" INTEGER,
    "multiplier" DECIMAL(10,4) NOT NULL DEFAULT 1.0,
    "install_date" DATE NOT NULL,
    "removal_date" DATE,
    "status" "meter_status" NOT NULL,
    "notes" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "search_vector" tsvector,

    CONSTRAINT "meter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "account_number" VARCHAR(50) NOT NULL,
    "customer_id" UUID,
    "account_type" VARCHAR(50) NOT NULL,
    "status" "account_status" NOT NULL,
    "credit_rating" "credit_rating" NOT NULL DEFAULT 'UNRATED',
    "deposit_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "deposit_waived" BOOLEAN NOT NULL DEFAULT false,
    "deposit_waived_reason" VARCHAR(255),
    "language_pref" CHAR(5) NOT NULL DEFAULT 'en-US',
    "paperless_billing" BOOLEAN NOT NULL DEFAULT false,
    "budget_billing" BOOLEAN NOT NULL DEFAULT false,
    "billing_cycle_id" UUID NOT NULL,
    "saaslogic_account_id" UUID,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "auto_post_bills" BOOLEAN,
    "last_due_date" DATE,
    "is_protected" BOOLEAN NOT NULL DEFAULT false,
    "protection_reason" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ,
    "search_vector" tsvector,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_agreement" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "agreement_number" VARCHAR(50) NOT NULL,
    "account_id" UUID NOT NULL,
    "commodity_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "status" "service_agreement_status" NOT NULL DEFAULT 'PENDING',
    "read_sequence" INTEGER,
    "rate_service_class_id" UUID,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "effective_range" tsrange,

    CONSTRAINT "service_agreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_point" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "service_agreement_id" UUID NOT NULL,
    "premise_id" UUID NOT NULL,
    "type" "service_point_type" NOT NULL DEFAULT 'METERED',
    "status" "service_point_status" NOT NULL DEFAULT 'ACTIVE',
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "service_point_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_point_meter" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "service_point_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "added_date" DATE NOT NULL,
    "removed_date" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_range" tsrange,

    CONSTRAINT "service_point_meter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_schedule" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "commodity_id" UUID NOT NULL,
    "effective_date" DATE NOT NULL,
    "expiration_date" DATE,
    "description" TEXT,
    "regulatory_ref" VARCHAR(100),
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedes_id" UUID,
    "superseded_by_id" UUID,
    "published_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_component" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "rate_schedule_id" UUID NOT NULL,
    "kind_code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "predicate" JSONB NOT NULL,
    "quantity_source" JSONB NOT NULL,
    "pricing" JSONB NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "effective_date" DATE NOT NULL,
    "expiration_date" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rate_component_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sa_rate_schedule_assignment" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "service_agreement_id" UUID NOT NULL,
    "rate_schedule_id" UUID NOT NULL,
    "role_code" VARCHAR(50) NOT NULL,
    "effective_date" DATE NOT NULL,
    "expiration_date" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sa_rate_schedule_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_index" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "period" VARCHAR(20) NOT NULL,
    "value" DECIMAL(18,8) NOT NULL,
    "effective_date" DATE NOT NULL,
    "expiration_date" DATE,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rate_index_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_cycle" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "cycle_code" VARCHAR(20) NOT NULL,
    "read_day_of_month" INTEGER NOT NULL,
    "bill_day_of_month" INTEGER NOT NULL,
    "frequency" "billing_frequency" NOT NULL DEFAULT 'MONTHLY',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "billing_cycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_segment" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "service_agreement_id" UUID NOT NULL,
    "bill_id" UUID,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "subtotal" DECIMAL(14,4) NOT NULL,
    "taxes" DECIMAL(14,4) NOT NULL,
    "credits" DECIMAL(14,4) NOT NULL,
    "total" DECIMAL(14,4) NOT NULL,
    "minimum_floor_applied" BOOLEAN NOT NULL,
    "segment_number" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_segment_line" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "bill_segment_id" UUID NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "kind_code" VARCHAR(50) NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "quantity" DECIMAL(14,4),
    "source_schedule_id" UUID NOT NULL,
    "source_component_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "bill_segment_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "billing_cycle_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "bill_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "subtotal" DECIMAL(14,4) NOT NULL,
    "taxes" DECIMAL(14,4) NOT NULL,
    "credits" DECIMAL(14,4) NOT NULL,
    "total" DECIMAL(14,4) NOT NULL,
    "bill_number" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_at" TIMESTAMPTZ,

    CONSTRAINT "bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_read" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "service_agreement_id" UUID NOT NULL,
    "register_id" UUID,
    "read_event_id" UUID,
    "uom_id" UUID NOT NULL,
    "read_date" DATE NOT NULL,
    "read_datetime" TIMESTAMPTZ NOT NULL,
    "reading" DECIMAL(12,4) NOT NULL,
    "prior_reading" DECIMAL(12,4) NOT NULL,
    "consumption" DECIMAL(12,4) NOT NULL,
    "read_type" "read_type" NOT NULL,
    "read_source" "read_source" NOT NULL,
    "exception_code" VARCHAR(50),
    "exception_notes" TEXT,
    "reader_id" UUID,
    "is_frozen" BOOLEAN NOT NULL DEFAULT false,
    "billed_at" TIMESTAMPTZ,
    "import_batch_id" UUID,
    "corrects_read_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "meter_read_pkey" PRIMARY KEY ("id","read_datetime")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "entity_type" VARCHAR(100) NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" "audit_action" NOT NULL,
    "actor_id" UUID,
    "actor_name" VARCHAR(255),
    "source" VARCHAR(100),
    "before_state" JSONB,
    "after_state" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "utility_theme" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "preset" VARCHAR(50),
    "colors" JSONB NOT NULL,
    "typography" JSONB NOT NULL,
    "border_radius" INTEGER NOT NULL DEFAULT 10,
    "logo_url" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "utility_theme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preference" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "theme_mode" "theme_mode" NOT NULL DEFAULT 'SYSTEM',
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "customer_type" "customer_type" NOT NULL,
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "organization_name" VARCHAR(255),
    "email" VARCHAR(255),
    "phone" VARCHAR(20),
    "alt_phone" VARCHAR(20),
    "date_of_birth" DATE,
    "drivers_license" VARCHAR(50),
    "tax_id" VARCHAR(50),
    "status" "customer_status" NOT NULL DEFAULT 'ACTIVE',
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "search_vector" tsvector,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "customer_id" UUID,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255),
    "phone" VARCHAR(20),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_address" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "address_line1" VARCHAR(255) NOT NULL,
    "address_line2" VARCHAR(255),
    "city" VARCHAR(100) NOT NULL,
    "state" CHAR(2) NOT NULL,
    "zip" VARCHAR(20) NOT NULL,
    "country" CHAR(2) NOT NULL DEFAULT 'US',
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "billing_address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_register" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "register_number" INTEGER NOT NULL,
    "description" VARCHAR(100),
    "uom_id" UUID NOT NULL,
    "measure_type_id" UUID NOT NULL,
    "multiplier" DECIMAL(10,4) NOT NULL DEFAULT 1.0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meter_register_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "entity_type" VARCHAR(100) NOT NULL,
    "entity_id" UUID NOT NULL,
    "file_name" VARCHAR(500) NOT NULL,
    "file_type" VARCHAR(100) NOT NULL,
    "file_size" INTEGER NOT NULL,
    "storage_path" VARCHAR(1000) NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "description" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "permissions" JSONB NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cis_user" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "external_id" VARCHAR(255),
    "email" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "customer_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "cis_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "utility_module" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "module_key" VARCHAR(50) NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabled_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "utility_module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_event" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "event_type" "MeterEventType" NOT NULL,
    "status" "MeterEventStatus" NOT NULL DEFAULT 'OPEN',
    "severity" INTEGER NOT NULL DEFAULT 1,
    "event_datetime" TIMESTAMPTZ NOT NULL,
    "source" "MeterEventSource" NOT NULL,
    "description" TEXT,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "resolution_notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "meter_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "container" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "premise_id" UUID NOT NULL,
    "service_agreement_id" UUID,
    "container_type" "ContainerType" NOT NULL,
    "size_gallons" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "serial_number" VARCHAR(100),
    "rfid_tag" VARCHAR(100),
    "status" "ContainerStatus" NOT NULL DEFAULT 'ACTIVE',
    "delivery_date" DATE NOT NULL,
    "removal_date" DATE,
    "rams_container_id" VARCHAR(100),
    "location_notes" VARCHAR(500),
    "size" VARCHAR(20),
    "frequency" VARCHAR(20),
    "item_type" VARCHAR(50),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "container_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_schema" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "entity_type" VARCHAR(50) NOT NULL,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "custom_field_schema_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "utility_config" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "require_hold_approval" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "suspension_enabled" BOOLEAN NOT NULL DEFAULT true,
    "notification_send_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sla_breach_sweep_enabled" BOOLEAN NOT NULL DEFAULT true,
    "delinquency_enabled" BOOLEAN NOT NULL DEFAULT true,
    "delinquency_run_hour_local" SMALLINT NOT NULL DEFAULT 3,
    "delinquency_last_run_at" TIMESTAMPTZ,
    "notification_quiet_start" VARCHAR(5) NOT NULL DEFAULT '22:00',
    "notification_quiet_end" VARCHAR(5) NOT NULL DEFAULT '07:00',
    "scheduler_audit_retention_days" INTEGER NOT NULL DEFAULT 365,
    "auto_post_bills" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "utility_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suspension_type_def" (
    "id" UUID NOT NULL,
    "utility_id" UUID,
    "code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(50),
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "default_billing_suspended" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "suspension_type_def_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_suspension" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "service_agreement_id" UUID NOT NULL,
    "suspension_type" VARCHAR(50) NOT NULL,
    "status" "SuspensionStatus" NOT NULL DEFAULT 'PENDING',
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "billing_suspended" BOOLEAN NOT NULL DEFAULT true,
    "prorate_on_start" BOOLEAN NOT NULL DEFAULT true,
    "prorate_on_end" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "requested_by" UUID,
    "approved_by" UUID,
    "rams_notified" BOOLEAN NOT NULL DEFAULT false,
    "rams_notified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "service_suspension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_event" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "premise_id" UUID NOT NULL,
    "service_agreement_id" UUID,
    "container_id" UUID,
    "event_type" "ServiceEventType" NOT NULL,
    "event_date" DATE NOT NULL,
    "event_datetime" TIMESTAMPTZ NOT NULL,
    "source" "ServiceEventSource" NOT NULL,
    "rams_event_id" VARCHAR(100),
    "status" "ServiceEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "billing_action" "ServiceEventBillingAction",
    "billing_amount" DECIMAL(10,2),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "service_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batch" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "entity_kind" VARCHAR(50) NOT NULL,
    "source" "ImportBatchSource" NOT NULL,
    "file_name" VARCHAR(500),
    "record_count" INTEGER NOT NULL DEFAULT 0,
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "exception_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING',
    "mapping" JSONB,
    "processing_started_at" TIMESTAMPTZ,
    "last_progress_at" TIMESTAMPTZ,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_row" (
    "id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "row_index" INTEGER NOT NULL,
    "raw_data" JSONB NOT NULL,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "result_entity_id" UUID,
    "error_code" VARCHAR(64),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "import_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "in_app_notification" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "InAppNotificationKind" NOT NULL,
    "severity" "NotificationSeverity" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "link" VARCHAR(500),
    "metadata" JSONB,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "in_app_notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_template" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "channels" JSONB NOT NULL DEFAULT '{}',
    "variables" JSONB NOT NULL DEFAULT '[]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "template_id" UUID,
    "event_type" VARCHAR(100) NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "recipient_email" VARCHAR(255),
    "recipient_phone" VARCHAR(20),
    "customer_id" UUID,
    "account_id" UUID,
    "context" JSONB NOT NULL DEFAULT '{}',
    "resolved_variables" JSONB NOT NULL DEFAULT '{}',
    "resolved_subject" TEXT,
    "resolved_body" TEXT NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "provider" VARCHAR(50),
    "provider_message_id" VARCHAR(255),
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delinquency_rule" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "account_type" VARCHAR(50),
    "commodity_id" UUID,
    "tier" INTEGER NOT NULL,
    "days_past_due" INTEGER NOT NULL,
    "min_balance" DECIMAL(10,2) NOT NULL,
    "action_type" VARCHAR(50) NOT NULL,
    "notification_event_type" VARCHAR(100),
    "auto_apply" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "delinquency_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delinquency_action" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "tier" INTEGER NOT NULL,
    "action_type" VARCHAR(50) NOT NULL,
    "status" "delinquency_action_status" NOT NULL DEFAULT 'PENDING',
    "balance_at_action" DECIMAL(10,2) NOT NULL,
    "days_past_due_at_action" INTEGER NOT NULL,
    "triggered_by" VARCHAR(20) NOT NULL,
    "triggered_by_user_id" UUID,
    "notification_id" UUID,
    "resolved_at" TIMESTAMPTZ,
    "resolution_type" VARCHAR(50),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "delinquency_action_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "rate_component_kind" (
    "id" UUID NOT NULL,
    "utility_id" UUID,
    "code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rate_component_kind_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_assignment_role" (
    "id" UUID NOT NULL,
    "utility_id" UUID,
    "code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rate_assignment_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_service_class" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "commodity_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rate_service_class_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "utility_setting" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "utility_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wqa_value" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "service_agreement_id" UUID NOT NULL,
    "water_year" INTEGER NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL,
    "source_window_start" DATE NOT NULL,
    "source_window_end" DATE NOT NULL,
    "computed_avg" DECIMAL(10,4) NOT NULL,
    "override_value" DECIMAL(10,4),
    "override_reason" TEXT,
    "override_by" UUID,
    "override_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "wqa_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "open_amount" DECIMAL(14,2) NOT NULL,
    "due_date" DATE,
    "effective_date" DATE NOT NULL,
    "posted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason_id" UUID,
    "bill_id" UUID,
    "assessed_on_id" UUID,
    "reverses_id" UUID,
    "tender" "PaymentTender",
    "external_ref" VARCHAR(100),
    "memo" TEXT,
    "created_by" UUID,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_application" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "credit_id" UUID NOT NULL,
    "debit_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "applied_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_reason_def" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "applies_to_type" "LedgerEntryType" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ledger_reason_def_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_message" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "body" TEXT NOT NULL,
    "account_type_def_id" UUID,
    "commodity_id" UUID,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active_from" DATE NOT NULL,
    "active_to" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bill_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_document" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "document_type" VARCHAR(20) NOT NULL,
    "storage_integration" VARCHAR(100) NOT NULL,
    "storage_connection" VARCHAR(100),
    "object_key" VARCHAR(500) NOT NULL,
    "byte_size" INTEGER,
    "sha256" CHAR(64),
    "template_key" VARCHAR(100) NOT NULL,
    "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_paperless" BOOLEAN NOT NULL,

    CONSTRAINT "bill_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_run" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "billing_cycle_id" UUID NOT NULL,
    "window_start" DATE NOT NULL,
    "window_end" DATE NOT NULL,
    "bill_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "status" "billing_run_status" NOT NULL DEFAULT 'PENDING',
    "account_count" INTEGER NOT NULL DEFAULT 0,
    "billed_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "posted_at" TIMESTAMPTZ,
    "posted_by" UUID,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "last_progress_at" TIMESTAMPTZ,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_run_item" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "billing_run_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "status" "billing_run_item_status" NOT NULL DEFAULT 'PENDING',
    "bill_id" UUID,
    "service_period_start" DATE,
    "service_period_end" DATE,
    "segment_count" INTEGER NOT NULL DEFAULT 0,
    "total" DECIMAL(14,4),
    "error_code" VARCHAR(64),
    "error_message" TEXT,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "billing_run_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commodity_default_uom_id_idx" ON "commodity"("default_uom_id");

-- CreateIndex
CREATE UNIQUE INDEX "commodity_utility_id_code_key" ON "commodity"("utility_id", "code");

-- CreateIndex
CREATE INDEX "unit_of_measure_commodity_id_idx" ON "unit_of_measure"("commodity_id");

-- CreateIndex
CREATE INDEX "unit_of_measure_measure_type_id_idx" ON "unit_of_measure"("measure_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "unit_of_measure_utility_id_commodity_id_code_key" ON "unit_of_measure"("utility_id", "commodity_id", "code");

-- CreateIndex
CREATE INDEX "premise_type_def_is_active_sort_order_idx" ON "premise_type_def"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "premise_type_def_utility_id_code_key" ON "premise_type_def"("utility_id", "code");

-- CreateIndex
CREATE INDEX "account_type_def_is_active_sort_order_idx" ON "account_type_def"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "account_type_def_utility_id_code_key" ON "account_type_def"("utility_id", "code");

-- CreateIndex
CREATE INDEX "measure_type_def_is_active_sort_order_idx" ON "measure_type_def"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "measure_type_def_utility_id_code_key" ON "measure_type_def"("utility_id", "code");

-- CreateIndex
CREATE INDEX "premise_utility_id_status_idx" ON "premise"("utility_id", "status");

-- CreateIndex
CREATE INDEX "premise_owner_id_idx" ON "premise"("owner_id");

-- CreateIndex
CREATE INDEX "premise_utility_id_city_zip_idx" ON "premise"("utility_id", "city", "zip");

-- CreateIndex
CREATE INDEX "meter_premise_id_idx" ON "meter"("premise_id");

-- CreateIndex
CREATE INDEX "meter_commodity_id_idx" ON "meter"("commodity_id");

-- CreateIndex
CREATE INDEX "meter_uom_id_idx" ON "meter"("uom_id");

-- CreateIndex
CREATE INDEX "meter_utility_id_status_idx" ON "meter"("utility_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "meter_utility_id_meter_number_key" ON "meter"("utility_id", "meter_number");

-- CreateIndex
CREATE INDEX "account_customer_id_idx" ON "account"("customer_id");

-- CreateIndex
CREATE INDEX "account_utility_id_status_idx" ON "account"("utility_id", "status");

-- CreateIndex
CREATE INDEX "account_utility_id_balance_idx" ON "account"("utility_id", "balance");

-- CreateIndex
CREATE INDEX "account_utility_id_billing_cycle_id_idx" ON "account"("utility_id", "billing_cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_utility_id_account_number_key" ON "account"("utility_id", "account_number");

-- CreateIndex
CREATE INDEX "service_agreement_account_id_idx" ON "service_agreement"("account_id");

-- CreateIndex
CREATE INDEX "service_agreement_commodity_id_idx" ON "service_agreement"("commodity_id");

-- CreateIndex
CREATE INDEX "service_agreement_utility_id_status_idx" ON "service_agreement"("utility_id", "status");

-- CreateIndex
CREATE INDEX "service_agreement_rate_service_class_id_idx" ON "service_agreement"("rate_service_class_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_agreement_utility_id_agreement_number_key" ON "service_agreement"("utility_id", "agreement_number");

-- CreateIndex
CREATE INDEX "service_point_service_agreement_id_idx" ON "service_point"("service_agreement_id");

-- CreateIndex
CREATE INDEX "service_point_premise_id_idx" ON "service_point"("premise_id");

-- CreateIndex
CREATE INDEX "service_point_utility_id_status_idx" ON "service_point"("utility_id", "status");

-- CreateIndex
CREATE INDEX "service_point_meter_service_point_id_idx" ON "service_point_meter"("service_point_id");

-- CreateIndex
CREATE INDEX "service_point_meter_meter_id_idx" ON "service_point_meter"("meter_id");

-- CreateIndex
CREATE INDEX "rate_schedule_commodity_id_idx" ON "rate_schedule"("commodity_id");

-- CreateIndex
CREATE INDEX "rate_schedule_supersedes_id_idx" ON "rate_schedule"("supersedes_id");

-- CreateIndex
CREATE INDEX "rate_schedule_utility_id_effective_date_expiration_date_idx" ON "rate_schedule"("utility_id", "effective_date", "expiration_date");

-- CreateIndex
CREATE UNIQUE INDEX "rate_schedule_utility_id_code_version_key" ON "rate_schedule"("utility_id", "code", "version");

-- CreateIndex
CREATE INDEX "rate_component_rate_schedule_id_idx" ON "rate_component"("rate_schedule_id");

-- CreateIndex
CREATE INDEX "rate_component_utility_id_rate_schedule_id_sort_order_idx" ON "rate_component"("utility_id", "rate_schedule_id", "sort_order");

-- CreateIndex
CREATE INDEX "rate_component_kind_code_idx" ON "rate_component"("kind_code");

-- CreateIndex
CREATE INDEX "sa_rate_schedule_assignment_service_agreement_id_effective__idx" ON "sa_rate_schedule_assignment"("service_agreement_id", "effective_date");

-- CreateIndex
CREATE INDEX "sa_rate_schedule_assignment_rate_schedule_id_idx" ON "sa_rate_schedule_assignment"("rate_schedule_id");

-- CreateIndex
CREATE INDEX "sa_rate_schedule_assignment_role_code_idx" ON "sa_rate_schedule_assignment"("role_code");

-- CreateIndex
CREATE INDEX "rate_index_utility_id_name_effective_date_idx" ON "rate_index"("utility_id", "name", "effective_date");

-- CreateIndex
CREATE UNIQUE INDEX "rate_index_utility_id_name_period_key" ON "rate_index"("utility_id", "name", "period");

-- CreateIndex
CREATE INDEX "billing_cycle_utility_id_active_idx" ON "billing_cycle"("utility_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "billing_cycle_utility_id_cycle_code_key" ON "billing_cycle"("utility_id", "cycle_code");

-- CreateIndex
CREATE INDEX "bill_segment_utility_id_service_agreement_id_period_start_idx" ON "bill_segment"("utility_id", "service_agreement_id", "period_start");

-- CreateIndex
CREATE INDEX "bill_segment_utility_id_period_end_idx" ON "bill_segment"("utility_id", "period_end");

-- CreateIndex
CREATE INDEX "bill_segment_utility_id_bill_id_idx" ON "bill_segment"("utility_id", "bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "bill_segment_utility_id_segment_number_key" ON "bill_segment"("utility_id", "segment_number");

-- CreateIndex
CREATE INDEX "bill_segment_line_bill_segment_id_sort_order_idx" ON "bill_segment_line"("bill_segment_id", "sort_order");

-- CreateIndex
CREATE INDEX "bill_segment_line_utility_id_source_component_id_idx" ON "bill_segment_line"("utility_id", "source_component_id");

-- CreateIndex
CREATE INDEX "bill_utility_id_account_id_period_end_idx" ON "bill"("utility_id", "account_id", "period_end");

-- CreateIndex
CREATE INDEX "bill_utility_id_due_date_idx" ON "bill"("utility_id", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "bill_utility_id_bill_number_key" ON "bill"("utility_id", "bill_number");

-- CreateIndex
CREATE INDEX "meter_read_id_idx" ON "meter_read"("id");

-- CreateIndex
CREATE INDEX "meter_read_meter_id_read_datetime_idx" ON "meter_read"("meter_id", "read_datetime");

-- CreateIndex
CREATE INDEX "meter_read_service_agreement_id_read_datetime_idx" ON "meter_read"("service_agreement_id", "read_datetime");

-- CreateIndex
CREATE INDEX "meter_read_register_id_idx" ON "meter_read"("register_id");

-- CreateIndex
CREATE INDEX "meter_read_utility_id_import_batch_id_idx" ON "meter_read"("utility_id", "import_batch_id");

-- CreateIndex
CREATE INDEX "meter_read_utility_id_read_event_id_idx" ON "meter_read"("utility_id", "read_event_id");

-- CreateIndex
CREATE INDEX "audit_log_utility_id_entity_type_entity_id_idx" ON "audit_log"("utility_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_utility_id_created_at_idx" ON "audit_log"("utility_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_utility_id_actor_id_created_at_idx" ON "audit_log"("utility_id", "actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_utility_id_source_created_at_idx" ON "audit_log"("utility_id", "source", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "utility_theme_utility_id_key" ON "utility_theme"("utility_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_preference_utility_id_user_id_key" ON "user_preference"("utility_id", "user_id");

-- CreateIndex
CREATE INDEX "customer_utility_id_last_name_first_name_idx" ON "customer"("utility_id", "last_name", "first_name");

-- CreateIndex
CREATE INDEX "customer_utility_id_email_idx" ON "customer"("utility_id", "email");

-- CreateIndex
CREATE INDEX "customer_utility_id_phone_idx" ON "customer"("utility_id", "phone");

-- CreateIndex
CREATE INDEX "customer_utility_id_status_idx" ON "customer"("utility_id", "status");

-- CreateIndex
CREATE INDEX "contact_account_id_idx" ON "contact"("account_id");

-- CreateIndex
CREATE INDEX "contact_customer_id_idx" ON "contact"("customer_id");

-- CreateIndex
CREATE INDEX "billing_address_account_id_idx" ON "billing_address"("account_id");

-- CreateIndex
CREATE INDEX "meter_register_meter_id_idx" ON "meter_register"("meter_id");

-- CreateIndex
CREATE INDEX "meter_register_uom_id_idx" ON "meter_register"("uom_id");

-- CreateIndex
CREATE INDEX "meter_register_measure_type_id_idx" ON "meter_register"("measure_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "meter_register_meter_id_register_number_key" ON "meter_register"("meter_id", "register_number");

-- CreateIndex
CREATE INDEX "attachment_utility_id_entity_type_entity_id_idx" ON "attachment"("utility_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "attachment_utility_id_uploaded_by_idx" ON "attachment"("utility_id", "uploaded_by");

-- CreateIndex
CREATE UNIQUE INDEX "role_utility_id_name_key" ON "role"("utility_id", "name");

-- CreateIndex
CREATE INDEX "cis_user_customer_id_idx" ON "cis_user"("customer_id");

-- CreateIndex
CREATE INDEX "cis_user_utility_id_is_active_idx" ON "cis_user"("utility_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "cis_user_utility_id_email_key" ON "cis_user"("utility_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "cis_user_utility_id_external_id_key" ON "cis_user"("utility_id", "external_id");

-- CreateIndex
CREATE INDEX "user_role_account_id_idx" ON "user_role"("account_id");

-- CreateIndex
CREATE INDEX "user_role_role_id_idx" ON "user_role"("role_id");

-- CreateIndex
CREATE INDEX "user_role_utility_id_user_id_idx" ON "user_role"("utility_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_user_id_account_id_key" ON "user_role"("user_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "utility_module_utility_id_module_key_key" ON "utility_module"("utility_id", "module_key");

-- CreateIndex
CREATE INDEX "meter_event_utility_id_status_idx" ON "meter_event"("utility_id", "status");

-- CreateIndex
CREATE INDEX "meter_event_meter_id_event_datetime_idx" ON "meter_event"("meter_id", "event_datetime");

-- CreateIndex
CREATE INDEX "meter_event_utility_id_event_type_status_idx" ON "meter_event"("utility_id", "event_type", "status");

-- CreateIndex
CREATE INDEX "container_utility_id_premise_id_idx" ON "container"("utility_id", "premise_id");

-- CreateIndex
CREATE INDEX "container_utility_id_service_agreement_id_idx" ON "container"("utility_id", "service_agreement_id");

-- CreateIndex
CREATE INDEX "container_utility_id_serial_number_idx" ON "container"("utility_id", "serial_number");

-- CreateIndex
CREATE INDEX "container_utility_id_status_idx" ON "container"("utility_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_schema_utility_id_entity_type_key" ON "custom_field_schema"("utility_id", "entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "utility_config_utility_id_key" ON "utility_config"("utility_id");

-- CreateIndex
CREATE INDEX "suspension_type_def_is_active_sort_order_idx" ON "suspension_type_def"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "suspension_type_def_utility_id_code_key" ON "suspension_type_def"("utility_id", "code");

-- CreateIndex
CREATE INDEX "service_suspension_utility_id_service_agreement_id_idx" ON "service_suspension"("utility_id", "service_agreement_id");

-- CreateIndex
CREATE INDEX "service_suspension_utility_id_status_idx" ON "service_suspension"("utility_id", "status");

-- CreateIndex
CREATE INDEX "service_suspension_utility_id_start_date_end_date_idx" ON "service_suspension"("utility_id", "start_date", "end_date");

-- CreateIndex
CREATE INDEX "service_event_utility_id_premise_id_event_date_idx" ON "service_event"("utility_id", "premise_id", "event_date");

-- CreateIndex
CREATE INDEX "service_event_utility_id_status_idx" ON "service_event"("utility_id", "status");

-- CreateIndex
CREATE INDEX "service_event_utility_id_event_type_idx" ON "service_event"("utility_id", "event_type");

-- CreateIndex
CREATE INDEX "service_event_utility_id_rams_event_id_idx" ON "service_event"("utility_id", "rams_event_id");

-- CreateIndex
CREATE INDEX "import_batch_utility_id_status_idx" ON "import_batch"("utility_id", "status");

-- CreateIndex
CREATE INDEX "import_batch_utility_id_created_at_idx" ON "import_batch"("utility_id", "created_at");

-- CreateIndex
CREATE INDEX "import_batch_utility_id_entity_kind_created_at_idx" ON "import_batch"("utility_id", "entity_kind", "created_at" DESC);

-- CreateIndex
CREATE INDEX "import_row_import_batch_id_status_idx" ON "import_row"("import_batch_id", "status");

-- CreateIndex
CREATE INDEX "import_row_import_batch_id_row_index_idx" ON "import_row"("import_batch_id", "row_index");

-- CreateIndex
CREATE INDEX "in_app_notification_utility_id_user_id_is_read_created_at_idx" ON "in_app_notification"("utility_id", "user_id", "is_read", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notification_template_utility_id_is_active_idx" ON "notification_template"("utility_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "notification_template_utility_id_event_type_key" ON "notification_template"("utility_id", "event_type");

-- CreateIndex
CREATE INDEX "notification_utility_id_status_created_at_idx" ON "notification"("utility_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "notification_customer_id_created_at_idx" ON "notification"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "notification_account_id_created_at_idx" ON "notification"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "notification_template_id_idx" ON "notification"("template_id");

-- CreateIndex
CREATE INDEX "notification_event_type_created_at_idx" ON "notification"("event_type", "created_at");

-- CreateIndex
CREATE INDEX "delinquency_rule_utility_id_is_active_tier_idx" ON "delinquency_rule"("utility_id", "is_active", "tier");

-- CreateIndex
CREATE UNIQUE INDEX "delinquency_rule_utility_id_account_type_tier_key" ON "delinquency_rule"("utility_id", "account_type", "tier");

-- CreateIndex
CREATE INDEX "delinquency_action_account_id_status_idx" ON "delinquency_action"("account_id", "status");

-- CreateIndex
CREATE INDEX "delinquency_action_utility_id_status_tier_idx" ON "delinquency_action"("utility_id", "status", "tier");

-- CreateIndex
CREATE INDEX "delinquency_action_rule_id_idx" ON "delinquency_action"("rule_id");

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

-- CreateIndex
CREATE INDEX "rate_component_kind_is_active_sort_order_idx" ON "rate_component_kind"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "rate_component_kind_utility_id_code_key" ON "rate_component_kind"("utility_id", "code");

-- CreateIndex
CREATE INDEX "rate_assignment_role_is_active_sort_order_idx" ON "rate_assignment_role"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "rate_assignment_role_utility_id_code_key" ON "rate_assignment_role"("utility_id", "code");

-- CreateIndex
CREATE INDEX "rate_service_class_utility_id_commodity_id_is_active_sort_o_idx" ON "rate_service_class"("utility_id", "commodity_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "rate_service_class_utility_id_commodity_id_code_key" ON "rate_service_class"("utility_id", "commodity_id", "code");

-- CreateIndex
CREATE INDEX "utility_setting_utility_id_idx" ON "utility_setting"("utility_id");

-- CreateIndex
CREATE UNIQUE INDEX "utility_setting_utility_id_name_key" ON "utility_setting"("utility_id", "name");

-- CreateIndex
CREATE INDEX "wqa_value_utility_id_service_agreement_id_idx" ON "wqa_value"("utility_id", "service_agreement_id");

-- CreateIndex
CREATE UNIQUE INDEX "wqa_value_utility_id_service_agreement_id_water_year_key" ON "wqa_value"("utility_id", "service_agreement_id", "water_year");

-- CreateIndex
CREATE INDEX "ledger_entry_utility_id_account_id_posted_at_idx" ON "ledger_entry"("utility_id", "account_id", "posted_at" DESC);

-- CreateIndex
CREATE INDEX "ledger_entry_utility_id_bill_id_idx" ON "ledger_entry"("utility_id", "bill_id");

-- CreateIndex
CREATE INDEX "ledger_entry_assessed_on_id_idx" ON "ledger_entry"("assessed_on_id");

-- CreateIndex
CREATE INDEX "ledger_entry_reverses_id_idx" ON "ledger_entry"("reverses_id");

-- CreateIndex
CREATE INDEX "ledger_application_credit_id_idx" ON "ledger_application"("credit_id");

-- CreateIndex
CREATE INDEX "ledger_application_debit_id_idx" ON "ledger_application"("debit_id");

-- CreateIndex
CREATE INDEX "ledger_reason_def_utility_id_applies_to_type_idx" ON "ledger_reason_def"("utility_id", "applies_to_type");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_reason_def_utility_id_code_key" ON "ledger_reason_def"("utility_id", "code");

-- CreateIndex
CREATE INDEX "bill_message_utility_id_active_from_idx" ON "bill_message"("utility_id", "active_from");

-- CreateIndex
CREATE INDEX "bill_document_utility_id_generated_at_idx" ON "bill_document"("utility_id", "generated_at");

-- CreateIndex
CREATE UNIQUE INDEX "bill_document_bill_id_document_type_key" ON "bill_document"("bill_id", "document_type");

-- CreateIndex
CREATE INDEX "billing_run_utility_id_created_at_idx" ON "billing_run"("utility_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_run_utility_id_billing_cycle_id_window_end_key" ON "billing_run"("utility_id", "billing_cycle_id", "window_end");

-- CreateIndex
CREATE INDEX "billing_run_item_billing_run_id_status_idx" ON "billing_run_item"("billing_run_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "billing_run_item_billing_run_id_account_id_key" ON "billing_run_item"("billing_run_id", "account_id");

-- AddForeignKey
ALTER TABLE "commodity" ADD CONSTRAINT "commodity_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commodity" ADD CONSTRAINT "commodity_default_uom_id_fkey" FOREIGN KEY ("default_uom_id") REFERENCES "unit_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_of_measure" ADD CONSTRAINT "unit_of_measure_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_of_measure" ADD CONSTRAINT "unit_of_measure_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_of_measure" ADD CONSTRAINT "unit_of_measure_measure_type_id_fkey" FOREIGN KEY ("measure_type_id") REFERENCES "measure_type_def"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "premise_type_def" ADD CONSTRAINT "premise_type_def_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_type_def" ADD CONSTRAINT "account_type_def_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measure_type_def" ADD CONSTRAINT "measure_type_def_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "premise" ADD CONSTRAINT "premise_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "premise" ADD CONSTRAINT "premise_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter" ADD CONSTRAINT "meter_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter" ADD CONSTRAINT "meter_premise_id_fkey" FOREIGN KEY ("premise_id") REFERENCES "premise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter" ADD CONSTRAINT "meter_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter" ADD CONSTRAINT "meter_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "unit_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_billing_cycle_id_fkey" FOREIGN KEY ("billing_cycle_id") REFERENCES "billing_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreement" ADD CONSTRAINT "service_agreement_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreement" ADD CONSTRAINT "service_agreement_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreement" ADD CONSTRAINT "service_agreement_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreement" ADD CONSTRAINT "service_agreement_rate_service_class_id_fkey" FOREIGN KEY ("rate_service_class_id") REFERENCES "rate_service_class"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_point" ADD CONSTRAINT "service_point_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_point" ADD CONSTRAINT "service_point_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_point" ADD CONSTRAINT "service_point_premise_id_fkey" FOREIGN KEY ("premise_id") REFERENCES "premise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_point_meter" ADD CONSTRAINT "service_point_meter_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_point_meter" ADD CONSTRAINT "service_point_meter_service_point_id_fkey" FOREIGN KEY ("service_point_id") REFERENCES "service_point"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_point_meter" ADD CONSTRAINT "service_point_meter_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "meter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_schedule" ADD CONSTRAINT "rate_schedule_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_schedule" ADD CONSTRAINT "rate_schedule_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_schedule" ADD CONSTRAINT "rate_schedule_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "rate_schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_component" ADD CONSTRAINT "rate_component_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_component" ADD CONSTRAINT "rate_component_rate_schedule_id_fkey" FOREIGN KEY ("rate_schedule_id") REFERENCES "rate_schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sa_rate_schedule_assignment" ADD CONSTRAINT "sa_rate_schedule_assignment_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sa_rate_schedule_assignment" ADD CONSTRAINT "sa_rate_schedule_assignment_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sa_rate_schedule_assignment" ADD CONSTRAINT "sa_rate_schedule_assignment_rate_schedule_id_fkey" FOREIGN KEY ("rate_schedule_id") REFERENCES "rate_schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_index" ADD CONSTRAINT "rate_index_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_cycle" ADD CONSTRAINT "billing_cycle_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_segment" ADD CONSTRAINT "bill_segment_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_segment" ADD CONSTRAINT "bill_segment_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_segment" ADD CONSTRAINT "bill_segment_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_segment_line" ADD CONSTRAINT "bill_segment_line_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_segment_line" ADD CONSTRAINT "bill_segment_line_bill_segment_id_fkey" FOREIGN KEY ("bill_segment_id") REFERENCES "bill_segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_segment_line" ADD CONSTRAINT "bill_segment_line_source_schedule_id_fkey" FOREIGN KEY ("source_schedule_id") REFERENCES "rate_schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_segment_line" ADD CONSTRAINT "bill_segment_line_source_component_id_fkey" FOREIGN KEY ("source_component_id") REFERENCES "rate_component"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill" ADD CONSTRAINT "bill_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill" ADD CONSTRAINT "bill_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill" ADD CONSTRAINT "bill_billing_cycle_id_fkey" FOREIGN KEY ("billing_cycle_id") REFERENCES "billing_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_read" ADD CONSTRAINT "meter_read_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_read" ADD CONSTRAINT "meter_read_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "meter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_read" ADD CONSTRAINT "meter_read_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_read" ADD CONSTRAINT "meter_read_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "meter_register"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_read" ADD CONSTRAINT "meter_read_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "unit_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "utility_theme" ADD CONSTRAINT "utility_theme_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preference" ADD CONSTRAINT "user_preference_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_address" ADD CONSTRAINT "billing_address_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_address" ADD CONSTRAINT "billing_address_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_register" ADD CONSTRAINT "meter_register_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_register" ADD CONSTRAINT "meter_register_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "meter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_register" ADD CONSTRAINT "meter_register_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "unit_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_register" ADD CONSTRAINT "meter_register_measure_type_id_fkey" FOREIGN KEY ("measure_type_id") REFERENCES "measure_type_def"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cis_user" ADD CONSTRAINT "cis_user_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cis_user" ADD CONSTRAINT "cis_user_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "cis_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "utility_module" ADD CONSTRAINT "utility_module_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_event" ADD CONSTRAINT "meter_event_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_event" ADD CONSTRAINT "meter_event_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "meter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container" ADD CONSTRAINT "container_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container" ADD CONSTRAINT "container_premise_id_fkey" FOREIGN KEY ("premise_id") REFERENCES "premise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container" ADD CONSTRAINT "container_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_schema" ADD CONSTRAINT "custom_field_schema_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "utility_config" ADD CONSTRAINT "utility_config_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suspension_type_def" ADD CONSTRAINT "suspension_type_def_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_suspension" ADD CONSTRAINT "service_suspension_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_suspension" ADD CONSTRAINT "service_suspension_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_event" ADD CONSTRAINT "service_event_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_event" ADD CONSTRAINT "service_event_premise_id_fkey" FOREIGN KEY ("premise_id") REFERENCES "premise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_event" ADD CONSTRAINT "service_event_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_event" ADD CONSTRAINT "service_event_container_id_fkey" FOREIGN KEY ("container_id") REFERENCES "container"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_app_notification" ADD CONSTRAINT "in_app_notification_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_template" ADD CONSTRAINT "notification_template_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "notification_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delinquency_rule" ADD CONSTRAINT "delinquency_rule_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delinquency_rule" ADD CONSTRAINT "delinquency_rule_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delinquency_action" ADD CONSTRAINT "delinquency_action_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delinquency_action" ADD CONSTRAINT "delinquency_action_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delinquency_action" ADD CONSTRAINT "delinquency_action_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "delinquency_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request_type_def" ADD CONSTRAINT "service_request_type_def_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla" ADD CONSTRAINT "sla_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla" ADD CONSTRAINT "sla_escalation_user_id_fkey" FOREIGN KEY ("escalation_user_id") REFERENCES "cis_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request_counter" ADD CONSTRAINT "service_request_counter_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "rate_component_kind" ADD CONSTRAINT "rate_component_kind_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_assignment_role" ADD CONSTRAINT "rate_assignment_role_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_service_class" ADD CONSTRAINT "rate_service_class_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_service_class" ADD CONSTRAINT "rate_service_class_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "utility_setting" ADD CONSTRAINT "utility_setting_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wqa_value" ADD CONSTRAINT "wqa_value_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wqa_value" ADD CONSTRAINT "wqa_value_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_reason_id_fkey" FOREIGN KEY ("reason_id") REFERENCES "ledger_reason_def"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_assessed_on_id_fkey" FOREIGN KEY ("assessed_on_id") REFERENCES "ledger_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "ledger_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_application" ADD CONSTRAINT "ledger_application_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_application" ADD CONSTRAINT "ledger_application_credit_id_fkey" FOREIGN KEY ("credit_id") REFERENCES "ledger_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_application" ADD CONSTRAINT "ledger_application_debit_id_fkey" FOREIGN KEY ("debit_id") REFERENCES "ledger_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_reason_def" ADD CONSTRAINT "ledger_reason_def_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_message" ADD CONSTRAINT "bill_message_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_message" ADD CONSTRAINT "bill_message_account_type_def_id_fkey" FOREIGN KEY ("account_type_def_id") REFERENCES "account_type_def"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_message" ADD CONSTRAINT "bill_message_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_document" ADD CONSTRAINT "bill_document_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_document" ADD CONSTRAINT "bill_document_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_run" ADD CONSTRAINT "billing_run_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_run" ADD CONSTRAINT "billing_run_billing_cycle_id_fkey" FOREIGN KEY ("billing_cycle_id") REFERENCES "billing_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_run_item" ADD CONSTRAINT "billing_run_item_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_run_item" ADD CONSTRAINT "billing_run_item_billing_run_id_fkey" FOREIGN KEY ("billing_run_id") REFERENCES "billing_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_run_item" ADD CONSTRAINT "billing_run_item_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_run_item" ADD CONSTRAINT "billing_run_item_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

