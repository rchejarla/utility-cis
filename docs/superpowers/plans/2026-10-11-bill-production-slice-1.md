# Bill Production Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a posted `Bill` into a durable, itemised PDF that staff and customers can download, reprintable as a new version without destroying the original.

**Architecture:** One resolver turns a `Bill` and its neighbours into a plain `BillPresentation`; a declarative template renders that to PDF; the bytes go to the tenant's object store through apptor-connect's files plane; a `BillDocument` row holds a pointer, never bytes. Reprints are new `Bill` rows chained by `replacesId`.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, Zod, `decimal.js`, `@react-pdf/renderer`, apptor-connect (`apptor-connect-service` HTTP surface), Vitest + testcontainers.

**Spec:** `docs/superpowers/specs/2026-10-11-bill-production-design.md`

## Global Constraints

Every task's requirements implicitly include these. Values are copied from the spec.

- **Renderer is `@react-pdf/renderer`.** No browser binary, no Puppeteer/Playwright, in the API package or its image.
- **Storage is apptor-connect's files plane only.** No local-disk writes for bill documents. No storage driver interface, no abstraction over S3/Azure/GCS — one integration name selects the backend.
- **Object key is exactly** `bills/{utilityId}/{billId}-v{version}.pdf`.
- **A minted capability link is a bearer credential.** It must never be returned to a client, embedded in a page or email, or written to a log. Bytes stream through our API so authorization stays with our RBAC.
- **`maxBytes` is always set explicitly** on a PUT link. TTL is the shortest workable value, never the 7-day maximum.
- **Templates and machinery stay separate:** declarative layout under `packages/api/src/bill-template/`, rendering machinery under `packages/api/src/bill-render/`. Machinery contains no tenant conditionals; anything per-tenant arrives inside `BillPresentation`.
- **Money is `Decimal` (`decimal.js`), never `Number`.** Amounts cross API and module boundaries as strings. `Bill` columns are `Decimal(14,4)`; display is 2dp.
- **Bill messages resolve at `bill.billDate`, never `now()`**, so reprinting an old bill reproduces the messages it carried.
- **Fonts are vendored and explicitly registered**, so output does not depend on host fonts.
- **apptor-connect is faked in tests, never run.** Reached through one client module that tests substitute.
- **Permissions** (corrected from the spec, which invented a `bills.REPRINT` that the fixed `PERMISSIONS` tuple has no room for): render/download `accounts:VIEW`; reprint `accounts:APPROVE`; bill-message CRUD `settings`; portal download `portal_billing:VIEW`.
- **apptor-connect auth is `X-Api-Key: ak_...`**, one deployment-level key in env, never in the database.

## Review Focus

Five failure modes the spec implies but no obvious task tests. Each has its test assigned to the task that owns the code.

1. **Rounded line amounts must still sum to the displayed total.** Columns are 4dp, bills display 2dp; rounding each line and summing can disagree with the rounded total by cents. A customer adding up their own bill and getting a different answer is the single most damaging bug this slice can ship. → Task 3.
2. **A bill with no segments, or segments with no lines, must refuse to render** rather than produce a document showing a total with nothing to explain it. → Task 3.
3. **An account with no customer name or no billing address must fail with a clear 422**, not render a bill with a blank recipient that gets mailed. → Task 3.
4. **A bill with enough lines to paginate must repeat the header and place totals and the remittance stub on the last page.** Silent truncation at the page boundary loses charges. → Task 5.
5. **Two concurrent reprints must not both produce version 2.** → Task 7.

---

## File Structure

**Create:**
- `packages/shared/prisma/migrations/20261011120000_tenant_issuer_identity/migration.sql` — issuer columns
- `packages/shared/prisma/migrations/20261011120100_bill_message/migration.sql` — bill message table
- `packages/shared/prisma/migrations/20261011120200_bill_version/migration.sql` — version/replacesId + unique constraint swap
- `packages/shared/prisma/migrations/20261011120300_bill_document/migration.sql` — bill document table
- `packages/shared/src/validators/bill-message.ts` — Zod schemas for bill messages
- `packages/api/src/lib/apptor-connect/files-client.ts` — the only place that talks to the files plane
- `packages/api/src/services/bill-message.service.ts` — CRUD + targeting selection
- `packages/api/src/services/bill-presentation.service.ts` — `BillPresentation` type + resolver
- `packages/api/src/bill-template/default-bill.tsx` — declarative layout
- `packages/api/src/bill-render/render-bill-pdf.ts` — machinery: fonts, pagination, bytes
- `packages/api/src/bill-render/stabilize-pdf.ts` — strips non-deterministic PDF metadata
- `packages/api/src/services/bill-document.service.ts` — render, store, read, reprint
- `packages/api/src/routes/bill-documents.ts` — document + reprint + versions endpoints
- `packages/api/src/routes/bill-messages.ts` — settings CRUD
- `packages/web/app/settings/bill-messages/page.tsx` — message management UI

**Modify:**
- `packages/shared/prisma/schema.prisma` — new models and fields
- `packages/shared/src/validators/index.ts` — export the new validator
- `packages/api/src/config.ts` — apptor-connect env
- `packages/api/src/routes/tenant-config.ts` + `services/tenant-config.service.ts` — issuer fields
- `packages/api/src/app.ts` — register two route modules
- `packages/api/tsconfig.json` — `"jsx": "react-jsx"`
- `packages/api/package.json` — `@react-pdf/renderer`, `react`
- `packages/web/app/bills/page.tsx` — download + reprint actions
- `packages/web/app/portal/bills/page.tsx` — download action

---

## Task 1: Issuer identity on TenantConfig

A bill must say who issued it and where to send payment. Nothing in the schema records that today — there is no `Utility` model at all.

**Files:**
- Create: `packages/shared/prisma/migrations/20261011120000_tenant_issuer_identity/migration.sql`
- Modify: `packages/shared/prisma/schema.prisma` (model `TenantConfig`)
- Modify: `packages/api/src/routes/tenant-config.ts` (the inline `updateBodySchema`)
- Modify: `packages/api/src/services/tenant-config.service.ts`
- Test: `packages/api/src/__tests__/integration/tenant-issuer-identity.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TenantConfig.utilityName`, `.utilityLegalName`, `.remittanceAddressLine1`, `.remittanceAddressLine2`, `.remittanceCity`, `.remittanceState`, `.remittancePostalCode`, `.billingPhone`, `.billingEmail`, `.websiteUrl` — all `string | null`. Task 3 reads them.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/__tests__/integration/tenant-issuer-identity.integration.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, resetDb, TENANT_A } from "./_effective-dating-fixtures.js";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetDb(prismaImports.prisma);
});

describe("tenant issuer identity", () => {
  it("stores and returns the fields a bill header needs", async () => {
    const { prisma } = prismaImports;
    await prisma.tenantConfig.create({
      data: {
        utilityId: TENANT_A,
        utilityName: "City of Testville Utilities",
        utilityLegalName: "City of Testville, Montana",
        remittanceAddressLine1: "PO Box 1230",
        remittanceCity: "Testville",
        remittanceState: "MT",
        remittancePostalCode: "59771",
        billingPhone: "406-555-0100",
        billingEmail: "utilitybilling@testville.gov",
        websiteUrl: "https://testville.gov/utilities",
      },
    });

    const row = await prisma.tenantConfig.findUniqueOrThrow({
      where: { utilityId: TENANT_A },
    });

    expect(row.utilityName).toBe("City of Testville Utilities");
    expect(row.remittancePostalCode).toBe("59771");
    expect(row.remittanceAddressLine2).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-issuer-identity.integration.test.ts`
Expected: FAIL — Prisma rejects `utilityName` as an unknown argument.

- [ ] **Step 3: Add the columns to the schema**

In `packages/shared/prisma/schema.prisma`, inside `model TenantConfig`, immediately after the `settings` field:

```prisma
  // ─── Issuer identity (bill production slice 1) ───────────────────
  // Who issued the bill and where payment goes. Explicit columns rather
  // than `settings` JSON because a bill cannot render without them, and
  // the settings UI validates them.
  utilityName            String? @map("utility_name") @db.VarChar(200)
  utilityLegalName       String? @map("utility_legal_name") @db.VarChar(200)
  remittanceAddressLine1 String? @map("remittance_address_line1") @db.VarChar(200)
  remittanceAddressLine2 String? @map("remittance_address_line2") @db.VarChar(200)
  remittanceCity         String? @map("remittance_city") @db.VarChar(100)
  remittanceState        String? @map("remittance_state") @db.VarChar(50)
  remittancePostalCode   String? @map("remittance_postal_code") @db.VarChar(20)
  billingPhone           String? @map("billing_phone") @db.VarChar(40)
  billingEmail           String? @map("billing_email") @db.VarChar(255)
  websiteUrl             String? @map("website_url") @db.VarChar(500)
```

- [ ] **Step 4: Write the migration**

```sql
-- packages/shared/prisma/migrations/20261011120000_tenant_issuer_identity/migration.sql
-- Issuer identity for bill documents. Nullable because existing tenants
-- have none; bill rendering refuses with a 422 until they are filled.
ALTER TABLE "tenant_config"
  ADD COLUMN "utility_name"             VARCHAR(200),
  ADD COLUMN "utility_legal_name"       VARCHAR(200),
  ADD COLUMN "remittance_address_line1" VARCHAR(200),
  ADD COLUMN "remittance_address_line2" VARCHAR(200),
  ADD COLUMN "remittance_city"          VARCHAR(100),
  ADD COLUMN "remittance_state"         VARCHAR(50),
  ADD COLUMN "remittance_postal_code"   VARCHAR(20),
  ADD COLUMN "billing_phone"            VARCHAR(40),
  ADD COLUMN "billing_email"            VARCHAR(255),
  ADD COLUMN "website_url"              VARCHAR(500);
```

- [ ] **Step 5: Regenerate the client and run the test**

Run: `pnpm --filter @utility-cis/shared exec prisma generate` then the Step 2 command.
Expected: PASS.

- [ ] **Step 6: Expose the fields on the settings endpoint**

In `packages/api/src/routes/tenant-config.ts`, extend the inline `updateBodySchema` with these keys (all `.optional()`), matching the style already in that object:

```ts
  utilityName: z.string().min(1).max(200).nullish(),
  utilityLegalName: z.string().min(1).max(200).nullish(),
  remittanceAddressLine1: z.string().min(1).max(200).nullish(),
  remittanceAddressLine2: z.string().max(200).nullish(),
  remittanceCity: z.string().min(1).max(100).nullish(),
  remittanceState: z.string().min(1).max(50).nullish(),
  remittancePostalCode: z.string().min(1).max(20).nullish(),
  billingPhone: z.string().max(40).nullish(),
  billingEmail: z.string().email().max(255).nullish(),
  websiteUrl: z.string().url().max(500).nullish(),
```

Then add the same keys to whatever field list `services/tenant-config.service.ts` uses to build its `select` and its update payload. Read that file first; mirror its existing shape rather than inventing one.

- [ ] **Step 7: Add an endpoint test**

Append to the same test file:

```ts
  it("rejects a malformed billing email", async () => {
    const { updateTenantConfig } = await import("../../services/tenant-config.service.js");
    await expect(
      updateTenantConfig(TENANT_A, "actor", "Actor", { billingEmail: "not-an-email" } as never),
    ).rejects.toThrow();
  });
```

If `updateTenantConfig`'s signature differs, match the real one — the point of the test is that validation rejects a bad email, not the argument order.

- [ ] **Step 8: Run both tests, then typecheck**

Run: the Step 2 command, then `pnpm --filter @utility-cis/api exec tsc --noEmit`
Expected: both PASS, typecheck exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/prisma packages/api/src/routes/tenant-config.ts packages/api/src/services/tenant-config.service.ts packages/api/src/__tests__/integration/tenant-issuer-identity.integration.test.ts
git commit -m "feat(billing): issuer identity on TenantConfig — who issued the bill"
```

---

## Task 2: BillMessage — configurable text on bills (#137)

**Files:**
- Create: `packages/shared/prisma/migrations/20261011120100_bill_message/migration.sql`
- Create: `packages/shared/src/validators/bill-message.ts`
- Create: `packages/api/src/services/bill-message.service.ts`
- Create: `packages/api/src/routes/bill-messages.ts`
- Modify: `packages/shared/prisma/schema.prisma`, `packages/shared/src/validators/index.ts`, `packages/api/src/app.ts`
- Test: `packages/api/src/__tests__/services/bill-message.service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `selectBillMessages(utilityId: string, opts: { accountTypeDefId: string | null; commodityIds: string[]; onDate: Date }): Promise<BillMessageRow[]>` where `BillMessageRow = { id: string; label: string; body: string; priority: number }`, ordered by `priority` ascending then `label` ascending. Task 3 calls this.

- [ ] **Step 1: Write the failing targeting tests**

```ts
// packages/api/src/__tests__/services/bill-message.service.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { selectBillMessages } from "../../services/bill-message.service.js";
import { prisma } from "../../lib/prisma.js";

const onDate = new Date("2026-03-15T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("selectBillMessages", () => {
  it("asks only for messages whose window contains the bill date", async () => {
    const findMany = vi.mocked(prisma.billMessage.findMany).mockResolvedValue([] as never);

    await selectBillMessages("util-1", { accountTypeDefId: "at-1", commodityIds: ["c-1"], onDate });

    const where = findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.utilityId).toBe("util-1");
    expect(where.activeFrom).toEqual({ lte: onDate });
    expect(where.OR).toEqual(
      expect.arrayContaining([{ activeTo: null }, { activeTo: { gte: onDate } }]),
    );
  });

  it("includes untargeted messages alongside ones matching this bill", async () => {
    const findMany = vi.mocked(prisma.billMessage.findMany).mockResolvedValue([] as never);

    await selectBillMessages("util-1", { accountTypeDefId: "at-1", commodityIds: ["c-1"], onDate });

    const where = findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.AND).toEqual([
      { OR: [{ accountTypeDefId: null }, { accountTypeDefId: "at-1" }] },
      { OR: [{ commodityId: null }, { commodityId: { in: ["c-1"] } }] },
    ]);
  });

  it("orders by priority then label so output is stable", async () => {
    const findMany = vi.mocked(prisma.billMessage.findMany).mockResolvedValue([] as never);

    await selectBillMessages("util-1", { accountTypeDefId: null, commodityIds: [], onDate });

    expect(findMany.mock.calls[0][0]!.orderBy).toEqual([{ priority: "asc" }, { label: "asc" }]);
  });

  it("matches only untargeted messages when the bill has no account type or services", async () => {
    const findMany = vi.mocked(prisma.billMessage.findMany).mockResolvedValue([] as never);

    await selectBillMessages("util-1", { accountTypeDefId: null, commodityIds: [], onDate });

    const where = findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.AND).toEqual([
      { OR: [{ accountTypeDefId: null }] },
      { OR: [{ commodityId: null }] },
    ]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/api && pnpm vitest run src/__tests__/services/bill-message.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the model**

In `packages/shared/prisma/schema.prisma`:

```prisma
/// Configurable text printed on bills (Bozeman #137). Targeting is by
/// account type and/or commodity; a null on either side means "all".
/// Selection happens at the bill's own bill_date, never at now(), so a
/// reprint reproduces the messages the bill originally carried.
model BillMessage {
  id               String   @id @default(uuid()) @db.Uuid
  utilityId        String   @map("utility_id") @db.Uuid
  label            String   @map("label") @db.VarChar(255)
  body             String   @map("body") @db.Text
  accountTypeDefId String?  @map("account_type_def_id") @db.Uuid
  commodityId      String?  @map("commodity_id") @db.Uuid
  priority         Int      @default(100) @map("priority")
  activeFrom       DateTime @map("active_from") @db.Date
  activeTo         DateTime? @map("active_to") @db.Date
  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt        DateTime @updatedAt @map("updated_at") @db.Timestamptz

  accountTypeDef   AccountTypeDef? @relation(fields: [accountTypeDefId], references: [id], onDelete: Restrict)
  commodity        Commodity?      @relation(fields: [commodityId], references: [id], onDelete: Restrict)

  @@index([utilityId, activeFrom])
  @@map("bill_message")
}
```

Add the matching back-relations: `billMessages BillMessage[]` on `AccountTypeDef` and on `Commodity`.

- [ ] **Step 4: Write the migration**

```sql
-- packages/shared/prisma/migrations/20261011120100_bill_message/migration.sql
CREATE TABLE "bill_message" (
  "id"                   UUID         NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"           UUID         NOT NULL,
  "label"                VARCHAR(255) NOT NULL,
  "body"                 TEXT         NOT NULL,
  "account_type_def_id"  UUID,
  "commodity_id"         UUID,
  "priority"             INTEGER      NOT NULL DEFAULT 100,
  "active_from"          DATE         NOT NULL,
  "active_to"            DATE,
  "created_at"           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "bill_message_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bill_message_account_type_def_id_fkey" FOREIGN KEY ("account_type_def_id")
    REFERENCES "account_type_def"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "bill_message_commodity_id_fkey" FOREIGN KEY ("commodity_id")
    REFERENCES "commodity"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "bill_message_utility_id_active_from_idx"
  ON "bill_message" ("utility_id", "active_from");

ALTER TABLE "bill_message" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bill_message_tenant_isolation" ON "bill_message"
  USING ("utility_id" = current_setting('app.current_utility_id', true)::uuid);
```

Before writing this, open the most recent migration that creates a table (`20261009120000_ledger_foundation`) and copy its RLS policy wording exactly — if it differs from the above, that file is authoritative, not this plan.

- [ ] **Step 5: Implement the selector**

```ts
// packages/api/src/services/bill-message.service.ts
import { prisma } from "../lib/prisma.js";

export interface BillMessageRow {
  id: string;
  label: string;
  body: string;
  priority: number;
}

export interface BillMessageSelector {
  accountTypeDefId: string | null;
  commodityIds: string[];
  /** The bill's own billDate. Never now(). */
  onDate: Date;
}

/**
 * Messages that belong on one bill. A null `accountTypeDefId` or
 * `commodityId` on a message means "all", so each side is an OR of
 * "untargeted" with "targeted at this bill".
 */
export async function selectBillMessages(
  utilityId: string,
  opts: BillMessageSelector,
): Promise<BillMessageRow[]> {
  const accountTypeClause: Array<Record<string, unknown>> = [{ accountTypeDefId: null }];
  if (opts.accountTypeDefId) accountTypeClause.push({ accountTypeDefId: opts.accountTypeDefId });

  const commodityClause: Array<Record<string, unknown>> = [{ commodityId: null }];
  if (opts.commodityIds.length > 0) commodityClause.push({ commodityId: { in: opts.commodityIds } });

  const rows = await prisma.billMessage.findMany({
    where: {
      utilityId,
      activeFrom: { lte: opts.onDate },
      OR: [{ activeTo: null }, { activeTo: { gte: opts.onDate } }],
      AND: [{ OR: accountTypeClause }, { OR: commodityClause }],
    },
    orderBy: [{ priority: "asc" }, { label: "asc" }],
    select: { id: true, label: true, body: true, priority: true },
  });

  return rows;
}
```

- [ ] **Step 6: Run the tests**

Run: `cd packages/api && pnpm vitest run src/__tests__/services/bill-message.service.test.ts`
Expected: PASS (4 tests). If `prisma.billMessage` is undefined in the mock, add `billMessage: crud(),` to the mock factory in `packages/api/src/__tests__/vitest.setup.ts`.

- [ ] **Step 7: Add the validator**

```ts
// packages/shared/src/validators/bill-message.ts
import { z } from "zod";

export const billMessageCreateSchema = z.object({
  label: z.string().min(1).max(255),
  body: z.string().min(1).max(4000),
  accountTypeDefId: z.string().uuid().nullish(),
  commodityId: z.string().uuid().nullish(),
  priority: z.number().int().min(0).max(10_000).default(100),
  activeFrom: z.coerce.date(),
  activeTo: z.coerce.date().nullish(),
});

export const billMessageUpdateSchema = billMessageCreateSchema.partial();

export type BillMessageCreate = z.infer<typeof billMessageCreateSchema>;
export type BillMessageUpdate = z.infer<typeof billMessageUpdateSchema>;
```

Add `export * from "./bill-message";` to `packages/shared/src/validators/index.ts`, keeping that file's existing ordering convention.

- [ ] **Step 8: Add CRUD routes and register them**

Create `packages/api/src/routes/bill-messages.ts` following `packages/api/src/routes/suspension-type-defs.ts` as the model for a settings-scoped tenant CRUD module — read it first and mirror its structure, using `{ config: { module: "settings", permission: "VIEW" | "CREATE" | "EDIT" | "DELETE" } }` and `billMessageCreateSchema` / `billMessageUpdateSchema`. Register it in `packages/api/src/app.ts` next to the other settings route registrations.

- [ ] **Step 9: Typecheck and commit**

Run: `pnpm --filter @utility-cis/api exec tsc --noEmit`

```bash
git add packages/shared packages/api/src/services/bill-message.service.ts packages/api/src/routes/bill-messages.ts packages/api/src/app.ts packages/api/src/__tests__
git commit -m "feat(billing): bill messages with account-type and commodity targeting"
```

---

## Task 3: BillPresentation — resolve a bill into render-ready content

The unit with the real logic, and the one carrying three of the five Review Focus items.

**Files:**
- Create: `packages/api/src/services/bill-presentation.service.ts`
- Test: `packages/api/src/__tests__/services/bill-presentation.service.test.ts`

**Interfaces:**
- Consumes: `selectBillMessages` from Task 2; `TenantConfig` issuer fields from Task 1.
- Produces:

```ts
export interface BillPresentation {
  issuer: { name: string; legalName: string | null; addressLines: string[]; phone: string | null; email: string | null; website: string | null };
  recipient: { name: string; addressLines: string[] };
  account: { number: string; id: string };
  bill: { number: string; version: number; billDate: Date; dueDate: Date; periodStart: Date; periodEnd: Date };
  groups: Array<{ heading: string; lines: Array<{ label: string; quantity: string | null; amount: string }>; subtotal: string }>;
  totals: { subtotal: string; taxes: string; credits: string; total: string };
  messages: Array<{ label: string; body: string }>;
  branding: { logoUrl: string | null; primaryColor: string; fontFamily: string };
  remittance: { payTo: string; addressLines: string[]; amountDue: string; dueDate: Date };
}

export class BillPresentationError extends Error {
  constructor(message: string, readonly code: "ISSUER_INCOMPLETE" | "NO_CHARGES" | "RECIPIENT_INCOMPLETE", readonly missing: string[]) { super(message); }
}

export async function loadBillPresentation(utilityId: string, billId: string): Promise<BillPresentation>;
```

All money fields are 2dp strings. Task 5 and Task 6 consume this.

> **Naming note for the implementer:** the spec calls this unit `BillPresentationLoader`. Services in this codebase export functions, not classes (`bill.service.ts` exports `getBill`, `listBills`), so it ships as a function module. The rate-engine `*Loader` classes are a different layer; do not follow them here.

- [ ] **Step 1: Write the failing tests, including three Review Focus items**

```ts
// packages/api/src/__tests__/services/bill-presentation.service.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import { loadBillPresentation, BillPresentationError } from "../../services/bill-presentation.service.js";
import { prisma } from "../../lib/prisma.js";

vi.mock("../../services/bill-message.service.js", () => ({
  selectBillMessages: vi.fn().mockResolvedValue([]),
}));

const ISSUER = {
  utilityId: "util-1",
  utilityName: "City of Testville Utilities",
  utilityLegalName: "City of Testville, Montana",
  remittanceAddressLine1: "PO Box 1230",
  remittanceAddressLine2: null,
  remittanceCity: "Testville",
  remittanceState: "MT",
  remittancePostalCode: "59771",
  billingPhone: "406-555-0100",
  billingEmail: "ub@testville.gov",
  websiteUrl: "https://testville.gov",
};

function billRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bill-1",
    utilityId: "util-1",
    accountId: "acct-1",
    billNumber: "B-1001",
    version: 1,
    billDate: new Date("2026-03-01"),
    dueDate: new Date("2026-03-31"),
    periodStart: new Date("2026-02-01"),
    periodEnd: new Date("2026-02-28"),
    subtotal: new Decimal("100.0000"),
    taxes: new Decimal("7.5000"),
    credits: new Decimal("0.0000"),
    total: new Decimal("107.5000"),
    postedAt: new Date("2026-03-01"),
    account: {
      id: "acct-1",
      accountNumber: "A-900",
      accountTypeDefId: "at-1",
      customer: { firstName: "Jane", lastName: "Smith", organizationName: null },
      billingAddress: {
        addressLine1: "12 Elm St",
        addressLine2: null,
        city: "Testville",
        state: "MT",
        zip: "59771",
        country: "US",
      },
    },
    segments: [
      {
        id: "seg-1",
        serviceAgreementId: "sa-1",
        subtotal: new Decimal("100.0000"),
        commodityCode: "WATER",
        commodityName: "Water",
        commodityId: "c-1",
        lines: [
          { label: "Base charge", kindCode: "fixed", quantity: null, amount: new Decimal("20.0000"), sortOrder: 1 },
          { label: "Usage tier 1", kindCode: "tiered", quantity: new Decimal("5.0000"), amount: new Decimal("80.0000"), sortOrder: 2 },
        ],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.tenantConfig.findUnique).mockResolvedValue(ISSUER as never);
  vi.mocked(prisma.tenantTheme.findUnique).mockResolvedValue(null as never);
});

describe("loadBillPresentation", () => {
  it("resolves issuer, recipient, groups and 2dp money", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);

    const p = await loadBillPresentation("util-1", "bill-1");

    expect(p.issuer.name).toBe("City of Testville Utilities");
    expect(p.issuer.addressLines).toEqual(["PO Box 1230", "Testville, MT 59771"]);
    expect(p.recipient.name).toBe("Jane Smith");
    expect(p.groups[0].heading).toBe("Water");
    expect(p.groups[0].lines[0].amount).toBe("20.00");
    expect(p.totals.total).toBe("107.50");
    expect(p.remittance.amountDue).toBe("107.50");
  });

  // Review Focus 1
  it("keeps rounded line amounts summing to the rounded group subtotal", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(
      billRow({
        subtotal: new Decimal("0.0300"),
        taxes: new Decimal("0.0000"),
        credits: new Decimal("0.0000"),
        total: new Decimal("0.0300"),
        segments: [
          {
            id: "seg-1",
            serviceAgreementId: "sa-1",
            subtotal: new Decimal("0.0300"),
            commodityCode: "WATER",
            commodityName: "Water",
            commodityId: "c-1",
            lines: [
              { label: "A", kindCode: "fixed", quantity: null, amount: new Decimal("0.0100"), sortOrder: 1 },
              { label: "B", kindCode: "fixed", quantity: null, amount: new Decimal("0.0100"), sortOrder: 2 },
              { label: "C", kindCode: "fixed", quantity: null, amount: new Decimal("0.0100"), sortOrder: 3 },
            ],
          },
        ],
      }) as never,
    );

    const p = await loadBillPresentation("util-1", "bill-1");
    const summed = p.groups[0].lines.reduce((acc, l) => acc.plus(new Decimal(l.amount)), new Decimal(0));

    expect(summed.toFixed(2)).toBe(p.groups[0].subtotal);
  });

  // Review Focus 2
  it("refuses a bill with no charge lines", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow({ segments: [] }) as never);

    await expect(loadBillPresentation("util-1", "bill-1")).rejects.toMatchObject({ code: "NO_CHARGES" });
  });

  // Review Focus 3
  it("refuses a bill whose recipient has no name or address", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(
      billRow({
        account: {
          id: "acct-1",
          accountNumber: "A-900",
          accountTypeDefId: "at-1",
          customer: { firstName: null, lastName: null, organizationName: null },
          billingAddress: null,
        },
      }) as never,
    );

    await expect(loadBillPresentation("util-1", "bill-1")).rejects.toMatchObject({
      code: "RECIPIENT_INCOMPLETE",
    });
  });

  it("refuses when issuer identity is incomplete, naming what is missing", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);
    vi.mocked(prisma.tenantConfig.findUnique).mockResolvedValue(
      { ...ISSUER, utilityName: null, remittanceAddressLine1: null } as never,
    );

    const err = await loadBillPresentation("util-1", "bill-1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BillPresentationError);
    expect((err as BillPresentationError).code).toBe("ISSUER_INCOMPLETE");
    expect((err as BillPresentationError).missing).toEqual(
      expect.arrayContaining(["utilityName", "remittanceAddressLine1"]),
    );
  });

  it("falls back to default branding when the tenant has no theme", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);

    const p = await loadBillPresentation("util-1", "bill-1");

    expect(p.branding.primaryColor).toBe("#1f2937");
    expect(p.branding.logoUrl).toBeNull();
  });

  it("passes the bill date, not today, to message selection", async () => {
    const { selectBillMessages } = await import("../../services/bill-message.service.js");
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);

    await loadBillPresentation("util-1", "bill-1");

    expect(vi.mocked(selectBillMessages).mock.calls[0][1].onDate).toEqual(new Date("2026-03-01"));
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/api && pnpm vitest run src/__tests__/services/bill-presentation.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

Write `packages/api/src/services/bill-presentation.service.ts` with the interfaces from the Interfaces block and this behaviour:

```ts
import { Decimal } from "decimal.js";
import { prisma } from "../lib/prisma.js";
import { selectBillMessages } from "./bill-message.service.js";

const REQUIRED_ISSUER_FIELDS = [
  "utilityName",
  "remittanceAddressLine1",
  "remittanceCity",
  "remittanceState",
  "remittancePostalCode",
] as const;

const DEFAULT_BRANDING = { logoUrl: null, primaryColor: "#1f2937", fontFamily: "Inter" };

/** 4dp column to 2dp display. One function so every amount rounds alike. */
function money(value: Decimal | string): string {
  return new Decimal(value).toFixed(2);
}
```

Then `loadBillPresentation`:

1. Load the bill with `prisma.bill.findFirst({ where: { id: billId, utilityId }, include: … })`, pulling account → customer and billingAddress, and segments → lines ordered by `sortOrder`, plus each segment's commodity code/name/id. Throw `BillPresentationError("Bill not found", "NO_CHARGES", [])` only for missing charges — a missing bill is the caller's 404, so return/throw whatever `getBill` already does for that case; read `bill.service.ts` and match it.
2. Load `tenantConfig.findUnique({ where: { utilityId } })`. Collect which of `REQUIRED_ISSUER_FIELDS` are null; if any, throw `BillPresentationError` with code `ISSUER_INCOMPLETE` and `missing` listing them.
3. Build `recipient.name` from `organizationName ?? [firstName, lastName].filter(Boolean).join(" ")`. If the result is empty, or `billingAddress` is null, throw code `RECIPIENT_INCOMPLETE`.
4. If every segment has no lines, or there are no segments, throw code `NO_CHARGES`.
5. Group lines by segment commodity. **Round each line with `money()`, then compute the group subtotal by summing the already-rounded line strings** — not by rounding the stored segment subtotal. That is what makes Review Focus 1 hold: what the customer can add up is what is printed. Keep the stored 4dp subtotal out of the presentation entirely.
6. `totals` come from the bill's own columns via `money()`. If the summed group subtotals disagree with `totals.subtotal`, that is a rating bug rather than a rendering one — do not paper over it here; the integration test in Task 6 asserts they agree for real rated data.
7. `messages` from `selectBillMessages(utilityId, { accountTypeDefId: bill.account.accountTypeDefId, commodityIds: [...], onDate: bill.billDate })`.
8. `branding` from `tenantTheme.findUnique`, falling back to `DEFAULT_BRANDING` field by field; read `colors`/`typography` JSON defensively since they are untyped.
9. `remittance.payTo` is `utilityLegalName ?? utilityName`; `amountDue` is `totals.total`.

- [ ] **Step 4: Run the tests**

Run: the Step 2 command.
Expected: PASS (7 tests). Add `bill: crud(), tenantTheme: crud(),` to the setup mock if they are missing.

- [ ] **Step 5: Typecheck and commit**

```bash
git add packages/api/src/services/bill-presentation.service.ts packages/api/src/__tests__/services/bill-presentation.service.test.ts
git commit -m "feat(billing): resolve a bill into render-ready presentation content"
```

---

## Task 4: apptor-connect files client

The only module in this codebase that talks to apptor-connect.

**Files:**
- Create: `packages/api/src/lib/apptor-connect/files-client.ts`
- Modify: `packages/api/src/config.ts`
- Test: `packages/api/src/__tests__/lib/apptor-connect-files-client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export interface FileLink { url: string; method: "GET" | "PUT"; expiresAt: string; maxBytes: number | null }
export async function mintFileLink(args: { integration: string; connection?: string | null; key: string; op: "GET" | "PUT"; ttlSeconds: number; maxBytes?: number }): Promise<FileLink>;
export async function putObject(args: { integration: string; connection?: string | null; key: string; body: Buffer; maxBytes: number; ttlSeconds?: number }): Promise<void>;
export async function getObject(args: { integration: string; connection?: string | null; key: string; ttlSeconds?: number }): Promise<Buffer>;
export class ApptorConnectError extends Error { constructor(message: string, readonly status: number | null, readonly integration: string) { super(message); } }
```

Task 6 consumes `putObject` / `getObject` and never `mintFileLink` directly.

- [ ] **Step 1: Write the contract test**

This is the test that notices if apptor-connect's contract moves, per the spec's testing section.

```ts
// packages/api/src/__tests__/lib/apptor-connect-files-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mintFileLink, putObject, getObject, ApptorConnectError } from "../../lib/apptor-connect/files-client.js";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function linkResponse(url = "https://ac.test/files/v1/d?sig=abc") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      url,
      method: "PUT",
      expiresAt: "2026-10-11T00:05:00Z",
      grantedTtlSeconds: 300,
      maxBytes: 1024,
      via: "service",
    }),
  };
}

describe("apptor-connect files client", () => {
  it("mints a link with exactly the documented request fields", async () => {
    fetchMock.mockResolvedValueOnce(linkResponse());

    await mintFileLink({
      integration: "cis-bills",
      connection: "primary",
      key: "bills/util-1/bill-1-v1.pdf",
      op: "PUT",
      ttlSeconds: 300,
      maxBytes: 1024,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/files\/v1\/links$/);
    expect(init.method).toBe("POST");
    expect(init.headers["X-Api-Key"]).toBeTruthy();
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      i: "cis-bills",
      cn: "primary",
      key: "bills/util-1/bill-1-v1.pdf",
      op: "PUT",
      ttlSeconds: 300,
      maxBytes: 1024,
    });
  });

  it("omits cn when there is no named connection", async () => {
    fetchMock.mockResolvedValueOnce(linkResponse());

    await mintFileLink({ integration: "cis-bills", key: "k", op: "GET", ttlSeconds: 60 });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      i: "cis-bills",
      key: "k",
      op: "GET",
      ttlSeconds: 60,
    });
  });

  it("uploads to the minted url and never returns it", async () => {
    fetchMock
      .mockResolvedValueOnce(linkResponse("https://ac.test/files/v1/d?sig=put"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    const result = await putObject({
      integration: "cis-bills",
      key: "bills/util-1/bill-1-v1.pdf",
      body: Buffer.from("%PDF-1.7"),
      maxBytes: 4096,
    });

    expect(result).toBeUndefined();
    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect(String(putUrl)).toBe("https://ac.test/files/v1/d?sig=put");
    expect(putInit.method).toBe("PUT");
  });

  it("raises ApptorConnectError naming the integration when minting fails", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "unavailable" });

    const err = await mintFileLink({ integration: "cis-bills", key: "k", op: "PUT", ttlSeconds: 60, maxBytes: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApptorConnectError);
    expect((err as ApptorConnectError).status).toBe(503);
    expect((err as ApptorConnectError).integration).toBe("cis-bills");
  });

  it("raises ApptorConnectError when the upload itself is rejected", async () => {
    fetchMock
      .mockResolvedValueOnce(linkResponse())
      .mockResolvedValueOnce({ ok: false, status: 413, text: async () => "too large" });

    const err = await putObject({ integration: "cis-bills", key: "k", body: Buffer.from("x"), maxBytes: 1 })
      .catch((e: unknown) => e);

    expect((err as ApptorConnectError).status).toBe(413);
  });

  it("downloads bytes through a GET link", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ url: "https://ac.test/files/v1/d?sig=get", method: "GET", expiresAt: "x", grantedTtlSeconds: 60, maxBytes: null, via: "service" }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("%PDF-1.7").buffer });

    const bytes = await getObject({ integration: "cis-bills", key: "k" });

    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/api && pnpm vitest run src/__tests__/lib/apptor-connect-files-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add config**

In `packages/api/src/config.ts`, inside `configSchema`, following the style of the entries already there:

```ts
  APPTOR_CONNECT_URL: z.string().default("http://localhost:8080"),
  APPTOR_CONNECT_API_KEY: z.string().default(""),
  BILL_DOCUMENT_LINK_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  BILL_DOCUMENT_MAX_BYTES: z.coerce.number().int().min(1024).default(10_485_760),
```

> **Open deployment question, do not resolve in code:** the apptor-connect API key is tenant-scoped on their side (`{"tenantId": "acme"}` when minted), while this service is multi-tenant by `utility_id`. This plan uses one deployment-level key and selects each utility's store by integration name. Whether each utility should instead get its own apptor-connect key or customer scope is a provisioning decision for the apptor-connect side; raise it, do not invent it.

- [ ] **Step 4: Implement the client**

```ts
// packages/api/src/lib/apptor-connect/files-client.ts
import { config } from "../../config.js";

export interface FileLink {
  url: string;
  method: "GET" | "PUT";
  expiresAt: string;
  maxBytes: number | null;
}

export class ApptorConnectError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly integration: string,
  ) {
    super(message);
    this.name = "ApptorConnectError";
  }
}

/**
 * Mint a capability link. The returned url needs no login: anyone holding
 * it can use it until it expires. It must not be logged, returned to a
 * client, or put in a page or email — callers use putObject/getObject,
 * which consume the link and discard it.
 */
export async function mintFileLink(args: {
  integration: string;
  connection?: string | null;
  key: string;
  op: "GET" | "PUT";
  ttlSeconds: number;
  maxBytes?: number;
}): Promise<FileLink> {
  const body: Record<string, unknown> = {
    i: args.integration,
    key: args.key,
    op: args.op,
    ttlSeconds: args.ttlSeconds,
  };
  if (args.connection) body.cn = args.connection;
  if (args.maxBytes !== undefined) body.maxBytes = args.maxBytes;

  const res = await fetch(`${config.APPTOR_CONNECT_URL}/files/v1/links`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": config.APPTOR_CONNECT_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new ApptorConnectError(
      `Minting a ${args.op} link failed with ${res.status}`,
      res.status,
      args.integration,
    );
  }

  const json = (await res.json()) as FileLink;
  return { url: json.url, method: json.method, expiresAt: json.expiresAt, maxBytes: json.maxBytes };
}
```

Then `putObject` (mint `PUT`, `fetch(link.url, { method: "PUT", body })`, throw `ApptorConnectError` on `!ok`) and `getObject` (mint `GET`, fetch, return `Buffer.from(await res.arrayBuffer())`). Default `ttlSeconds` to `config.BILL_DOCUMENT_LINK_TTL_SECONDS`. Never include `link.url` in an error message.

- [ ] **Step 5: Run the tests**

Run: the Step 2 command.
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/lib/apptor-connect packages/api/src/config.ts packages/api/src/__tests__/lib/apptor-connect-files-client.test.ts
git commit -m "feat(billing): apptor-connect files client, with a contract test"
```

---

## Task 5: Render a BillPresentation to PDF

**Files:**
- Create: `packages/api/src/bill-template/default-bill.tsx`
- Create: `packages/api/src/bill-render/render-bill-pdf.ts`
- Create: `packages/api/src/bill-render/stabilize-pdf.ts`
- Modify: `packages/api/tsconfig.json`, `packages/api/package.json`
- Test: `packages/api/src/__tests__/bill-render/render-bill-pdf.test.ts`

**Interfaces:**
- Consumes: `BillPresentation` from Task 3.
- Produces: `renderBillPdf(presentation: BillPresentation): Promise<Buffer>` and `DEFAULT_TEMPLATE_KEY = "default-bill-v1"`. Task 6 consumes both.

- [ ] **Step 1: Install dependencies and enable JSX**

```bash
cd packages/api && pnpm add @react-pdf/renderer@4.3.0 react@18.3.1
```

In `packages/api/tsconfig.json`, add to `compilerOptions`:

```json
    "jsx": "react-jsx",
```

- [ ] **Step 2: Write the failing tests, including Review Focus 4 and byte-stability**

```ts
// packages/api/src/__tests__/bill-render/render-bill-pdf.test.ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { renderBillPdf } from "../../bill-render/render-bill-pdf.js";
import type { BillPresentation } from "../../services/bill-presentation.service.js";

function presentation(lineCount: number): BillPresentation {
  return {
    issuer: { name: "City of Testville Utilities", legalName: "City of Testville, Montana", addressLines: ["PO Box 1230", "Testville, MT 59771"], phone: "406-555-0100", email: "ub@testville.gov", website: "https://testville.gov" },
    recipient: { name: "Jane Smith", addressLines: ["12 Elm St", "Testville, MT 59771"] },
    account: { number: "A-900", id: "acct-1" },
    bill: { number: "B-1001", version: 1, billDate: new Date("2026-03-01"), dueDate: new Date("2026-03-31"), periodStart: new Date("2026-02-01"), periodEnd: new Date("2026-02-28") },
    groups: [
      {
        heading: "Water",
        lines: Array.from({ length: lineCount }, (_, i) => ({ label: `Charge ${i + 1}`, quantity: "1.00", amount: "1.00" })),
        subtotal: `${lineCount}.00`,
      },
    ],
    totals: { subtotal: `${lineCount}.00`, taxes: "0.00", credits: "0.00", total: `${lineCount}.00` },
    messages: [{ label: "Notice", body: "Water restrictions begin June 1." }],
    branding: { logoUrl: null, primaryColor: "#1f2937", fontFamily: "Inter" },
    remittance: { payTo: "City of Testville, Montana", addressLines: ["PO Box 1230", "Testville, MT 59771"], amountDue: `${lineCount}.00`, dueDate: new Date("2026-03-31") },
  };
}

function pageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

describe("renderBillPdf", () => {
  it("produces a valid PDF", async () => {
    const pdf = await renderBillPdf(presentation(3));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("carries the issuer, bill number, every charge label and the total", async () => {
    const pdf = await renderBillPdf(presentation(3));
    const text = pdf.toString("latin1");
    for (const needle of ["B-1001", "A-900", "Charge 1", "Charge 2", "Charge 3"]) {
      expect(text).toContain(needle);
    }
  });

  // Review Focus 4
  it("paginates a long bill without losing lines", async () => {
    const many = await renderBillPdf(presentation(120));
    expect(pageCount(many)).toBeGreaterThan(1);
    const text = many.toString("latin1");
    expect(text).toContain("Charge 1");
    expect(text).toContain("Charge 120");
  });

  // Spec §4.5 depends on this
  it("is byte-stable across renders of the same presentation", async () => {
    const a = await renderBillPdf(presentation(3));
    const b = await renderBillPdf(presentation(3));
    const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    expect(hash(a)).toBe(hash(b));
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `cd packages/api && pnpm vitest run src/__tests__/bill-render/render-bill-pdf.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the template**

Create `packages/api/src/bill-template/default-bill.tsx` exporting `DefaultBillTemplate({ presentation }: { presentation: BillPresentation })`, built from `@react-pdf/renderer`'s `Document`, `Page`, `View`, `Text` and `StyleSheet`. Requirements the tests pin:

- A header with the issuer block and the recipient block; mark it `fixed` so it repeats on every page.
- One section per group: heading, then a row per line with label, quantity and amount.
- A totals block and the remittance stub, both at the end so they land on the last page.
- The messages block after the totals.
- Colors come only from `presentation.branding`. No tenant conditionals anywhere in this file — it reads the presentation and nothing else.

- [ ] **Step 5: Write the machinery**

```ts
// packages/api/src/bill-render/render-bill-pdf.ts
import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { DefaultBillTemplate } from "../bill-template/default-bill.js";
import { stabilizePdf } from "./stabilize-pdf.js";
import type { BillPresentation } from "../services/bill-presentation.service.js";

export const DEFAULT_TEMPLATE_KEY = "default-bill-v1";

export async function renderBillPdf(presentation: BillPresentation): Promise<Buffer> {
  const buffer = await renderToBuffer(createElement(DefaultBillTemplate, { presentation }));
  return stabilizePdf(buffer);
}
```

- [ ] **Step 6: Make the output byte-stable**

A PDF normally embeds `/CreationDate` and `/ModDate` from the wall clock, which would break both the byte-stability test and the idempotent-overwrite reasoning in spec §4.5.

```ts
// packages/api/src/bill-render/stabilize-pdf.ts

/**
 * Remove the only non-deterministic bytes a PDF carries: the creation and
 * modification timestamps. Without this, two renders of the same
 * presentation differ, and spec §4.5's "a re-render overwrites the same
 * object with identical bytes" stops being true — which is what makes a
 * concurrent render safe.
 *
 * Fixed date rather than deleted, because some readers expect the key to
 * exist. The value is arbitrary and carries no information: when a bill
 * was rendered lives in BillDocument.generatedAt.
 */
const FIXED = "D:20000101000000Z";

export function stabilizePdf(pdf: Buffer): Buffer {
  const latin = pdf.toString("latin1");
  const replaced = latin
    .replace(/\/CreationDate\s*\(D:[^)]*\)/g, `/CreationDate (${FIXED})`)
    .replace(/\/ModDate\s*\(D:[^)]*\)/g, `/ModDate (${FIXED})`);
  return Buffer.from(replaced, "latin1");
}
```

If the byte-stability test still fails after this, print the two buffers' first differing offset and inspect what varies — do not weaken the test. If react-pdf embeds a document ID (`/ID [<…><…>]`), normalise that the same way, and add a test asserting the specific key is pinned.

- [ ] **Step 7: Run the tests**

Run: the Step 3 command.
Expected: PASS (4 tests).

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm --filter @utility-cis/api exec tsc --noEmit`

```bash
git add packages/api/package.json packages/api/tsconfig.json packages/api/src/bill-template packages/api/src/bill-render packages/api/src/__tests__/bill-render ../../pnpm-lock.yaml
git commit -m "feat(billing): render a bill presentation to a byte-stable PDF"
```

---

## Task 6: BillDocument — store, retrieve, endpoints

**Files:**
- Create: `packages/shared/prisma/migrations/20261011120300_bill_document/migration.sql`
- Create: `packages/api/src/services/bill-document.service.ts`
- Create: `packages/api/src/routes/bill-documents.ts`
- Modify: `packages/shared/prisma/schema.prisma`, `packages/api/src/app.ts`
- Test: `packages/api/src/__tests__/integration/bill-document.integration.test.ts`

**Interfaces:**
- Consumes: `loadBillPresentation` (Task 3), `putObject`/`getObject`/`ApptorConnectError` (Task 4), `renderBillPdf`/`DEFAULT_TEMPLATE_KEY` (Task 5).
- Produces:

```ts
export interface BillDocumentRow {
  id: string;
  billId: string;
  documentType: "PDF";
  storageIntegration: string;
  storageConnection: string | null;
  objectKey: string;
  byteSize: number;
  sha256: string;
  templateKey: string;
  generatedAt: Date;
  isPaperless: boolean;
}

export async function renderBillDocument(
  utilityId: string,
  billId: string,
  actorId: string,
  opts?: { force?: boolean },
): Promise<BillDocumentRow>;

export async function readBillDocument(
  utilityId: string,
  billId: string,
): Promise<{ row: BillDocumentRow; bytes: Buffer }>;

export function billObjectKey(utilityId: string, billId: string, version: number): string;
```

Task 7 consumes `renderBillDocument`. Note what is deliberately absent: no field holds a URL. A minted link is consumed and discarded inside the files client.

- [ ] **Step 1: Add the model and migration**

```prisma
/// The rendered artifact for one bill. Holds a pointer, never bytes: the
/// object lives in the tenant's own store, reached through
/// apptor-connect's files plane.
model BillDocument {
  id                 String   @id @default(uuid()) @db.Uuid
  utilityId          String   @map("utility_id") @db.Uuid
  billId             String   @map("bill_id") @db.Uuid
  documentType       String   @map("document_type") @db.VarChar(20)
  storageIntegration String   @map("storage_integration") @db.VarChar(100)
  storageConnection  String?  @map("storage_connection") @db.VarChar(100)
  objectKey          String   @map("object_key") @db.VarChar(500)
  byteSize           Int      @map("byte_size")
  sha256             String   @map("sha256") @db.Char(64)
  templateKey        String   @map("template_key") @db.VarChar(100)
  generatedAt        DateTime @default(now()) @map("generated_at") @db.Timestamptz
  isPaperless        Boolean  @map("is_paperless")

  bill               Bill     @relation(fields: [billId], references: [id], onDelete: Restrict)

  @@unique([billId, documentType])
  @@index([utilityId, generatedAt])
  @@map("bill_document")
}
```

Add `documents BillDocument[]` to `model Bill`. Write the migration to match, including the RLS policy copied from an existing table's migration, and `CONSTRAINT "bill_document_bill_id_document_type_key" UNIQUE ("bill_id", "document_type")`.

`documentType` is a `VARCHAR` with `PDF` the only value written now, rather than a Postgres enum, because the project's own migration notes record that enum values cannot be removed once added — and `PRINT_EXPORT` / `EMAIL_HTML` are not designed yet.

- [ ] **Step 2: Write the failing integration test**

```ts
// packages/api/src/__tests__/integration/bill-document.integration.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, resetDb, makeTenantFixture, TENANT_A, ACTOR } from "./_effective-dating-fixtures.js";

const put = vi.fn().mockResolvedValue(undefined);
const get = vi.fn();

vi.mock("../../lib/apptor-connect/files-client.js", () => ({
  putObject: (...a: unknown[]) => put(...a),
  getObject: (...a: unknown[]) => get(...a),
  ApptorConnectError: class extends Error {
    constructor(m: string, readonly status: number | null, readonly integration: string) { super(m); }
  },
}));

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/bill-document.service.js");

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/bill-document.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetDb(prismaImports.prisma);
  put.mockClear();
  get.mockReset();
});

/**
 * Builds a posted bill with one segment and two lines, plus complete
 * issuer identity and a billing address, so rendering can succeed.
 * Returns the bill id. Implement with makeTenantFixture plus direct
 * creates — read _effective-dating-fixtures.ts for the available ids.
 */
async function postedBill(): Promise<string> {
  throw new Error("implement in Step 3");
}

describe("bill documents", () => {
  it("renders once, stores a pointer, and is idempotent", async () => {
    const billId = await postedBill();

    const first = await svc.renderBillDocument(TENANT_A, billId, ACTOR);
    const second = await svc.renderBillDocument(TENANT_A, billId, ACTOR);

    expect(put).toHaveBeenCalledTimes(1);
    expect(second.id).toBe(first.id);
    expect(first.objectKey).toBe(`bills/${TENANT_A}/${billId}-v1.pdf`);
    expect(first.sha256).toHaveLength(64);
    expect(first.byteSize).toBeGreaterThan(0);
  });

  it("round-trips the stored bytes on read", async () => {
    const billId = await postedBill();
    const row = await svc.renderBillDocument(TENANT_A, billId, ACTOR);
    const uploaded = put.mock.calls[0][0].body as Buffer;
    get.mockResolvedValue(uploaded);

    const { bytes } = await svc.readBillDocument(TENANT_A, billId);

    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBe(row.byteSize);
  });

  it("writes no row when the upload fails", async () => {
    const billId = await postedBill();
    put.mockRejectedValueOnce(new Error("rejected"));

    await expect(svc.renderBillDocument(TENANT_A, billId, ACTOR)).rejects.toThrow();

    const count = await prismaImports.prisma.billDocument.count({ where: { billId } });
    expect(count).toBe(0);
  });

  it("refuses an unposted bill", async () => {
    const billId = await postedBill();
    await prismaImports.prisma.bill.update({ where: { id: billId }, data: { postedAt: null } });

    await expect(svc.renderBillDocument(TENANT_A, billId, ACTOR)).rejects.toMatchObject({
      code: "NOT_POSTED",
    });
  });

  it("keeps a document invisible to another tenant", async () => {
    const billId = await postedBill();
    await svc.renderBillDocument(TENANT_A, billId, ACTOR);

    await expect(svc.readBillDocument("00000000-0000-4000-8000-0000000000bb", billId)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Implement the fixture helper**

Replace `postedBill()` with a real builder: `makeTenantFixture(prisma, TENANT_A)`, then create a `BillSegment` with two `BillSegmentLine` rows, a `Bill` with matching totals and `postedAt` set, a `BillingAddress` on the account, and a `TenantConfig` carrying all five required issuer fields. Read `_effective-dating-fixtures.ts` and `bill.service.ts` for the exact required columns rather than guessing.

- [ ] **Step 4: Run and confirm failure**

Run: `cd packages/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/bill-document.integration.test.ts`
Expected: FAIL — service module not found.

- [ ] **Step 5: Implement the service**

`packages/api/src/services/bill-document.service.ts`:

```ts
export function billObjectKey(utilityId: string, billId: string, version: number): string {
  return `bills/${utilityId}/${billId}-v${version}.pdf`;
}
```

`renderBillDocument(utilityId, billId, actorId, opts)`:

1. Load the bill (`postedAt`, `version`, `account.paperlessBilling`, `utilityId`). Throw `{ code: "NOT_POSTED" }` if `postedAt` is null.
2. Unless `opts.force`, return any existing `billDocument` for `(billId, "PDF")`.
3. Resolve the storage integration from `TenantConfig`. If unset, throw `{ code: "STORAGE_NOT_CONFIGURED", integration: null }`.
4. `loadBillPresentation` → `renderBillPdf` → compute `sha256` over the buffer.
5. `putObject({ integration, connection, key: billObjectKey(...), body, maxBytes: config.BILL_DOCUMENT_MAX_BYTES })`.
6. Then create the row inside `auditCreate`, so the audit row and the document commit together. **Upload before the row, per spec §7:** an orphan object at a deterministic key is inert and the next render overwrites it; a row pointing at nothing is not.
7. On a unique-constraint violation (a concurrent render won), re-read and return the existing row rather than throwing.

`readBillDocument(utilityId, billId)` finds the row scoped by `utilityId`, calls `getObject`, and returns both. A missing row is the caller's 404; a missing object is a 500 naming bill id, integration and key.

- [ ] **Step 6: Run the tests**

Run: the Step 4 command.
Expected: PASS (5 tests).

- [ ] **Step 7: Add the routes**

Create `packages/api/src/routes/bill-documents.ts`:

- `POST /api/v1/bills/:id/document` — `accounts:VIEW`; `?force=true` re-renders.
- `GET /api/v1/bills/:id/document` — `accounts:VIEW`; sets `Content-Type: application/pdf` and `Content-Disposition: attachment; filename="bill-<billNumber>-v<version>.pdf"`, then sends the buffer.
- `GET /api/v1/bills/:id/versions` — `accounts:VIEW`; the reprint chain, newest first (Task 7 fills the chain; return the single bill until then).
- `GET /portal/api/bills/:id/document` — `portal_billing:VIEW`, scoped so the authenticated customer can only reach bills on their own accounts; follow `routes/portal-api.ts` for how that scoping is already done.

Map error codes to statuses: `ISSUER_INCOMPLETE` / `RECIPIENT_INCOMPLETE` / `NO_CHARGES` / `STORAGE_NOT_CONFIGURED` → 422 with the `missing` list; `NOT_POSTED` → 409; `ApptorConnectError` → 502 naming the integration and never the link. Register in `app.ts`.

- [ ] **Step 8: Add the 422 and 502 endpoint tests**

Append two cases to the integration file: a bill whose `TenantConfig` lacks `utilityName` renders a 422 whose body names `utilityName`; and a `put` that rejects with `ApptorConnectError(…, 503, "cis-bills")` surfaces 502 with the integration name and no `url` anywhere in the body.

- [ ] **Step 9: Typecheck and commit**

```bash
git add packages/shared/prisma packages/api/src/services/bill-document.service.ts packages/api/src/routes/bill-documents.ts packages/api/src/app.ts packages/api/src/__tests__/integration/bill-document.integration.test.ts
git commit -m "feat(billing): BillDocument — render, store a pointer, stream the bytes"
```

---

## Task 7: Reprint versioning

**Files:**
- Create: `packages/shared/prisma/migrations/20261011120200_bill_version/migration.sql`
- Modify: `packages/shared/prisma/schema.prisma`, `packages/api/src/services/bill-document.service.ts`, `packages/api/src/routes/bill-documents.ts`
- Test: `packages/api/src/__tests__/integration/bill-reprint.integration.test.ts`

**Interfaces:**
- Consumes: `renderBillDocument` (Task 6).
- Produces: `reprintBill(utilityId, billId, actorId, actorName): Promise<{ bill: BillSummary; document: BillDocumentRow }>` and `listBillVersions(utilityId, billId): Promise<BillSummary[]>`.

> **`BillSummary` has to grow first.** The existing interface in `packages/api/src/services/bill.service.ts` carries no `version` or `replacesId`, but this task's tests read both. Add them there — `version: number` and `replacesId: string | null` — and include the columns in that service's `select`, so the bills list and `getBill` return them too. Task 8's reprint action needs `version` to label a bill, so leaving it off the summary would force a second fetch.

- [ ] **Step 1: Write the migration**

```sql
-- packages/shared/prisma/migrations/20261011120200_bill_version/migration.sql
-- Reprint versioning. A reprint is a new bill row sharing the bill number,
-- so the number is no longer unique on its own.
ALTER TABLE "bill"
  ADD COLUMN "version"     INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "replaces_id" UUID;

ALTER TABLE "bill"
  ADD CONSTRAINT "bill_replaces_id_fkey" FOREIGN KEY ("replaces_id")
    REFERENCES "bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX IF EXISTS "bill_utility_id_bill_number_key";
ALTER TABLE "bill" DROP CONSTRAINT IF EXISTS "bill_utility_id_bill_number_key";

ALTER TABLE "bill"
  ADD CONSTRAINT "bill_utility_id_bill_number_version_key"
    UNIQUE ("utility_id", "bill_number", "version");

CREATE UNIQUE INDEX "bill_replaces_id_key" ON "bill" ("replaces_id") WHERE "replaces_id" IS NOT NULL;
```

That last index is what makes Review Focus 5 hold: one bill can be superseded by at most one successor, so two concurrent reprints cannot both create version 2 — the second gets a constraint violation rather than forking the chain.

Update `model Bill` to match: `version Int @default(1)`, `replacesId String? @map("replaces_id") @db.Uuid`, a self-relation (`replaces Bill? @relation("BillReprint", fields: [replacesId], references: [id])` plus `replacedBy Bill? @relation("BillReprint")`), and change `@@unique([utilityId, billNumber])` to `@@unique([utilityId, billNumber, version])`.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/api/src/__tests__/integration/bill-reprint.integration.test.ts
// Same boot/mock preamble as bill-document.integration.test.ts, plus the
// same postedBill() helper — copy it rather than importing, so each file
// owns its fixture.

describe("bill reprints", () => {
  it("creates version 2 chained to the original and renders it", async () => {
    const billId = await postedBill();
    await svc.renderBillDocument(TENANT_A, billId, ACTOR);

    const { bill, document } = await svc.reprintBill(TENANT_A, billId, ACTOR, "Actor");

    expect(bill.version).toBe(2);
    expect(bill.replacesId).toBe(billId);
    expect(bill.billNumber).toBe((await prismaImports.prisma.bill.findUniqueOrThrow({ where: { id: billId } })).billNumber);
    expect(document.objectKey).toBe(`bills/${TENANT_A}/${bill.id}-v2.pdf`);
  });

  it("leaves version 1 and its document retrievable", async () => {
    const billId = await postedBill();
    await svc.renderBillDocument(TENANT_A, billId, ACTOR);
    await svc.reprintBill(TENANT_A, billId, ACTOR, "Actor");

    const original = await prismaImports.prisma.bill.findUniqueOrThrow({ where: { id: billId } });
    expect(original.version).toBe(1);
    expect(await prismaImports.prisma.billDocument.count({ where: { billId } })).toBe(1);
  });

  it("writes nothing to the ledger", async () => {
    const billId = await postedBill();
    const before = await prismaImports.prisma.ledgerEntry.count();

    await svc.reprintBill(TENANT_A, billId, ACTOR, "Actor");

    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(before);
  });

  // Review Focus 5
  it("does not let two concurrent reprints both become version 2", async () => {
    const billId = await postedBill();

    const results = await Promise.allSettled([
      svc.reprintBill(TENANT_A, billId, ACTOR, "Actor"),
      svc.reprintBill(TENANT_A, billId, ACTOR, "Actor"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const versions = await prismaImports.prisma.bill.findMany({ where: { OR: [{ id: billId }, { replacesId: billId }] } });
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
  });

  it("lists the chain newest first", async () => {
    const billId = await postedBill();
    const { bill: v2 } = await svc.reprintBill(TENANT_A, billId, ACTOR, "Actor");

    const chain = await svc.listBillVersions(TENANT_A, billId);

    expect(chain.map((b) => b.id)).toEqual([v2.id, billId]);
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `cd packages/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/bill-reprint.integration.test.ts`
Expected: FAIL — `reprintBill` is not exported.

- [ ] **Step 4: Implement reprint**

In `bill-document.service.ts`:

`reprintBill` runs one transaction that copies the source bill's period, dates, totals and `billNumber` into a new row with `version = source.version + 1` and `replacesId = source.id`, re-points nothing in the ledger, and writes an audit row via `auditCreate`. Then, outside that transaction, calls `renderBillDocument` for the new bill. Walk to the newest version first so reprinting an already-reprinted bill chains from the tip rather than forking.

`listBillVersions` walks the chain by `billNumber` within the tenant, ordered by `version` descending.

- [ ] **Step 5: Run the tests**

Run: the Step 3 command.
Expected: PASS (5 tests).

- [ ] **Step 6: Add the route**

`POST /api/v1/bills/:id/reprint` gated `{ config: { module: "accounts", permission: "APPROVE" } }`. Return `{ bill, document }`. Fill in `GET /api/v1/bills/:id/versions` from `listBillVersions`.

- [ ] **Step 7: Typecheck and commit**

```bash
git add packages/shared/prisma packages/api/src/services/bill-document.service.ts packages/api/src/routes/bill-documents.ts packages/api/src/__tests__/integration/bill-reprint.integration.test.ts
git commit -m "feat(billing): reprint a bill as a new chained version"
```

---

## Task 8: UI — download, reprint, and bill messages

**Files:**
- Create: `packages/web/app/settings/bill-messages/page.tsx`
- Modify: `packages/web/app/bills/page.tsx`, `packages/web/app/portal/bills/page.tsx`
- Test: `packages/web/app/settings/bill-messages/__tests__/page.test.tsx`, `packages/web/app/bills/__tests__/page.test.tsx`

**Interfaces:**
- Consumes: the endpoints from Tasks 6 and 7.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing bills-page test**

Follow `packages/web/app/receipts/__tests__/page.test.tsx` for the established mocking style in this package — read it first. Assert: a Download action per bill calls `GET /api/v1/bills/:id/document`; a bill with no document yet shows a Generate action that POSTs; the Reprint action is absent for a user whose permissions lack `accounts:APPROVE`.

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/web && pnpm vitest run app/bills/__tests__/page.test.tsx`
Expected: FAIL on the missing actions.

- [ ] **Step 3: Add the actions to the bills page**

Download triggers a fetch and a blob download; Generate POSTs then downloads; Reprint is permission-gated and confirms first. The confirmation copy must say plainly that a reprint re-renders the bill and does not change what is owed — spec §10 records that operators will otherwise expect a correction.

- [ ] **Step 4: Run the test**

Expected: PASS.

- [ ] **Step 5: Add the portal download**

Same pattern on `packages/web/app/portal/bills/page.tsx`, against `GET /portal/api/bills/:id/document`. Never render a link minted by apptor-connect; the browser only ever talks to our API.

- [ ] **Step 6: Add the download to the account AR tab**

Spec §9 puts a download alongside each bill in `packages/web/components/ar/ar-tab.tsx`, because that is where staff already look when a customer phones about a bill. Add the same download action used on the bills list — extract it into a small shared component rather than copying the fetch-and-blob logic, since two call sites now need it and a third (the portal) has its own endpoint. Assert in `packages/web/components/ar/__tests__/ar-tab.test.tsx` that a bill row offers the download and hits `GET /api/v1/bills/:id/document`.

- [ ] **Step 7: Build the bill-messages settings page**

CRUD over `/api/v1/bill-messages` with fields for label, body, account type, commodity, priority and the active window, following an existing settings page (`packages/web/app/settings/slas/page.tsx`) for layout and data-fetching conventions.

- [ ] **Step 8: Add the issuer-identity fields to settings**

Extend `packages/web/app/settings/general/page.tsx` with the ten Task 1 fields, and state on the page that bills cannot be produced until the required five are filled.

- [ ] **Step 9: Run the full web suite, typecheck, commit**

Run: `cd packages/web && pnpm vitest run` then `pnpm typecheck` from the repo root.

```bash
git add packages/web
git commit -m "feat(billing): download and reprint bills, manage bill messages"
```

---

## Final verification

- [ ] `pnpm typecheck` — exit 0 across shared, api and web.
- [ ] `pnpm --filter @utility-cis/api test` — the unit suite, which is what CI runs.
- [ ] `cd packages/api && pnpm vitest run --config vitest.integration.config.ts` — the full 58-file suite with the dev server stopped. Budget ~25 minutes; a `migrate deploy` failure here is environmental, not yours.
- [ ] `cd packages/web && pnpm vitest run`.
- [ ] Update `docs/specs/09-billing.md`: mark `BillDocument` and bill messages shipped, correct its `BillingRecord` references to `Bill`, and record that reprint versioning now exists. The project's CLAUDE.md requires the module spec to move with the schema.
- [ ] Update `docs/bozeman/17-implementation-gap-analysis.md`: #130, #133 and #137 move from absent to built; #132 from absent to partial. Do not touch the other verdicts.
