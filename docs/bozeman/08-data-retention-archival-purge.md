# 08 — Data Retention, Archival, and Purge

**RFP commitment owner:** SaaSLogic Utilities — split between `packages/shared/prisma/schema.prisma` (retention metadata + legal-hold columns), `packages/api/src/services/retention/*` (engine, sweepers, manifest writer), `packages/api/src/workers/*` (BullMQ-driven sweeps), and `packages/web/app/(admin)/settings/retention/*` (operator UI). Cross-cuts deeply with [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) (immutable manifests, Merkle chains, two-person approval), [04-attachments.md](./04-attachments.md) (S3 lifecycle for attachment bytes), and [17-reporting-and-audit.md](../specs/17-reporting-and-audit.md) (audit immutability commitment).
**Status:** Drafted — minimal implementation. Only one component is built today: a daily sweeper that deletes scheduler-emitted audit rows older than 365 days (`scheduler_audit_retention_days` per tenant). Everything else — closed-account archival, historical-bill archival, cost-tiered storage for entity rows, the purge engine, two-person approval gating, immutable purge manifests, statutory retention floors, legal-hold enforcement, GDPR/CCPA right-to-erasure — is unbuilt.
**Effort estimate:** L (~12-16 weeks engineering). The largest cost is the **archival pipeline for entity rows** (bills, accounts, meter reads — these are PostgreSQL rows, not S3 objects, so "tiering" requires a different mechanism than `04-attachments.md` proposes for files). Second-largest is the **statutory retention engine** with per-event-class floors, legal-hold flags, and policy-conflict resolution. Purge dual-approval and manifests are smaller because they generalize patterns already designed in docs 01 and 04.

---

## 1. RFP commitment (verbatim)

> Production data is retained indefinitely by default. Archival policies can move closed accounts and historical bills to cost-optimized storage while preserving searchability and reportability. Purge requires policy configuration, dual approval where required, and produces an immutable audit manifest. Statutory retention timers (financial records, audit log) override purge requests.

The commitment decomposes into **five guarantees**:

1. **Default retention is indefinite.** No data is deleted unless a policy says so.
2. **Archival exists** as a distinct lifecycle stage between "live" and "purged" — closed accounts and historical bills can move to cost-optimized storage while remaining searchable and reportable.
3. **Purge is governed by policy** — no operator can hard-delete production data without an active retention policy authorizing it.
4. **Purge requires dual approval where configured**, and **always** produces an **immutable audit manifest** of what was purged.
5. **Statutory retention timers override purge requests** — financial records and audit logs cannot be removed before their regulatory minimums elapse, regardless of operator intent or policy edits.

This doc defines the requirements at the **system level** (every major entity). Doc 04 already defines the same primitives at the **attachment level**. Where they overlap, this doc references doc 04 rather than restating.

---

## 2. Current state — what exists today

### 2.1 Default retention — indefinite by default ✓ (mostly)

**Status: Substantially compliant — production data accumulates indefinitely.**

The schema has no `deletedAt`, `archivedAt`, `purgedAt`, or `softDeletedAt` columns on any production entity (`packages/shared/prisma/schema.prisma`). Customers, accounts, premises, meters, service agreements, meter reads, service requests, payments, and audit rows all accumulate without time-based deletion.

**One exception:**

- **Scheduler-emitted audit rows** (`audit_log` rows where `source LIKE 'scheduler:%'`) are deleted by `sweepExpiredSchedulerAudits()` in `packages/api/src/services/audit-retention.service.ts:32-75`. Default retention: 365 days, configurable per tenant via `tenant_config.scheduler_audit_retention_days` (`packages/shared/prisma/schema.prisma:900`). User-emitted audits (`source LIKE 'user:%'` or NULL) are NOT touched by this sweep.

This single exception is the **only** active deletion in the system. Everything else lives forever today — which incidentally satisfies the RFP's "indefinite by default" commitment, but only because no policy mechanism exists to do anything else.

### 2.2 Archival of closed accounts ✗

**Status: Not implemented.**

`Account` has a `CLOSED` status and a `closedAt: DateTime?` column (`packages/shared/prisma/schema.prisma:323, 338`). When `workflows.service.moveOut()` closes an account, it sets `status = "CLOSED"` and populates `closedAt`. Nothing else happens. The row stays in the live `account` table indefinitely. Related entities (service agreements with `status = "FINAL"`, meter assignments, payment history) also stay in their hot tables.

There is no separate `account_archive` table. There is no S3 export. There is no flag tracking whether the closed account is in "warm" or "cold" storage. The customer graph view (`packages/api/src/services/customer-graph.service.ts`) treats closed accounts as ordinary nodes with `validTo` populated.

### 2.3 Archival of historical bills ✗

**Status: Not applicable yet — billing is Phase 3.**

There is no `Bill`, `Invoice`, or `BillingCycle` model in the current schema. SaaSLogic Billing is the proposed Phase 3 product (`docs/specs/21-saaslogic-billing.md`). Bill archival therefore can't fail today — there's no historical bill data to archive. This requirements doc must define the archival approach so SaaSLogic Billing ships with retention/archival baked in from day one rather than retrofitted later.

### 2.4 Cost-optimized storage ✗

**Status: Not implemented.**

There is no S3 client in the current codebase, no AWS SDK dependency, no Glacier or Standard-IA references, no lifecycle policy configuration anywhere in `packages/api/`, `packages/web/`, or any IaC files. Attachments are stored on the local filesystem at `../../uploads/` (per [04-attachments.md](./04-attachments.md) §2). No tiered storage, no cold storage, no archive bucket exists.

[04-attachments.md](./04-attachments.md) §4.8 designs the S3 lifecycle for attachment bytes (Standard → Standard-IA → Glacier IR → Glacier Deep Archive). That design is not yet implemented and applies only to attachment **content** — not to PostgreSQL rows.

### 2.5 Purge — no engine, no UI ✗

**Status: Not implemented.**

The codebase has zero "purge" code paths. There is no DELETE endpoint that hard-deletes a customer, an account, a meter, or a payment. There is no admin UI for "permanently remove this record." There is no GDPR/CCPA right-to-erasure path.

The only deletion that runs is the scheduler-audit retention sweep (§2.1). It is policy-driven (per-tenant `scheduler_audit_retention_days`), but:
- It deletes only one narrow row class (scheduler audits)
- It is not gated by operator action
- It does not produce a manifest
- It does not require approval
- It does not check legal holds

Hard DELETE on attachments via the API exists today (per [04-attachments.md](./04-attachments.md) §2) — that path is also unguarded by approval, manifest, or hold checks.

### 2.6 Dual approval — one narrow case ⚠

**Status: Partial — exists for ServiceSuspension only, not generalized.**

`ServiceSuspension` has `requestedBy: String?` and `approvedBy: String?` columns (`packages/shared/prisma/schema.prisma:943-944`), and `TenantConfig.requireHoldApproval` (`schema.prisma:884`) gates whether a second human must approve a suspension before it activates. This is the **only** entity in the schema with a dual-approval workflow today.

[01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.5 (FR-AUDIT-040..044) **proposes** generalizing this into a `pending_security_change` table for sensitive security-relevant operations (role edits, MFA changes, credential rotation). [04-attachments.md](./04-attachments.md) §4.8 FR-ATT-091 further generalizes that into a `pending_administrative_change` table for purge approvals. Both are **proposed, not built**.

### 2.7 Immutable manifest ✗

**Status: Not implemented — design proposed in docs 01 and 04.**

There is no `audit_merkle_root` table, no Ed25519 signing key in any KMS, no S3 bucket with object-lock compliance mode, no manifest-generation code anywhere in the codebase. [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.3 designs the daily Merkle hash chain. [04-attachments.md](./04-attachments.md) §4.8 FR-ATT-093 designs the per-purge manifest. Both rely on the same S3-object-lock infrastructure. None of it is built.

### 2.8 Statutory retention timers ✗

**Status: Not implemented — columns exist but enforce nothing.**

`Account.isProtected: Boolean @default(false)` and `Account.protectionReason: String?` exist on the schema (`schema.prisma:334-335`). They are read **nowhere** in the service layer. Search for `isProtected` across `packages/api/src/services/` returns zero hits. The columns are documentation, not policy.

[01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.6 proposes per-event-class minimum retention floors:

| Event class | Statutory floor | Source of constraint |
|---|---|---|
| `FINANCIAL` | 7 years (2,555 days) | IRS / state utility-commission record retention |
| `SECURITY` | 7 years | SOC 2, HIPAA-adjacent, state breach-notification laws |
| `OPERATIONAL` | 2 years (730 days) | Internal policy |
| `TECHNICAL` | 1 year (365 days) | Internal policy |

The `event_class` column doesn't exist on `audit_log` yet. No code enforces these floors.

### Summary of current state

| Guarantee | Today |
|---|---|
| Indefinite default retention | ✓ (incidentally — no deletion runs except scheduler audits) |
| Closed-account archival | ✗ |
| Historical-bill archival | N/A (billing is Phase 3) |
| Cost-optimized storage | ✗ |
| Searchable archive | ✗ |
| Reportable archive | ✗ |
| Purge engine | ✗ (only narrow scheduler-audit retention runs) |
| Policy configuration UI | ⚠ (only `scheduler_audit_retention_days` per tenant) |
| Dual approval | ⚠ (ServiceSuspension only) |
| Immutable purge manifest | ✗ |
| Statutory retention floor | ✗ (event_class column not added; protectionReason unused) |
| Legal-hold enforcement | ✗ |
| GDPR/CCPA right-to-erasure | ✗ |

---

## 3. Functional requirements

### 3.1 Indefinite default + retention class catalog

- **FR-RET-001** — Every entity in the production schema MUST be retained indefinitely unless a `retention_policy` row authorizes deletion. The system MUST NOT hard-delete production data based on time alone — only via an explicit policy plus all gates from §3.5–3.7 below.
  - **Acceptance:** Audit every model in `schema.prisma` and confirm no service code performs unconditional time-based DELETE. The scheduler-audit sweep continues to operate but is rewritten to consult the `retention_policy` table (FR-RET-010) instead of reading `tenant_config.scheduler_audit_retention_days` directly.

- **FR-RET-002** — A new `retention_class` enum classifies every retention-eligible row in the system into one of:

  | Class | Description | Default retention | Statutory floor (if any) |
  |---|---|---|---|
  | `FINANCIAL` | Bills, payments, adjustments, statements, tax docs | Indefinite | **7 years** (IRS; state UC retention) |
  | `AUDIT_FINANCIAL` | Audit rows tagged as financial-relevant | Indefinite | **7 years** |
  | `AUDIT_SECURITY` | Auth, role, MFA, credential, password-policy audits | Indefinite | **7 years** (SOC 2) |
  | `AUDIT_OPERATIONAL` | CSR actions, workflow audits | 2 years | None |
  | `AUDIT_TECHNICAL` | Scheduler emissions, system audits | 1 year | None |
  | `CUSTOMER_PII` | Customer rows, contact info, agreements after closure | Indefinite | State-specific (varies) |
  | `METER_READ` | MeterRead rows | 7 years | **5 years** (state UC) |
  | `NOTIFICATION_LOG` | Email/SMS/push delivery records | 2 years | None |
  | `SESSION` | Login sessions, refresh tokens | 90 days | None |
  | `ATTACHMENT_CONTENT` | File bytes (governed by [04-attachments.md](./04-attachments.md)) | Per category | Per category |
  | `OPERATIONAL_LOG` | Background job state, queue metadata | 90 days | None |

  Class is intrinsic to each row type (set by the code that emits the row). It cannot be overridden by tenant configuration. Tenant configuration sets the **retention period** within a class, **bounded below** by the statutory floor.

- **FR-RET-003** — Every service that emits a row destined for retention MUST tag the row with its class. For new tables this is a NOT NULL column (`retention_class retention_class NOT NULL`). For existing tables (`audit_log`, `meter_read`, `customer`, `account`, etc.) a backfill migration sets the class based on the row's existing source.
  - **Acceptance:** A grep for every `prisma.X.create()` in the codebase finds at least one of: (a) explicit `retention_class` field set, (b) class injected at the service layer, or (c) the table doesn't participate in retention (e.g., `tenant_config`).

### 3.2 Retention policy table

- **FR-RET-010** — A new `retention_policy` table:

  ```prisma
  model RetentionPolicy {
    id                       String          @id @default(uuid()) @db.Uuid
    utilityId                String          @map("utility_id") @db.Uuid
    retentionClass           RetentionClass  @map("retention_class")
    documentCategory         String?         @map("document_category") @db.VarChar(64)  // null = all categories within the class
    retentionDays            Int             @map("retention_days")
    archiveAfterDays         Int?            @map("archive_after_days")  // null = never archive (live → purge directly)
    requireDualApproval      Boolean         @default(true) @map("require_dual_approval")
    statutoryFloorDays       Int             @map("statutory_floor_days")  // hard minimum, cannot be reduced via UI
    legalHoldOverride        Boolean         @default(false) @map("legal_hold_override")  // true = legal hold blocks even archive
    enabled                  Boolean         @default(false) @map("enabled")  // policies are dormant by default
    notes                    String?         @db.Text
    createdAt                DateTime        @default(now()) @map("created_at") @db.Timestamptz
    createdBy                String          @map("created_by") @db.Uuid
    lastApprovedAt           DateTime?       @map("last_approved_at") @db.Timestamptz
    lastApprovedBy           String?         @map("last_approved_by") @db.Uuid

    @@unique([utilityId, retentionClass, documentCategory])
    @@map("retention_policy")
  }
  ```

  Effort estimate: S (~3 days for schema + migrations + RLS).

- **FR-RET-011** — `enabled = false` is the default. A retention policy must be **explicitly turned on** by an operator after configuration. This is a defense-in-depth measure — no policy can autonomously start purging on first deploy. (See §3.7 — turning on a policy with `enabled = true` is itself a dual-approval operation.)

- **FR-RET-012** — `statutoryFloorDays` is set by **product**, not by tenants. The schema-migration code reads from a const map (`STATUTORY_FLOORS` in `packages/shared/src/retention/constants.ts`) and writes the value to each policy row at create time. Any UI attempt to set `retentionDays < statutoryFloorDays` MUST fail validation with an actionable error citing the floor source. Tenants can extend retention beyond the floor; they cannot reduce below it.
  - **Acceptance:** Attempting to set `FINANCIAL` retention to 1,000 days (under the 2,555-day floor) returns 422 with message: *"Cannot reduce FINANCIAL retention below 2,555 days. This is the IRS / state utility-commission statutory minimum. To request a regulatory exception, contact SaaSLogic support."*

- **FR-RET-013** — `documentCategory` is null by default (policy applies to all rows of that class for the tenant). Setting a non-null category lets a tenant differentiate, e.g., `FINANCIAL + "tax_doc"` retained 10 years vs. `FINANCIAL + "monthly_bill"` retained 7 years. The retention engine resolves: most-specific category wins, falls back to category-null, falls back to product default.

- **FR-RET-014** — Every change to a `retention_policy` row (INSERT, UPDATE, DELETE) emits an audit row of class `AUDIT_SECURITY` with `before_state` + `after_state`. The audit trail is immutable per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md).

### 3.3 Archival pipeline — cost-tiered storage

The RFP commitment is "archival policies can move closed accounts and historical bills to cost-optimized storage." Two distinct mechanics apply, depending on what is being archived:

- **Attachment bytes** (already governed by [04-attachments.md](./04-attachments.md) §4.8) → S3 lifecycle transitions Standard → IA → Glacier IR → Glacier Deep Archive.
- **PostgreSQL rows** (closed accounts, historical bills, old meter reads, old audit rows) → table partitioning + Parquet export to S3 with searchable metadata kept in hot Postgres.

This section addresses the second case. Doc 04 covers the first.

#### 3.3.1 Postgres-row archival

- **FR-RET-020** — High-volume time-series tables (`meter_read`, `audit_log`, `notification_log`, eventually `payment` and `bill`) MUST use **declarative range partitioning** by `created_at` (monthly granularity). A partition manager job (added to the worker process per [the scheduler design](../specs/14-service-requests.md)) creates next month's partition on the 25th of each month and runs `VACUUM ANALYZE` on month-old partitions.
  - **Why partitioning:** Detaching a partition is O(1). Dropping a partition reclaims space without `VACUUM FULL`. Postgres's planner prunes partitions for time-range queries automatically, so reportability stays cheap.
  - **Acceptance:** `meter_read` is range-partitioned by `created_at` monthly. Inserting a row with `created_at = '2027-03-15'` lands in the `meter_read_y2027m03` partition. Querying `WHERE created_at >= '2027-03-01' AND created_at < '2027-04-01'` shows only that partition in `EXPLAIN`.

- **FR-RET-021** — When a partition crosses its policy's `archiveAfterDays` boundary AND no row in it has an active legal hold (FR-RET-070), the archival worker:
  1. Locks the partition (`ALTER TABLE ... DETACH PARTITION CONCURRENTLY`).
  2. Exports it as **Parquet** to `s3://saaslogic-archive-{tenant}/{table}/y{year}m{month}.parquet` with KMS-encryption at rest (CMK per tenant).
  3. Computes SHA-256 of the Parquet object and stores it in `archive_manifest` (FR-RET-024).
  4. Writes a row to `archive_partition_index` (table, partition name, year-month, S3 key, row count, size, first/last `created_at`, archived-at timestamp).
  5. Drops the local partition.
  6. Emits an audit row of class `AUDIT_OPERATIONAL` with the manifest reference.

  The Parquet schema is the table's column list **plus** `_archive_metadata` (object key, manifest signature). Dropping the local partition reclaims hot-storage cost; the Parquet object is one tier cheaper (Standard) and lifecycle-transitions further over time (FR-RET-022).
  - **Acceptance:** Run the archival worker against a test tenant with a fully-aged partition; verify the partition is detached, the Parquet object exists in S3 with valid KMS encryption headers, the SHA-256 matches, the index row exists, and the local partition is gone. Re-running the worker is a no-op.
  - **Acceptance (failure handling):** If the S3 PUT fails, the partition is NOT detached. The worker must perform the export-then-detach as a saga: stage Parquet to S3, verify checksum, only then `DETACH PARTITION` and `DROP TABLE`. A worker crash mid-saga must leave the partition attached.

- **FR-RET-022** — Archive S3 objects MUST be subject to lifecycle transitions:
  - Days 0-90 after archive: S3 Standard
  - Days 90-365: S3 Standard-IA
  - Days 365-730: S3 Glacier Instant Retrieval (still <1s reads)
  - Days 730+ to retention end: S3 Glacier Deep Archive (12-hour restore latency)
  - At retention end + dual-approved purge: object is deleted (FR-RET-040+).

- **FR-RET-023** — Closed accounts and their dependent rows (service agreements, meter assignments, payment history) follow a **different** archival rule than time-partitioned tables. Reason: an account is one row, not a partition. Approach:
  1. Apply only after `closedAt` is N years in the past (default 7 for `FINANCIAL` class — most state UC regs require keeping the account record while the financial trail is required).
  2. Worker exports the full account graph (account row + agreements + assignments + adjustments + custom-field values) to a single Parquet file in `s3://saaslogic-archive-{tenant}/account/{accountId}.parquet`.
  3. Updates a new `account.archive_status` column (`LIVE | ARCHIVING | ARCHIVED | RESTORED`) and `account.archive_s3_key`.
  4. Removes the dependent rows from their hot tables (cascading via `onDelete: Cascade` on the FKs).
  5. Keeps the `account` row itself in the hot table — but flagged `ARCHIVED` and stripped of its dependents — so search/reports continue to find the account record without rehydrating the graph.

  **Why keep the parent row:** Cheaper than rebuilding a slim `account_index` table, and CSR search latency stays unchanged. The archived account row still appears in customer-graph queries with `archived_status: "ARCHIVED"` — see FR-RET-031.

#### 3.3.2 Searchability post-archive

- **FR-RET-030** — All entity-level search and listing endpoints MUST function correctly regardless of archive status. For partition-archived tables, the metadata that the search index reads (`customer_id`, `account_id`, `meter_id`, `created_at`, `amount`) MUST stay in hot Postgres. For partitioned tables this is trivially true since all rows that haven't been archived are still in hot tables. For archived account graphs (FR-RET-023), the parent `account` row stays hot with archive flags.

- **FR-RET-031** — Search responses MUST include the archive status as a structured field (e.g., `{ id, name, status: "CLOSED", archive_status: "ARCHIVED" }`) so the UI can render an "archived" badge. Operators clicking an archived record see a slim view with the option to "Restore for review" (FR-RET-032).

- **FR-RET-032** — A `restore` operation rehydrates an archived row's full graph from Parquet back into hot Postgres. Restore is rate-limited (≤10 concurrent restores per tenant), audited, and time-boxed (the restored data is auto-re-archived after 30 days unless explicitly retained). Glacier Deep Archive restores have a 12-hour window — the worker queues the S3 restore request and notifies the requester on completion. UI shows progress.
  - **Acceptance:** Click "Restore" on an archived account → see a "Restoring (estimated 12h)" banner → receive an in-portal notification when restore completes → see the full graph as it existed at archive time.

#### 3.3.3 Reportability post-archive

- **FR-RET-035** — All reports defined in the reporting module ([06-custom-fields.md](./06-custom-fields.md) §4.5 Phase 3) and the ad-hoc query builder MUST be able to query data that spans live + archived. Two execution paths:
  1. **Hot-only queries** — default; faster; queries hit only attached partitions.
  2. **Hot+archive queries** — operator opts in via a "Include archived data" checkbox. The query builder transpiles to a federated query: hot Postgres for live data, AWS Athena (or DuckDB-via-S3) over the Parquet objects for archived data, results UNION-ed and sorted.

- **FR-RET-036** — Hot+archive queries are rate-limited (≤5 concurrent per tenant) and surface estimated runtime + cost (rough Athena scan estimate) before execution. Operators must confirm before a Glacier-Deep-Archive-touching query runs (because Glacier IR/Deep Archive restore costs apply).

- **FR-RET-037** — Reports that statutorily must scan the full history (e.g., 7-year financial audit) MUST be re-runnable against archived data without restoring it to hot Postgres. The Athena/DuckDB path is the canonical mechanism.

### 3.4 Purge engine — policy-gated, dual-approved, manifested

#### 3.4.1 Purge sources

The system runs purge in three modes:

1. **Retention-driven purge** — automatic, evaluated nightly. A row passes purge eligibility when: (a) its retention policy is `enabled = true`, (b) its age exceeds `retentionDays`, (c) no legal hold is set, (d) the row's class statutory floor has elapsed.
2. **Operator-requested purge** — UI-initiated. A tenant admin selects a record (or batch matching a filter) and requests purge. Subject to all the same gates as retention-driven, plus dual approval (FR-RET-051).
3. **Subject-requested purge (GDPR/CCPA)** — privacy regulation right-to-erasure. Routes through a separate intake flow (FR-RET-095) but ultimately uses the same purge primitives.

#### 3.4.2 Purge execution

- **FR-RET-040** — A daily purge worker (added to the BullMQ scheduler from [job-scheduler-migration](../specs/14-service-requests.md)) selects rows eligible for purge per FR-RET-040.1 below. For each eligible row:
  1. Re-checks legal hold (race-tolerant — hold may have been added since the row was selected).
  2. Re-checks statutory floor (defensive — the floor for the row's class cannot have moved, but the check is cheap).
  3. If both pass: deletes the row from Postgres OR from the Parquet archive (depending on where the row lives) inside a transaction. Emits a manifest entry per FR-RET-060.
  4. If either fails: skips the row, logs the skip, increments a Prometheus counter, and re-queues for next day.

- **FR-RET-040.1** — Eligibility query (single SQL with joins, evaluated per tenant per day):

  ```sql
  -- Pseudocode shape; concrete SQL per partition table
  SELECT row_id
  FROM <table> r
  JOIN retention_policy rp
    ON rp.utility_id = r.utility_id
   AND rp.retention_class = r.retention_class
   AND (rp.document_category IS NULL OR rp.document_category = r.document_category)
   AND rp.enabled = true
  LEFT JOIN legal_hold lh
    ON lh.utility_id = r.utility_id
   AND lh.entity_type = '<table>'
   AND lh.entity_id = r.id
   AND lh.released_at IS NULL
  WHERE r.created_at < now() - (rp.retention_days || ' days')::interval
    AND r.created_at < now() - (rp.statutory_floor_days || ' days')::interval
    AND lh.id IS NULL
  ```

  Statutory floor is checked **independently** of `retention_days` — they may differ (an aggressive policy could try to set retention > floor by accident; the floor still applies if it's older).

- **FR-RET-041** — Purge runs MUST be transactional per row OR per batch (configurable, default per-batch with batch size 1000). A worker crash mid-run leaves partial purges visible — this is fine because (a) every purged row has its manifest entry already committed to the manifest table before the actual delete (write-ahead pattern), and (b) the worker resumes from where it left off because un-purged rows still match the eligibility query.

- **FR-RET-042** — Operator-requested purge (mode 2) writes a `pending_administrative_change` row with `operationType = "purge_records"` and the eligibility filter (saved as JSON). The purge does NOT execute until two approvals land (FR-RET-051). The retention worker reads `pending_administrative_change` rows in `status = "approved"` and proceeds with purge using the saved filter.

#### 3.4.3 Dual approval

- **FR-RET-050** — Generalize the `pending_security_change` table from [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.5 into `pending_administrative_change` (the rename is per [04-attachments.md](./04-attachments.md) §4.8 FR-ATT-091). Schema:

  ```prisma
  model PendingAdministrativeChange {
    id                  String                @id @default(uuid()) @db.Uuid
    utilityId           String                @map("utility_id") @db.Uuid
    operationType       String                @map("operation_type") @db.VarChar(64)  // "purge_records" | "purge_attachment" | "edit_role" | "rotate_credential" | "enable_retention_policy" | ...
    targetEntity        String?               @map("target_entity") @db.VarChar(64)
    targetId            String?               @map("target_id")  // string, not UUID — could reference a non-UUID
    proposedState       Json                  @map("proposed_state")
    requestedBy         String                @map("requested_by") @db.Uuid
    requestedAt         DateTime              @default(now()) @map("requested_at") @db.Timestamptz
    expiresAt           DateTime              @map("expires_at") @db.Timestamptz
    requiredApprovers   Int                   @default(2) @map("required_approvers")
    approvals           Json                  @default("[]") @map("approvals")  // [{ approverId, approvedAt, ip, userAgent }]
    status              ChangeStatus          @default(PENDING)
    rejectionReason     String?               @db.Text
    executedAt          DateTime?             @map("executed_at") @db.Timestamptz
    @@index([utilityId, status, expiresAt])
    @@map("pending_administrative_change")
  }

  enum ChangeStatus {
    PENDING
    APPROVED
    REJECTED
    EXPIRED
    EXECUTED
  }
  ```

- **FR-RET-051** — A purge proposal with `requireDualApproval = true` (per the policy or the operator-requested path):
  - MUST require approvals from **two distinct human admins** (system actors don't count).
  - MUST reject self-approval (the requester cannot approve their own request — checked by `approverId != requestedBy`).
  - MUST expire after 30 days if not approved (TTL via `expiresAt`). Expired requests are visible in the UI but cannot be re-activated; a new request must be filed.
  - MUST record approval IP and user-agent for audit (immutable once set).

- **FR-RET-052** — Approvers MUST have the `retention.approve_purge` permission. This permission is separate from `retention.request_purge` so that the same person cannot do both (approval policy enforced at the permission level, not just at the runtime check).

- **FR-RET-053** — When the second approval lands, the system transitions the row to `APPROVED` and the purge worker picks it up on its next tick. No purge runs synchronously with approval — this ensures the audit trail captures the full lifecycle (request → approval → execute) as separate events.

- **FR-RET-054** — Bulk purge: when a purge proposal targets N records (e.g., "all closed accounts older than 8 years"), the proposal stores the **filter**, not the N IDs. At execute time, the worker re-runs the filter to get the current matching set. This handles two race conditions: rows added since approval (the spec is clear: "all matching at execute time") and rows protected since approval (legal hold added between request and execute will exclude them). The manifest itemizes the actual N rows purged.

#### 3.4.4 Immutable manifest

- **FR-RET-060** — Every purge run (whether retention-driven or operator-requested) produces a **purge manifest** stored in the same S3 object-lock-compliance-mode bucket as the audit Merkle roots ([01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.3). Schema of a manifest:

  ```json
  {
    "manifestVersion": "1",
    "tenantId": "...",
    "runId": "...",
    "runStartedAt": "2027-04-26T03:00:00Z",
    "runCompletedAt": "2027-04-26T03:14:17Z",
    "purgeMode": "retention_driven" | "operator_requested" | "subject_requested",
    "policySnapshot": { /* full retention_policy row at run time */ },
    "approvals": [ /* if operator/subject mode: list of approverId/timestamps */ ],
    "purgedItems": [
      {
        "entityType": "meter_read",
        "entityId": "...",
        "createdAt": "2020-01-15T...",
        "rowSha256": "<hash of pre-purge row content>",
        "retentionClass": "METER_READ",
        "purgedFrom": "hot" | "archive"
      },
      ...
    ],
    "totalCount": 12453,
    "previousManifestSha256": "<hash of prior manifest, forming a chain>",
    "manifestSha256": "<hash of this manifest excluding the signature field>",
    "signature": "<Ed25519 signature over manifestSha256, KMS-managed key>"
  }
  ```

- **FR-RET-061** — The manifest's `previousManifestSha256` chains every manifest to its predecessor. Combined with object-lock compliance mode (no deletion before retention period), this means: an attacker who compromises the system **cannot** retroactively hide a purge — the chain breaks visibly.

- **FR-RET-062** — A separate `purge_manifest_index` table keeps `(manifestId, manifestSha256, s3Key, signedAt, runId, totalCount)` for fast operator queries ("show me all purge runs in 2027"). Hot table, immutable, append-only via the same triggers as `audit_log`.

- **FR-RET-063** — A standalone CLI verification utility (`saaslogic-verify-purge-chain`) reads all manifests from the S3 bucket, walks the chain backwards, validates every signature, and reports any breaks. Auditors run this against the bucket directly with read-only credentials. The utility does NOT depend on the application database — it verifies from S3 alone.
  - **Acceptance:** Run the utility against a 1-year archive of purge manifests; verify every signature; report PASS. Manually edit one manifest in the bucket (via privileged AWS access for the test) and re-run; report FAIL with the broken-chain manifest ID.

### 3.5 Statutory retention floors

- **FR-RET-070** — `RetentionClass` rows specify `statutoryFloorDays` set by product code (FR-RET-002 table). The retention engine MUST enforce: `effective_retention = MAX(policy.retention_days, class.statutory_floor_days)`. A policy whose `retention_days < statutory_floor_days` is invalid input — UI rejects it.

- **FR-RET-071** — Statutory floors per class are **encoded in code**, not in the database, because tenants cannot edit them and they should change only via product release. They live in `packages/shared/src/retention/floors.ts`:

  ```typescript
  export const STATUTORY_FLOORS_DAYS: Record<RetentionClass, number> = {
    FINANCIAL: 2555,         // 7 years (IRS, state UC)
    AUDIT_FINANCIAL: 2555,   // 7 years
    AUDIT_SECURITY: 2555,    // 7 years (SOC 2)
    AUDIT_OPERATIONAL: 730,  // 2 years
    AUDIT_TECHNICAL: 365,    // 1 year
    CUSTOMER_PII: 0,         // no floor — GDPR/CCPA may shorten
    METER_READ: 1825,        // 5 years (state UC retention varies; 5y conservative)
    NOTIFICATION_LOG: 0,     // no floor
    SESSION: 0,              // no floor
    ATTACHMENT_CONTENT: 0,   // governed per-category in retention_policy
    OPERATIONAL_LOG: 0,      // no floor
  };
  ```

  Changes to this file are reviewed by the product owner + legal counsel before merge (process, not technical).

- **FR-RET-072** — A `legal_hold` table:

  ```prisma
  model LegalHold {
    id           String    @id @default(uuid()) @db.Uuid
    utilityId    String    @map("utility_id") @db.Uuid
    entityType   String    @map("entity_type") @db.VarChar(64)  // "account" | "customer" | "meter_read" | "audit_log" | ...
    entityId     String    @map("entity_id") @db.VarChar(128)   // string to allow non-UUID entity types
    reason       String    @db.Text
    placedBy     String    @map("placed_by") @db.Uuid
    placedAt     DateTime  @default(now()) @map("placed_at") @db.Timestamptz
    releasedAt   DateTime? @map("released_at") @db.Timestamptz
    releasedBy   String?   @map("released_by") @db.Uuid

    @@index([utilityId, entityType, entityId, releasedAt])
    @@map("legal_hold")
  }
  ```

  Placing a hold is a single-approval operation (FR-RET-073). Releasing a hold is a **dual-approval** operation, because release re-exposes the row to retention-driven purge.

- **FR-RET-073** — When any retention-driven or operator-requested purge evaluates a row, it MUST query `legal_hold` for an active hold (`released_at IS NULL`). If found, the row is excluded from purge. Audit row is emitted of class `AUDIT_OPERATIONAL` recording the skip with hold reference.

- **FR-RET-074** — The `Account.isProtected` and `Account.protectionReason` columns (which exist today, never enforced) are deprecated in favor of `legal_hold` rows. A migration moves any existing protected accounts into `legal_hold` rows and drops the columns from `Account` in the next major schema version.

- **FR-RET-075** — The "audit log" itself is subject to retention via class `AUDIT_FINANCIAL` / `AUDIT_SECURITY` / `AUDIT_OPERATIONAL` / `AUDIT_TECHNICAL`. The current scheduler-audit retention sweep continues to run, but reads `retention_policy` for `AUDIT_TECHNICAL` instead of the legacy `tenant_config.scheduler_audit_retention_days` column. The legacy column is deprecated and removed in the migration that introduces `retention_policy`.

### 3.6 GDPR/CCPA right-to-erasure

- **FR-RET-080** — Subjects (customers, portal users) MUST be able to request erasure of their PII via the portal. The request creates a `pending_administrative_change` row with `operationType = "subject_erasure"` and `targetEntity = "customer"`, `targetId = <customer_id>`.

- **FR-RET-081** — The erasure proposal:
  - MUST require dual-admin approval per FR-RET-051.
  - MUST be **rejected** if the customer has financial obligations active (open accounts, unpaid balances, undisbursed deposits).
  - MUST be **partial-only** if statutory financial-record retention applies — a customer who has had bills in the past 7 years cannot have their billing-related records erased; only their portal account, contact preferences, communication logs, and supplementary PII can be removed. The remaining financial records have the customer's name replaced with `"<erased subject {date}>"` but the financial trail stays intact for audit.
  - MUST produce a manifest per FR-RET-060 with `purgeMode = "subject_requested"` and the customer ID in `targetEntity`.
  - MUST notify the subject when complete, with a summary of what was/wasn't erased and why (statutory retention citation).

- **FR-RET-082** — A `data_subject_request` table tracks the lifecycle (request received, dual-approval pending, executed, partially executed, rejected) and is exposed to subjects in the portal as their request history.

### 3.7 Operator UI — Settings → Retention

A new admin page at `/settings/retention` with tabs:

#### 3.7.1 Policies tab

- **FR-RET-090** — Matrix view of `(retentionClass, documentCategory)` cells. Each cell shows: current retentionDays, statutoryFloorDays (read-only), enabled state, lastApprovedAt + approver name. Clicking a cell opens an edit dialog that submits as a `pending_administrative_change` of type `enable_retention_policy` (or `update_retention_policy`).

- **FR-RET-091** — Cells colored by status:
  - Gray = no policy defined (data retained indefinitely)
  - Green = policy enabled
  - Yellow = policy proposed (pending approval)
  - Red = policy enabled but `retentionDays = statutoryFloorDays` (the most aggressive state — flag for awareness)

#### 3.7.2 Holds tab

- **FR-RET-092** — Tabular list of active legal holds. Add Hold button (single approval, role-gated). Release Hold button (dual approval). Filter by entity type, placed-by, age.

#### 3.7.3 Pending changes tab

- **FR-RET-093** — Lists all `pending_administrative_change` rows for the tenant with status PENDING. Each row shows: operation type, requested-by, requested-at, expires-at, current approval count (e.g., "1 of 2"). Approve / Reject buttons. Approving requires re-authentication (per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) sensitive-action policy).

#### 3.7.4 Run history tab

- **FR-RET-094** — Read-only listing of past purge runs: run ID, mode, started-at, completed-at, total purged, manifest S3 key (link). Clicking a row shows the manifest's `purgedItems` summary (NOT the full IDs — that would be a privacy regression — only counts by entityType + dateRange).

#### 3.7.5 What-will-be-purged preview

- **FR-RET-095** — Before any operator-requested purge, the UI MUST run a dry-run query that returns the count + sample of N=20 rows that would be affected. Operators confirm against the preview before submitting the proposal. Proposals submitted with stale previews (more than 24h old when approved) trigger a re-confirmation step.

### 3.8 Non-functional requirements

- **NFR-RET-001** — Retention worker time budget: ≤30 minutes per nightly run. Time-bounded loop with resume-from-where-stopped (the eligibility query naturally re-selects un-purged rows).

- **NFR-RET-002** — Archive Parquet writes use multipart upload with checksum verification. A failed upload does not detach the partition.

- **NFR-RET-003** — Athena/DuckDB query latency for archived data: ≤30s for typical 1-month-window queries. Operators see an estimate before running.

- **NFR-RET-004** — Purge manifest S3 PUT latency: ≤2s p99. Manifest is signed in-process (Ed25519 is fast); KMS sign latency is the dominant cost (~50-200ms).

- **NFR-RET-005** — Restore from Glacier Deep Archive: 12h p99 (governed by AWS, not us). Standard-IA restore: ≤5s. Operators see realistic ETAs.

- **NFR-RET-006** — Storage cost target: archived rows in Glacier Deep Archive cost ≤1% of equivalent hot Postgres storage. (As a sanity check for the RFP cost-of-ownership story; not a contractual obligation.)

- **NFR-RET-007** — RLS continues to apply to `retention_policy`, `legal_hold`, `pending_administrative_change`, `purge_manifest_index`, `archive_partition_index`, `data_subject_request`. Cross-tenant queries from the worker bypass RLS via the same pattern as the existing scheduler workers (single transactional query, app.current_utility_id reset per tenant).

---

## 4. Data model changes

### 4.1 New tables

| Table | Purpose | Section |
|---|---|---|
| `retention_policy` | Per-tenant retention configuration | 3.2 |
| `legal_hold` | Active holds blocking purge | 3.5 |
| `pending_administrative_change` | Generalized dual-approval queue (replaces `pending_security_change` from doc 01) | 3.4.3 |
| `archive_partition_index` | Tracks partitioned-table archives | 3.3.1 |
| `purge_manifest_index` | Tracks purge run manifests (S3 keys + hashes) | 3.4.4 |
| `data_subject_request` | GDPR/CCPA subject erasure lifecycle | 3.6 |

### 4.2 New enums

```prisma
enum RetentionClass {
  FINANCIAL
  AUDIT_FINANCIAL
  AUDIT_SECURITY
  AUDIT_OPERATIONAL
  AUDIT_TECHNICAL
  CUSTOMER_PII
  METER_READ
  NOTIFICATION_LOG
  SESSION
  ATTACHMENT_CONTENT
  OPERATIONAL_LOG
}

enum ArchiveStatus {
  LIVE
  ARCHIVING
  ARCHIVED
  RESTORING
  RESTORED
}

enum ChangeStatus {
  PENDING
  APPROVED
  REJECTED
  EXPIRED
  EXECUTED
}
```

### 4.3 New columns on existing tables

| Table | Column | Type | Notes |
|---|---|---|---|
| `audit_log` | `event_class` | `RetentionClass` (NOT NULL after backfill) | Backfilled per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.4 FR-AUDIT-032 |
| `audit_log` | `is_protected` | `Boolean @default(false)` | Set when row is part of an active legal hold (denormalized for query speed) |
| `account` | `archive_status` | `ArchiveStatus @default(LIVE)` | Tracks closed-account archive lifecycle |
| `account` | `archive_s3_key` | `String?` | Set when ARCHIVED |
| `account` | `archived_at` | `DateTime?` | Set when transition to ARCHIVED |
| `meter_read` | partitioning | declarative range by `created_at` | Migration restructures table with `PARTITION BY RANGE` |
| `notification_log` | partitioning | declarative range by `created_at` | New table with partitioning at create time |
| `audit_log` | partitioning | declarative range by `created_at` | Migration restructures table with `PARTITION BY RANGE` |

### 4.4 Removed/deprecated columns

| Table | Column | Reason |
|---|---|---|
| `account` | `is_protected` | Replaced by `legal_hold` rows (FR-RET-074) |
| `account` | `protection_reason` | Replaced by `legal_hold.reason` |
| `tenant_config` | `scheduler_audit_retention_days` | Replaced by `retention_policy` row with class `AUDIT_TECHNICAL` (FR-RET-075) |

### 4.5 RLS updates

All new tables get tenant RLS via `utilityId`:

```sql
ALTER TABLE retention_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON retention_policy
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
-- repeat for legal_hold, pending_administrative_change, archive_partition_index, ...
```

The retention/archive/purge workers run with `app.current_utility_id` set per tenant in a loop (same pattern as the existing scheduler workers).

---

## 5. Implementation sequence

### Phase 1 — Foundation (~3 weeks)

1. **`retention_class` enum + audit_log column + backfill** (~3 days). Adds the column, classifies all existing audit emit sites in code, runs a backfill migration that infers the class from `audit_log.source` patterns. Removes the `tenant_config.scheduler_audit_retention_days` column at the end (replaced by retention_policy).
2. **`retention_policy` table + UI** (~1 week). Schema, migrations, RLS, Settings → Retention → Policies tab in `/settings/retention`. No purge yet — just the policy registry. Statutory floors are enforced at validation time.
3. **`legal_hold` table + Holds tab** (~3 days). Schema, RLS, place/release flows. Migration moves existing `Account.isProtected` into `legal_hold` rows; deprecates the column.
4. **`pending_administrative_change` generalization** (~3 days). Renames or replaces `pending_security_change` (from doc 01) with the more general form. All consumers (purge requests, retention policy enable, security changes, etc.) reuse the same table.

### Phase 2 — Archival (~5 weeks)

5. **Partitioning migration for `meter_read`, `audit_log`, `notification_log`** (~1 week). Restructures these tables with declarative range partitioning. Includes the partition manager job (creates next-month partition; vacuums month-old).
6. **Archive worker for time-partitioned tables** (~1 week). Detach + Parquet export + S3 upload + index row + drop partition. Saga-safe ordering (export-then-detach).
7. **Archive worker for closed accounts** (~1 week). The non-partitioned mechanism per FR-RET-023 — exports the full account graph to a single Parquet file; flags the account row as ARCHIVED; cascades dependent-row removal.
8. **Athena/DuckDB integration for archived-data queries** (~1 week). Federated query path for the reporting module + ad-hoc query builder.
9. **Restore workflow** (~3 days). UI flow + worker that requests Glacier restore + rehydrates Parquet into hot Postgres + auto-re-archive after 30 days.

### Phase 3 — Purge (~3 weeks)

10. **Purge worker** (~1 week). Daily eligibility query + per-row purge with race-tolerant re-checks of legal hold and statutory floor.
11. **Purge manifest writer + S3 object-lock bucket** (~3 days). Manifest schema, signing (reuses Ed25519 KMS key from doc 01 §3.3 if already in place; otherwise provisions a separate manifest-signing key), S3 PUT, manifest chain.
12. **Verification CLI** (`saaslogic-verify-purge-chain`) (~3 days). Standalone Node.js script; reads from S3 directly; validates signatures and chain.
13. **Operator-requested purge UI + dry-run preview** (~1 week). The `/settings/retention` workflow with filter editor, count-and-sample preview, proposal submit, two-approver flow.

### Phase 4 — GDPR/CCPA & polish (~2 weeks)

14. **Subject erasure flow** (~1 week). Portal endpoint, partial-erasure logic for financial-retention conflicts, name-redaction strategy on retained financial records.
15. **Pending changes tab + run history tab + audit-log retention reconciliation** (~1 week). Operator tooling for visibility; reconcile the existing scheduler-audit sweep with the new policy-driven path.

**Total: ~13 weeks** with one engineer, ~8 weeks with two parallel tracks (Phase 2 archival can run alongside Phase 1 foundation; Phase 3 purge depends on both).

---

## 6. Out of scope (Phase 5+)

The following are deliberately not committed in this RFP response:

1. **Real-time data residency controls** — the RFP doesn't mention residency. We commit to single-region storage (configurable per-tenant in IaC, but not via UI). Multi-region replication for archive objects is a Phase 5 capability.
2. **Cross-tenant archives** — every tenant gets its own S3 prefix (`s3://saaslogic-archive-{tenantId}/`). No shared archive bucket; no cross-tenant queries.
3. **PostgreSQL row-level encryption beyond TLS + KMS at rest** — the schema does not encrypt individual columns at the application layer. Sensitive fields (SSN, payment methods) rely on the existing KMS-encrypted database storage. Application-level field encryption is Phase 5.
4. **Real-time auditor portal** — auditors validate archives/manifests via the verification CLI (FR-RET-063), not via a live UI. A read-only auditor web portal is Phase 5.
5. **Automated regulator export** — annual financial-record exports for the state utility commission are operator-driven (export the tenant's archive bucket); no scheduled-export-to-regulator pipeline.
6. **Backup distinct from archive** — daily database backups (operational disaster recovery) are infrastructure, not application-level. The 30-day point-in-time-recovery window from RDS / managed Postgres covers operational recovery. Archive is a different lifecycle stage with different access patterns.
7. **Attachment-bytes archival mechanics** — already governed by [04-attachments.md](./04-attachments.md) §4.8. This doc references but does not duplicate.
8. **Audit Merkle hash chains** — already governed by [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.3. Purge manifests use the same S3 object-lock infrastructure but are a separate signed-document type.
9. **Live data-subject self-service erasure UI** — Phase 4.x deliverable (subject submits request via the portal). Custom intake forms (specific to a tenant's privacy policy) are out of scope.
10. **Row-level "redact" without delete** — this doc commits to delete-and-replace-with-tombstone for partial subject erasure. A more sophisticated redaction-only mode (mask in place, retain row) is Phase 5.

---

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Statutory floors are jurisdiction-specific; what's right in Montana may not apply elsewhere | High | Floors in code are a conservative product default. Per-tenant overrides are NOT supported (tenants extend, not reduce) but the product can ship a state-specific floor file in Phase 5. For Bozeman specifically, Montana state UC retention is documented in the proposal appendix — engineering reviews at every release. |
| Archive Parquet schema drift breaks Athena queries on old partitions | Medium | Parquet files include the schema in their footer. The Athena table definition versions the schema. Adding columns to a table forward-only is supported (Parquet handles missing columns as NULL); removing columns requires a fan-out re-archive (rare). |
| Purge worker bug deletes rows that should have been protected | High | (a) Eligibility query is single SQL, reviewed and tested. (b) Legal hold + statutory floor both checked at execute time, not just request time. (c) Purge runs in dry-run mode for the first 7 days post-deploy in every tenant — surfaces what *would* be purged before any actual delete. (d) Manifest-write-before-delete pattern means even an over-aggressive purge is fully reconstructible from S3 (you know what was deleted; you can restore from backup). |
| Restore from Glacier Deep Archive blows the 12-hour SLA | Medium | This is an AWS limitation, not ours. UI surfaces realistic ETAs. Tenants that need faster restores opt into Glacier IR (more expensive); those that need real-time access stay in Standard-IA (most expensive of the cheap tiers). |
| Two-person approval is bypassed via direct DB access | High | Audit-log immutability triggers ([01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.1) prevent the `pending_administrative_change` row from being mutated post-creation. Manifest signature-chain (FR-RET-061) detects retroactive deletions. Database access is itself audited at the connection level via Apptorflow Auth (separate from app-level audit). Defense in depth: no single-control reliance. |
| Tenant accidentally enables an aggressive retention policy and loses data | High | (a) Enabling a policy is a dual-approval operation. (b) Statutory floors prevent below-floor reductions. (c) First 7-day dry-run mode (above) surfaces what would be purged. (d) Manifest preserves full row content (rowSha256 plus full row body in the deletedItems list, content-addressable in S3) — accidental purge can be reversed by restoring from manifest. (e) Customer support runbook for "undo last purge" exists and is exercised quarterly. |
| Subject erasure conflicts with financial retention; subject is dissatisfied | Medium | Partial-erasure with name-redaction is the documented mechanism. The subject sees a clear citation of which records were retained and why. Customer support is trained to walk through the response. |
| Archive S3 bucket lifecycle misconfiguration sends data to Glacier prematurely | High | IaC-defined lifecycle (Terraform/CloudFormation) is reviewed and version-controlled. Test tenants run with accelerated timing for QA. Production tenants only get default (long) timing. |
| Cost of cross-tenant S3 + Athena exceeds RFP cost commitments | Medium | Per-tenant cost dashboards (Phase 1 deliverable). Per-tenant rate limits on hot+archive queries (NFR-RET-003). Tier-down to less-expensive Glacier Deep Archive happens after 2 years of archived age — most queries hit Standard-IA / Glacier IR tiers where cost is acceptable. |
| Partition migration on existing `audit_log` table fails on a large tenant | High | Migration is staged: (a) create new partitioned table, (b) `INSERT INTO new SELECT FROM old` in batches with no app downtime via pgrolling, (c) atomic table rename. Documented runbook with rollback. Tested on synthetic 10M-row data. |
| `pending_administrative_change` table grows unboundedly | Low | Rows expire after 30 days (FR-RET-051). A separate cleanup sweeper drops EXPIRED/REJECTED/EXECUTED rows older than 1 year. Active rows are bounded by tenant headcount × pending-action rate (~tens to hundreds per tenant). |

---

## 8. Acceptance criteria (consolidated)

For the proposal owner to sign off, every line below must pass.

### Retention basics
- [ ] No production entity is hard-deleted by time-based code outside the retention engine.
- [ ] Adding a row to a retention-eligible table sets `retention_class` (or the table doesn't participate in retention).
- [ ] `tenant_config.scheduler_audit_retention_days` is removed; AUDIT_TECHNICAL retention is set via `retention_policy` instead.

### Policy configuration
- [ ] Operators with `retention.write` permission can view and edit the retention matrix at `/settings/retention/policies`.
- [ ] Attempting to set `retentionDays < statutoryFloorDays` returns 422 with the floor source citation.
- [ ] Enabling a policy creates a `pending_administrative_change` row; the policy doesn't activate until two admins approve.
- [ ] All policy changes emit audit rows of class `AUDIT_SECURITY`.

### Legal hold
- [ ] Placing a hold on an entity excludes that entity from any subsequent purge run, including retention-driven runs.
- [ ] Releasing a hold requires dual approval; the release event is audited.
- [ ] `Account.isProtected` is removed; existing protected accounts are migrated to `legal_hold` rows.

### Archival
- [ ] `meter_read`, `audit_log`, `notification_log` are range-partitioned monthly; partition manager creates next-month partitions on schedule.
- [ ] An aged partition is exported to Parquet, indexed in `archive_partition_index`, and removed from hot Postgres atomically (saga-safe).
- [ ] A closed account >7 years old is exported to Parquet; the parent row is flagged ARCHIVED; dependent rows are removed.
- [ ] Search and listing endpoints return both live and archived account records with `archive_status` populated.
- [ ] A tenant report with "Include archived data" enabled returns a federated UNION of live + archive query results, with per-section provenance.
- [ ] Restoring a Glacier-Deep-Archive partition completes within 24h (operator-visible ETA) and rehydrates rows back to hot Postgres.

### Purge
- [ ] Retention-driven purge runs daily; rows past their retention period AND past their statutory floor are purged.
- [ ] Each purge run produces a signed manifest in the S3 object-lock-compliance bucket.
- [ ] `saaslogic-verify-purge-chain` validates the chain from outside the application; tampering with a manifest in S3 is detected.
- [ ] Operator-requested purge requires dual approval; the proposal stores the filter, not row IDs (re-evaluated at execute time).
- [ ] Bulk purge of N rows produces a manifest itemizing every row.

### Statutory overrides
- [ ] FINANCIAL retention < 7 years is rejected at policy-edit time.
- [ ] Subject erasure where the subject has financial records in the past 7 years runs as partial erasure: portal account + contact info removed; financial records retained with name redacted.
- [ ] Audit log rows of class `AUDIT_FINANCIAL` cannot be purged before 7 years regardless of any policy.

### GDPR/CCPA
- [ ] A portal user can submit an erasure request; the request appears in `data_subject_request` and `pending_administrative_change`.
- [ ] On dual approval and execution, a manifest is generated with `purgeMode = "subject_requested"`; the subject is notified of completion with a clear summary of what was/wasn't erased.

### Manifest immutability
- [ ] Manifest S3 bucket has object-lock compliance mode enabled and a retention period ≥ retention class statutory floor.
- [ ] Manifest signature is generated via KMS-managed Ed25519 (same infrastructure as audit Merkle roots from doc 01 §3.3).
- [ ] `previousManifestSha256` chains every manifest to its predecessor; a missing chain link is detected by the verification CLI.

### Non-functional
- [ ] Daily retention worker run: ≤30 minutes p99 across all tenants combined.
- [ ] Federated hot+archive report query: ≤30s p99 for typical 1-month-window queries (Standard-IA tier).
- [ ] Manifest PUT: ≤2s p99.
- [ ] Standard-IA restore: ≤5s; Glacier Deep Archive restore: 12h p99 (AWS-bounded).

---

## 9. References

- **Internal**:
  - [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) — append-only audit, Merkle hash chains, S3 object-lock bucket (reused for manifest storage), event-class enum (reused for retention class)
  - [04-attachments.md](./04-attachments.md) §4.8 — attachment-bytes retention/archival (governs `ATTACHMENT_CONTENT` class details; this doc references rather than restates)
  - [06-custom-fields.md](./06-custom-fields.md) §4.5 Phase 3 — reporting module against which "Include archived data" toggle integrates
  - [17-reporting-and-audit.md](../specs/17-reporting-and-audit.md) — existing audit-immutability commitment; reconciled with this doc's class-based retention
  - `packages/api/src/services/audit-retention.service.ts` — current scheduler-audit retention sweep (refactored to use `retention_policy`)
  - `packages/shared/prisma/schema.prisma` — current schema state (`Account.isProtected/protectionReason`, `tenant_config.scheduler_audit_retention_days`, `ServiceSuspension.requestedBy/approvedBy`)

- **External**:
  - IRS record retention (financial) — 7 years for business records
  - SOC 2 audit-log retention — 7 years recommended
  - Montana Public Service Commission rules (state-specific) — to be cited in proposal appendix
  - GDPR Article 17 (right to erasure) + Article 23 (restrictions for legal obligations) — basis for partial-erasure design
  - AWS S3 Object Lock compliance mode — manifest storage immutability
  - AWS S3 lifecycle policies — Standard → IA → Glacier IR → Glacier Deep Archive transitions
  - AWS Athena / Apache Parquet — federated archive querying

---

**End of doc 08.**
