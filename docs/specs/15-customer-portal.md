# Customer Portal

**Module:** 15 — Customer Portal
**Status:** Stub (Phase 4)
**Entities:** (No new CIS entities — uses existing entities via portal-scoped API layer)

## Overview

The Customer Portal is a secure, customer-facing web application that allows utility customers to self-serve on their account — view and pay bills, monitor usage, start/stop/transfer service, report issues, manage communication preferences, and check service status. It is distinct from the admin UI (used by utility staff) and operates on a separate authentication domain with customer-level access controls.

The portal delegates payment processing to SaaSLogic (embedded UI or redirect) and service workflow execution to ApptorFlow. CIS provides the data layer and API.

Primary users: residential and commercial utility customers.

## Overview of Capabilities (No New Entities)

The portal does not introduce new database entities. It consumes existing CIS entities through a portal-scoped API surface with customer-level authorization (customers can only see their own accounts). New fields added to existing entities to support portal:

**Account additions (Phase 4):**
- `portal_user_id` — link to portal authentication identity
- `portal_registered_at` — when customer registered for portal access
- `portal_last_login` — last portal login timestamp

**Premise additions (Phase 4):**
- No new fields required; usage and outage data surfaced from existing entities

**ServiceAgreement additions (Phase 4):**
- `portal_visible` — whether this agreement is visible in the portal (default true)

## Portal Feature Areas

### 1. Account Registration and Authentication

Customers register for portal access using their account number and a verification step (email or last 4 of SSN/phone). Portal authentication is separate from the admin JWT system — portal sessions use a separate auth domain with customer-scoped JWT tokens.

**Flows:**
- Self-registration: account number + verification → email link → password setup
- Forgot password: email reset flow
- Multi-factor authentication (TOTP or SMS OTP)
- Household multi-account view: one portal login can view multiple linked accounts

### 2. Account Dashboard

Landing page after login showing:
- Current balance and due date (from SaaSLogic)
- Active service agreements and their status
- Recent bills (last 3)
- Delinquency alert banner (if applicable)
- Quick actions: Pay Now, Report Issue, View Usage

### 3. Bill Viewing and Payment

- List of all bills: billing period, amount, due date, payment status
- Bill detail: full itemized charge breakdown (from BillingRecord.charge_breakdown)
- PDF download for each bill
- Usage chart: monthly consumption trend
- Payment button: redirects to SaaSLogic payment widget (embedded iframe or hosted page)
- Autopay enrollment (managed in SaaSLogic, enrollment status surfaced in CIS)
- Paperless billing toggle (updates Account.paperless_billing)

### 4. Usage Dashboard

- Consumption chart: daily, weekly, monthly views using MeterRead data
- Comparison: current period vs. prior period, same period last year
- Usage alerts: configurable threshold notifications (e.g., "notify me if daily usage exceeds X gallons")
- AMI interval data visualization (hourly/15-minute if available)
- Estimated bill based on current usage pace (rate engine calculation, not final bill)
- Leak indicator: if consumption is nonzero during hours with no expected usage (AMI data)

### 5. Start / Stop / Transfer Service

- Start service: premise lookup, service type selection, desired start date → creates ServiceRequest (Module 14) type START_SERVICE → triggers ApptorFlow workflow
- Stop service: desired stop date, forwarding address → creates ServiceRequest type STOP_SERVICE
- Transfer service: move to new address → creates linked STOP_SERVICE and START_SERVICE requests
- Status tracker: shows workflow steps and current step for pending requests
- Estimated completion date based on SLA configuration (Module 14)

### 6. Service Requests

- Submit new SR: type selection, description, photo attachment
- View open and closed SRs with status timeline
- Receive notifications on status changes (Module 13)
- Dispute a bill or charge
- Request vacation hold for solid waste (Module 12)

### 7. Outage and Service Status

- Service status page: current outages or planned maintenance by geographic area
- Outage map (if GIS integration is available)
- Outage subscription: notify me about outages at my premises
- Planned maintenance calendar

### 8. Communication Preferences

- Channel preferences: email, SMS, mail per notification category
- SMS opt-in with explicit consent recording (TCPA compliance — Module 13)
- Notification preview: shows what each notification type looks like
- Email address and phone number management (updates Account/Contact records)

## API Endpoints

All endpoints are planned for Phase 4. Portal API is a separate route namespace with customer-scoped authorization.

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | `/portal/api/auth/register` | Customer self-registration |
| POST | `/portal/api/auth/verify` | Verify account ownership |
| POST | `/portal/api/auth/login` | Login (returns customer-scoped JWT) |
| POST | `/portal/api/auth/logout` | Logout |
| POST | `/portal/api/auth/reset-password` | Password reset request |

### Account and Billing

| Method | Path | Description |
|--------|------|-------------|
| GET | `/portal/api/accounts` | Get linked accounts for authenticated customer |
| GET | `/portal/api/accounts/:id` | Get account summary (balance, status) |
| GET | `/portal/api/accounts/:id/bills` | List bills |
| GET | `/portal/api/accounts/:id/bills/:billId` | Bill detail with charge breakdown |
| GET | `/portal/api/accounts/:id/bills/:billId/pdf` | Download bill PDF |
| PATCH | `/portal/api/accounts/:id/paperless` | Toggle paperless billing |

### Usage

| Method | Path | Description |
|--------|------|-------------|
| GET | `/portal/api/service-agreements/:id/usage` | Usage data (date range, aggregation interval) |
| GET | `/portal/api/service-agreements/:id/usage/compare` | Compare current vs prior period |

### Service Requests

| Method | Path | Description |
|--------|------|-------------|
| POST | `/portal/api/service-requests` | Submit a service request |
| GET | `/portal/api/service-requests` | List own SRs |
| GET | `/portal/api/service-requests/:id` | SR detail and status timeline |

### Communication Preferences

| Method | Path | Description |
|--------|------|-------------|
| GET | `/portal/api/preferences` | Get communication preferences |
| PUT | `/portal/api/preferences` | Update preferences |

## Business Rules

1. **Customer-scoped authorization:** Portal JWTs carry a `customer_id` claim (not `utility_id` like admin tokens). Every portal API endpoint filters data to accounts where the authenticated customer is the primary contact or authorized account holder. No cross-customer data leakage is possible.

2. **Read-only for sensitive fields:** Customers cannot change their account number, account type, deposit amount, or billing cycle through the portal. Changes to contact information require CSR approval or identity re-verification.

3. **Payment delegation:** CIS never handles payment data. The portal's "Pay Now" action redirects to SaaSLogic's hosted payment page or embeds SaaSLogic's payment widget via iframe. Payment confirmation is received by CIS via webhook (Module 10).

4. **Service request submission limits:** Customers cannot submit duplicate SRs of the same type for the same account within 24 hours. The system warns if an existing open SR of the same type exists.

5. **Outage status sourcing:** Outage and service interruption data comes from an external operational system (configured per tenant). CIS proxies this data for the portal. If no external system is integrated, the status page shows "No known outages."

6. **Usage data visibility:** Customers can view usage data for their active service agreements. Historical usage for closed agreements is available for 2 years. Raw interval data (AMI) is displayed in charts but not exportable by default (configurable per tenant).

7. **Multi-account view:** Customers with multiple account numbers (e.g., a landlord with multiple properties) can link all accounts to a single portal login. A dropdown or tabs allow switching between accounts. Billing summary shows aggregate balance across all linked accounts.

8. **Portal registration verification:** To prevent unauthorized portal access, account ownership is verified by matching account number plus one of: email on file, last 4 digits of phone, or last 4 digits of SSN/tax ID. Verification attempts are rate-limited and logged.

9. **SMS consent:** When a customer enables SMS notifications in the portal, the consent flow presents the TCPA-compliant consent language and records the consent text and timestamp in CommunicationPreference (Module 13).

10. **Third-party payer access:** Accounts with a designated third-party payer can grant that payer access to view and pay bills without access to other account details. This is a restricted portal role (Bozeman Reqs 152–156).

## UI Pages

All pages are planned for Phase 4. The portal is a separate Next.js application (or dedicated route segment) with its own layout, brand theming, and responsive design for mobile use.

### Portal Pages

| Page | Path | Description |
|------|------|-------------|
| Registration | `/portal/register` | Account lookup and identity verification |
| Login | `/portal/login` | Customer login |
| Dashboard | `/portal/dashboard` | Account overview, balance, quick actions |
| Bills | `/portal/bills` | Bill history, download, pay |
| Usage | `/portal/usage` | Consumption charts, interval data |
| Service Requests | `/portal/service-requests` | Submit and track SRs |
| Start Service | `/portal/start-service` | Move-in wizard |
| Stop Service | `/portal/stop-service` | Move-out wizard |
| Transfer Service | `/portal/transfer-service` | Move wizard |
| Preferences | `/portal/preferences` | Communication preferences, opt-in/out |
| Service Status | `/portal/status` | Outage and maintenance information |
| Profile | `/portal/profile` | Contact info, password change |

## Phase Roadmap

- **Phase 1-3 (Complete/Planned):** Admin-facing CIS only. No customer portal.

- **Phase 4 (Planned):**
  - Customer portal authentication (separate from admin auth)
  - Account dashboard (balance, bills, status)
  - Bill viewing and PDF download
  - Usage charts (MeterRead data)
  - Payment redirect/embed via SaaSLogic
  - Paperless billing toggle
  - Service request submission and tracking
  - Start/stop/transfer service wizards (ApptorFlow-backed)
  - Communication preferences (Module 13)
  - Solid waste vacation hold request (Module 12)
  - Outage/service status page
  - Multi-account view
  - Third-party payer access (Bozeman Reqs 152–156)

- **Phase 5 (Planned):** Special assessment viewing and installment payment portal.

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 34 | Secure portal | Phase 4: customer auth with MFA, customer-scoped JWT |
| 35 | Account registration | Phase 4: self-registration with account verification |
| 36 | Bill viewing | Phase 4: bill list + PDF download |
| 37 | Portal payments | Phase 4: SaaSLogic redirect/embed |
| 38 | Usage dashboard | Phase 4: consumption charts with interval data |
| 39 | Start/stop/transfer service | Phase 4: service request wizards + ApptorFlow |
| 40 | Outage/service status | Phase 4: status page with external system integration |
| 41 | Communication preferences in portal | Phase 4: preferences management + SMS consent |
| 128–129 | Portal bill display, consolidated view | Phase 4: bill history + charge breakdown display |
| 132 | Paperless billing enrollment | Phase 4: portal toggle (Phase 1 field already exists) |
| 152–156 | Multi-account, third-party payer, payment allocation | Phase 4: multi-account view, third-party payer role |
