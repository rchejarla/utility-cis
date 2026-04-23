# Module 14 — Service Requests, Slice B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first vertical slice of Module 14 — CSR-created service requests end-to-end with SLA tracking, covering data model, API, admin UI, and RBAC, while explicitly deferring portal intake, attachments, external-system routing, billing-on-completion, and the SLA breach background job.

**Architecture:** Three new Prisma tables (`ServiceRequest`, `Sla`, `ServiceRequestTypeDef`) plus a request-number counter table; Fastify routes backed by service modules that follow the existing `SuspensionTypeDef` + `ServiceSuspension` pattern; four Next.js pages (queue, detail, create, SLA settings) plus an account-detail tab and sidebar nav entry, reusing `EntityListPage`, `SearchableEntitySelect`, and existing Indigo Wash tokens. Every mutation emits a domain event via `auditCreate`/`auditUpdate` so the detail-page timeline reads from the existing `AuditLog`.

**Tech Stack:** TypeScript monorepo — Prisma 5 + PostgreSQL 16 (+ RLS), Fastify 4, Zod validators shared via `@utility-cis/shared`, Next.js 14 App Router, Tailwind + Indigo Wash tokens, Font Awesome Pro icons, Vitest for unit/integration tests, pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-04-23-service-requests-slice-b-design.md`.

---

## File Structure

### Created

| Path | Responsibility |
|---|---|
| `packages/shared/prisma/migrations/<TS>_add_service_requests/migration.sql` | Prisma migration — new enums, tables, indexes, counter table. |
| `packages/shared/prisma/migrations/<TS>_add_service_requests_rls/migration.sql` | Row-Level Security policies for new tables. |
| `packages/shared/src/validators/service-request-type-def.ts` | Zod + types for type-def list endpoint. |
| `packages/shared/src/validators/sla.ts` | Zod + types for SLA CRUD. |
| `packages/shared/src/validators/service-request.ts` | Zod + types for service requests (enums, create, patch, query, transition, complete, cancel, assign). |
| `packages/shared/src/lib/agreement-label.ts` | `formatAgreementLabel` helper. |
| `packages/shared/src/validators/index.ts` | (modify) re-exports. |
| `packages/api/src/services/service-request-type-def.service.ts` | List + `assertRequestTypeCode`. |
| `packages/api/src/services/sla.service.ts` | CRUD + `resolveSlaForRequest`. |
| `packages/api/src/services/service-request-counter.service.ts` | Per-tenant/year sequential request-number generation. |
| `packages/api/src/services/service-request.service.ts` | Create, list, get, patch, assign, transition, complete, cancel, + scoped listings; emits audit events. |
| `packages/api/src/routes/service-request-types.ts` | Fastify route module. |
| `packages/api/src/routes/slas.ts` | Fastify route module. |
| `packages/api/src/routes/service-requests.ts` | Fastify route module. |
| `packages/api/src/__tests__/services/service-request-counter.service.test.ts` | Unit tests for counter. |
| `packages/api/src/__tests__/services/service-request.service.test.ts` | Unit tests for create/transition/complete/cancel/SLA resolution. |
| `packages/api/src/__tests__/services/sla.service.test.ts` | Unit tests for SLA CRUD + resolve. |
| `packages/api/src/__tests__/services/service-request-type-def.service.test.ts` | Unit tests for type list + assert. |
| `packages/api/src/__tests__/integration/service-requests.test.ts` | Route + RBAC + state-machine integration tests. |
| `packages/shared/src/__tests__/agreement-label.test.ts` | Label helper tests. |
| `packages/web/app/service-requests/page.tsx` | Queue page. |
| `packages/web/app/service-requests/new/page.tsx` | Creation form. |
| `packages/web/app/service-requests/[id]/page.tsx` | Detail page. |
| `packages/web/app/settings/slas/page.tsx` | SLA configuration page. |
| `packages/web/components/service-requests/sla-countdown.tsx` | Shared SLA countdown pill + color logic. |
| `packages/web/components/service-requests/request-list.tsx` | Shared list-table component consumed by queue + account tab. |

### Modified

| Path | Change |
|---|---|
| `packages/shared/prisma/schema.prisma` | Add 5 enums, 3 models (`ServiceRequestTypeDef`, `Sla`, `ServiceRequest`), counter model, relation back-refs on `Account`, `Premise`, `ServiceAgreement`, `CisUser`, `DelinquencyAction`. |
| `packages/shared/src/modules/constants.ts` | Add `service_requests` + `service_request_slas` to `MODULES`, `MODULE_META`, and all `PRESET_ROLES`. |
| `packages/shared/src/index.ts` | Re-export new validator + lib modules. |
| `packages/api/src/app.ts` | Register new route modules. |
| `seed.js` | Seed 8 global type-defs, SLA rows, role permissions, 3 demo service-request rows. |
| `packages/web/components/sidebar.tsx` | Add Service Requests nav item. |
| `packages/web/app/accounts/[id]/page.tsx` | Add Service Requests tab. |
| `docs/specs/14-service-requests.md` | Flip status to "Slice B in progress" with per-field/endpoint annotations. |
| `docs/design/utility-cis-architecture.md` | Add entities + enums + counts to master data model. |
| `docs/specs/00-data-model-overview.md` | Add the three new entities. |

---

## Task 1: Prisma schema — enums, counter, type-def, SLA, service request

**Files:**
- Modify: `packages/shared/prisma/schema.prisma`

- [ ] **Step 1: Add enums at the bottom of the enum block**

Search for the end of the enum declarations (after `ServiceEventBillingAction`). Append:

```prisma
enum ServiceRequestStatus {
  NEW
  ASSIGNED
  IN_PROGRESS
  PENDING_FIELD
  COMPLETED
  CANCELLED
  FAILED
}

enum ServiceRequestPriority {
  EMERGENCY
  HIGH
  NORMAL
  LOW
}

enum ServiceRequestSource {
  CSR
  PORTAL
  API
  SYSTEM
  DELINQUENCY_WORKFLOW
}

enum ServiceRequestExternalSystem {
  RAMS
  WORK_MANAGEMENT
  APPTORFLOW
}

enum ServiceRequestBillingAction {
  FEE_APPLIED
  CREDIT_APPLIED
  NO_ACTION
}
```

- [ ] **Step 2: Add models at the end of the file**

```prisma
// Reference table for service-request type codes. Same pattern as
// SuspensionTypeDef: utilityId NULL = global (seeded), utilityId set =
// tenant-local shadow. Admin UI to manage tenant-local rows is a later
// slice; this slice ships the globals only.
model ServiceRequestTypeDef {
  id          String   @id @default(uuid()) @db.Uuid
  utilityId   String?  @map("utility_id") @db.Uuid
  code        String   @db.VarChar(100)
  label       String   @db.VarChar(150)
  description String?  @db.Text
  category    String?  @db.VarChar(50)
  sortOrder   Int      @default(100) @map("sort_order")
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz

  @@unique([utilityId, code])
  @@index([isActive, sortOrder])
  @@map("service_request_type_def")
}

// SLA policy per (request_type, priority). request_type is a VARCHAR key
// into ServiceRequestTypeDef.code — deliberately not a FK so code changes
// don't cascade. The service layer validates the code at write time.
model Sla {
  id                String                 @id @default(uuid()) @db.Uuid
  utilityId         String                 @map("utility_id") @db.Uuid
  requestType       String                 @map("request_type") @db.VarChar(100)
  priority          ServiceRequestPriority @map("priority")
  responseHours     Decimal                @map("response_hours") @db.Decimal(5, 2)
  resolutionHours   Decimal                @map("resolution_hours") @db.Decimal(5, 2)
  escalationHours   Decimal?               @map("escalation_hours") @db.Decimal(5, 2)
  escalationUserId  String?                @map("escalation_user_id") @db.Uuid
  isActive          Boolean                @default(true) @map("is_active")
  createdAt         DateTime               @default(now()) @map("created_at") @db.Timestamptz
  updatedAt         DateTime               @updatedAt @map("updated_at") @db.Timestamptz

  escalationUser CisUser?         @relation("SlaEscalationUser", fields: [escalationUserId], references: [id], onDelete: SetNull)
  serviceRequests ServiceRequest[]

  @@unique([utilityId, requestType, priority])
  @@index([utilityId, isActive])
  @@map("sla")
}

// Per-tenant per-year counter row used by createServiceRequest to mint
// SR-YYYY-NNNNNN numbers. Separate table so we can lock a single row via
// SELECT ... FOR UPDATE inside the creation transaction without
// contending on the service_request table itself.
model ServiceRequestCounter {
  utilityId String @map("utility_id") @db.Uuid
  year      Int
  nextValue BigInt @default(1) @map("next_value")

  @@id([utilityId, year])
  @@map("service_request_counter")
}

model ServiceRequest {
  id                  String                         @id @default(uuid()) @db.Uuid
  utilityId           String                         @map("utility_id") @db.Uuid
  requestNumber       String                         @map("request_number") @db.VarChar(50)
  accountId           String?                        @map("account_id") @db.Uuid
  premiseId           String?                        @map("premise_id") @db.Uuid
  serviceAgreementId  String?                        @map("service_agreement_id") @db.Uuid
  requestType         String                         @map("request_type") @db.VarChar(100)
  requestSubtype      String?                        @map("request_subtype") @db.VarChar(100)
  priority            ServiceRequestPriority         @map("priority")
  status              ServiceRequestStatus           @default(NEW) @map("status")
  source              ServiceRequestSource           @default(CSR) @map("source")
  description         String                         @map("description") @db.Text
  resolutionNotes     String?                        @map("resolution_notes") @db.Text
  slaId               String?                        @map("sla_id") @db.Uuid
  slaDueAt            DateTime?                      @map("sla_due_at") @db.Timestamptz
  slaBreached         Boolean                        @default(false) @map("sla_breached")
  assignedTo          String?                        @map("assigned_to") @db.Uuid
  assignedTeam        String?                        @map("assigned_team") @db.VarChar(100)
  externalSystem      ServiceRequestExternalSystem?  @map("external_system")
  externalRequestId   String?                        @map("external_request_id") @db.VarChar(200)
  externalStatus      String?                        @map("external_status") @db.VarChar(100)
  delinquencyActionId String?                        @map("delinquency_action_id") @db.Uuid
  billingAction       ServiceRequestBillingAction?   @map("billing_action")
  adhocChargeId       String?                        @map("adhoc_charge_id") @db.Uuid
  attachments         Json                           @default("[]") @map("attachments")
  createdBy           String?                        @map("created_by") @db.Uuid
  createdAt           DateTime                       @default(now()) @map("created_at") @db.Timestamptz
  updatedAt           DateTime                       @updatedAt @map("updated_at") @db.Timestamptz
  completedAt         DateTime?                      @map("completed_at") @db.Timestamptz
  cancelledAt         DateTime?                      @map("cancelled_at") @db.Timestamptz

  account           Account?           @relation(fields: [accountId], references: [id], onDelete: SetNull)
  premise           Premise?           @relation(fields: [premiseId], references: [id], onDelete: SetNull)
  serviceAgreement  ServiceAgreement?  @relation(fields: [serviceAgreementId], references: [id], onDelete: SetNull)
  sla               Sla?               @relation(fields: [slaId], references: [id], onDelete: SetNull)
  assignee          CisUser?           @relation("ServiceRequestAssignee", fields: [assignedTo], references: [id], onDelete: SetNull)
  creator           CisUser?           @relation("ServiceRequestCreator", fields: [createdBy], references: [id], onDelete: SetNull)
  delinquencyAction DelinquencyAction? @relation(fields: [delinquencyActionId], references: [id], onDelete: SetNull)

  @@unique([utilityId, requestNumber])
  @@index([utilityId, accountId, status])
  @@index([utilityId, requestType, status])
  @@index([utilityId, assignedTo, status])
  @@map("service_request")
}
```

- [ ] **Step 3: Add relation back-references on existing models**

Add these fields inside the existing models (don't add new blocks — append to their existing field lists):

In `model Account` — after existing `serviceAgreements ServiceAgreement[]`:
```prisma
  serviceRequests ServiceRequest[]
```

In `model Premise` — after existing `serviceAgreements ServiceAgreement[]`:
```prisma
  serviceRequests ServiceRequest[]
```

In `model ServiceAgreement` — in its relations block:
```prisma
  serviceRequests ServiceRequest[]
```

In `model CisUser` — in its relations block:
```prisma
  assignedServiceRequests ServiceRequest[] @relation("ServiceRequestAssignee")
  createdServiceRequests  ServiceRequest[] @relation("ServiceRequestCreator")
  slaEscalations          Sla[]            @relation("SlaEscalationUser")
```

In `model DelinquencyAction` — in its relations block:
```prisma
  serviceRequests ServiceRequest[]
```

- [ ] **Step 4: Run `prisma format` and verify no errors**

```bash
cd packages/shared && pnpm exec prisma format
```

Expected: file reformatted, no errors. If Prisma complains about a missing relation side, re-check Step 3 — every `@relation("X")` on one side needs a matching back-ref with the same relation name on the other.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/prisma/schema.prisma
git commit -m "feat(service-requests): add ServiceRequest/Sla/ServiceRequestTypeDef models"
```

---

## Task 2: Prisma migration — create tables + partial SLA index

**Files:**
- Create: `packages/shared/prisma/migrations/<timestamp>_add_service_requests/migration.sql`

- [ ] **Step 1: Ensure containers are running**

```bash
./start_db.bat
```

Expected: postgres + redis healthy.

- [ ] **Step 2: Generate the migration**

```bash
cd packages/shared && pnpm exec prisma migrate dev --name add_service_requests
```

Expected: a new timestamped directory under `migrations/` containing a `migration.sql` that creates the 5 enums, the 4 tables (`service_request_type_def`, `sla`, `service_request_counter`, `service_request`), the unique + normal indexes, and the relation FKs.

- [ ] **Step 3: Add the partial index manually**

Prisma can't express partial indexes in the schema, so add one at the end of the generated `migration.sql`:

```sql
-- Partial index — only open requests need fast SLA-due-at scanning. Used
-- by the `/service-requests?slaStatus=...` filter and (in a later slice)
-- the SLA breach sweep job.
CREATE INDEX "service_request_sla_due_at_open_idx"
  ON "service_request" ("utility_id", "sla_due_at")
  WHERE "status" NOT IN ('COMPLETED', 'CANCELLED', 'FAILED');
```

- [ ] **Step 4: Re-apply the migration to pick up the partial index**

```bash
cd packages/shared && pnpm exec prisma migrate reset --force --skip-seed
```

Expected: all migrations re-applied cleanly, including the partial index. Running `psql -c "\d service_request"` on the dev DB should list `service_request_sla_due_at_open_idx`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/prisma/migrations/
git commit -m "feat(service-requests): migration — add SR/Sla/type-def tables + partial index"
```

---

## Task 3: RLS policies for new tables

**Files:**
- Create: `packages/shared/prisma/migrations/<timestamp>_add_service_requests_rls/migration.sql`

- [ ] **Step 1: Create an empty migration**

```bash
cd packages/shared && pnpm exec prisma migrate dev --create-only --name add_service_requests_rls
```

Expected: a new empty migration directory.

- [ ] **Step 2: Populate the migration**

Copy the existing RLS pattern from `20260423021700_rls_policies/migration.sql` — same structure per table. Write into the new file:

```sql
-- service_request_type_def: global rows (utility_id IS NULL) visible to
-- every tenant; tenant-local rows visible only to their owner.
ALTER TABLE "service_request_type_def" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_request_type_def_tenant_isolation"
  ON "service_request_type_def"
  USING (utility_id IS NULL OR utility_id = current_setting('app.current_utility_id', true)::uuid);

ALTER TABLE "sla" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sla_tenant_isolation" ON "sla"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);

ALTER TABLE "service_request_counter" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_request_counter_tenant_isolation" ON "service_request_counter"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);

ALTER TABLE "service_request" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_request_tenant_isolation" ON "service_request"
  USING (utility_id = current_setting('app.current_utility_id', true)::uuid);
```

- [ ] **Step 3: Apply the migration**

```bash
cd packages/shared && pnpm exec prisma migrate dev
```

Expected: migration applied, no errors.

- [ ] **Step 4: Verify RLS is on**

```bash
psql -h localhost -U postgres -d utility_cis -c "SELECT tablename, rowsecurity FROM pg_tables WHERE tablename IN ('service_request_type_def', 'sla', 'service_request_counter', 'service_request');"
```

Expected: all four rows show `rowsecurity = t`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/prisma/migrations/
git commit -m "feat(service-requests): RLS policies on new tables"
```

---

## Task 4: Shared constants — add modules + preset role permissions

**Files:**
- Modify: `packages/shared/src/modules/constants.ts`

- [ ] **Step 1: Add module keys**

Find the `MODULES` tuple. Add `"service_requests"` and `"service_request_slas"` just before the portal entries:

```typescript
export const MODULES = [
  // ...existing entries through "delinquency"
  "delinquency",
  "service_requests",
  "service_request_slas",
  "portal_accounts",
  // ...rest
] as const;
```

- [ ] **Step 2: Add MODULE_META entries**

In `MODULE_META`, before the `portal_*` entries:

```typescript
  service_requests: { label: "Service Requests", icon: "faClipboardCheck" },
  service_request_slas: { label: "SLAs", icon: "faStopwatch" },
```

- [ ] **Step 3: Grant permissions in preset roles**

In `PRESET_ROLES` — System Admin and Utility Admin already get everything via `Object.fromEntries(MODULES.map(...))`, so both pick up `service_requests` and `service_request_slas` with full CRUD automatically. Edit the **CSR**, **Field Technician**, and **Read-Only** blocks:

CSR — inside its `permissions`:
```typescript
      service_requests: ["VIEW", "CREATE", "EDIT"],
```

Field Technician:
```typescript
      service_requests: ["VIEW", "EDIT"],
```

Read-Only:
```typescript
      service_requests: ["VIEW"],
      service_request_slas: ["VIEW"],
```

(Portal Customer intentionally gets nothing for either module — portal SR submission is a later slice.)

- [ ] **Step 4: Build shared package and verify no errors**

```bash
pnpm --filter @utility-cis/shared build
```

Expected: build passes.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/modules/constants.ts
git commit -m "feat(service-requests): add service_requests modules + preset role permissions"
```

---

## Task 5: Shared validators — service-request-type-def

**Files:**
- Create: `packages/shared/src/validators/service-request-type-def.ts`
- Modify: `packages/shared/src/validators/index.ts`

- [ ] **Step 1: Write the validator file**

```typescript
import { z } from "zod";
import { baseListQuerySchema } from "../lib/base-list-query";

export const serviceRequestTypeCode = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Z0-9_]+$/, "Type code must be uppercase letters, digits, and underscores");

export const serviceRequestTypeQuerySchema = baseListQuerySchema
  .extend({
    includeInactive: z.coerce.boolean().optional(),
  })
  .strict();

export interface ServiceRequestTypeDefDTO {
  id: string;
  code: string;
  label: string;
  description: string | null;
  category: string | null;
  sortOrder: number;
  isActive: boolean;
  isGlobal: boolean;
}

export type ServiceRequestTypeQuery = z.infer<typeof serviceRequestTypeQuerySchema>;
```

- [ ] **Step 2: Re-export**

Add to `packages/shared/src/validators/index.ts`:
```typescript
export * from "./service-request-type-def";
```

- [ ] **Step 3: Build and verify**

```bash
pnpm --filter @utility-cis/shared build
```

Expected: build passes.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/validators/
git commit -m "feat(service-requests): shared validators for type-def"
```

---

## Task 6: Shared validators — SLA

**Files:**
- Create: `packages/shared/src/validators/sla.ts`
- Modify: `packages/shared/src/validators/index.ts`

- [ ] **Step 1: Write the validator file**

```typescript
import { z } from "zod";
import { baseListQuerySchema } from "../lib/base-list-query";
import { serviceRequestTypeCode } from "./service-request-type-def";

export const serviceRequestPriorityEnum = z.enum([
  "EMERGENCY",
  "HIGH",
  "NORMAL",
  "LOW",
]);

const hours = z.coerce.number().positive().max(9999.99);

export const createSlaSchema = z
  .object({
    requestType: serviceRequestTypeCode,
    priority: serviceRequestPriorityEnum,
    responseHours: hours,
    resolutionHours: hours,
    escalationHours: hours.optional(),
    escalationUserId: z.string().uuid().optional(),
  })
  .strict();

export const updateSlaSchema = z
  .object({
    responseHours: hours.optional(),
    resolutionHours: hours.optional(),
    escalationHours: hours.optional().nullable(),
    escalationUserId: z.string().uuid().optional().nullable(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const slaQuerySchema = baseListQuerySchema
  .extend({
    requestType: serviceRequestTypeCode.optional(),
    includeInactive: z.coerce.boolean().optional(),
  })
  .strict();

export interface SlaDTO {
  id: string;
  requestType: string;
  priority: z.infer<typeof serviceRequestPriorityEnum>;
  responseHours: number;
  resolutionHours: number;
  escalationHours: number | null;
  escalationUserId: string | null;
  escalationUser?: { id: string; name: string } | null;
  isActive: boolean;
}

export type CreateSlaInput = z.infer<typeof createSlaSchema>;
export type UpdateSlaInput = z.infer<typeof updateSlaSchema>;
export type SlaQuery = z.infer<typeof slaQuerySchema>;
export type ServiceRequestPriority = z.infer<typeof serviceRequestPriorityEnum>;
```

- [ ] **Step 2: Re-export**

Add to `packages/shared/src/validators/index.ts`:
```typescript
export * from "./sla";
```

- [ ] **Step 3: Build and verify**

```bash
pnpm --filter @utility-cis/shared build
```

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/validators/
git commit -m "feat(service-requests): shared validators for SLA"
```

---

## Task 7: Shared validators — service request + agreement-label helper

**Files:**
- Create: `packages/shared/src/validators/service-request.ts`
- Create: `packages/shared/src/lib/agreement-label.ts`
- Modify: `packages/shared/src/validators/index.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/src/__tests__/agreement-label.test.ts`

- [ ] **Step 1: Write the agreement-label test FIRST (TDD)**

```typescript
// packages/shared/src/__tests__/agreement-label.test.ts
import { describe, it, expect } from "vitest";
import { formatAgreementLabel } from "../lib/agreement-label";

describe("formatAgreementLabel", () => {
  it("formats with agreement number, commodity name, and premise address line 1", () => {
    expect(
      formatAgreementLabel({
        agreementNumber: "SA-0421",
        commodity: { name: "Potable Water" },
        premise: { addressLine1: "412 N 7th Ave" },
      }),
    ).toBe("SA-0421 · Potable Water · 412 N 7th Ave");
  });

  it("falls back gracefully when commodity or premise is missing", () => {
    expect(
      formatAgreementLabel({
        agreementNumber: "SA-0001",
        commodity: null,
        premise: null,
      }),
    ).toBe("SA-0001");
  });

  it("omits only the missing segment when one side is present", () => {
    expect(
      formatAgreementLabel({
        agreementNumber: "SA-0002",
        commodity: { name: "Electricity" },
        premise: null,
      }),
    ).toBe("SA-0002 · Electricity");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm --filter @utility-cis/shared test -- agreement-label
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `formatAgreementLabel`**

```typescript
// packages/shared/src/lib/agreement-label.ts
export interface AgreementLabelInput {
  agreementNumber: string;
  commodity?: { name: string } | null;
  premise?: { addressLine1: string } | null;
}

export function formatAgreementLabel(agreement: AgreementLabelInput): string {
  const parts: string[] = [agreement.agreementNumber];
  if (agreement.commodity?.name) parts.push(agreement.commodity.name);
  if (agreement.premise?.addressLine1) parts.push(agreement.premise.addressLine1);
  return parts.join(" · ");
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm --filter @utility-cis/shared test -- agreement-label
```

Expected: PASS, 3 tests green.

- [ ] **Step 5: Write service-request validators**

```typescript
// packages/shared/src/validators/service-request.ts
import { z } from "zod";
import { baseListQuerySchema } from "../lib/base-list-query";
import { serviceRequestTypeCode } from "./service-request-type-def";
import { serviceRequestPriorityEnum } from "./sla";

export const serviceRequestStatusEnum = z.enum([
  "NEW",
  "ASSIGNED",
  "IN_PROGRESS",
  "PENDING_FIELD",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]);

export const serviceRequestSourceEnum = z.enum([
  "CSR",
  "PORTAL",
  "API",
  "SYSTEM",
  "DELINQUENCY_WORKFLOW",
]);

export const slaStatusFilter = z.enum(["on_time", "at_risk", "breached"]);

export const createServiceRequestSchema = z
  .object({
    accountId: z.string().uuid().optional().nullable(),
    premiseId: z.string().uuid().optional().nullable(),
    serviceAgreementId: z.string().uuid().optional().nullable(),
    requestType: serviceRequestTypeCode,
    requestSubtype: z.string().max(100).optional().nullable(),
    priority: serviceRequestPriorityEnum,
    description: z.string().min(1).max(10_000),
  })
  .strict();

export const updateServiceRequestSchema = z
  .object({
    description: z.string().min(1).max(10_000).optional(),
    priority: serviceRequestPriorityEnum.optional(),
    requestSubtype: z.string().max(100).optional().nullable(),
  })
  .strict();

export const assignServiceRequestSchema = z
  .object({
    assignedTo: z.string().uuid().optional().nullable(),
    assignedTeam: z.string().max(100).optional().nullable(),
  })
  .strict()
  .refine(
    (v) => v.assignedTo !== undefined || v.assignedTeam !== undefined,
    { message: "Provide at least one of assignedTo or assignedTeam" },
  );

export const transitionServiceRequestSchema = z
  .object({
    toStatus: z.enum(["ASSIGNED", "IN_PROGRESS", "PENDING_FIELD", "FAILED"]),
    notes: z.string().max(10_000).optional(),
  })
  .strict();

export const completeServiceRequestSchema = z
  .object({
    resolutionNotes: z.string().min(1).max(10_000),
  })
  .strict();

export const cancelServiceRequestSchema = z
  .object({
    reason: z.string().min(1).max(10_000),
  })
  .strict();

export const serviceRequestQuerySchema = baseListQuerySchema
  .extend({
    type: serviceRequestTypeCode.optional(),
    status: z
      .union([serviceRequestStatusEnum, z.array(serviceRequestStatusEnum)])
      .optional(),
    priority: z
      .union([serviceRequestPriorityEnum, z.array(serviceRequestPriorityEnum)])
      .optional(),
    accountId: z.string().uuid().optional(),
    premiseId: z.string().uuid().optional(),
    assignedTo: z.string().uuid().optional(),
    slaStatus: slaStatusFilter.optional(),
    dateFrom: z.string().date().optional(),
    dateTo: z.string().date().optional(),
    q: z.string().max(200).optional(),
  })
  .strict();

export type ServiceRequestStatus = z.infer<typeof serviceRequestStatusEnum>;
export type ServiceRequestSource = z.infer<typeof serviceRequestSourceEnum>;
export type CreateServiceRequestInput = z.infer<typeof createServiceRequestSchema>;
export type UpdateServiceRequestInput = z.infer<typeof updateServiceRequestSchema>;
export type AssignServiceRequestInput = z.infer<typeof assignServiceRequestSchema>;
export type TransitionServiceRequestInput = z.infer<typeof transitionServiceRequestSchema>;
export type CompleteServiceRequestInput = z.infer<typeof completeServiceRequestSchema>;
export type CancelServiceRequestInput = z.infer<typeof cancelServiceRequestSchema>;
export type ServiceRequestQuery = z.infer<typeof serviceRequestQuerySchema>;
```

- [ ] **Step 6: Add re-exports**

In `packages/shared/src/validators/index.ts`:
```typescript
export * from "./service-request";
```

In `packages/shared/src/index.ts`, add:
```typescript
export * from "./lib/agreement-label";
```

- [ ] **Step 7: Build and verify**

```bash
pnpm --filter @utility-cis/shared build && pnpm --filter @utility-cis/shared test
```

Expected: build + all shared tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/
git commit -m "feat(service-requests): shared validators + agreement-label helper"
```

---

## Task 8: Service — service-request-type-def

**Files:**
- Create: `packages/api/src/services/service-request-type-def.service.ts`
- Create: `packages/api/src/__tests__/services/service-request-type-def.service.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/api/src/__tests__/services/service-request-type-def.service.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listServiceRequestTypes,
  assertServiceRequestTypeCode,
} from "../../services/service-request-type-def.service.js";
import { prisma } from "../../lib/prisma.js";

const UID = "00000000-0000-4000-8000-00000000000a";

describe("service-request-type-def service", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("listServiceRequestTypes", () => {
    it("shadow-resolves tenant rows over globals with the same code", async () => {
      (prisma.serviceRequestTypeDef.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "g1", utilityId: null, code: "LEAK_REPORT", label: "Global Leak", description: null, category: null, sortOrder: 100, isActive: true },
        { id: "t1", utilityId: UID, code: "LEAK_REPORT", label: "Tenant Leak", description: null, category: null, sortOrder: 100, isActive: true },
        { id: "g2", utilityId: null, code: "OTHER", label: "Other", description: null, category: null, sortOrder: 900, isActive: true },
      ]);

      const result = await listServiceRequestTypes(UID);
      const leak = result.find((r) => r.code === "LEAK_REPORT")!;
      expect(leak.label).toBe("Tenant Leak");
      expect(leak.isGlobal).toBe(false);
    });
  });

  describe("assertServiceRequestTypeCode", () => {
    it("throws 400 when the code is unknown", async () => {
      (prisma.serviceRequestTypeDef.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(assertServiceRequestTypeCode(UID, "BOGUS"))
        .rejects.toMatchObject({ statusCode: 400 });
    });

    it("resolves when the code exists as a global row", async () => {
      (prisma.serviceRequestTypeDef.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "g1" });
      await expect(assertServiceRequestTypeCode(UID, "LEAK_REPORT")).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

```bash
pnpm --filter api test -- service-request-type-def
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement the service**

```typescript
// packages/api/src/services/service-request-type-def.service.ts
import { prisma } from "../lib/prisma.js";
import type { ServiceRequestTypeDefDTO } from "@utility-cis/shared";

type Row = {
  id: string;
  utilityId: string | null;
  code: string;
  label: string;
  description: string | null;
  category: string | null;
  sortOrder: number;
  isActive: boolean;
};

function toDto(row: Row): ServiceRequestTypeDefDTO {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    description: row.description,
    category: row.category,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    isGlobal: row.utilityId === null,
  };
}

export async function listServiceRequestTypes(
  utilityId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<ServiceRequestTypeDefDTO[]> {
  const rows = await prisma.serviceRequestTypeDef.findMany({
    where: {
      OR: [{ utilityId: null }, { utilityId }],
      ...(opts.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
  });
  // Tenant rows shadow same-code global rows.
  const byCode = new Map<string, Row>();
  for (const row of rows as Row[]) {
    const existing = byCode.get(row.code);
    if (!existing || (existing.utilityId === null && row.utilityId !== null)) {
      byCode.set(row.code, row);
    }
  }
  return Array.from(byCode.values())
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
    .map(toDto);
}

export async function assertServiceRequestTypeCode(
  utilityId: string,
  code: string,
): Promise<void> {
  const found = await prisma.serviceRequestTypeDef.findFirst({
    where: {
      code,
      isActive: true,
      OR: [{ utilityId: null }, { utilityId }],
    },
    select: { id: true },
  });
  if (!found) {
    throw Object.assign(
      new Error(`Unknown service request type code: ${code}`),
      { statusCode: 400, code: "SERVICE_REQUEST_TYPE_UNKNOWN" },
    );
  }
}
```

- [ ] **Step 4: Run test, confirm it passes**

```bash
pnpm --filter api test -- service-request-type-def
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/service-request-type-def.service.ts packages/api/src/__tests__/services/service-request-type-def.service.test.ts
git commit -m "feat(service-requests): type-def service + tests"
```

---

## Task 9: Service — SLA CRUD + resolver

**Files:**
- Create: `packages/api/src/services/sla.service.ts`
- Create: `packages/api/src/__tests__/services/sla.service.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/api/src/__tests__/services/sla.service.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/audit-wrap.js", () => ({
  auditCreate: vi.fn(async (_ctx, _evt, fn) => fn()),
  auditUpdate: vi.fn(async (_ctx, _evt, _before, fn) => fn()),
}));

import { createSla, resolveSlaForRequest } from "../../services/sla.service.js";
import { prisma } from "../../lib/prisma.js";

const UID = "00000000-0000-4000-8000-00000000000a";
const ACTOR = "00000000-0000-4000-8000-00000000000b";

describe("sla service", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("createSla", () => {
    it("creates with response + resolution hours", async () => {
      (prisma.sla.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "s1", utilityId: UID, requestType: "LEAK_REPORT", priority: "HIGH",
        responseHours: "2", resolutionHours: "12", escalationHours: null,
        escalationUserId: null, isActive: true,
      });
      const result = await createSla(UID, ACTOR, "Jane", {
        requestType: "LEAK_REPORT",
        priority: "HIGH",
        responseHours: 2,
        resolutionHours: 12,
      });
      expect(result.requestType).toBe("LEAK_REPORT");
      expect(result.responseHours).toBe(2);
    });
  });

  describe("resolveSlaForRequest", () => {
    it("returns the matching active SLA", async () => {
      (prisma.sla.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "s1", responseHours: "2", resolutionHours: "12",
      });
      const sla = await resolveSlaForRequest(UID, "LEAK_REPORT", "HIGH");
      expect(sla?.id).toBe("s1");
    });

    it("returns null when no SLA matches", async () => {
      (prisma.sla.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const sla = await resolveSlaForRequest(UID, "BILLING_DISPUTE", "LOW");
      expect(sla).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
pnpm --filter api test -- sla.service
```

Expected: FAIL.

- [ ] **Step 3: Implement the service**

```typescript
// packages/api/src/services/sla.service.ts
import { prisma } from "../lib/prisma.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateSlaInput,
  UpdateSlaInput,
  SlaQuery,
  SlaDTO,
  ServiceRequestPriority,
} from "@utility-cis/shared";

const fullInclude = {
  escalationUser: { select: { id: true, name: true } },
} as const;

type SlaRow = {
  id: string;
  requestType: string;
  priority: ServiceRequestPriority;
  responseHours: unknown;
  resolutionHours: unknown;
  escalationHours: unknown;
  escalationUserId: string | null;
  isActive: boolean;
  escalationUser?: { id: string; name: string } | null;
};

function toDto(row: SlaRow): SlaDTO {
  return {
    id: row.id,
    requestType: row.requestType,
    priority: row.priority,
    responseHours: Number(row.responseHours),
    resolutionHours: Number(row.resolutionHours),
    escalationHours: row.escalationHours === null ? null : Number(row.escalationHours),
    escalationUserId: row.escalationUserId,
    escalationUser: row.escalationUser ?? null,
    isActive: row.isActive,
  };
}

export async function listSlas(utilityId: string, query: SlaQuery): Promise<SlaDTO[]> {
  const rows = await prisma.sla.findMany({
    where: {
      utilityId,
      ...(query.requestType ? { requestType: query.requestType } : {}),
      ...(query.includeInactive ? {} : { isActive: true }),
    },
    include: fullInclude,
    orderBy: [{ requestType: "asc" }, { priority: "asc" }],
  });
  return (rows as SlaRow[]).map(toDto);
}

export async function getSla(id: string, utilityId: string): Promise<SlaDTO> {
  const row = await prisma.sla.findFirstOrThrow({
    where: { id, utilityId },
    include: fullInclude,
  });
  return toDto(row as SlaRow);
}

export async function createSla(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateSlaInput,
): Promise<SlaDTO> {
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Sla" },
    "sla.created",
    async () => {
      const row = await prisma.sla.create({
        data: {
          utilityId,
          requestType: data.requestType,
          priority: data.priority,
          responseHours: data.responseHours,
          resolutionHours: data.resolutionHours,
          escalationHours: data.escalationHours ?? null,
          escalationUserId: data.escalationUserId ?? null,
        },
        include: fullInclude,
      });
      return toDto(row as SlaRow);
    },
  );
}

export async function updateSla(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateSlaInput,
): Promise<SlaDTO> {
  const before = await getSla(id, utilityId);
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "Sla" },
    "sla.updated",
    before,
    async () => {
      const row = await prisma.sla.update({
        where: { id },
        data: {
          ...(data.responseHours !== undefined ? { responseHours: data.responseHours } : {}),
          ...(data.resolutionHours !== undefined ? { resolutionHours: data.resolutionHours } : {}),
          ...(data.escalationHours !== undefined ? { escalationHours: data.escalationHours } : {}),
          ...(data.escalationUserId !== undefined ? { escalationUserId: data.escalationUserId } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        },
        include: fullInclude,
      });
      return toDto(row as SlaRow);
    },
  );
}

export async function deactivateSla(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
): Promise<SlaDTO> {
  return updateSla(utilityId, actorId, actorName, id, { isActive: false });
}

export async function resolveSlaForRequest(
  utilityId: string,
  requestType: string,
  priority: ServiceRequestPriority,
): Promise<{ id: string; resolutionHours: number; responseHours: number } | null> {
  const row = await prisma.sla.findFirst({
    where: { utilityId, requestType, priority, isActive: true },
    select: { id: true, responseHours: true, resolutionHours: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    responseHours: Number(row.responseHours),
    resolutionHours: Number(row.resolutionHours),
  };
}
```

- [ ] **Step 4: Run test, confirm green**

```bash
pnpm --filter api test -- sla.service
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/sla.service.ts packages/api/src/__tests__/services/sla.service.test.ts
git commit -m "feat(service-requests): SLA service CRUD + resolver"
```

---

## Task 10: Service — request-number counter

**Files:**
- Create: `packages/api/src/services/service-request-counter.service.ts`
- Create: `packages/api/src/__tests__/services/service-request-counter.service.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/api/src/__tests__/services/service-request-counter.service.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextRequestNumber } from "../../services/service-request-counter.service.js";
import { prisma } from "../../lib/prisma.js";

const UID = "00000000-0000-4000-8000-00000000000a";

describe("nextRequestNumber", () => {
  beforeEach(() => vi.clearAllMocks());

  it("formats as SR-YYYY-NNNNNN with zero-padding", async () => {
    // Mock the interactive $transaction flow: create counter row if missing, increment, return new value.
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const tx = {
          serviceRequestCounter: {
            upsert: vi.fn().mockResolvedValue({ utilityId: UID, year: 2026, nextValue: 42n }),
            update: vi.fn().mockResolvedValue({ nextValue: 43n }),
          },
        } as unknown as typeof prisma;
        return fn(tx);
      },
    );

    const result = await nextRequestNumber(UID, new Date("2026-04-23T10:00:00Z"));
    expect(result).toBe("SR-2026-000042");
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
pnpm --filter api test -- service-request-counter
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// packages/api/src/services/service-request-counter.service.ts
import { prisma } from "../lib/prisma.js";

/**
 * Mint the next per-tenant, per-year service-request number. Uses a
 * tiny counter table locked via raw SQL inside a transaction so two
 * concurrent creations on the same tenant serialize cleanly and never
 * produce duplicates. Format: SR-YYYY-NNNNNN (six-digit zero-padded).
 */
export async function nextRequestNumber(
  utilityId: string,
  now: Date = new Date(),
): Promise<string> {
  const year = now.getUTCFullYear();
  const value = await prisma.$transaction(async (tx) => {
    // Upsert ensures a row exists; the read-then-update pattern runs
    // under a row lock because $transaction uses a single connection.
    await tx.serviceRequestCounter.upsert({
      where: { utilityId_year: { utilityId, year } },
      create: { utilityId, year, nextValue: 1n },
      update: {},
    });
    // Raw SQL for SELECT ... FOR UPDATE, then bump.
    const rows = await tx.$queryRaw<Array<{ next_value: bigint }>>`
      SELECT next_value FROM service_request_counter
      WHERE utility_id = ${utilityId}::uuid AND year = ${year}
      FOR UPDATE
    `;
    const current = rows[0]!.next_value;
    await tx.serviceRequestCounter.update({
      where: { utilityId_year: { utilityId, year } },
      data: { nextValue: current + 1n },
    });
    return current;
  });
  const padded = value.toString().padStart(6, "0");
  return `SR-${year}-${padded}`;
}
```

- [ ] **Step 4: Run tests — the mocked version should pass**

```bash
pnpm --filter api test -- service-request-counter
```

Expected: PASS. (The `$queryRaw` path is exercised by the integration test in Task 14.)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/service-request-counter.service.ts packages/api/src/__tests__/services/service-request-counter.service.test.ts
git commit -m "feat(service-requests): per-tenant/year request-number counter"
```

---

## Task 11: Service — service-request lifecycle

**Files:**
- Create: `packages/api/src/services/service-request.service.ts`
- Create: `packages/api/src/__tests__/services/service-request.service.test.ts`

- [ ] **Step 1: Write failing tests for state machine + create + complete**

```typescript
// packages/api/src/__tests__/services/service-request.service.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/audit-wrap.js", () => ({
  auditCreate: vi.fn(async (_c, _e, fn) => fn()),
  auditUpdate: vi.fn(async (_c, _e, _b, fn) => fn()),
}));

const assertTypeMock = vi.fn();
vi.mock("../../services/service-request-type-def.service.js", () => ({
  assertServiceRequestTypeCode: (u: string, c: string) => assertTypeMock(u, c),
}));

const resolveSlaMock = vi.fn();
vi.mock("../../services/sla.service.js", () => ({
  resolveSlaForRequest: (u: string, t: string, p: string) => resolveSlaMock(u, t, p),
}));

const nextNumberMock = vi.fn();
vi.mock("../../services/service-request-counter.service.js", () => ({
  nextRequestNumber: (u: string) => nextNumberMock(u),
}));

import {
  createServiceRequest,
  transitionServiceRequest,
  completeServiceRequest,
  cancelServiceRequest,
  assignServiceRequest,
  updateServiceRequest,
  isValidTransition,
} from "../../services/service-request.service.js";
import { prisma } from "../../lib/prisma.js";

const UID = "00000000-0000-4000-8000-00000000000a";
const ACTOR = "00000000-0000-4000-8000-00000000000b";

function sr(partial: Partial<{ status: string; slaDueAt: Date | null; priority: string; requestType: string }> = {}) {
  return {
    id: "sr-1",
    utilityId: UID,
    requestNumber: "SR-2026-000001",
    accountId: null,
    premiseId: null,
    serviceAgreementId: null,
    requestType: partial.requestType ?? "LEAK_REPORT",
    requestSubtype: null,
    priority: partial.priority ?? "HIGH",
    status: partial.status ?? "NEW",
    source: "CSR",
    description: "desc",
    resolutionNotes: null,
    slaId: null,
    slaDueAt: partial.slaDueAt === undefined ? new Date("2026-04-23T20:00:00Z") : partial.slaDueAt,
    slaBreached: false,
    assignedTo: null,
    assignedTeam: null,
    externalSystem: null,
    externalRequestId: null,
    externalStatus: null,
    delinquencyActionId: null,
    billingAction: null,
    adhocChargeId: null,
    attachments: [],
    createdBy: ACTOR,
    createdAt: new Date("2026-04-23T10:00:00Z"),
    updatedAt: new Date(),
    completedAt: null,
    cancelledAt: null,
  };
}

describe("service-request state machine", () => {
  it.each([
    ["NEW", "ASSIGNED", true],
    ["NEW", "IN_PROGRESS", false],
    ["ASSIGNED", "IN_PROGRESS", true],
    ["IN_PROGRESS", "PENDING_FIELD", true],
    ["PENDING_FIELD", "IN_PROGRESS", true],
    ["COMPLETED", "IN_PROGRESS", false],
    ["CANCELLED", "NEW", false],
    ["FAILED", "IN_PROGRESS", false],
  ])("transition %s → %s is %s", (from, to, ok) => {
    expect(isValidTransition(from as never, to as never)).toBe(ok);
  });
});

describe("createServiceRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertTypeMock.mockResolvedValue(undefined);
    nextNumberMock.mockResolvedValue("SR-2026-000001");
  });

  it("resolves SLA and computes sla_due_at from resolutionHours", async () => {
    resolveSlaMock.mockResolvedValue({ id: "sla-1", resolutionHours: 6, responseHours: 0.5 });
    const created = sr({ status: "NEW" });
    (prisma.serviceRequest.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    const result = await createServiceRequest(UID, ACTOR, "Jane", {
      requestType: "LEAK_REPORT",
      priority: "EMERGENCY",
      description: "leak",
    });

    const args = (prisma.serviceRequest.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.data.slaId).toBe("sla-1");
    expect(args.data.slaDueAt).toBeInstanceOf(Date);
    expect(result.requestNumber).toBe("SR-2026-000001");
  });

  it("leaves slaId and slaDueAt null when no SLA matches", async () => {
    resolveSlaMock.mockResolvedValue(null);
    (prisma.serviceRequest.create as ReturnType<typeof vi.fn>).mockResolvedValue(sr());
    await createServiceRequest(UID, ACTOR, "Jane", {
      requestType: "OTHER",
      priority: "LOW",
      description: "x",
    });
    const args = (prisma.serviceRequest.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.data.slaId).toBeNull();
    expect(args.data.slaDueAt).toBeNull();
  });
});

describe("completeServiceRequest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets slaBreached=true when completed after slaDueAt", async () => {
    (prisma.serviceRequest.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
      sr({ status: "IN_PROGRESS", slaDueAt: new Date("2026-04-23T10:00:00Z") }),
    );
    (prisma.serviceRequest.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => ({
      ...sr(), ...data, status: "COMPLETED",
    }));
    vi.useFakeTimers().setSystemTime(new Date("2026-04-23T13:00:00Z"));
    const result = await completeServiceRequest(UID, ACTOR, "Jane", "sr-1", { resolutionNotes: "fixed" });
    expect(result.slaBreached).toBe(true);
    vi.useRealTimers();
  });

  it("sets slaBreached=false when completed within SLA", async () => {
    (prisma.serviceRequest.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
      sr({ status: "IN_PROGRESS", slaDueAt: new Date("2026-04-23T20:00:00Z") }),
    );
    (prisma.serviceRequest.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => ({
      ...sr(), ...data, status: "COMPLETED",
    }));
    vi.useFakeTimers().setSystemTime(new Date("2026-04-23T12:00:00Z"));
    const result = await completeServiceRequest(UID, ACTOR, "Jane", "sr-1", { resolutionNotes: "fixed" });
    expect(result.slaBreached).toBe(false);
    vi.useRealTimers();
  });

  it("rejects completion from a terminal state", async () => {
    (prisma.serviceRequest.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(sr({ status: "CANCELLED" }));
    await expect(completeServiceRequest(UID, ACTOR, "Jane", "sr-1", { resolutionNotes: "x" }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("assignServiceRequest", () => {
  it("auto-transitions NEW → ASSIGNED when assignedTo is set", async () => {
    vi.clearAllMocks();
    (prisma.serviceRequest.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(sr({ status: "NEW" }));
    (prisma.serviceRequest.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => ({
      ...sr(), ...data, status: "ASSIGNED",
    }));
    const result = await assignServiceRequest(UID, ACTOR, "Jane", "sr-1", {
      assignedTo: "00000000-0000-4000-8000-00000000000c",
    });
    expect(result.status).toBe("ASSIGNED");
  });
});

describe("updateServiceRequest", () => {
  it("recomputes slaDueAt when priority changes and a matching SLA exists", async () => {
    vi.clearAllMocks();
    (prisma.serviceRequest.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(
      sr({ status: "IN_PROGRESS", priority: "NORMAL" }),
    );
    resolveSlaMock.mockResolvedValue({ id: "sla-2", resolutionHours: 3, responseHours: 1 });
    (prisma.serviceRequest.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => ({
      ...sr(), ...data,
    }));
    const result = await updateServiceRequest(UID, ACTOR, "Jane", "sr-1", { priority: "EMERGENCY" });
    expect(result.slaId).toBe("sla-2");
    expect(result.slaDueAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run tests, confirm all fail**

```bash
pnpm --filter api test -- service-request.service
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

```typescript
// packages/api/src/services/service-request.service.ts
import { prisma } from "../lib/prisma.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { assertServiceRequestTypeCode } from "./service-request-type-def.service.js";
import { resolveSlaForRequest } from "./sla.service.js";
import { nextRequestNumber } from "./service-request-counter.service.js";
import type {
  CreateServiceRequestInput,
  UpdateServiceRequestInput,
  AssignServiceRequestInput,
  TransitionServiceRequestInput,
  CompleteServiceRequestInput,
  CancelServiceRequestInput,
  ServiceRequestQuery,
  ServiceRequestStatus,
  ServiceRequestPriority,
} from "@utility-cis/shared";

const fullInclude = {
  account: { select: { id: true, accountNumber: true, accountType: true } },
  premise: { select: { id: true, addressLine1: true, city: true, state: true, zip: true } },
  serviceAgreement: {
    select: {
      id: true,
      agreementNumber: true,
      commodity: { select: { name: true } },
      premise: { select: { addressLine1: true } },
    },
  },
  sla: { select: { id: true, responseHours: true, resolutionHours: true } },
  assignee: { select: { id: true, name: true, email: true } },
  creator: { select: { id: true, name: true } },
} as const;

const VALID_TRANSITIONS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
  NEW:           ["ASSIGNED", "CANCELLED"],
  ASSIGNED:      ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS:   ["PENDING_FIELD", "COMPLETED", "FAILED", "CANCELLED"],
  PENDING_FIELD: ["IN_PROGRESS", "COMPLETED", "FAILED"],
  COMPLETED:     [],
  CANCELLED:     [],
  FAILED:        [],
};

export function isValidTransition(from: ServiceRequestStatus, to: ServiceRequestStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

function invalidTransition(from: ServiceRequestStatus, to: ServiceRequestStatus): Error {
  return Object.assign(
    new Error(`Invalid status transition: ${from} → ${to}`),
    { statusCode: 409, code: "INVALID_SERVICE_REQUEST_TRANSITION", currentStatus: from },
  );
}

function computeSlaDueAt(createdAt: Date, resolutionHours: number): Date {
  return new Date(createdAt.getTime() + resolutionHours * 60 * 60 * 1000);
}

export async function listServiceRequests(utilityId: string, query: ServiceRequestQuery) {
  const where: Record<string, unknown> = { utilityId };
  if (query.type) where.requestType = query.type;
  if (query.status) where.status = Array.isArray(query.status) ? { in: query.status } : query.status;
  if (query.priority) where.priority = Array.isArray(query.priority) ? { in: query.priority } : query.priority;
  if (query.accountId) where.accountId = query.accountId;
  if (query.premiseId) where.premiseId = query.premiseId;
  if (query.assignedTo) where.assignedTo = query.assignedTo;
  if (query.dateFrom || query.dateTo) {
    where.createdAt = {
      ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
      ...(query.dateTo ? { lte: new Date(query.dateTo + "T23:59:59Z") } : {}),
    };
  }
  if (query.q) {
    where.OR = [
      { requestNumber: { contains: query.q, mode: "insensitive" } },
      { description:   { contains: query.q, mode: "insensitive" } },
    ];
  }
  if (query.slaStatus) {
    const now = new Date();
    if (query.slaStatus === "breached") {
      where.slaDueAt = { lt: now };
      where.status = { notIn: ["COMPLETED", "CANCELLED", "FAILED"] };
    } else if (query.slaStatus === "at_risk") {
      // slaDueAt in future, within 50% of the remaining window heuristic:
      // treat "at_risk" as slaDueAt within the next 8 hours.
      const soon = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      where.slaDueAt = { gte: now, lte: soon };
      where.status = { notIn: ["COMPLETED", "CANCELLED", "FAILED"] };
    } else {
      where.slaDueAt = { gt: new Date(Date.now() + 8 * 60 * 60 * 1000) };
      where.status = { notIn: ["COMPLETED", "CANCELLED", "FAILED"] };
    }
  }
  const take = Math.min(query.limit ?? 50, 500);
  const rows = await prisma.serviceRequest.findMany({
    where,
    include: fullInclude,
    orderBy: [{ createdAt: "desc" }],
    take,
  });
  return { data: rows, total: rows.length };
}

export async function getServiceRequest(id: string, utilityId: string) {
  return prisma.serviceRequest.findFirstOrThrow({
    where: { id, utilityId },
    include: fullInclude,
  });
}

export async function createServiceRequest(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateServiceRequestInput,
) {
  await assertServiceRequestTypeCode(utilityId, data.requestType);
  const now = new Date();
  const sla = await resolveSlaForRequest(utilityId, data.requestType, data.priority);
  const requestNumber = await nextRequestNumber(utilityId, now);
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "ServiceRequest" },
    "service_request.created",
    async () =>
      prisma.serviceRequest.create({
        data: {
          utilityId,
          requestNumber,
          accountId: data.accountId ?? null,
          premiseId: data.premiseId ?? null,
          serviceAgreementId: data.serviceAgreementId ?? null,
          requestType: data.requestType,
          requestSubtype: data.requestSubtype ?? null,
          priority: data.priority,
          status: "NEW",
          source: "CSR",
          description: data.description,
          slaId: sla?.id ?? null,
          slaDueAt: sla ? computeSlaDueAt(now, sla.resolutionHours) : null,
          createdBy: actorId,
        },
        include: fullInclude,
      }),
  );
}

export async function updateServiceRequest(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateServiceRequestInput,
) {
  const before = await getServiceRequest(id, utilityId);
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceRequest" },
    "service_request.updated",
    before,
    async () => {
      const priorityChanged = data.priority !== undefined && data.priority !== before.priority;
      let slaPatch: { slaId?: string | null; slaDueAt?: Date | null } = {};
      if (priorityChanged) {
        const sla = await resolveSlaForRequest(utilityId, before.requestType, data.priority!);
        slaPatch = {
          slaId: sla?.id ?? null,
          slaDueAt: sla ? computeSlaDueAt(before.createdAt, sla.resolutionHours) : null,
        };
      }
      return prisma.serviceRequest.update({
        where: { id },
        data: {
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.priority !== undefined ? { priority: data.priority } : {}),
          ...(data.requestSubtype !== undefined ? { requestSubtype: data.requestSubtype } : {}),
          ...slaPatch,
        },
        include: fullInclude,
      });
    },
  );
}

export async function assignServiceRequest(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: AssignServiceRequestInput,
) {
  const before = await getServiceRequest(id, utilityId);
  if (["COMPLETED", "CANCELLED", "FAILED"].includes(before.status)) {
    throw Object.assign(
      new Error("Cannot assign a terminal request"),
      { statusCode: 409, code: "SERVICE_REQUEST_TERMINAL" },
    );
  }
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceRequest" },
    "service_request.assigned",
    before,
    async () =>
      prisma.serviceRequest.update({
        where: { id },
        data: {
          ...(data.assignedTo !== undefined ? { assignedTo: data.assignedTo } : {}),
          ...(data.assignedTeam !== undefined ? { assignedTeam: data.assignedTeam } : {}),
          ...(before.status === "NEW" ? { status: "ASSIGNED" } : {}),
        },
        include: fullInclude,
      }),
  );
}

export async function transitionServiceRequest(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: TransitionServiceRequestInput,
) {
  const before = await getServiceRequest(id, utilityId);
  if (!isValidTransition(before.status, data.toStatus)) {
    throw invalidTransition(before.status, data.toStatus);
  }
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceRequest" },
    "service_request.transitioned",
    before,
    async () =>
      prisma.serviceRequest.update({
        where: { id },
        data: {
          status: data.toStatus,
          ...(data.notes
            ? { resolutionNotes: before.resolutionNotes
                ? `${before.resolutionNotes}\n\n${data.notes}`
                : data.notes }
            : {}),
        },
        include: fullInclude,
      }),
  );
}

export async function completeServiceRequest(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: CompleteServiceRequestInput,
) {
  const before = await getServiceRequest(id, utilityId);
  if (!isValidTransition(before.status, "COMPLETED")) {
    throw invalidTransition(before.status, "COMPLETED");
  }
  const now = new Date();
  const breached = before.slaDueAt ? now > before.slaDueAt : false;
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceRequest" },
    "service_request.completed",
    before,
    async () =>
      prisma.serviceRequest.update({
        where: { id },
        data: {
          status: "COMPLETED",
          completedAt: now,
          resolutionNotes: data.resolutionNotes,
          slaBreached: breached,
        },
        include: fullInclude,
      }),
  );
}

export async function cancelServiceRequest(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: CancelServiceRequestInput,
) {
  const before = await getServiceRequest(id, utilityId);
  if (!isValidTransition(before.status, "CANCELLED")) {
    throw invalidTransition(before.status, "CANCELLED");
  }
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceRequest" },
    "service_request.cancelled",
    before,
    async () =>
      prisma.serviceRequest.update({
        where: { id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          resolutionNotes: before.resolutionNotes
            ? `${before.resolutionNotes}\n\nCancelled: ${data.reason}`
            : `Cancelled: ${data.reason}`,
        },
        include: fullInclude,
      }),
  );
}

export async function listByAccount(utilityId: string, accountId: string) {
  return prisma.serviceRequest.findMany({
    where: { utilityId, accountId },
    include: fullInclude,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function listByPremise(utilityId: string, premiseId: string) {
  return prisma.serviceRequest.findMany({
    where: { utilityId, premiseId },
    include: fullInclude,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
```

- [ ] **Step 4: Run tests, confirm green**

```bash
pnpm --filter api test -- service-request.service
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/service-request.service.ts packages/api/src/__tests__/services/service-request.service.test.ts
git commit -m "feat(service-requests): service-request lifecycle service + tests"
```

---

## Task 12: Route — service-request-types

**Files:**
- Create: `packages/api/src/routes/service-request-types.ts`
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Write the route module**

```typescript
// packages/api/src/routes/service-request-types.ts
import type { FastifyInstance } from "fastify";
import { serviceRequestTypeQuerySchema } from "@utility-cis/shared";
import { listServiceRequestTypes } from "../services/service-request-type-def.service.js";

export async function serviceRequestTypeRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/service-request-types",
    { config: { module: "service_requests", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = serviceRequestTypeQuerySchema.parse(request.query);
      const result = await listServiceRequestTypes(utilityId, {
        includeInactive: query.includeInactive,
      });
      return reply.send(result);
    },
  );
}
```

- [ ] **Step 2: Register in app.ts**

Add import near the other route imports:
```typescript
import { serviceRequestTypeRoutes } from "./routes/service-request-types.js";
```

Add registration after `serviceEventRoutes`:
```typescript
await app.register(serviceRequestTypeRoutes);
```

- [ ] **Step 3: Build + run type check**

```bash
pnpm --filter api typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/service-request-types.ts packages/api/src/app.ts
git commit -m "feat(service-requests): route — GET /service-request-types"
```

---

## Task 13: Route — SLAs

**Files:**
- Create: `packages/api/src/routes/slas.ts`
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Write the route module**

```typescript
// packages/api/src/routes/slas.ts
import type { FastifyInstance } from "fastify";
import {
  createSlaSchema,
  updateSlaSchema,
  slaQuerySchema,
} from "@utility-cis/shared";
import {
  listSlas,
  getSla,
  createSla,
  updateSla,
  deactivateSla,
} from "../services/sla.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function slaRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/slas",
    module: "service_request_slas",
    list: {
      querySchema: slaQuerySchema,
      service: (utilityId, query) => listSlas(utilityId, query as never),
    },
    get: getSla,
    create: {
      bodySchema: createSlaSchema,
      service: (user, data) =>
        createSla(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateSlaSchema,
      service: (user, id, data) =>
        updateSla(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
  });

  app.delete(
    "/api/v1/slas/:id",
    { config: { module: "service_request_slas", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const result = await deactivateSla(utilityId, actorId, actorName, id);
      return reply.send(result);
    },
  );
}
```

- [ ] **Step 2: Register in app.ts**

```typescript
import { slaRoutes } from "./routes/slas.js";
// ...
await app.register(slaRoutes);
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter api typecheck
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/slas.ts packages/api/src/app.ts
git commit -m "feat(service-requests): route — /slas CRUD"
```

---

## Task 14: Route — service-requests + integration tests

**Files:**
- Create: `packages/api/src/routes/service-requests.ts`
- Modify: `packages/api/src/app.ts`
- Create: `packages/api/src/__tests__/integration/service-requests.test.ts`

- [ ] **Step 1: Write the route module**

```typescript
// packages/api/src/routes/service-requests.ts
import type { FastifyInstance } from "fastify";
import {
  createServiceRequestSchema,
  updateServiceRequestSchema,
  assignServiceRequestSchema,
  transitionServiceRequestSchema,
  completeServiceRequestSchema,
  cancelServiceRequestSchema,
  serviceRequestQuerySchema,
} from "@utility-cis/shared";
import {
  listServiceRequests,
  getServiceRequest,
  createServiceRequest,
  updateServiceRequest,
  assignServiceRequest,
  transitionServiceRequest,
  completeServiceRequest,
  cancelServiceRequest,
  listByAccount,
  listByPremise,
} from "../services/service-request.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";
import { idParamSchema } from "../lib/route-schemas.js";
import { z } from "zod";

const uuidParam = z.object({ id: z.string().uuid() });

export async function serviceRequestRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/service-requests",
    module: "service_requests",
    list: {
      querySchema: serviceRequestQuerySchema,
      service: (utilityId, query) => listServiceRequests(utilityId, query as never),
    },
    get: getServiceRequest,
    create: {
      bodySchema: createServiceRequestSchema,
      service: (user, data) =>
        createServiceRequest(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateServiceRequestSchema,
      service: (user, id, data) =>
        updateServiceRequest(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
  });

  app.post(
    "/api/v1/service-requests/:id/assign",
    { config: { module: "service_requests", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = assignServiceRequestSchema.parse(request.body);
      return reply.send(await assignServiceRequest(utilityId, actorId, actorName, id, data));
    },
  );

  app.post(
    "/api/v1/service-requests/:id/transition",
    { config: { module: "service_requests", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = transitionServiceRequestSchema.parse(request.body);
      return reply.send(await transitionServiceRequest(utilityId, actorId, actorName, id, data));
    },
  );

  app.post(
    "/api/v1/service-requests/:id/complete",
    { config: { module: "service_requests", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = completeServiceRequestSchema.parse(request.body);
      return reply.send(await completeServiceRequest(utilityId, actorId, actorName, id, data));
    },
  );

  app.post(
    "/api/v1/service-requests/:id/cancel",
    { config: { module: "service_requests", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = cancelServiceRequestSchema.parse(request.body);
      return reply.send(await cancelServiceRequest(utilityId, actorId, actorName, id, data));
    },
  );

  app.get(
    "/api/v1/accounts/:id/service-requests",
    { config: { module: "service_requests", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = uuidParam.parse(request.params);
      return reply.send(await listByAccount(utilityId, id));
    },
  );

  app.get(
    "/api/v1/premises/:id/service-requests",
    { config: { module: "service_requests", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = uuidParam.parse(request.params);
      return reply.send(await listByPremise(utilityId, id));
    },
  );
}
```

- [ ] **Step 2: Register in app.ts**

```typescript
import { serviceRequestRoutes } from "./routes/service-requests.js";
// ...
await app.register(serviceRequestRoutes);
```

- [ ] **Step 3: Write integration test**

```typescript
// packages/api/src/__tests__/integration/service-requests.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";

const UID = "00000000-0000-4000-8000-000000000001"; // dev tenant

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

async function csrToken() {
  return createTestToken({ role: "CSR", utilityId: UID });
}

async function portalToken() {
  return createTestToken({ role: "Portal Customer", utilityId: UID, customerId: "00000000-0000-4000-8000-00000000abcd" });
}

describe("service-requests routes", () => {
  beforeEach(async () => {
    await prisma.serviceRequest.deleteMany({ where: { utilityId: UID } });
  });

  it("creates a request, then lists it, then completes it", async () => {
    const token = await csrToken();
    const headers = { authorization: `Bearer ${token}` };

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/service-requests",
      headers,
      payload: {
        requestType: "LEAK_REPORT",
        priority: "HIGH",
        description: "pipe leak near meter",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.requestNumber).toMatch(/^SR-\d{4}-\d{6}$/);
    expect(created.status).toBe("NEW");

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/service-requests",
      headers,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().data.some((r: { id: string }) => r.id === created.id)).toBe(true);

    // NEW → ASSIGNED (via /assign auto-transition)
    const assignRes = await app.inject({
      method: "POST",
      url: `/api/v1/service-requests/${created.id}/assign`,
      headers,
      payload: { assignedTeam: "Field Ops" },
    });
    expect(assignRes.json().status).toBe("ASSIGNED");

    // ASSIGNED → IN_PROGRESS
    await app.inject({
      method: "POST",
      url: `/api/v1/service-requests/${created.id}/transition`,
      headers,
      payload: { toStatus: "IN_PROGRESS" },
    });

    // Complete
    const completeRes = await app.inject({
      method: "POST",
      url: `/api/v1/service-requests/${created.id}/complete`,
      headers,
      payload: { resolutionNotes: "Fixed the leak, no further action." },
    });
    expect(completeRes.statusCode).toBe(200);
    expect(completeRes.json().status).toBe("COMPLETED");
  });

  it("rejects invalid status transitions with 409", async () => {
    const token = await csrToken();
    const headers = { authorization: `Bearer ${token}` };

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/service-requests",
      headers,
      payload: { requestType: "OTHER", priority: "LOW", description: "x" },
    });
    const { id } = createRes.json();
    // NEW → IN_PROGRESS is invalid (must go through ASSIGNED).
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-requests/${id}/transition`,
      headers,
      payload: { toStatus: "IN_PROGRESS" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("denies portal customers", async () => {
    const token = await portalToken();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/service-requests",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 4: Run the integration test against the dev DB**

```bash
./start_db.bat
./seed_db.bat
pnpm --filter api test -- integration/service-requests
```

Expected: all three tests PASS. (This exercises the real `$queryRaw` FOR UPDATE path in the counter.)

- [ ] **Step 5: Run the full api test suite**

```bash
pnpm --filter api test
```

Expected: 240+ tests green (was 205 + ~35–45 new).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/service-requests.ts packages/api/src/app.ts packages/api/src/__tests__/integration/service-requests.test.ts
git commit -m "feat(service-requests): service-request routes + integration tests"
```

---

## Task 15: Seed — type-defs, SLAs, demo requests, role permissions

**Files:**
- Modify: `seed.js`

- [ ] **Step 1: Add constants near the top of seed.js**

Locate the `UID = "00000000-0000-4000-8000-000000000001"` constant. Below the commodities block, before the accounts block, add:

```javascript
  // --- Service Request Type Definitions (globals — utility_id null) ---
  await p.serviceRequestTypeDef.deleteMany({ where: { utilityId: null } });
  const srTypes = [
    { code: "LEAK_REPORT",      label: "Leak report",        sortOrder: 10 },
    { code: "DISCONNECT",       label: "Service disconnect", sortOrder: 20 },
    { code: "RECONNECT",        label: "Service reconnect",  sortOrder: 30 },
    { code: "START_SERVICE",    label: "Start service",      sortOrder: 40 },
    { code: "STOP_SERVICE",     label: "Stop service",       sortOrder: 50 },
    { code: "BILLING_DISPUTE",  label: "Billing dispute",    sortOrder: 60 },
    { code: "METER_ISSUE",      label: "Meter issue",        sortOrder: 70 },
    { code: "OTHER",            label: "Other",              sortOrder: 900 },
  ];
  for (const t of srTypes) {
    await p.serviceRequestTypeDef.create({ data: { utilityId: null, ...t } });
  }
```

- [ ] **Step 2: Add SLA seed rows**

After the service-request type-defs block:

```javascript
  // --- SLAs for the dev tenant ---
  await p.sla.deleteMany({ where: { utilityId: UID } });
  const slaRows = [
    { requestType: "LEAK_REPORT",     priority: "EMERGENCY", responseHours: 0.5, resolutionHours: 6 },
    { requestType: "LEAK_REPORT",     priority: "HIGH",      responseHours: 2,   resolutionHours: 12 },
    { requestType: "LEAK_REPORT",     priority: "NORMAL",    responseHours: 4,   resolutionHours: 24 },
    { requestType: "LEAK_REPORT",     priority: "LOW",       responseHours: 24,  resolutionHours: 72 },
    { requestType: "DISCONNECT",      priority: "HIGH",      responseHours: 2,   resolutionHours: 8 },
    { requestType: "DISCONNECT",      priority: "NORMAL",    responseHours: 4,   resolutionHours: 24 },
    { requestType: "DISCONNECT",      priority: "LOW",       responseHours: 24,  resolutionHours: 48 },
    { requestType: "BILLING_DISPUTE", priority: "NORMAL",    responseHours: 8,   resolutionHours: 72 },
  ];
  for (const s of slaRows) {
    await p.sla.create({ data: { utilityId: UID, ...s } });
  }
```

- [ ] **Step 3: Add demo ServiceRequest rows at the end of the existing seeding, after accounts**

Locate where accounts are created. Pick the first two account IDs from the created variables. Add at the end of the seed:

```javascript
  // --- Demo Service Requests ---
  const allAccounts = await p.account.findMany({ where: { utilityId: UID }, take: 2 });
  if (allAccounts.length >= 2) {
    const [acc1, acc2] = allAccounts;
    await p.serviceRequest.deleteMany({ where: { utilityId: UID } });
    const now = new Date();
    const hoursAgo = (h) => new Date(now.getTime() - h * 60 * 60 * 1000);

    const sla1 = await p.sla.findFirst({ where: { utilityId: UID, requestType: "LEAK_REPORT", priority: "EMERGENCY" } });
    await p.serviceRequest.create({
      data: {
        utilityId: UID,
        requestNumber: "SR-2026-000001",
        accountId: acc1.id,
        premiseId: acc1.premiseId ?? null,
        requestType: "LEAK_REPORT",
        priority: "EMERGENCY",
        status: "IN_PROGRESS",
        source: "CSR",
        description: "Water pooling near sidewalk, suspected main line.",
        slaId: sla1?.id ?? null,
        slaDueAt: sla1 ? new Date(hoursAgo(10).getTime() + Number(sla1.resolutionHours) * 60 * 60 * 1000) : null,
        createdAt: hoursAgo(10),
      },
    });

    const sla2 = await p.sla.findFirst({ where: { utilityId: UID, requestType: "DISCONNECT", priority: "NORMAL" } });
    await p.serviceRequest.create({
      data: {
        utilityId: UID,
        requestNumber: "SR-2026-000002",
        accountId: acc2.id,
        premiseId: acc2.premiseId ?? null,
        requestType: "DISCONNECT",
        priority: "NORMAL",
        status: "NEW",
        source: "CSR",
        description: "Customer requested disconnect after move-out.",
        slaId: sla2?.id ?? null,
        slaDueAt: sla2 ? new Date(now.getTime() + Number(sla2.resolutionHours) * 60 * 60 * 1000) : null,
      },
    });

    await p.serviceRequest.create({
      data: {
        utilityId: UID,
        requestNumber: "SR-2026-000003",
        accountId: acc1.id,
        requestType: "METER_ISSUE",
        priority: "LOW",
        status: "COMPLETED",
        source: "CSR",
        description: "Reported stuck register; tested and cleared.",
        resolutionNotes: "Register reseated, reads normal.",
        completedAt: hoursAgo(48),
        createdAt: hoursAgo(72),
      },
    });

    await p.serviceRequestCounter.upsert({
      where: { utilityId_year: { utilityId: UID, year: 2026 } },
      create: { utilityId: UID, year: 2026, nextValue: 4n },
      update: { nextValue: 4n },
    });
  }
```

- [ ] **Step 4: Ensure role seeding picks up new modules**

Roles are seeded from `PRESET_ROLES` via `@utility-cis/shared`, so Task 4 already wires them through. Grep `seed.js` for where roles are created to confirm it iterates `PRESET_ROLES` dynamically. If not, add `service_requests: [...]` to the hard-coded role payload there.

- [ ] **Step 5: Run the seed**

```bash
./seed_db.bat
```

Expected: seed completes, `psql -c "SELECT count(*) FROM service_request_type_def"` returns 8, `"SELECT count(*) FROM sla WHERE utility_id='00000000-0000-4000-8000-000000000001'"` returns 8, `"SELECT count(*) FROM service_request"` returns 3.

- [ ] **Step 6: Commit**

```bash
git add seed.js
git commit -m "feat(service-requests): seed type-defs, SLAs, and demo requests"
```

---

## Task 16: Web — shared SLA countdown component

**Files:**
- Create: `packages/web/components/service-requests/sla-countdown.tsx`

- [ ] **Step 1: Write the component**

```tsx
"use client";

export interface SlaCountdownProps {
  slaDueAt: string | null;
  slaBreached: boolean;
  status: string;
}

const TERMINAL = new Set(["COMPLETED", "CANCELLED", "FAILED"]);

export function SlaCountdown({ slaDueAt, slaBreached, status }: SlaCountdownProps) {
  if (TERMINAL.has(status) || !slaDueAt) {
    return <span style={{ color: "var(--text-muted)" }}>—</span>;
  }
  const due = new Date(slaDueAt).getTime();
  const now = Date.now();
  const ms = due - now;
  if (slaBreached || ms < 0) {
    const hoursOver = Math.round(-ms / 3_600_000);
    return (
      <span style={{ color: "var(--danger)", fontWeight: 600 }}>
        BREACHED · {hoursOver}h over
      </span>
    );
  }
  const hoursLeft = Math.floor(ms / 3_600_000);
  const minutesLeft = Math.floor((ms % 3_600_000) / 60_000);
  const warn = ms < 8 * 3_600_000;
  return (
    <span style={{ color: warn ? "var(--warning)" : "var(--success)", fontWeight: 600 }}>
      {hoursLeft >= 24
        ? `${Math.floor(hoursLeft / 24)}d ${hoursLeft % 24}h left`
        : `${hoursLeft}h ${minutesLeft}m left`}
    </span>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter web typecheck
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/components/service-requests/
git commit -m "feat(web): SlaCountdown shared component"
```

---

## Task 17: Web — shared service-request list component

**Files:**
- Create: `packages/web/components/service-requests/request-list.tsx`

- [ ] **Step 1: Write the component using EntityListPage pattern**

Study `packages/web/app/service-suspensions/page.tsx` for the `EntityListPage` + columns pattern. Write a wrapper consumed by both the queue page and the account tab:

```tsx
"use client";

import Link from "next/link";
import { EntityListPage } from "@/components/ui/entity-list-page";
import type { Column } from "@/components/ui/data-table";
import { SlaCountdown } from "./sla-countdown";

export interface ServiceRequestRow {
  id: string;
  requestNumber: string;
  requestType: string;
  status: string;
  priority: string;
  slaDueAt: string | null;
  slaBreached: boolean;
  createdAt: string;
  account: { id: string; accountNumber: string } | null;
  premise: { id: string; addressLine1: string } | null;
  assignee: { id: string; name: string } | null;
  assignedTeam: string | null;
}

const STATUS_OPTIONS = [
  { value: "NEW", label: "New" },
  { value: "ASSIGNED", label: "Assigned" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "PENDING_FIELD", label: "Pending Field" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "FAILED", label: "Failed" },
];

const PRIORITY_OPTIONS = [
  { value: "EMERGENCY", label: "Emergency" },
  { value: "HIGH", label: "High" },
  { value: "NORMAL", label: "Normal" },
  { value: "LOW", label: "Low" },
];

const columns: Column<ServiceRequestRow>[] = [
  {
    key: "requestNumber",
    header: "Request #",
    render: (row) => (
      <Link href={`/service-requests/${row.id}`} style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}>
        {row.requestNumber}
      </Link>
    ),
  },
  {
    key: "requestType",
    header: "Type",
    render: (row) => <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em" }}>{row.requestType.replace(/_/g, " ")}</span>,
  },
  {
    key: "account",
    header: "Account",
    render: (row) => row.account ? <Link href={`/accounts/${row.account.id}`}>{row.account.accountNumber}</Link> : <span style={{ color: "var(--text-muted)" }}>—</span>,
  },
  {
    key: "premise",
    header: "Premise",
    render: (row) => row.premise ? <span>{row.premise.addressLine1}</span> : <span style={{ color: "var(--text-muted)" }}>—</span>,
  },
  { key: "priority", header: "Priority", render: (row) => <span style={{ fontSize: 11, fontWeight: 700 }}>{row.priority}</span> },
  { key: "status", header: "Status", render: (row) => <span style={{ fontSize: 11, fontWeight: 700 }}>{row.status.replace("_", " ")}</span> },
  { key: "assignee", header: "Assigned", render: (row) => row.assignee?.name ?? row.assignedTeam ?? <span style={{ color: "var(--text-muted)" }}>unassigned</span> },
  { key: "sla", header: "SLA", render: (row) => <SlaCountdown slaDueAt={row.slaDueAt} slaBreached={row.slaBreached} status={row.status} /> },
  { key: "createdAt", header: "Created", render: (row) => new Date(row.createdAt).toLocaleDateString() },
];

export interface ServiceRequestListProps {
  endpoint?: string;
  accountScope?: string;
  showFilters?: boolean;
  createHref?: string;
}

export function ServiceRequestList({
  endpoint = "/api/v1/service-requests",
  accountScope,
  showFilters = true,
  createHref,
}: ServiceRequestListProps) {
  return (
    <EntityListPage<ServiceRequestRow>
      title={accountScope ? "Service Requests" : undefined}
      endpoint={accountScope ? `/api/v1/accounts/${accountScope}/service-requests` : endpoint}
      columns={columns}
      filters={showFilters ? [
        { key: "status", label: "Status", options: STATUS_OPTIONS, multi: true },
        { key: "priority", label: "Priority", options: PRIORITY_OPTIONS, multi: true },
      ] : []}
      createButton={createHref ? { href: createHref, label: "+ New Service Request" } : undefined}
    />
  );
}
```

(If `EntityListPage` props differ, align to its actual signature — read `packages/web/components/ui/entity-list-page.tsx` and adapt.)

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter web typecheck
```

Expected: green. Fix prop mismatches against the real `EntityListPage` signature as needed.

- [ ] **Step 3: Commit**

```bash
git add packages/web/components/service-requests/request-list.tsx
git commit -m "feat(web): shared service-request list component"
```

---

## Task 18: Web — queue page

**Files:**
- Create: `packages/web/app/service-requests/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
"use client";

import { ServiceRequestList } from "@/components/service-requests/request-list";

export default function ServiceRequestsPage() {
  return <ServiceRequestList createHref="/service-requests/new" />;
}
```

- [ ] **Step 2: Start dev server and smoke-test**

```bash
pnpm dev
```

Open `http://localhost:3000/service-requests`, log in as a CSR. Expected: queue renders, two seeded active rows + one completed row visible, SLA countdown shows colors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/app/service-requests/page.tsx
git commit -m "feat(web): service-requests queue page"
```

---

## Task 19: Web — creation page

**Files:**
- Create: `packages/web/app/service-requests/new/page.tsx`

- [ ] **Step 1: Write the page**

Follow the mockup in the spec (§4.2). Use `SearchableEntitySelect` for the account picker, `formatAgreementLabel` for agreement options, and fetch SLA preview live as type/priority changes. Key contract:

- Account typeahead → on select, load `/api/v1/accounts/:id` to pick up `premiseId` + agreements via existing relations.
- Hide agreement field if no agreements; read-only pill if one; dropdown if two+.
- SLA preview fetches `/api/v1/slas?requestType=<type>` on every type/priority change, finds the matching priority row, and renders response/resolution hours + computed `due at`.
- Submit `POST /api/v1/service-requests` with `{ accountId, premiseId, serviceAgreementId, requestType, requestSubtype, priority, description }`.
- Redirect to `/service-requests/:id` on success.

```tsx
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { SearchableEntitySelect } from "@/components/ui/searchable-entity-select";
import { api } from "@/lib/api-client";
import { formatAgreementLabel } from "@utility-cis/shared";

interface Account { id: string; accountNumber: string; customer?: { name: string } | null; premiseId?: string | null; serviceAgreements?: Array<{ id: string; agreementNumber: string; commodity?: { name: string } | null; premise?: { addressLine1: string } | null; status: string }>; }
interface ServiceRequestType { code: string; label: string; }
interface Sla { id: string; requestType: string; priority: string; responseHours: number; resolutionHours: number; }

const PRIORITIES = ["EMERGENCY", "HIGH", "NORMAL", "LOW"] as const;

export default function NewServiceRequestPage() {
  const router = useRouter();
  const [types, setTypes] = useState<ServiceRequestType[]>([]);
  const [account, setAccount] = useState<Account | null>(null);
  const [serviceAgreementId, setServiceAgreementId] = useState<string>("");
  const [requestType, setRequestType] = useState<string>("");
  const [priority, setPriority] = useState<string>("NORMAL");
  const [subtype, setSubtype] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [slaPreview, setSlaPreview] = useState<Sla | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<ServiceRequestType[]>("/api/v1/service-request-types").then((res) => {
      setTypes(res);
      if (!requestType && res[0]) setRequestType(res[0].code);
    });
  }, []);

  useEffect(() => {
    if (!requestType) { setSlaPreview(null); return; }
    api.get<Sla[]>(`/api/v1/slas?requestType=${requestType}`).then((res) => {
      setSlaPreview(res.find((s) => s.priority === priority) ?? null);
    });
  }, [requestType, priority]);

  const activeAgreements = account?.serviceAgreements?.filter((a) => a.status === "ACTIVE") ?? [];
  useEffect(() => {
    if (activeAgreements.length === 1) setServiceAgreementId(activeAgreements[0].id);
    else if (activeAgreements.length === 0) setServiceAgreementId("");
  }, [account?.id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!account || !requestType || !description) return;
    setSubmitting(true);
    try {
      const created = await api.post<{ id: string }>("/api/v1/service-requests", {
        accountId: account.id,
        premiseId: account.premiseId ?? null,
        serviceAgreementId: serviceAgreementId || null,
        requestType,
        requestSubtype: subtype || null,
        priority,
        description,
      });
      router.push(`/service-requests/${created.id}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 18 }}>New Service Request</h1>
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 18 }}>
        <div>
          <section style={{ background: "white", border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginBottom: 14 }}>
            <h4 style={{ marginTop: 0 }}>Who / where</h4>
            <label>Account *</label>
            <SearchableEntitySelect<Account>
              value={account}
              onChange={setAccount}
              endpoint="/api/v1/accounts"
              placeholder="Search accounts by number or name..."
              renderLabel={(a) => `${a.accountNumber} · ${a.customer?.name ?? ""}`}
            />
            {activeAgreements.length >= 2 && (
              <>
                <label>Service agreement</label>
                <select value={serviceAgreementId} onChange={(e) => setServiceAgreementId(e.target.value)}>
                  <option value="">— none —</option>
                  {activeAgreements.map((a) => (
                    <option key={a.id} value={a.id}>{formatAgreementLabel(a)}</option>
                  ))}
                </select>
              </>
            )}
            {activeAgreements.length === 1 && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                Auto-selected: {formatAgreementLabel(activeAgreements[0])}
              </div>
            )}
          </section>

          <section style={{ background: "white", border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}>
            <h4 style={{ marginTop: 0 }}>Request details</h4>
            <label>Type *</label>
            <select value={requestType} onChange={(e) => setRequestType(e.target.value)}>
              {types.map((t) => <option key={t.code} value={t.code}>{t.code} — {t.label}</option>)}
            </select>
            <label style={{ marginTop: 12 }}>Subtype</label>
            <input type="text" value={subtype} onChange={(e) => setSubtype(e.target.value)} />
            <label style={{ marginTop: 12 }}>Priority *</label>
            <div style={{ display: "flex", gap: 6 }}>
              {PRIORITIES.map((p) => (
                <button key={p} type="button"
                  onClick={() => setPriority(p)}
                  style={{
                    flex: 1, padding: 7, borderRadius: 6,
                    border: priority === p ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: priority === p ? "var(--accent)" : "white",
                    color: priority === p ? "white" : "var(--text)",
                  }}
                >{p}</button>
              ))}
            </div>
            <label style={{ marginTop: 12 }}>Description *</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
          </section>
        </div>

        <aside>
          <section style={{ background: "white", border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}>
            <h4 style={{ marginTop: 0 }}>SLA preview</h4>
            {slaPreview ? (
              <div style={{ fontSize: 13 }}>
                <div>Matching: {slaPreview.requestType} · {slaPreview.priority}</div>
                <div>Response: {slaPreview.responseHours}h</div>
                <div>Resolution: {slaPreview.resolutionHours}h</div>
                <div>Due at: {new Date(Date.now() + slaPreview.resolutionHours * 3600 * 1000).toLocaleString()}</div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--warning)" }}>No SLA configured for this type/priority.</div>
            )}
          </section>
        </aside>
      </div>

      <div style={{ marginTop: 18, display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={() => router.back()}>Cancel</button>
        <button type="submit" disabled={submitting || !account || !requestType || !description}>
          Create Request
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Typecheck and smoke-test in browser**

```bash
pnpm --filter web typecheck
```

Navigate to `/service-requests/new`, create a leak report. Expected: redirect to detail page with request number.

- [ ] **Step 3: Commit**

```bash
git add packages/web/app/service-requests/new/page.tsx
git commit -m "feat(web): service-request creation form with SLA preview"
```

---

## Task 20: Web — detail page

**Files:**
- Create: `packages/web/app/service-requests/[id]/page.tsx`

- [ ] **Step 1: Write the detail page**

Two-column layout per the spec §4.3. Panels: context card, description, resolution form, assignment, status actions, timeline from `/api/v1/audit-log?entityType=ServiceRequest&entityId=:id`. Status actions derived from a `VALID_TRANSITIONS` map identical to the backend's (consider importing from shared — add an export if not already there).

```tsx
"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { SlaCountdown } from "@/components/service-requests/sla-countdown";
import { formatAgreementLabel } from "@utility-cis/shared";

// UI mirror of the server state machine; keep in sync with service.
const UI_VALID_TRANSITIONS: Record<string, string[]> = {
  NEW: ["ASSIGNED"],
  ASSIGNED: ["IN_PROGRESS"],
  IN_PROGRESS: ["PENDING_FIELD"],
  PENDING_FIELD: ["IN_PROGRESS"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

interface ServiceRequest {
  id: string;
  requestNumber: string;
  requestType: string;
  priority: string;
  status: string;
  description: string;
  resolutionNotes: string | null;
  slaDueAt: string | null;
  slaBreached: boolean;
  createdAt: string;
  assignedTo: string | null;
  assignedTeam: string | null;
  account: { id: string; accountNumber: string } | null;
  premise: { id: string; addressLine1: string } | null;
  serviceAgreement: { id: string; agreementNumber: string; commodity?: { name: string } | null; premise?: { addressLine1: string } | null } | null;
  assignee: { id: string; name: string } | null;
  creator: { id: string; name: string } | null;
  requestSubtype: string | null;
  source: string;
}

interface AuditEntry { id: string; eventType: string; actorName: string | null; createdAt: string; beforeState: unknown; afterState: unknown; }

export default function ServiceRequestDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [sr, setSr] = useState<ServiceRequest | null>(null);
  const [timeline, setTimeline] = useState<AuditEntry[]>([]);
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [assignTeam, setAssignTeam] = useState("");

  async function reload() {
    const [detail, audit] = await Promise.all([
      api.get<ServiceRequest>(`/api/v1/service-requests/${id}`),
      api.get<AuditEntry[]>(`/api/v1/audit-log?entityType=ServiceRequest&entityId=${id}`),
    ]);
    setSr(detail);
    setTimeline(audit);
    setAssignTeam(detail.assignedTeam ?? "");
  }

  useEffect(() => { if (id) reload(); }, [id]);

  const terminal = useMemo(() => sr ? ["COMPLETED", "CANCELLED", "FAILED"].includes(sr.status) : false, [sr]);

  if (!sr) return <div style={{ padding: 24 }}>Loading…</div>;

  const nextStatuses = UI_VALID_TRANSITIONS[sr.status] ?? [];

  async function complete() {
    if (!resolutionNotes.trim()) return;
    await api.post(`/api/v1/service-requests/${id}/complete`, { resolutionNotes });
    setResolutionNotes("");
    reload();
  }

  async function fail() {
    await api.post(`/api/v1/service-requests/${id}/transition`, { toStatus: "FAILED", notes: resolutionNotes || undefined });
    setResolutionNotes("");
    reload();
  }

  async function cancel() {
    const reason = prompt("Cancel reason?");
    if (!reason) return;
    await api.post(`/api/v1/service-requests/${id}/cancel`, { reason });
    reload();
  }

  async function transitionTo(toStatus: string) {
    await api.post(`/api/v1/service-requests/${id}/transition`, { toStatus });
    reload();
  }

  async function assignTeamOnly() {
    await api.post(`/api/v1/service-requests/${id}/assign`, { assignedTeam: assignTeam || null });
    reload();
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ fontSize: 12, marginBottom: 6 }}>
        <Link href="/service-requests">‹ Back to queue</Link>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px" }}>{sr.requestNumber} · {sr.requestType.replace(/_/g, " ")}</h1>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontWeight: 700, fontSize: 11 }}>{sr.status.replace("_", " ")}</span>
            <span style={{ fontWeight: 700, fontSize: 11 }}>{sr.priority}</span>
            <SlaCountdown slaDueAt={sr.slaDueAt} slaBreached={sr.slaBreached} status={sr.status} />
          </div>
        </div>
        {!terminal && <button onClick={cancel}>Cancel request</button>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18 }}>
        <div>
          <section style={{ background: "white", border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginBottom: 14 }}>
            <h4>Context</h4>
            <div>Account: {sr.account ? <Link href={`/accounts/${sr.account.id}`}>{sr.account.accountNumber}</Link> : "—"}</div>
            <div>Premise: {sr.premise?.addressLine1 ?? "—"}</div>
            <div>Agreement: {sr.serviceAgreement ? formatAgreementLabel(sr.serviceAgreement) : "—"}</div>
            <div>Subtype: {sr.requestSubtype ?? "—"}</div>
            <div>Source: {sr.source}</div>
            <div>Created: {new Date(sr.createdAt).toLocaleString()} · {sr.creator?.name ?? ""}</div>
            <div>SLA due: {sr.slaDueAt ? new Date(sr.slaDueAt).toLocaleString() : "—"}</div>
          </section>

          <section style={{ background: "white", border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginBottom: 14 }}>
            <h4>Description</h4>
            <div style={{ whiteSpace: "pre-wrap" }}>{sr.description}</div>
          </section>

          <section style={{ background: "white", border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}>
            <h4>Resolution</h4>
            {terminal ? (
              <div style={{ whiteSpace: "pre-wrap" }}>{sr.resolutionNotes ?? <em>(no notes)</em>}</div>
            ) : (
              <>
                <textarea value={resolutionNotes} onChange={(e) => setResolutionNotes(e.target.value)} rows={3} style={{ width: "100%" }} />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button onClick={complete} disabled={!resolutionNotes.trim()}>Mark Completed</button>
                  <button onClick={fail}>Mark Failed</button>
                </div>
              </>
            )}
          </section>
        </div>

        <div>
          <section style={{ background: "white", border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginBottom: 14 }}>
            <h4>Assignment</h4>
            <div>Assignee: {sr.assignee?.name ?? <em>unassigned</em>}</div>
            <div style={{ marginTop: 10 }}>
              <label style={{ fontSize: 11 }}>Team</label>
              <input type="text" value={assignTeam} onChange={(e) => setAssignTeam(e.target.value)} style={{ width: "100%" }} />
              <button onClick={assignTeamOnly} style={{ marginTop: 6 }}>Save</button>
            </div>
          </section>

          {nextStatuses.length > 0 && (
            <section style={{ background: "white", border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginBottom: 14 }}>
              <h4>Status actions</h4>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {nextStatuses.map((s) => (
                  <button key={s} onClick={() => transitionTo(s)}>Move to {s.replace("_", " ")}</button>
                ))}
              </div>
            </section>
          )}

          <section style={{ background: "white", border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}>
            <h4>Timeline</h4>
            {timeline.map((t) => (
              <div key={t.id} style={{ fontSize: 12, padding: "6px 0", borderBottom: "1px dashed var(--border)" }}>
                <div style={{ fontWeight: 500 }}>{t.actorName ?? "system"} <span style={{ color: "var(--text-muted)" }}>{new Date(t.createdAt).toLocaleString()}</span></div>
                <div>{t.eventType}</div>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + smoke-test**

```bash
pnpm --filter web typecheck
```

Navigate to a seeded SR; assign, transition, complete. Confirm timeline entries appear.

- [ ] **Step 3: Commit**

```bash
git add packages/web/app/service-requests/[id]/page.tsx
git commit -m "feat(web): service-request detail page"
```

---

## Task 21: Web — SLA settings page

**Files:**
- Create: `packages/web/app/settings/slas/page.tsx`

- [ ] **Step 1: Write the page**

Grouped-by-type card layout per §4.4. Each card is a table of priorities with inline editable cells. `PATCH /api/v1/slas/:id` on blur; `POST /api/v1/slas` for adding a priority row. Load `/api/v1/service-request-types` to populate the "Add type coverage" picker, and `/api/v1/slas?includeInactive=true` for the full list. See `packages/web/app/settings/` for existing inline-edit patterns (e.g., tenant config or theme editor).

Implementation sketch:

```tsx
"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

interface SlaRow { id: string; requestType: string; priority: string; responseHours: number; resolutionHours: number; escalationHours: number | null; escalationUserId: string | null; isActive: boolean; }
interface TypeDef { code: string; label: string; }

const PRIORITIES = ["EMERGENCY", "HIGH", "NORMAL", "LOW"] as const;

export default function SlaSettingsPage() {
  const [types, setTypes] = useState<TypeDef[]>([]);
  const [slas, setSlas] = useState<SlaRow[]>([]);

  async function reload() {
    const [t, s] = await Promise.all([
      api.get<TypeDef[]>("/api/v1/service-request-types"),
      api.get<SlaRow[]>("/api/v1/slas?includeInactive=true"),
    ]);
    setTypes(t); setSlas(s.filter((r) => r.isActive));
  }
  useEffect(() => { reload(); }, []);

  const byType = types.reduce<Record<string, SlaRow[]>>((acc, t) => {
    acc[t.code] = slas.filter((s) => s.requestType === t.code);
    return acc;
  }, {});

  async function addRow(requestType: string, priority: string) {
    await api.post("/api/v1/slas", {
      requestType, priority,
      responseHours: 1, resolutionHours: 24,
    });
    reload();
  }
  async function updateField(id: string, patch: Partial<SlaRow>) {
    await api.patch(`/api/v1/slas/${id}`, patch);
    reload();
  }
  async function remove(id: string) {
    await api.delete(`/api/v1/slas/${id}`);
    reload();
  }

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>Service Level Agreements</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 18 }}>
        Define response and resolution targets per request type and priority. Requests without a matching SLA get no countdown.
      </p>
      {types.filter((t) => byType[t.code]?.length > 0 || true).map((t) => {
        const rows = byType[t.code] ?? [];
        const covered = rows.map((r) => r.priority);
        const missing = PRIORITIES.filter((p) => !covered.includes(p));
        return (
          <div key={t.code} style={{ background: "white", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 14 }}>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between" }}>
              <div><b>{t.code}</b> <span style={{ color: "var(--text-muted)" }}>{t.label}</span></div>
              <span>{rows.length} / 4 priorities</span>
            </div>
            <table style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Priority</th><th>Response (hrs)</th><th>Resolution (hrs)</th><th>Escalate after (hrs)</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.priority}</td>
                    <td><input defaultValue={r.responseHours} onBlur={(e) => updateField(r.id, { responseHours: Number(e.target.value) })} /></td>
                    <td><input defaultValue={r.resolutionHours} onBlur={(e) => updateField(r.id, { resolutionHours: Number(e.target.value) })} /></td>
                    <td><input defaultValue={r.escalationHours ?? ""} onBlur={(e) => updateField(r.id, { escalationHours: e.target.value ? Number(e.target.value) : null })} /></td>
                    <td><button onClick={() => remove(r.id)}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {missing.length > 0 && (
              <div style={{ padding: 10 }}>
                Add: {missing.map((p) => (
                  <button key={p} onClick={() => addRow(t.code, p)} style={{ marginRight: 6 }}>+ {p}</button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 18 }}>
        <b>Note for this slice:</b> SLA breach detection runs at request creation only. The background breach-sweep job and escalation notifications are deferred.
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + smoke-test**

```bash
pnpm --filter web typecheck
```

Load `/settings/slas` — edit a resolution hour, confirm the PATCH round-trip, refresh, confirm persistence. Add a missing priority row. Delete a row.

- [ ] **Step 3: Commit**

```bash
git add packages/web/app/settings/slas/page.tsx
git commit -m "feat(web): SLA settings page with inline-edit"
```

---

## Task 22: Web — sidebar nav entry + account detail tab

**Files:**
- Modify: `packages/web/components/sidebar.tsx`
- Modify: `packages/web/app/accounts/[id]/page.tsx`

- [ ] **Step 1: Add sidebar entry**

In `packages/web/components/sidebar.tsx`, in the **Operations** section, insert the Service Requests entry between Meter Reads and Accounts:

```tsx
import { faClipboardCheck } from "@fortawesome/pro-solid-svg-icons";
// ...
      { href: "/service-requests", label: "Service Requests", icon: faClipboardCheck, module: "service_requests" },
```

- [ ] **Step 2: Add account detail tab**

In `packages/web/app/accounts/[id]/page.tsx`, find the tab configuration. Add a new tab:

```tsx
{ key: "service-requests", label: "Service Requests",
  content: <ServiceRequestList accountScope={accountId} showFilters={false}
             createHref={`/service-requests/new?accountId=${accountId}`} /> },
```

(If the existing page uses a different pattern, adapt — point is a new tab that renders `<ServiceRequestList accountScope={id} />`.)

- [ ] **Step 3: Typecheck + smoke-test**

```bash
pnpm --filter web typecheck
```

Load an account detail page, switch to the Service Requests tab. Expected: seeded SR for that account is visible. Sidebar shows the new entry.

- [ ] **Step 4: Commit**

```bash
git add packages/web/components/sidebar.tsx packages/web/app/accounts/
git commit -m "feat(web): sidebar + account detail tab for service requests"
```

---

## Task 23: Documentation updates

**Files:**
- Modify: `docs/specs/14-service-requests.md`
- Modify: `docs/design/utility-cis-architecture.md`
- Modify: `docs/specs/00-data-model-overview.md`

- [ ] **Step 1: Update `14-service-requests.md`**

Change the status header from `Status: Stub (Phase 4)` to `Status: Slice B in progress (Phase 4)`. Above the "Planned Entities" section, add a "Slice B scope" paragraph with bullets for what's live vs. deferred (pull from the spec's §9 deferred table). For each endpoint in the API table, append `— ✓ slice B` or `— deferred`.

- [ ] **Step 2: Update `docs/design/utility-cis-architecture.md`**

Find the entity count near the top of the data-model section (it will say "N entities" or list them). Add `ServiceRequest`, `Sla`, `ServiceRequestTypeDef`, `ServiceRequestCounter` to the list and bump the count. Add the 5 new enums to the enum index. Add a subsection under the relevant grouping describing the three tables — one paragraph each.

- [ ] **Step 3: Update `docs/specs/00-data-model-overview.md`**

Locate the entity index table. Add three new rows for the service-request entities, following the existing column structure (entity name, purpose, module reference).

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs(service-requests): slice B — update specs + architecture"
```

---

## Task 24: Full suite run + memory update

- [ ] **Step 1: Rebuild everything clean**

```bash
pnpm install
pnpm turbo typecheck test
```

Expected: all typechecks pass, ~390 tests green (352 prior + ~40 new).

- [ ] **Step 2: Verify servers run**

```bash
pnpm dev
```

Exercise each new page in the browser:
- `/service-requests` — filter combinations, pagination
- `/service-requests/new` — create a new request end-to-end
- `/service-requests/:id` — assign, transition through PENDING_FIELD, complete
- `/settings/slas` — edit a hour, add a priority, delete a row
- `/accounts/:id` → Service Requests tab

- [ ] **Step 3: Update project memory resume note**

Edit `C:/Users/RaoChejarla/.claude/projects/C--development-claude-test/memory/project_session_resume.md`: add a new "Session summary (2026-04-23+)" section noting Slice B is complete with a short commit list and next slice candidates (attachments, SLA breach job, or portal intake).

- [ ] **Step 4: Final commit + push**

```bash
git push origin main
```

---

## Self-review

**Spec coverage:**

- §2.1 ServiceRequestTypeDef → Tasks 1, 5, 8, 15
- §2.2 Sla → Tasks 1, 6, 9, 15
- §2.3 ServiceRequest → Tasks 1, 7, 11, 14, 15
- §2.4 Enums → Task 1
- §2.5 Request number generation → Task 10 (counter) + Task 11 (usage)
- §3.1 `/service-request-types` → Task 12
- §3.2 `/slas` CRUD → Task 13
- §3.3 `/service-requests` + actions → Tasks 11, 14
- §3.4 State machine → Task 11 (`isValidTransition` + tests)
- §3.5 `formatAgreementLabel` → Task 7
- §3.6 RBAC → Task 4
- §4.1 queue → Tasks 17, 18
- §4.2 create → Task 19
- §4.3 detail → Task 20
- §4.4 SLA settings → Task 21
- §4.5 account tab → Task 22
- §4.6 sidebar → Task 22
- §5 seed → Task 15
- §6 tests → Tasks 7, 8, 9, 10, 11, 14
- §7 docs → Task 23
- §8 rollout → Task 24

**Placeholder scan:** No "TBD" / "implement later" / undefined references. A couple of UI tasks instruct the engineer to "read the real component signature and adapt" when the concrete existing API isn't fully visible in this plan — that's deliberate (existing code is authoritative) but each of those steps still shows the pattern to follow.

**Type consistency:** Service function names match between tests, routes, and implementations (`createServiceRequest`, `transitionServiceRequest`, `completeServiceRequest`, `cancelServiceRequest`, `assignServiceRequest`, `updateServiceRequest`, `listServiceRequests`, `getServiceRequest`, `listByAccount`, `listByPremise`, `resolveSlaForRequest`, `nextRequestNumber`, `assertServiceRequestTypeCode`, `listServiceRequestTypes`). Zod schema names consistent (`createServiceRequestSchema`, `serviceRequestQuerySchema`, etc.). Module keys (`service_requests`, `service_request_slas`) match across `constants.ts`, routes, and sidebar.

**Scope check:** This is a single focused slice. Each task produces a commit and each commit leaves the system in a green-test state.
