-- AR Ledger slice 1. See docs/superpowers/specs/2026-10-09-ar-ledger-design.md
--
-- Signed money: positive increases what the customer owes the utility.
-- openAmount shares its parent's sign and never exceeds it in magnitude,
-- so SUM(open_amount) over an account IS its balance.

CREATE TYPE "LedgerEntryType" AS ENUM (
  'BILL_CHARGE','FEE','ADJUSTMENT_DEBIT','PAYMENT','ADJUSTMENT_CREDIT','WRITE_OFF','REVERSAL'
);
CREATE TYPE "PaymentTender" AS ENUM ('CARD','ACH','CASH','CHECK','LOCKBOX');

CREATE TABLE "ledger_reason_def" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"      UUID NOT NULL,
  "code"            VARCHAR(50) NOT NULL,
  "label"           VARCHAR(255) NOT NULL,
  "applies_to_type" "LedgerEntryType" NOT NULL,
  "is_active"       BOOLEAN NOT NULL DEFAULT true,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ledger_reason_def_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ledger_reason_def_utility_code_key" ON "ledger_reason_def"("utility_id","code");
CREATE INDEX "ledger_reason_def_type_idx" ON "ledger_reason_def"("utility_id","applies_to_type");

CREATE TABLE "ledger_entry" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"     UUID NOT NULL,
  "account_id"     UUID NOT NULL,
  "type"           "LedgerEntryType" NOT NULL,
  "amount"         DECIMAL(14,2) NOT NULL,
  "open_amount"    DECIMAL(14,2) NOT NULL,
  "due_date"       DATE,
  "effective_date" DATE NOT NULL,
  "posted_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "reason_id"      UUID,
  "bill_id"        UUID,
  "assessed_on_id" UUID,
  "reverses_id"    UUID,
  "tender"         "PaymentTender",
  "external_ref"   VARCHAR(100),
  "memo"           TEXT,
  "created_by"     UUID,
  CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ledger_entry_account_fkey"
    FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_entry_reason_fkey"
    FOREIGN KEY ("reason_id") REFERENCES "ledger_reason_def"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_entry_bill_fkey"
    FOREIGN KEY ("bill_id") REFERENCES "bill"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_entry_assessed_on_fkey"
    FOREIGN KEY ("assessed_on_id") REFERENCES "ledger_entry"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_entry_reverses_fkey"
    FOREIGN KEY ("reverses_id") REFERENCES "ledger_entry"("id") ON DELETE RESTRICT,

  -- A zero-amount entry is never meaningful. This is also what rejects a
  -- $0 late fee; a minimum-fee policy belongs on delinquency_rule.
  CONSTRAINT "ledger_entry_amount_nonzero" CHECK ("amount" <> 0),

  -- open_amount may be fully consumed (0) but never over-consumed and
  -- never flipped to the other side of its parent.
  CONSTRAINT "ledger_entry_open_within_amount"
    CHECK (abs("open_amount") <= abs("amount")),
  CONSTRAINT "ledger_entry_open_sign"
    CHECK ("open_amount" = 0 OR sign("open_amount") = sign("amount")),

  -- Expected sign per type. REVERSAL is excluded: its amount is
  -- -original.amount, so its sign follows its target and it instead
  -- must name that target.
  CONSTRAINT "ledger_entry_type_sign" CHECK (
    ("type" IN ('BILL_CHARGE','FEE','ADJUSTMENT_DEBIT') AND "amount" > 0)
    OR ("type" IN ('PAYMENT','ADJUSTMENT_CREDIT','WRITE_OFF') AND "amount" < 0)
    OR ("type" = 'REVERSAL' AND "reverses_id" IS NOT NULL)
  ),

  -- Provenance rules: a bill charge names its bill, a fee names what it
  -- was assessed on, a payment is the only thing with a tender.
  CONSTRAINT "ledger_entry_bill_charge_has_bill" CHECK (
    "type" <> 'BILL_CHARGE' OR "bill_id" IS NOT NULL
  ),
  CONSTRAINT "ledger_entry_tender_only_payment" CHECK (
    "tender" IS NULL OR "type" = 'PAYMENT'
  )
);

-- Structural idempotency: a Bill can be posted at most once.
CREATE UNIQUE INDEX "ledger_entry_bill_charge_key"
  ON "ledger_entry"("utility_id","bill_id") WHERE "type" = 'BILL_CHARGE';

CREATE INDEX "ledger_entry_account_posted_idx"
  ON "ledger_entry"("utility_id","account_id","posted_at" DESC);
CREATE INDEX "ledger_entry_bill_idx"       ON "ledger_entry"("utility_id","bill_id");
CREATE INDEX "ledger_entry_assessed_on_idx" ON "ledger_entry"("assessed_on_id");
CREATE INDEX "ledger_entry_reverses_idx"    ON "ledger_entry"("reverses_id");

-- Aging and allocation walk only open debits. Because credits are
-- negative, `open_amount > 0` selects exactly those.
CREATE INDEX "ledger_entry_open_debits_idx"
  ON "ledger_entry"("utility_id","due_date")
  WHERE "open_amount" > 0 AND "due_date" IS NOT NULL;

CREATE TABLE "ledger_application" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "utility_id" UUID NOT NULL,
  "credit_id"  UUID NOT NULL,
  "debit_id"   UUID NOT NULL,
  "amount"     DECIMAL(14,2) NOT NULL,
  "applied_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ledger_application_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ledger_application_credit_fkey"
    FOREIGN KEY ("credit_id") REFERENCES "ledger_entry"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_application_debit_fkey"
    FOREIGN KEY ("debit_id") REFERENCES "ledger_entry"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_application_amount_positive" CHECK ("amount" > 0)
);
CREATE INDEX "ledger_application_credit_idx" ON "ledger_application"("credit_id");
CREATE INDEX "ledger_application_debit_idx"  ON "ledger_application"("debit_id");

ALTER TABLE "ledger_entry"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_reason_def"  ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ledger_entry"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);
CREATE POLICY "tenant_isolation" ON "ledger_application"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);
CREATE POLICY "tenant_isolation" ON "ledger_reason_def"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);

-- Posting configuration. Default true per the product decision; the
-- nullable account column means null inherits the tenant value, so
-- flipping the tenant setting moves every account that has not opted out.
ALTER TABLE "tenant_config" ADD COLUMN "auto_post_bills" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "account"       ADD COLUMN "auto_post_bills" BOOLEAN;

-- Cache of a derivable fact, written in the posting transaction. Lets
-- the operator screen filter unposted bills without an anti-join.
ALTER TABLE "bill" ADD COLUMN "posted_at" TIMESTAMPTZ;
