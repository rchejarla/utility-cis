# 01 — Audit & Tamper-Evidence

**RFP commitment owner:** SaaSLogic Utilities (with shared object-lock + key-management infrastructure)
**Status:** Drafted — implementation pending. Nine of fifteen RFP-cited capabilities are not yet built; this document scopes the gap.
**Effort estimate:** L (~3-4 weeks engineering plus 1 week security review).

---

## 1. RFP commitments (verbatim)

The following two paragraphs are the City-facing commitments in the proposal response. Every requirement in this document traces to at least one phrase here.

> Audit logs are written to an append-only PostgreSQL table with database-level constraints preventing UPDATE and DELETE statements; even a database administrator cannot modify entries. Logs are replicated to encrypted S3 storage with object-lock retention. Default retention is seven (7) years for financial-relevant events; the City may extend retention. Tamper-evidence is provided by daily Merkle-tree hash chains, which are signed and stored separately.

> Role assignments, permission-matrix edits, MFA enforcement changes, password-policy changes, integration-credential rotation, and IdP federation changes all generate audit-log entries with full before/after state and the user who performed the change. Optional approval workflows can require a second approver for sensitive security changes.

---

## 2. Current-state gap analysis

| RFP phrase | Current state | Gap |
|---|---|---|
| Append-only PostgreSQL table | `audit_log` is a standard Prisma table (see `packages/shared/prisma/migrations/20260423021530_init/migration.sql`). RLS is enabled for tenant isolation but does not prevent UPDATE/DELETE. | Triggers + role grants. |
| DB-level constraints preventing UPDATE/DELETE | None. No triggers, no rules, no `REVOKE` on the application role. | Implement BEFORE UPDATE/DELETE triggers + REVOKE pattern. |
| Even a DB admin cannot modify entries | False today. The new audit-retention worker (`packages/api/src/workers/audit-retention-worker.ts`, plan task 9) actively `DELETE`s scheduler-emitted audits per tenant retention policy. Reconciliation needed. | Move retention to a privileged-role path with logged justification, or shift to soft-archive (move-to-S3-then-delete-with-hash). |
| Replicated to encrypted S3 with object-lock | Zero S3 integration. No `@aws-sdk` dependency. No daily export. | Implement nightly export job + S3 bucket with object-lock in compliance mode. |
| Default 7-year retention for financial events | `tenant_config.scheduler_audit_retention_days` defaults to 365 (1 year) and applies only to scheduler-emitted audits. No event-type classification, no per-class retention. | Add per-event-type retention policy with a financial-events bucket defaulting to 2555 days. |
| City may extend retention | Tenant settings UI exposes `schedulerAuditRetentionDays` but only one number for all scheduler audits. Cannot extend a specific event type independently. | Per-class retention controls on the same Settings page. |
| Daily Merkle-tree hash chains | None. No merkle implementation. No hashing job. No signing infrastructure. | New daily job; new signing key management; new verification utility. |
| Stored separately and signed | N/A — no merkle output exists. | Separate S3 bucket (or distinct KMS key), separate retention policy. |
| Role assignments → audit log | `services/role.service.ts` has zero `auditCreate`/`auditUpdate` calls. Mutations are silent. | Wire audit-emit into every role/permission mutation. |
| Permission-matrix edits → audit log | Same as above. | Same. |
| MFA enforcement changes | No MFA in the codebase at all. | Implement MFA enrollment + tenant-policy enforcement, then audit changes. |
| Password-policy changes | No password policy. Dev login is email-only stub. | Implement password policy (min length, complexity, rotation), then audit changes. |
| Integration-credential rotation | No credential management. | Implement credential vault + rotation UI, then audit. |
| IdP federation changes | No SAML/OIDC federation. No IdP-config UI. | Out of scope for this RFP (call out in §6). |
| Full before/after state + actor | Where audits exist (~17 services covering account/customer/premise/meter/etc.), payload is correct: `actorId`, `actorName`, `beforeState`, `afterState`, ISO timestamps. Pattern is sound; coverage is the gap. | Apply the existing pattern to the security services. |
| Two-person approval for sensitive security changes | Only existing approval workflow is `tenant_config.requireHoldApproval` for service suspensions — different domain. | Generalize the approval pattern; apply to sensitive security ops. |

---

## 3. Functional requirements

### 3.1 Append-only enforcement

- **FR-AUDIT-001** — `audit_log` rows MUST NOT be modifiable via SQL `UPDATE` from any application database role.
  - **Implementation:** BEFORE UPDATE trigger that `RAISE EXCEPTION` with SQLSTATE `'P0001'` and message `'audit_log is append-only'`. Plus `REVOKE UPDATE ON audit_log FROM <app_role>` to defend in depth.
  - **Acceptance:** Integration test asserts `prisma.auditLog.update(...)` rejects with the documented error, and a direct `psql` `UPDATE audit_log SET ...` from the app role rejects.

- **FR-AUDIT-002** — `audit_log` rows MUST NOT be deletable via SQL `DELETE` from any application database role.
  - **Implementation:** BEFORE DELETE trigger with the same shape. `REVOKE DELETE` on the app role.
  - **Acceptance:** Same as FR-AUDIT-001 but for `DELETE`.

- **FR-AUDIT-003** — Retention-driven removal of audit rows MUST occur via a separate, audited path (see FR-AUDIT-005) and never use the application role.
  - **Implementation:** Two approaches (pick one during build):
    - **Option A — privileged role:** A dedicated `audit_retention` Postgres role that owns `DELETE` on `audit_log`. The retention worker connects with this role's credentials (sourced from a separate secrets path, not the app's `DATABASE_URL`). Every retention DELETE writes a row to a sibling `audit_log_retention_runs` table capturing operator, batch size, time range, and Merkle root of deleted rows.
    - **Option B — soft-archive only:** Retention moves rows to `audit_log_archive` (cold-storage table) instead of deleting. The `audit_log` table is truly append-only forever; the archive table can be pruned per policy.
  - **Recommendation:** Option B for the simpler audit story; Option A only if storage cost makes B impractical.
  - **Acceptance:** Code review confirms the retention worker uses a different DB connection string than the API, and neither connection is the same role.

- **NFR-AUDIT-001** — The append-only enforcement MUST survive a database role swap or schema migration. The trigger definitions must live in a migration that's idempotent (i.e., `CREATE OR REPLACE TRIGGER` semantics) so a DBA can't quietly drop them in a maintenance migration without leaving a paper trail.

### 3.2 S3 replication with object-lock

- **FR-AUDIT-010** — The system MUST replicate every committed `audit_log` row to an encrypted S3 bucket within 24 hours of insertion.
  - **Implementation:** Nightly export job (a sibling of the audit-retention worker, runs after retention sweep). Exports are partitioned by `(utility_id, YYYY-MM-DD)` for efficient retrieval.
  - **Acceptance:** Integration test seeds N audit rows, runs the export, verifies the S3 object exists and contains every row.

- **FR-AUDIT-011** — The S3 bucket MUST be encrypted at rest with SSE-KMS and a customer-managed key. The KMS key MUST be in a separate AWS account from the application's primary account, or at minimum in a separate KMS key rotation policy from any other application key.
  - **Implementation:** Terraform/CloudFormation manages the bucket + KMS policy. Bucket policy denies any read/write that isn't encrypted with the documented key.
  - **Acceptance:** AWS CLI `aws s3api get-bucket-encryption` returns SSE-KMS with the correct KMS key ARN.

- **FR-AUDIT-012** — The S3 bucket MUST have object-lock enabled in **compliance mode** (not governance mode) with a default retention period of 2555 days (7 years).
  - **Note:** Compliance mode is non-overridable even by the bucket owner, which is what RFP claim #3 ("even a DB admin cannot modify") requires for the offsite copy. Governance mode permits override and would not satisfy the claim.
  - **Acceptance:** `aws s3api get-object-lock-configuration` returns `Mode: COMPLIANCE`, `Days: 2555`.

- **FR-AUDIT-013** — The City MUST be able to extend retention on a per-event-type basis without a code release.
  - **Implementation:** New `audit_event_class` enum and a new `tenant_config_audit_retention` JSON column mapping `class → days`. The export job applies the per-class retention as the object's `Retain Until` field. Defaults: `FINANCIAL` → 2555, `SECURITY` → 2555, `OPERATIONAL` → 730, `TECHNICAL` → 365.
  - **UI:** Extends the `/settings/automation` page (already shipped) with a new "Audit retention by event class" section.
  - **Acceptance:** A tenant admin can extend `FINANCIAL` retention to 3650 days via the UI; the next export carries the new `Retain Until` for new objects (existing object retention is independently extendable via S3 console / SDK, documented in the runbook).

- **NFR-AUDIT-002** — The export job MUST be idempotent. A re-run for the same `(utility_id, date)` partition MUST NOT produce duplicate S3 objects or duplicate row contents.
  - **Implementation:** Use deterministic S3 keys (`<utility_id>/<YYYY-MM-DD>/audit.jsonl.gz`). Use `If-None-Match: *` on PUT or compare existing object's hash before re-writing.

- **NFR-AUDIT-003** — A documented restore procedure MUST exist for retrieving a specific tenant's audit history from S3 within 4 hours of a request.

### 3.3 Merkle-tree hash chain (tamper-evidence)

- **FR-AUDIT-020** — The system MUST produce a daily signed Merkle root summarizing all `audit_log` rows committed during that 24-hour UTC window for each tenant.
  - **Implementation:** New job `audit-merkle-roll`. For each tenant for each UTC day:
    1. SELECT all rows whose `created_at` falls within the window, ordered by `(created_at, id)`.
    2. For each row, compute `SHA-256(canonical_serialization(row))`. The canonical form is JSON with sorted keys + UTF-8 + LF line endings; documented in the spec to ensure third-party verifiability.
    3. Build a binary Merkle tree (SHA-256) from the leaf hashes. Pad with the previous day's root if leaf count is odd.
    4. Sign the root with the system's audit-signing key (Ed25519, separate from any other application key).
    5. Persist the root + signature into a new `audit_merkle_root` table AND publish the same payload to a separate S3 bucket (different from the audit-export bucket; see FR-AUDIT-022).

- **FR-AUDIT-021** — The Merkle root payload MUST include: tenant ID, window start/end (UTC), leaf count, root hash, signing-key fingerprint, signature, prior-day root hash (chained — current day's leaf input includes the prior root).
  - **Acceptance:** Schema review of `audit_merkle_root` row shape against this list.

- **FR-AUDIT-022** — Signed Merkle roots MUST be stored in a bucket with a different KMS key, different IAM policy, and different bucket from the audit-row exports. The principle: an attacker who compromises one bucket cannot tamper with the verification source for the other.
  - **Acceptance:** Architecture review confirms two distinct AWS accounts (or two distinct buckets with non-overlapping IAM policies in one account), each with its own KMS key.

- **FR-AUDIT-023** — The signing key's public key MUST be publicly retrievable (e.g., a `well-known/audit-signing-key.pem` URL or published in the City's runbook). The City — or any auditor — MUST be able to independently verify any day's root without any SaaSLogic credentials.
  - **Acceptance:** Public key published; verification utility runnable from the City's environment using only public information.

- **FR-AUDIT-024** — A verification utility (CLI tool packaged with the platform) MUST take a date range + tenant ID + the audit-export S3 location and assert that:
  1. Each daily root is correctly signed by the published public key.
  2. Each daily root chains correctly from the prior day.
  3. Each row in the S3 export, when re-hashed, reproduces the published Merkle root for its day.
  4. Any mismatch is reported with the specific date + leaf index.
  - **Acceptance:** Integration test that seeds rows, runs the merkle job, then deliberately tampers with one S3 export row and asserts the verification utility reports the tampered leaf.

- **NFR-AUDIT-004** — The signing key's private material MUST live in AWS KMS (or equivalent HSM) and MUST NOT be exportable. Signing happens via KMS API; the application never holds the raw key.

- **NFR-AUDIT-005** — The Merkle daily job MUST complete within 30 minutes for the worst-case tenant (10M audit rows/day). Above that threshold, the job partitions by hour and runs hourly sub-jobs.

### 3.4 Security-event audit coverage

- **FR-AUDIT-030** — Every mutation to the following entities MUST emit an audit row using the existing `auditCreate` / `auditUpdate` pattern:
  1. **Role** — create, update (including permissions JSON), delete, role-to-user assignment, role-to-user removal.
  2. **CisUser** — create, update (excluding password hash), delete, isActive toggle.
  3. **Tenant password policy** — every field on the policy entity.
  4. **Tenant MFA policy** — enforcement level changes, per-role MFA requirements.
  5. **Integration credentials** — create, rotate, revoke (the credential value itself is never written to audit; only the metadata + actor).
  6. **IdP federation config** (when implemented) — every field.
  7. **API keys + webhooks** — create, rotate, revoke.

- **FR-AUDIT-031** — The audit row MUST include `beforeState` and `afterState` JSON for every field that changed, the actor's ID and display name, the actor's IP address (from `X-Forwarded-For` if behind a proxy), and the request correlation ID.
  - **Note:** Sensitive fields (password hashes, secret credentials, MFA seeds) are redacted to `"[REDACTED]"` rather than included verbatim.
  - **Acceptance:** Per-entity integration tests that perform each mutation and assert the audit row's payload matches.

- **FR-AUDIT-032** — Each audit row's `event_class` MUST classify the mutation: `SECURITY` for role/permission/MFA/password/credential/IdP changes, `FINANCIAL` for billing/payment/refund/credit, `OPERATIONAL` for service suspensions, agreements, meters, and `TECHNICAL` for tenant config / integration config that doesn't fall into another bucket.
  - **Implementation:** New column `event_class` on `audit_log` with NOT NULL default `'OPERATIONAL'`. The mutation site sets it explicitly; default is the catch-all so a missed classification is auditable but not blocking.
  - **Acceptance:** Migration adds the column; existing audits classified by entity-type heuristic; new audit calls require explicit class.

### 3.5 Approval workflows for sensitive security changes

- **FR-AUDIT-040** — A tenant admin MUST be able to enable, per operation type, a "two-person approval" rule that prevents the change from taking effect until a second admin approves.
  - **Operations covered (configurable):**
    - Role permission edits
    - Granting administrator role to a user
    - Disabling MFA for a user or globally
    - Rotating integration credentials
    - Changing password policy
    - IdP federation config changes (when implemented)

- **FR-AUDIT-041** — A change subject to two-person approval MUST be persisted in a `pending_security_change` table with the proposed `afterState`, the requesting actor, and a default 24-hour TTL. The change is NOT applied to the live entity until an approver is recorded.

- **FR-AUDIT-042** — Approval requests MUST notify all eligible approvers (admins not equal to the requester) via email immediately. A pending request that expires unapproved emits an audit row of class `SECURITY` with action `EXPIRED` and is removed from the pending table.

- **FR-AUDIT-043** — The approver MUST NOT be the requester. The system rejects self-approval with HTTP 403.

- **FR-AUDIT-044** — Both the request and the approval emit audit rows with the full proposed state, requester, approver, and timestamps. Denials emit an audit row with reason and denier.

### 3.6 Retention policy granularity

- **FR-AUDIT-050** — The system MUST support per-event-class retention policies, configurable per tenant.
  - **Defaults:**
    - `FINANCIAL` → 2555 days (7 years) — meets the RFP commitment for financial events
    - `SECURITY` → 2555 days
    - `OPERATIONAL` → 730 days (2 years)
    - `TECHNICAL` → 365 days (1 year)
    - `SCHEDULER` → 365 days (already shipped via `tenant_config.scheduler_audit_retention_days`)
  - **Floor:** SECURITY and FINANCIAL classes have a minimum of 2555 days that the tenant cannot reduce. The City can extend; cannot shorten below the regulatory minimum.
  - **Implementation:** Replace the single `scheduler_audit_retention_days` column with a JSON column `audit_retention_days_by_class` plus a backward-compat view that exposes the scheduler-class field for the existing UI.

- **FR-AUDIT-051** — When the platform admin (SaaSLogic, not a tenant) applies a longer retention via support, the change emits an audit row of class `SECURITY` with the rationale and the support ticket reference.

---

## 4. Data model changes

```prisma
// New columns on audit_log
model AuditLog {
  // ... existing fields ...
  eventClass  AuditEventClass @default(OPERATIONAL) @map("event_class")
  ipAddress   String?         @map("ip_address") @db.Inet
  requestId   String?         @map("request_id") @db.VarChar(64)
}

enum AuditEventClass {
  FINANCIAL
  SECURITY
  OPERATIONAL
  TECHNICAL
  SCHEDULER
}

// New table — daily Merkle roots
model AuditMerkleRoot {
  id                String   @id @default(uuid()) @db.Uuid
  utilityId         String   @map("utility_id") @db.Uuid
  windowStart       DateTime @map("window_start") @db.Timestamptz
  windowEnd         DateTime @map("window_end") @db.Timestamptz
  leafCount         Int      @map("leaf_count")
  rootHash          String   @map("root_hash") @db.Char(64) // hex SHA-256
  signature         String   @db.Text                       // base64 Ed25519 signature
  signingKeyId      String   @map("signing_key_id") @db.VarChar(64) // KMS key ARN or fingerprint
  priorRootHash     String?  @map("prior_root_hash") @db.Char(64)
  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@unique([utilityId, windowStart])
  @@index([utilityId, createdAt])
  @@map("audit_merkle_root")
}

// New table — pending security changes (two-person approval)
model PendingSecurityChange {
  id              String   @id @default(uuid()) @db.Uuid
  utilityId       String   @map("utility_id") @db.Uuid
  operationType   String   @map("operation_type") @db.VarChar(64)
  targetEntityId  String?  @map("target_entity_id") @db.Uuid
  proposedState   Json     @map("proposed_state")
  requestedBy     String   @map("requested_by") @db.Uuid
  requestedAt     DateTime @default(now()) @map("requested_at") @db.Timestamptz
  expiresAt       DateTime @map("expires_at") @db.Timestamptz
  approvedBy      String?  @map("approved_by") @db.Uuid
  approvedAt      DateTime? @map("approved_at") @db.Timestamptz
  status          PendingChangeStatus @default(AWAITING_APPROVAL)

  @@index([utilityId, status, expiresAt])
  @@map("pending_security_change")
}

enum PendingChangeStatus {
  AWAITING_APPROVAL
  APPROVED_AND_APPLIED
  REJECTED
  EXPIRED
}

// Replace scheduler-only retention with per-class retention on TenantConfig
model TenantConfig {
  // ... existing fields ...
  // schedulerAuditRetentionDays — kept for backward compat, generated
  // from auditRetentionByClass.scheduler at read time.
  auditRetentionByClass Json @default("{\"FINANCIAL\":2555,\"SECURITY\":2555,\"OPERATIONAL\":730,\"TECHNICAL\":365,\"SCHEDULER\":365}") @map("audit_retention_by_class")
}
```

---

## 5. Implementation sequence

Suggested order. Each step is independently shippable.

1. **Append-only triggers + REVOKE pattern.** New migration. Update the audit-retention worker to use a privileged role OR switch to soft-archive. Effort: S (~1 day).
2. **`event_class` column + classification at every audit-emit site.** Backward-compat default keeps existing audits valid. Effort: S (~1 day).
3. **Per-class retention policy + UI extension.** Schema + service + automation page section. Effort: M (~2-3 days).
4. **Security-event audit coverage.** Wire `auditCreate`/`auditUpdate` into role/user/tenant-config/credentials/IdP services. Effort: M (~3 days plus prerequisite MFA + password-policy implementation).
5. **S3 replication job.** New worker + AWS SDK + bucket + KMS + IAM. Effort: M (~3-4 days plus 1 day infra).
6. **Daily Merkle-roll job + signing infrastructure.** New worker + KMS signing + verification utility + public-key publication. Effort: L (~5-7 days).
7. **Two-person approval workflow.** New entity + UI + per-operation gating in services. Effort: L (~5-7 days).

**Recommended preflight before RFP signature:** items 1, 2, 3, and 4. Items 5, 6, 7 can be committed as Phase 2 deliverables in the contract; the City is unlikely to insist on a working Merkle CLI on day 1, but they will insist on append-only enforcement and security-event coverage from go-live.

---

## 6. Out of scope for this RFP

These items are NOT committed by this requirements doc:

- **IdP federation (SAML/OIDC) implementation itself.** The audit coverage in FR-AUDIT-030 #6 applies only once IdP federation is built (separate proposal item). If IdP is required for go-live, that's a different requirements doc.
- **MFA implementation itself.** Same shape: audit coverage applies once MFA is built. Pre-shipping MFA is a separate requirement.
- **HSM-grade signing without KMS.** AWS KMS is the chosen signing infrastructure. Customer-controlled HSMs (CloudHSM, on-prem) are not in this commitment.
- **Real-time replication to S3.** Daily export is the commitment. Sub-hour latency is not promised.
- **Chain of custody for non-audit data.** This doc covers `audit_log`. Chain of custody for billing data, customer PII, etc. is not promised here.
- **Air-gapped or offline verification.** Verification requires AWS S3 access (read-only) plus the published public key. No offline mode is promised.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| KMS compliance-mode lock is irrevocable. A bug that writes 7-year-locked garbage to the bucket can't be removed. | Stage exports to a non-locked staging bucket first; only promote to the locked bucket after a hash-validation step. |
| The retention-DELETE path becomes a tamper vector if not carefully gated. | Soft-archive (Option B in §3.1) eliminates the path. Recommend Option B unless storage cost forces Option A. |
| Per-class retention floor (FR-AUDIT-050) reduces tenant flexibility. | Document the floor explicitly in tenant onboarding; surface it in the UI as a non-editable "regulatory minimum" annotation. |
| Two-person approval can lock out a tenant if the only admin leaves. | Always-allow break-glass: a tenant can request SaaSLogic support to apply a manual change with elevated audit + approval logging. Documented in the runbook. |
| Merkle verification CLI is the City's audit tool but lives in our codebase. | Publish source under an OSS license (or at minimum mirror the verification logic to the City's repo at delivery) so the City isn't dependent on us to verify our own claims. |

---

## 8. Acceptance criteria summary

The RFP commitment is satisfied when ALL of the following pass:

- [ ] `psql` `UPDATE audit_log SET ...` from the application role rejects with the documented error (FR-AUDIT-001).
- [ ] `psql` `DELETE FROM audit_log ...` from the application role rejects with the documented error (FR-AUDIT-002).
- [ ] Every mutation in §3.4's entity list emits an audit row with classified `event_class` and full before/after state — automated tests assert one row per documented operation (FR-AUDIT-030, FR-AUDIT-031).
- [ ] An auditor can run the verification CLI against any tenant, any date range, using only the public key and S3 read access, and detect a single-row tampering injected by the test (FR-AUDIT-024).
- [ ] The two-person approval workflow blocks a sensitive change until a second admin approves; the approver MUST NOT be the requester (FR-AUDIT-040, FR-AUDIT-043).
- [ ] A tenant admin can extend retention for any event class via `/settings/automation` UI; the next nightly export carries the new `Retain Until` value (FR-AUDIT-013, FR-AUDIT-050).
- [ ] S3 bucket has object-lock in compliance mode with 7-year default. AWS CLI verification runbook runs clean (FR-AUDIT-012).
- [ ] Daily Merkle root chained to prior day, signed with KMS-managed Ed25519 key, published to a separate bucket with separate KMS key (FR-AUDIT-020, FR-AUDIT-022).

Each criterion above maps to a specific automated test or runbook procedure. Sign-off: engineering lead + security review + proposal owner.
