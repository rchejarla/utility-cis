-- A deferred payment agreement, and the debts it covers.
--
-- The term of art is "Deferred Payment Agreement"; `payment_plan` is
-- what everyone says. Design:
-- docs/superpowers/specs/2026-10-26-payment-plans-design.md
--
-- Nothing here changes a balance. A plan is an overlay that says *when*
-- money is chased, not *what* is owed: no ledger entry is posted on
-- agreement, no debt is moved, `account.balance` is untouched. That is
-- the deliberate departure from Oracle CC&B, where a payment
-- arrangement is its own service agreement and the overdue debt is
-- transferred onto it — a model that would make every balance query in
-- this codebase learn about plans.
CREATE TYPE payment_plan_status AS ENUM ('ACTIVE', 'COMPLETED', 'DEFAULTED', 'CANCELLED');

-- No PENDING. An earlier draft had one, for "agreed, down payment not
-- yet received", with two transitions to leave it — and they changed
-- nothing the system did, because suppression began at agreement either
-- way. The down payment is simply the first payment, due on
-- `start_date`, judged by `grace_days` like every other.
CREATE TYPE payment_plan_frequency AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY');

CREATE TABLE payment_plan (
  id         UUID                NOT NULL DEFAULT gen_random_uuid(),
  utility_id UUID                NOT NULL,
  account_id UUID                NOT NULL,
  status     payment_plan_status NOT NULL,

  -- Frozen at agreement from the sum of the covered debits'
  -- `open_amount` — not their `amount`. A bill charge of $110.75 with
  -- $55.37 left owes $55.37, and a plan covering its face value would
  -- collect money the customer does not owe.
  total_balance      DECIMAL(14, 2)         NOT NULL,
  down_payment       DECIMAL(14, 2),
  installment_amount DECIMAL(14, 2)         NOT NULL,
  installment_frequency payment_plan_frequency NOT NULL,
  installment_count  INTEGER                NOT NULL,

  -- The down payment is due on this date and instalment *n* on
  -- `start_date + (n - 1) * frequency`. There is no instalment table:
  -- the schedule is derivable, and a stored copy of a derivable figure
  -- is a copy that can disagree with the ledger.
  start_date  DATE NOT NULL,
  approved_by UUID NOT NULL,
  notes       TEXT,

  -- ── The six terms this plan is judged by, frozen at agreement ──
  --
  -- A customer agreed to *these* terms. A tenant lowering grace from
  -- five days to two must not thereby break every plan already running,
  -- and the alternative — reading the settings namespace live — makes a
  -- live agreement's fate depend on a screen nobody connected to it.
  --
  -- Typed columns rather than a JSON snapshot because the default sweep
  -- reads them per plan, which is this codebase's own rule for when a
  -- value earns a column.
  --
  -- The creation-time terms (down payment percent, the instalment
  -- bounds, the frequency) are not frozen separately: they shaped this
  -- plan and are already embodied in the columns above.
  grace_days                        INTEGER NOT NULL,
  missed_before_default             INTEGER NOT NULL,
  partial_installment_counts        BOOLEAN NOT NULL,
  current_bill_counts               BOOLEAN NOT NULL,
  suppress_fees_while_kept          BOOLEAN NOT NULL,
  assess_suppressed_fees_on_default BOOLEAN NOT NULL,

  -- When the status last moved. The CSR panel reads `DEFAULTED
  -- 2026-12-20` (design §4b) and `updated_at` cannot answer that: any
  -- write to the row moves it, so a note edited in March would relabel
  -- a default that happened in December. COMPLETED and CANCELLED want
  -- the same date for the same reason.
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payment_plan_pkey PRIMARY KEY (id)
);

-- `payment_plan_debit` references this compositely, which needs the
-- tenant in a unique key.
ALTER TABLE payment_plan
  ADD CONSTRAINT payment_plan_utility_id_id_key UNIQUE (utility_id, id);

-- The commonest query by far: the plans on the account a CSR is looking
-- at. Leading column is the RLS policy's, so the policy reads through
-- it too.
CREATE INDEX payment_plan_account_idx ON payment_plan (utility_id, account_id);

-- The sweep's query: every plan still running, across the tenant.
CREATE INDEX payment_plan_status_idx ON payment_plan (utility_id, status);

-- Which debts the customer agreed a schedule for.
--
-- Keyed on the entry: a debit belongs to at most one plan. Naming the
-- debits rather than carrying a `covers_debts_as_of` date on the plan is
-- what makes it auditable — and stops a back-dated bill issued later
-- being swept into an agreement nobody made about it.
CREATE TABLE payment_plan_debit (
  utility_id UUID        NOT NULL,
  plan_id    UUID        NOT NULL,
  entry_id   UUID        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payment_plan_debit_pkey PRIMARY KEY (utility_id, entry_id)
);

CREATE INDEX payment_plan_debit_plan_idx
  ON payment_plan_debit (utility_id, plan_id);

-- Tenant-scoped composites, like every other key between two
-- tenant-scoped tables here, so a row in one tenant cannot reference a
-- row in another — which RLS cannot enforce, because a referential
-- integrity check is not a row read.
--
-- RESTRICT throughout: a plan is history, an account is closed rather
-- than deleted, and a ledger entry is reversed, never deleted. None of
-- these parents has a delete path for this to soften.
ALTER TABLE payment_plan
  ADD CONSTRAINT payment_plan_utility_id_fkey
  FOREIGN KEY (utility_id) REFERENCES utility (id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE payment_plan
  ADD CONSTRAINT payment_plan_account_id_fkey
  FOREIGN KEY (utility_id, account_id)
  REFERENCES account (utility_id, id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- Single-column, following `service_request_created_by_fkey`: a
-- composite key cannot reach `cis_user`, whose `utility_id` is nullable
-- because the platform actor sits above the tenants. RESTRICT, not SET
-- NULL — a staff member is retired with `is_active` rather than
-- deleted, and a plan with no record of who agreed it is the thing the
-- audit discipline here exists to prevent.
ALTER TABLE payment_plan
  ADD CONSTRAINT payment_plan_approved_by_fkey
  FOREIGN KEY (approved_by) REFERENCES cis_user (id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE payment_plan_debit
  ADD CONSTRAINT payment_plan_debit_utility_id_fkey
  FOREIGN KEY (utility_id) REFERENCES utility (id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE payment_plan_debit
  ADD CONSTRAINT payment_plan_debit_plan_id_fkey
  FOREIGN KEY (utility_id, plan_id)
  REFERENCES payment_plan (utility_id, id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE payment_plan_debit
  ADD CONSTRAINT payment_plan_debit_entry_id_fkey
  FOREIGN KEY (utility_id, entry_id)
  REFERENCES ledger_entry (utility_id, id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- A plan over nothing is not a plan: it would be created and complete
-- on the very next sweep, having collected a down payment against no
-- debt.
ALTER TABLE payment_plan
  ADD CONSTRAINT payment_plan_total_balance_positive CHECK (total_balance > 0);

ALTER TABLE payment_plan
  ADD CONSTRAINT payment_plan_installment_amount_positive CHECK (installment_amount > 0);

ALTER TABLE payment_plan
  ADD CONSTRAINT payment_plan_installment_count_positive CHECK (installment_count > 0);

-- Zero is allowed — a utility may agree a plan with nothing down — but
-- a negative down payment would pay the customer to fall behind.
ALTER TABLE payment_plan
  ADD CONSTRAINT payment_plan_down_payment_not_negative CHECK (
    down_payment IS NULL OR down_payment >= 0
  );

-- A threshold of zero would default every plan on the sweep that
-- followed its agreement.
ALTER TABLE payment_plan
  ADD CONSTRAINT payment_plan_missed_before_default_positive CHECK (missed_before_default > 0);

-- Grace may be zero (due today, late tomorrow) but not negative, which
-- would make an instalment missed before it was due.
ALTER TABLE payment_plan
  ADD CONSTRAINT payment_plan_grace_days_not_negative CHECK (grace_days >= 0);

-- Tenant isolation, which `schema-invariants.integration.test.ts`
-- requires of every table carrying a `utility_id`.
--
-- One-argument `current_setting`, deliberately: with no tenant set this
-- raises 22023 rather than returning nothing. An unscoped read of the
-- table that says which debts are suppressed would otherwise answer
-- "none are", and the ladder would charge fees on every debt the
-- utility had agreed to wait for.
--
-- FORCE as well as ENABLE, so the owner is not exempt either.
ALTER TABLE payment_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_plan FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_plan
  USING (utility_id = (current_setting('app.current_utility_id'))::uuid);

ALTER TABLE payment_plan_debit ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_plan_debit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_plan_debit
  USING (utility_id = (current_setting('app.current_utility_id'))::uuid);
