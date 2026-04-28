import { EVENT_TYPES } from "@utility-cis/shared";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { registerImportKind } from "../registry.js";
import type { ImportKindHandler } from "../types.js";

/**
 * Customer import kind handler. Used for portfolio-acquisition data
 * loads, legacy migrations, and bulk move-in seed data.
 *
 * Per-row pipeline (within the framework-supplied tx):
 *   1. Insert one Customer row.
 *   2. Emit audit row.
 *
 * Compared to the meter-read handler, customer rows have no cross-row
 * dependencies — there's no "prior reading" or chronological ordering
 * to honour, so `prepareBatch` is a no-op. This is the simplest
 * shape a kind handler can take and exists partly to validate the
 * framework's abstraction holds for entities without batch-level state.
 *
 * Idempotency note: this slice does not de-duplicate against existing
 * customers. Re-running an import file produces duplicate Customer
 * rows. That's a Phase 2 concern (operators will ask for it; the
 * framework already records the source file via Attachment so a
 * dedupe sweep can run after the fact).
 */

interface CustomerRow {
  customerType: "INDIVIDUAL" | "ORGANIZATION";
  firstName?: string;
  lastName?: string;
  organizationName?: string;
  email?: string;
  phone?: string;
  status?: "ACTIVE" | "INACTIVE";
}

const CUSTOMER_TYPES = ["INDIVIDUAL", "ORGANIZATION"] as const;
const CUSTOMER_STATUSES = ["ACTIVE", "INACTIVE"] as const;

// Loose-but-practical email check. The spec at the wire only stores
// a varchar(255), and we don't want to reject anything Postgres would
// happily store; this catches obvious typos (no @, trailing space).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const handler: ImportKindHandler<CustomerRow, void> = {
  kind: "customer",
  label: "Customers",
  module: "customers",
  permission: "CREATE",

  canonicalFields: [
    {
      name: "customerType",
      label: "Customer type",
      required: true,
      description: "INDIVIDUAL or ORGANIZATION.",
      example: "INDIVIDUAL",
      aliases: ["^customertype$", "^type$", "^customerclass$", "^class$"],
    },
    {
      name: "firstName",
      label: "First name",
      required: false,
      description: "Required for INDIVIDUAL customers.",
      example: "Jane",
      aliases: ["^firstname$", "^fname$", "^givenname$"],
    },
    {
      name: "lastName",
      label: "Last name",
      required: false,
      description: "Required for INDIVIDUAL customers.",
      example: "Doe",
      aliases: ["^lastname$", "^lname$", "^surname$", "^familyname$"],
    },
    {
      name: "organizationName",
      label: "Organization name",
      required: false,
      description: "Required for ORGANIZATION customers.",
      example: "Acme Corp",
      aliases: [
        "^organizationname$",
        "^organization$",
        "^orgname$",
        "^companyname$",
        "^company$",
        "^business$",
        "^businessname$",
      ],
    },
    {
      name: "email",
      label: "Email",
      required: false,
      example: "jane@example.com",
      aliases: ["^email$", "^emailaddress$", "^primaryemail$"],
    },
    {
      name: "phone",
      label: "Phone",
      required: false,
      example: "+1-555-0100",
      aliases: ["^phone$", "^phonenumber$", "^primaryphone$", "^telephone$", "^tel$"],
    },
    {
      name: "status",
      label: "Status",
      required: false,
      description: "ACTIVE (default) or INACTIVE.",
      example: "ACTIVE",
      aliases: ["^status$", "^state$"],
    },
  ],

  templateRows: [
    {
      customerType: "INDIVIDUAL",
      firstName: "Jane",
      lastName: "Doe",
      organizationName: "",
      email: "jane.doe@example.com",
      phone: "+1-555-0100",
      status: "ACTIVE",
    },
    {
      customerType: "ORGANIZATION",
      firstName: "",
      lastName: "",
      organizationName: "Acme Corp",
      email: "billing@acme.test",
      phone: "+1-555-0199",
      status: "ACTIVE",
    },
  ],

  parseRow: (raw) => {
    const typeRaw = (raw.customerType ?? "").trim().toUpperCase();
    if (!typeRaw) {
      return {
        ok: false,
        code: "MISSING_CUSTOMER_TYPE",
        message: "customer_type is required",
      };
    }
    if (!CUSTOMER_TYPES.includes(typeRaw as (typeof CUSTOMER_TYPES)[number])) {
      return {
        ok: false,
        code: "INVALID_CUSTOMER_TYPE",
        message: `customer_type "${raw.customerType}" must be one of ${CUSTOMER_TYPES.join(", ")}`,
      };
    }
    const customerType = typeRaw as (typeof CUSTOMER_TYPES)[number];

    const firstName = (raw.firstName ?? "").trim() || undefined;
    const lastName = (raw.lastName ?? "").trim() || undefined;
    const organizationName = (raw.organizationName ?? "").trim() || undefined;

    // Conditional required logic: an INDIVIDUAL needs at least a last
    // name OR a first name; an ORGANIZATION needs an organization
    // name. Catching this here means the operator gets a row-level
    // error code instead of a vague Prisma constraint failure.
    if (customerType === "INDIVIDUAL" && !firstName && !lastName) {
      return {
        ok: false,
        code: "MISSING_NAME",
        message: "INDIVIDUAL customers require first_name or last_name",
      };
    }
    if (customerType === "ORGANIZATION" && !organizationName) {
      return {
        ok: false,
        code: "MISSING_ORGANIZATION_NAME",
        message: "ORGANIZATION customers require organization_name",
      };
    }

    const emailRaw = (raw.email ?? "").trim();
    if (emailRaw && !EMAIL_RE.test(emailRaw)) {
      return {
        ok: false,
        code: "INVALID_EMAIL",
        message: `email "${raw.email}" is not a valid address`,
      };
    }

    const statusRaw = (raw.status ?? "").trim().toUpperCase();
    let status: "ACTIVE" | "INACTIVE" | undefined;
    if (statusRaw) {
      if (!CUSTOMER_STATUSES.includes(statusRaw as (typeof CUSTOMER_STATUSES)[number])) {
        return {
          ok: false,
          code: "INVALID_STATUS",
          message: `status "${raw.status}" must be one of ${CUSTOMER_STATUSES.join(", ")}`,
        };
      }
      status = statusRaw as (typeof CUSTOMER_STATUSES)[number];
    }

    return {
      ok: true,
      row: {
        customerType,
        firstName,
        lastName,
        organizationName,
        email: emailRaw || undefined,
        phone: ((raw.phone ?? "").trim()) || undefined,
        status,
      },
    };
  },

  async processRow(ctx, row) {
    const created = await ctx.tx.customer.create({
      data: {
        utilityId: ctx.utilityId,
        customerType: row.customerType,
        firstName: row.firstName ?? null,
        lastName: row.lastName ?? null,
        organizationName: row.organizationName ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
        status: row.status ?? "ACTIVE",
      },
    });

    await writeAuditRow(
      ctx.tx,
      {
        utilityId: ctx.utilityId,
        actorId: ctx.actorId,
        actorName: ctx.actorName,
        entityType: "Customer",
      },
      EVENT_TYPES.CUSTOMER_CREATED,
      created.id,
      null,
      created,
    );

    return { ok: true, entityId: created.id };
  },
};

registerImportKind(handler);
