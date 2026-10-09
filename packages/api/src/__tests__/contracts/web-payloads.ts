/**
 * Web→API payload fixtures.
 *
 * Each fixture captures the EXACT body/query shape the web client sends.
 * When you change a web form, update the corresponding fixture here — the
 * contract tests in `contracts/*.contract.test.ts` will tell you immediately
 * if the API no longer accepts what the web is sending.
 *
 * Maintenance rule: every fixture has a comment linking to the web file
 * and line where the payload is built. Keep those pointers accurate.
 */

import type { AttachmentEntityType } from "@utility-cis/shared";

/* ──────────────────────────────────────────────────────────
 * Attachments
 * ──────────────────────────────────────────────────────── */

// Source: packages/web/components/ui/attachments-tab.tsx:57-60
export function attachmentsListQuery(
  entityType: AttachmentEntityType,
  entityId: string
): Record<string, string> {
  return { entityType, entityId };
}

// Source: packages/web/components/ui/attachments-tab.tsx:77-83
export function attachmentsUploadFields(
  entityType: AttachmentEntityType,
  entityId: string,
  description?: string
): Record<string, string> {
  const fields: Record<string, string> = { entityType, entityId };
  if (description) fields.description = description;
  return fields;
}

/* ──────────────────────────────────────────────────────────
 * Customers
 * ──────────────────────────────────────────────────────── */

// Source: packages/web/app/customers/new/page.tsx — INDIVIDUAL branch
export function customerCreateIndividual(): Record<string, unknown> {
  return {
    customerType: "INDIVIDUAL",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    phone: "5551234567",
    dateOfBirth: "1990-01-15",
    driversLicense: "D1234567",
  };
}

// Source: packages/web/app/customers/new/page.tsx — ORGANIZATION branch
export function customerCreateOrganization(): Record<string, unknown> {
  return {
    customerType: "ORGANIZATION",
    organizationName: "Acme Corp",
    email: "billing@acme.test",
    phone: "5559998888",
    taxId: "12-3456789",
  };
}

/* ──────────────────────────────────────────────────────────
 * Accounts
 * ──────────────────────────────────────────────────────── */

// Source: packages/web/app/accounts/new/page.tsx:158-174 (`toRequestBody`)
//
// billingCycleId is required and unconditional — Account has required a
// billing cycle since Rate Model v2 slice 5b.1. This fixture went stale
// when that landed and said so for months without anyone seeing it,
// because its contract test could not even be imported (ioredis /
// `Cannot redefine property: default`). It is the exact failure this
// file exists to catch, hidden by a broken test runner rather than by a
// missing test.
export function accountCreate(): Record<string, unknown> {
  return {
    accountNumber: "ACC-000001",
    accountType: "RESIDENTIAL",
    billingCycleId: "00000000-0000-4000-8000-00000000c001",
    languagePref: "en-US",
    creditRating: "GOOD",
    depositAmount: 150,
  };
}

/* ──────────────────────────────────────────────────────────
 * Audit log (queried from detail pages)
 * ──────────────────────────────────────────────────────── */

// Source: packages/web/app/premises/[id]/page.tsx:163-166,
//         packages/web/app/rate-schedules/[id]/page.tsx:78-81,
//         packages/web/app/service-agreements/[id]/page.tsx:143-146,
//         packages/web/app/accounts/[id]/page.tsx:145-148
export function auditLogEntityQuery(
  entityType: AttachmentEntityType,
  entityId: string
): Record<string, string> {
  return { entityType, entityId };
}
