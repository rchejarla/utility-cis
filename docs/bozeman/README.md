# Bozeman RFP — Requirements Tracker

**City:** Bozeman, Montana
**RFP:** Utility Billing Software
**Proposed solution:** SaaSLogic Utilities + SaaSLogic Billing
**Status:** Proposal preparation

This folder collects the formal requirements documents for every commitment we make in the Bozeman RFP response. Each numbered file translates one or more RFP claims into testable requirements with acceptance criteria, implementation approach, and current-state gap analysis.

The point: every claim we make to the City should map to a requirements doc here so the engineering team can scope, build, and verify against it. If a claim doesn't map to a doc, it shouldn't be in the RFP response.

## Index

| # | Topic | RFP claim summary | Status |
|---|---|---|---|
| 01 | [Audit & Tamper-Evidence](./01-audit-and-tamper-evidence.md) | Append-only audit log, S3 replication with object-lock, daily Merkle hash chains, security-event coverage, two-person approval for sensitive changes | **Drafted — implementation pending** |
| 02 | [Mobile & Responsive UI](./02-mobile-and-responsive-ui.md) | Three-tier mobile strategy: CSR workflows fully mobile (Tier 1), power-user workflows desktop-optimized + tablet-usable (Tier 2), field-technician workflows mobile-first with offline + photo + GPS + barcode (Tier 3) | **Drafted — implementation pending** |
| 03 | [Progressive Web App (PWA)](./03-progressive-web-app.md) | Manifest + installability across admin/portal/field surfaces, service worker with per-resource cache strategies, offline shell, IndexedDB queue + background sync for field surface, update lifecycle with force-reload for security patches, iOS Safari constraints. Push notifications explicitly out of scope. | **Drafted — implementation pending** |
| 04 | [Attachments](./04-attachments.md) | Upload/view/download/delete on 7 entity types (current: 5 — adds ServiceRequest + Adjustment), expanded MIME types (adds PowerPoint + HEIC + TIFF), full audit trail (currently absent), document categories, soft-delete with configurable purge, multi-field search by filename/description/uploader/date/parent, S3 storage with KMS + pre-signed URLs + lifecycle archival to lower-cost tiers, **Apptorflow-mediated DMS integration (SharePoint/Laserfiche/OnBase/M-Files)** with two patterns (external pointer or internal replication), **per-entity-type-and-category retention policies** with dual-approved purges and immutable signed manifests. Native FTS explicitly roadmap. | **Drafted — partial implementation (basic CRUD exists for 5 entities)** |
| 05 | [Customer Portal](./05-customer-portal.md) | ~30-capability surface: bill view (PDF + itemized), consumption charts, one-time + scheduled payments + AutoPay + payment plans, paperless billing, service start/stop/transfer, SR intake + tracking, tax docs, in-portal messaging, contact preferences. Multi-account login with one-click switching across multiple Customers; landlord/property-mgmt portfolio access; audit-logged delegation. Notifications via email + SMS + in-portal + web push (portal only) + voice via Apptorflow; templated, event-configurable, per-resident preferences. Largest scope in the proposal. | **Drafted — minimal implementation (login/dashboard/profile/usage exist; bills are mock; no payments/SRs/messaging/delegation/multi-account/notifications)** |

## Conventions

- **Numbered prefix** (`01-`, `02-`, …) keeps the index ordered and stable. Re-numbering invalidates citations in the RFP response.
- **Filenames** use kebab-case. The first line of each doc is the topic title.
- **Requirement IDs** follow `FR-<DOMAIN>-<NNN>` for functional and `NFR-<DOMAIN>-<NNN>` for non-functional. Cite these in code comments and test names so traceability holds.
- **"Out of scope"** sections are mandatory in each doc. Naming what we are not committing to is as important as naming what we are.
- **Current-state gap** sections cite specific files and line numbers where applicable so the gap is auditable.

## Process

1. Each RFP claim is captured verbatim in the requirements doc that owns it.
2. Implementation effort estimates carry a confidence band (S / M / L / XL).
3. Acceptance criteria must be testable — automated where reasonable, documented manual verification otherwise.
4. The "Out of scope" section is signed off by the proposal owner before the RFP response is finalized.

## SaaSLogic product positioning

- **SaaSLogic Utilities** — the customer information system (CIS) covering customer/account/premise/agreement/meter/SR domains. This is the codebase in `packages/api` and `packages/web`.
- **SaaSLogic Billing** — the billing engine. Proposed integration documented in `docs/specs/21-saaslogic-billing.md` (Phase 3).

The Bozeman proposal positions both as a single deployable solution. Where requirements span both products, the doc should call out which side owns each piece.
