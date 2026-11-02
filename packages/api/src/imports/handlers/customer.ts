import { EVENT_TYPES } from "@utility-cis/shared";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { prisma } from "../../lib/prisma.js";
import { registerImportKind } from "../registry.js";
import { identityConflict, legacyKeyField, legacyKeyOf } from "../legacy-key.js";
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
 * to honour. It was the simplest shape a kind handler can take, with no
 * `prepareBatch` at all, and existed partly to validate the framework's
 * abstraction holds for entities without batch-level state. It gained
 * one when legacy-key matching arrived (spec 28, OVL-IN-5): one query
 * for the keys the file carries, and none at all for a file without
 * them.
 *
 * Idempotency note: this slice does not de-duplicate against existing
 * customers. Re-running an import file produces duplicate Customer
 * rows. That's a Phase 2 concern (operators will ask for it; the
 * framework already records the source file via Attachment so a
 * dedupe sweep can run after the fact).
 */

interface CustomerRow {
  /** The customer's id in the legacy CIS, when the file carries it. */
  legacyKey?: string;
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

interface BatchData {
  /** Legacy key → the customer already mirrored under it. */
  existingByLegacyKey: Map<string, { id: string; customerType: string }>;
}

const handler: ImportKindHandler<CustomerRow, BatchData> = {
  kind: "customer",
  label: "Customers",
  module: "customers",
  permission: "CREATE",
  wizardPath: "/customers/import",

  canonicalFields: [
    legacyKeyField,
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
        legacyKey: ((raw.legacyKey ?? "").trim()) || undefined,
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

  async prepareBatch(ctx, rows) {
    const legacyKeys = new Set(
      rows.map((r) => legacyKeyOf(r)).filter((k): k is string => Boolean(k)),
    );
    const existingByLegacyKey = new Map<string, { id: string; customerType: string }>();
    if (legacyKeys.size > 0) {
      const existing = await prisma.customer.findMany({
        where: { utilityId: ctx.utilityId, legacyKey: { in: [...legacyKeys] } },
        select: { id: true, legacyKey: true, customerType: true },
      });
      for (const e of existing) {
        if (e.legacyKey) {
          existingByLegacyKey.set(e.legacyKey, { id: e.id, customerType: e.customerType });
        }
      }
    }
    return { existingByLegacyKey };
  },

  async processRow(ctx, row, batch) {
    /*
     * Already mirrored under this key? Update in place (spec 28,
     * OVL-IN-5). This handler gained its first `prepareBatch` for the
     * lookup — it had none, because nothing else about a customer row
     * needs resolving.
     *
     * Identity is the customer *type*. An individual that has become an
     * organisation under the same legacy id is not a corrected name, it
     * is a different party: the name columns that matter swap over
     * (`firstName`/`lastName` against `organizationName`), and
     * overwriting would leave a row whose required fields came from the
     * wrong half of the file.
     */
    const legacyKey = legacyKeyOf(row);
    const existing = legacyKey ? batch.existingByLegacyKey.get(legacyKey) : undefined;
    if (existing) {
      const conflict = identityConflict(
        { customerType: existing.customerType },
        { customerType: row.customerType },
      );
      if (conflict) {
        return {
          ok: false,
          code: "LEGACY_KEY_CONFLICT",
          message: `Legacy id "${legacyKey}" is already mirrored to a customer of a different type — ${conflict}`,
        };
      }

      const updated = await ctx.tx.customer.update({
        where: { id: existing.id },
        data: {
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
        EVENT_TYPES.CUSTOMER_UPDATED,
        updated.id,
        null,
        updated,
      );

      return { ok: true, entityId: updated.id };
    }

    const created = await ctx.tx.customer.create({
      data: {
        utilityId: ctx.utilityId,
        legacyKey: legacyKey ?? null,
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
