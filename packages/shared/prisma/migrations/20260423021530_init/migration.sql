-- CreateEnum
CREATE TYPE "premise_type" AS ENUM ('RESIDENTIAL', 'COMMERCIAL', 'INDUSTRIAL', 'MUNICIPAL');

-- CreateEnum
CREATE TYPE "premise_status" AS ENUM ('ACTIVE', 'INACTIVE', 'CONDEMNED');

-- CreateEnum
CREATE TYPE "meter_type" AS ENUM ('AMR', 'AMI', 'MANUAL', 'SMART');

-- CreateEnum
CREATE TYPE "meter_status" AS ENUM ('ACTIVE', 'REMOVED', 'DEFECTIVE', 'PENDING_INSTALL');

-- CreateEnum
CREATE TYPE "account_type" AS ENUM ('RESIDENTIAL', 'COMMERCIAL', 'INDUSTRIAL', 'MUNICIPAL');

-- CreateEnum
CREATE TYPE "account_status" AS ENUM ('ACTIVE', 'INACTIVE', 'FINAL', 'CLOSED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "credit_rating" AS ENUM ('EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'UNRATED');

-- CreateEnum
CREATE TYPE "service_agreement_status" AS ENUM ('PENDING', 'ACTIVE', 'FINAL', 'CLOSED');

-- CreateEnum
CREATE TYPE "rate_type" AS ENUM ('FLAT', 'TIERED', 'TIME_OF_USE', 'DEMAND', 'BUDGET', 'SEASONAL');

-- CreateEnum
CREATE TYPE "billing_frequency" AS ENUM ('MONTHLY', 'BIMONTHLY', 'QUARTERLY');

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
CREATE TYPE "contact_role" AS ENUM ('PRIMARY', 'BILLING', 'AUTHORIZED', 'EMERGENCY');

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
CREATE TYPE "ImportBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "delinquency_action_status" AS ENUM ('PENDING', 'COMPLETED', 'RESOLVED', 'CANCELLED');

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
    "conversion_factor" DECIMAL(15,8) NOT NULL,
    "is_base_unit" BOOLEAN NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_of_measure_pkey" PRIMARY KEY ("id")
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
    "premise_type" "premise_type" NOT NULL,
    "commodity_ids" UUID[],
    "service_territory_id" UUID,
    "municipality_code" VARCHAR(50),
    "status" "premise_status" NOT NULL DEFAULT 'ACTIVE',
    "owner_id" UUID,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

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

    CONSTRAINT "meter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "account_number" VARCHAR(50) NOT NULL,
    "customer_id" UUID,
    "account_type" "account_type" NOT NULL,
    "status" "account_status" NOT NULL,
    "credit_rating" "credit_rating" NOT NULL DEFAULT 'UNRATED',
    "deposit_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "deposit_waived" BOOLEAN NOT NULL DEFAULT false,
    "deposit_waived_reason" VARCHAR(255),
    "language_pref" CHAR(5) NOT NULL DEFAULT 'en-US',
    "paperless_billing" BOOLEAN NOT NULL DEFAULT false,
    "budget_billing" BOOLEAN NOT NULL DEFAULT false,
    "saaslogic_account_id" UUID,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "last_due_date" DATE,
    "is_protected" BOOLEAN NOT NULL DEFAULT false,
    "protection_reason" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_agreement" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "agreement_number" VARCHAR(50) NOT NULL,
    "account_id" UUID NOT NULL,
    "premise_id" UUID NOT NULL,
    "commodity_id" UUID NOT NULL,
    "rate_schedule_id" UUID NOT NULL,
    "billing_cycle_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "status" "service_agreement_status" NOT NULL DEFAULT 'PENDING',
    "read_sequence" INTEGER,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "service_agreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_agreement_meter" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "service_agreement_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "added_date" DATE NOT NULL,
    "removed_date" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_agreement_meter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_schedule" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "commodity_id" UUID NOT NULL,
    "rate_type" "rate_type" NOT NULL,
    "effective_date" DATE NOT NULL,
    "expiration_date" DATE,
    "description" TEXT,
    "regulatory_ref" VARCHAR(100),
    "rate_config" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedes_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_schedule_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "meter_read" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "service_agreement_id" UUID NOT NULL,
    "register_id" UUID,
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
    "actor_id" UUID NOT NULL,
    "actor_name" VARCHAR(255),
    "before_state" JSONB,
    "after_state" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_theme" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "preset" VARCHAR(50),
    "colors" JSONB NOT NULL,
    "typography" JSONB NOT NULL,
    "border_radius" INTEGER NOT NULL DEFAULT 10,
    "logo_url" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenant_theme_pkey" PRIMARY KEY ("id")
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

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "customer_id" UUID,
    "role" "contact_role" NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255),
    "phone" VARCHAR(20),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
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
    "role_id" UUID NOT NULL,
    "customer_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "cis_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_module" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "module_key" VARCHAR(50) NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabled_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_module_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "tenant_config" (
    "id" UUID NOT NULL,
    "utility_id" UUID NOT NULL,
    "require_hold_approval" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenant_config_pkey" PRIMARY KEY ("id")
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
    "source" "ImportBatchSource" NOT NULL,
    "file_name" VARCHAR(500),
    "record_count" INTEGER NOT NULL DEFAULT 0,
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "exception_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING',
    "errors" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "import_batch_pkey" PRIMARY KEY ("id")
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
    "account_type" "account_type",
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

-- CreateIndex
CREATE INDEX "commodity_default_uom_id_idx" ON "commodity"("default_uom_id");

-- CreateIndex
CREATE UNIQUE INDEX "commodity_utility_id_code_key" ON "commodity"("utility_id", "code");

-- CreateIndex
CREATE INDEX "unit_of_measure_commodity_id_idx" ON "unit_of_measure"("commodity_id");

-- CreateIndex
CREATE UNIQUE INDEX "unit_of_measure_utility_id_commodity_id_code_key" ON "unit_of_measure"("utility_id", "commodity_id", "code");

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
CREATE UNIQUE INDEX "account_utility_id_account_number_key" ON "account"("utility_id", "account_number");

-- CreateIndex
CREATE INDEX "service_agreement_account_id_idx" ON "service_agreement"("account_id");

-- CreateIndex
CREATE INDEX "service_agreement_premise_id_idx" ON "service_agreement"("premise_id");

-- CreateIndex
CREATE INDEX "service_agreement_commodity_id_idx" ON "service_agreement"("commodity_id");

-- CreateIndex
CREATE INDEX "service_agreement_rate_schedule_id_idx" ON "service_agreement"("rate_schedule_id");

-- CreateIndex
CREATE INDEX "service_agreement_billing_cycle_id_idx" ON "service_agreement"("billing_cycle_id");

-- CreateIndex
CREATE INDEX "service_agreement_utility_id_status_idx" ON "service_agreement"("utility_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "service_agreement_utility_id_agreement_number_key" ON "service_agreement"("utility_id", "agreement_number");

-- CreateIndex
CREATE INDEX "service_agreement_meter_service_agreement_id_idx" ON "service_agreement_meter"("service_agreement_id");

-- CreateIndex
CREATE INDEX "service_agreement_meter_meter_id_idx" ON "service_agreement_meter"("meter_id");

-- CreateIndex
CREATE INDEX "rate_schedule_commodity_id_idx" ON "rate_schedule"("commodity_id");

-- CreateIndex
CREATE INDEX "rate_schedule_supersedes_id_idx" ON "rate_schedule"("supersedes_id");

-- CreateIndex
CREATE INDEX "rate_schedule_utility_id_effective_date_expiration_date_idx" ON "rate_schedule"("utility_id", "effective_date", "expiration_date");

-- CreateIndex
CREATE UNIQUE INDEX "rate_schedule_utility_id_code_version_key" ON "rate_schedule"("utility_id", "code", "version");

-- CreateIndex
CREATE INDEX "billing_cycle_utility_id_active_idx" ON "billing_cycle"("utility_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "billing_cycle_utility_id_cycle_code_key" ON "billing_cycle"("utility_id", "cycle_code");

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
CREATE INDEX "audit_log_utility_id_entity_type_entity_id_idx" ON "audit_log"("utility_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_utility_id_created_at_idx" ON "audit_log"("utility_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_utility_id_actor_id_created_at_idx" ON "audit_log"("utility_id", "actor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_theme_utility_id_key" ON "tenant_theme"("utility_id");

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
CREATE UNIQUE INDEX "meter_register_meter_id_register_number_key" ON "meter_register"("meter_id", "register_number");

-- CreateIndex
CREATE INDEX "attachment_utility_id_entity_type_entity_id_idx" ON "attachment"("utility_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "attachment_utility_id_uploaded_by_idx" ON "attachment"("utility_id", "uploaded_by");

-- CreateIndex
CREATE UNIQUE INDEX "role_utility_id_name_key" ON "role"("utility_id", "name");

-- CreateIndex
CREATE INDEX "cis_user_role_id_idx" ON "cis_user"("role_id");

-- CreateIndex
CREATE INDEX "cis_user_customer_id_idx" ON "cis_user"("customer_id");

-- CreateIndex
CREATE INDEX "cis_user_utility_id_is_active_idx" ON "cis_user"("utility_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "cis_user_utility_id_email_key" ON "cis_user"("utility_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "cis_user_utility_id_external_id_key" ON "cis_user"("utility_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_module_utility_id_module_key_key" ON "tenant_module"("utility_id", "module_key");

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
CREATE UNIQUE INDEX "tenant_config_utility_id_key" ON "tenant_config"("utility_id");

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

-- AddForeignKey
ALTER TABLE "commodity" ADD CONSTRAINT "commodity_default_uom_id_fkey" FOREIGN KEY ("default_uom_id") REFERENCES "unit_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_of_measure" ADD CONSTRAINT "unit_of_measure_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "premise" ADD CONSTRAINT "premise_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter" ADD CONSTRAINT "meter_premise_id_fkey" FOREIGN KEY ("premise_id") REFERENCES "premise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter" ADD CONSTRAINT "meter_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter" ADD CONSTRAINT "meter_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "unit_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreement" ADD CONSTRAINT "service_agreement_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreement" ADD CONSTRAINT "service_agreement_premise_id_fkey" FOREIGN KEY ("premise_id") REFERENCES "premise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreement" ADD CONSTRAINT "service_agreement_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreement" ADD CONSTRAINT "service_agreement_rate_schedule_id_fkey" FOREIGN KEY ("rate_schedule_id") REFERENCES "rate_schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreement" ADD CONSTRAINT "service_agreement_billing_cycle_id_fkey" FOREIGN KEY ("billing_cycle_id") REFERENCES "billing_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreement_meter" ADD CONSTRAINT "service_agreement_meter_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreement_meter" ADD CONSTRAINT "service_agreement_meter_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "meter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_schedule" ADD CONSTRAINT "rate_schedule_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_schedule" ADD CONSTRAINT "rate_schedule_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "rate_schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_read" ADD CONSTRAINT "meter_read_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "meter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_read" ADD CONSTRAINT "meter_read_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_read" ADD CONSTRAINT "meter_read_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "meter_register"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_read" ADD CONSTRAINT "meter_read_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "unit_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_address" ADD CONSTRAINT "billing_address_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_register" ADD CONSTRAINT "meter_register_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "meter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_register" ADD CONSTRAINT "meter_register_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "unit_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cis_user" ADD CONSTRAINT "cis_user_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cis_user" ADD CONSTRAINT "cis_user_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_event" ADD CONSTRAINT "meter_event_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "meter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container" ADD CONSTRAINT "container_premise_id_fkey" FOREIGN KEY ("premise_id") REFERENCES "premise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container" ADD CONSTRAINT "container_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_suspension" ADD CONSTRAINT "service_suspension_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_event" ADD CONSTRAINT "service_event_premise_id_fkey" FOREIGN KEY ("premise_id") REFERENCES "premise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_event" ADD CONSTRAINT "service_event_service_agreement_id_fkey" FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_event" ADD CONSTRAINT "service_event_container_id_fkey" FOREIGN KEY ("container_id") REFERENCES "container"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "notification_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delinquency_rule" ADD CONSTRAINT "delinquency_rule_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delinquency_action" ADD CONSTRAINT "delinquency_action_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delinquency_action" ADD CONSTRAINT "delinquency_action_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "delinquency_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
