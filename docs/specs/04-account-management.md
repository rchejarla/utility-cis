# Account Management

**Module:** 04 — Account Management
**Status:** Built (Phase 1)
**Entities:** Account

## Overview

The Account Management module manages the billing relationship between a customer and the utility. An Account is created when a customer starts service and persists through the life of that billing relationship. Multiple accounts can belong to one customer (e.g., a commercial customer with several locations), and one account can span multiple service locations via separate ServiceAgreements.

The Account is the billing unit from the utility's perspective: deposits are tracked here, credit rating is assessed here, billing preferences (paperless, budget billing) are set here, and the link to the financial system (SaaSLogic) is established here.

**Who uses it:** CSRs opening new accounts, billing staff managing deposits and credit ratings, managers reviewing account standing before service decisions.

**Why it matters:** Every ServiceAgreement must belong to an Account. No Account means no billing. The Account closure guard prevents orphaned agreements and ensures final bills are generated before an account is permanently closed.

## Entities

### Account

Billing relationship between a customer and the utility.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| account_number | VARCHAR(50) | Unique per utility; human-readable identifier |
| customer_id | UUID | FK → Customer (required in normal operations; nullable for bulk migration) |
| account_type | ENUM | `RESIDENTIAL`, `COMMERCIAL`, `INDUSTRIAL`, `MUNICIPAL` |
| status | ENUM | `ACTIVE`, `INACTIVE`, `FINAL`, `CLOSED`, `SUSPENDED` |
| credit_rating | ENUM | `EXCELLENT`, `GOOD`, `FAIR`, `POOR`, `UNRATED` |
| deposit_amount | DECIMAL(10,2) | Deposit held by utility; default 0 |
| deposit_waived | BOOLEAN | Whether the deposit requirement was waived; default false |
| deposit_waived_reason | VARCHAR(255) | Optional reason for waiver |
| language_pref | CHAR(5) | Language for communications; default `"en-US"` |
| paperless_billing | BOOLEAN | Opted into paperless; default false |
| budget_billing | BOOLEAN | Enrolled in budget/levelized billing; default false |
| saaslogic_account_id | UUID | Nullable; FK into SaaSLogic for financial operations |
| created_at | TIMESTAMPTZ | |
| closed_at | TIMESTAMPTZ | Null = not closed |

**Unique constraint:** `[utility_id, account_number]`

**Relationships:**
- `customer` → Customer (FK; account may be nullable during bulk migration but expected in normal operations)
- `serviceAgreements` → ServiceAgreement[] (all agreements on this account)
- `contacts` → Contact[] (authorized contacts for this account)
- `billingAddresses` → BillingAddress[] (alternate bill-to addresses)

**Account status definitions:**
- `ACTIVE` — Account in good standing with active services
- `INACTIVE` — Account suspended or no current active services
- `FINAL` — Account in the process of being closed; final bill being prepared
- `CLOSED` — Account permanently closed; no new agreements allowed
- `SUSPENDED` — Account temporarily suspended (e.g., for non-payment)

## API Endpoints

All endpoints require JWT authentication with `utility_id` claim.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/accounts` | List accounts (paginated, filterable) |
| POST | `/api/v1/accounts` | Create a new account |
| GET | `/api/v1/accounts/:id` | Get account by ID (includes agreements, contacts, billing addresses) |
| PATCH | `/api/v1/accounts/:id` | Update account fields |

**Query parameters for `GET /accounts`:**

| Parameter | Type | Description |
|-----------|------|-------------|
| page | integer | Default 1 |
| limit | integer | Default 20, max 500 |
| sort | string | Default `createdAt` |
| order | `asc` \| `desc` | Default `desc` |
| status | AccountStatus | Filter by status |
| accountType | AccountType | Filter by type |
| creditRating | CreditRating | Filter by credit rating |
| search | string | Search by account number (full-text search in Phase 2) |

**Create request body:**

| Field | Required | Validation |
|-------|----------|------------|
| accountNumber | Yes | min 1, max 50 chars |
| customerId | No | UUID |
| accountType | Yes | RESIDENTIAL, COMMERCIAL, INDUSTRIAL, MUNICIPAL |
| status | No | Default ACTIVE |
| creditRating | No | Default UNRATED |
| depositAmount | No | min 0, default 0 |
| depositWaived | No | boolean, default false |
| depositWaivedReason | No | max 255 chars |
| languagePref | No | exactly 5 chars (e.g., `"en-US"`), default `"en-US"` |
| paperlessBilling | No | boolean, default false |
| budgetBilling | No | boolean, default false |
| saaslogicAccountId | No | UUID |

**Update restrictions:** `accountNumber` cannot be changed via PATCH (`updateAccountSchema` omits `accountNumber`). Account numbers are permanent identifiers once issued.

## Business Rules

### Account Closure Guard

An account cannot be set to `CLOSED` or `FINAL` while it has active ServiceAgreements. This is enforced inside a `$transaction`: the closure request first checks for agreements with `status IN ('PENDING', 'ACTIVE')`. If any exist, the transaction rolls back with a descriptive error. This prevents orphaned agreements and ensures final billing occurs before closure.

### Status Lifecycle

```
ACTIVE ←→ INACTIVE
ACTIVE → SUSPENDED → ACTIVE
ACTIVE → FINAL → CLOSED
INACTIVE → FINAL → CLOSED
```

- An account can move between `ACTIVE` and `INACTIVE` freely (e.g., seasonally inactive)
- `SUSPENDED` is temporary and can be lifted back to `ACTIVE`
- `FINAL` and `CLOSED` are one-way transitions
- `CLOSED` accounts cannot be reopened; a new account must be created

### Account Number

Account numbers are assigned by the utility (not auto-generated by CIS). They must be unique within a utility. The utility's existing numbering scheme is preserved. Attempts to create a duplicate account number return a conflict error.

### Deposits

- `deposit_amount` is the dollar amount of deposit held by the utility (not managed in CIS financials — SaaSLogic tracks actual payment)
- `deposit_waived` = true means the deposit was not collected; `deposit_waived_reason` captures why
- Deposit refund on close: the flag and amount are on the Account for CSR reference; actual refund processing happens in SaaSLogic (Phase 2 workflow)
- Deposit application to unpaid charges: Phase 3 feature

### Credit Rating

Set by CSRs or (Phase 3) automatically based on payment history from SaaSLogic:
- `UNRATED` — New account, no history
- `EXCELLENT` / `GOOD` / `FAIR` / `POOR` — Based on payment performance

Credit rating may influence deposit requirements (e.g., POOR rating = higher deposit). This rule engine is a Phase 3 feature.

### Paperless Billing

`paperless_billing = true` opts the account into electronic-only delivery. When false, physical bills are sent to the BillingAddress (if present) or the premise address. Paperless enrollment does not affect the billing cycle or calculations; only the delivery channel.

### Budget Billing

`budget_billing = true` enrolls the account in levelized billing (equal monthly payments averaged over 12 months, with true-up). The actual budget amount calculation and true-up logic are Phase 3 billing engine features.

### SaaSLogic Integration

`saaslogic_account_id` stores the corresponding account identifier in SaaSLogic. CIS sends billing instructions keyed by this ID. Payment events from SaaSLogic reference this ID to update account standing in CIS. This field is nullable because new accounts may be created in CIS before the SaaSLogic account is provisioned.

### Soft Delete Only

Accounts are never deleted. `CLOSED` with `closed_at` timestamp is the terminal state.

### Customer Linkage

`customer_id` is a FK → Customer entity (not an external CRM reference). It is nullable only to support bulk migration scenarios where accounts are imported before customer records are fully established. In normal operations every account must have a linked Customer. Accounts can be created from the Customer detail Accounts tab, which pre-populates the `customerId` automatically.

## UI Pages

| Page | Path | Features |
|------|------|----------|
| Accounts List | `/accounts` | Table with account number, customer name, type, status, credit rating; search by account number; filter by type/status/credit rating |
| Account Detail | `/accounts/:id` | Tabs: Overview (inline editable fields), Agreements (list of service agreements), Contacts (add/edit/delete inline), Billing Addresses (add/edit inline); Close Account button with confirmation dialog (enforces BR-AC-004 — blocked if active agreements exist) |
| Account Create | `/accounts/new` | Form with account number, customer selector (SearchableSelect), type, deposit, billing preferences; HelpTooltip on deposit and credit rating fields |

**Overview tab fields displayed:** account number, customer name (linked), account type, status, credit rating, deposit amount/waived, language preference, paperless and budget billing flags, SaaSLogic ID, created/closed dates. All editable fields support inline editing.

**Contacts tab:** List of contacts with role badges (PRIMARY, BILLING, AUTHORIZED, EMERGENCY). Add Contact inline form. Edit contact inline. Delete contact with confirmation. Uses Contact endpoints (`GET/POST/PATCH/DELETE /api/v1/contacts`).

**Billing Addresses tab:** List of billing addresses with primary badge. Add Billing Address inline form. Edit inline. Remove. Uses BillingAddress endpoints (`GET/POST/PATCH /api/v1/billing-addresses`).

## Phase Roadmap

- **Phase 1 (Complete):** Full Account CRUD (4 endpoints), deposit tracking, credit rating, paperless/budget billing flags, closure guard, SaaSLogic ID field, Contact and BillingAddress relationships defined.
- **Phase 2 (Built):** `customerId` is now a FK → Customer entity (not an external CRM string). Account detail inline editing on all overview fields. Close Account button with confirmation dialog enforcing BR-AC-004 (blocked if active agreements exist). New Contacts tab with add/edit/delete inline forms using Contact API endpoints. New Billing Addresses tab with add/edit inline forms using BillingAddress API endpoints. Accounts can be added from Customer detail Accounts tab (customerId pre-populated). SearchableSelect for customer lookup on account create. Still planned for Phase 2: full-text search across account/customer name, deposit refund workflow, landlord/tenant SA relationship, transfer of service, delinquency status indicator.
- **Phase 3+:** Budget billing calculation and true-up logic. Credit rating auto-update from SaaSLogic payment events. Deposit auto-application to unpaid charges. Delinquency rules engine. User-defined required fields (configurable custom fields). Bill holds. Communication preferences per account.

## Bozeman RFP Coverage

| Req | Requirement | Status |
|-----|-------------|--------|
| 9 | Multiple accounts per property | Covered — multiple ServiceAgreements per Premise per Account |
| 10 | One account across multiple properties | Covered — Account → many ServiceAgreements → many Premises |
| 11 | User-defined required fields in customer file | Gap (Phase 3) |
| 12 | Multiple customer types | Covered — `account_type` enum |
| 13 | Multiple contacts per account with roles | Covered — Contact entity (routes in Phase 2) |
| 15 | Transfer of service | Planned (Phase 2) |
| 17 | Alternate bill-to addresses | Covered — BillingAddress entity (routes in Phase 2) |
| 18 | International billing addresses | Covered — `country` field on BillingAddress |
| 19 | Deposits for certain account types | Covered — `deposit_amount`, `deposit_waived`, `deposit_waived_reason` |
| 20 | Deposit refund on close | Partial (Phase 2) — fields exist; workflow planned |
| 21 | Apply deposit to unpaid charges | Gap (Phase 3) |
| 22 | Customer account status values | Covered — `status` enum (ACTIVE, INACTIVE, FINAL, CLOSED, SUSPENDED) |
| 23 | Delinquency flagging visible during lookup | Gap (Phase 3) |
| 24 | Customer search by any data field | Partial — account number search exists; full-text in Phase 2 |
| 26 | Consolidated account history view | Partial — AuditLog exists; unified history UI planned Phase 2 |
| 132 | Paperless billing enrollment | Covered — `paperless_billing` flag |
| 135 | Multiple concurrent billing cycles | Covered — BillingCycle entity |
