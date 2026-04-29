import { EVENT_TYPES } from "@utility-cis/shared";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { prisma } from "../../lib/prisma.js";
import { registerImportKind } from "../registry.js";
import type { ImportKindHandler } from "../types.js";

/**
 * Account import kind handler. Used for legacy account migrations,
 * portfolio acquisitions where customers exist (or were imported in a
 * prior batch) and accounts need to attach to them.
 *
 * Per-row pipeline (within the framework-supplied tx):
 *   1. Optionally resolve customerEmail → customerId.
 *   2. Insert one Account row.
 *   3. Emit audit row.
 *
 * customerId is nullable in the schema (an account can exist before a
 * customer is on file, e.g., a vacant property), so a missing
 * customerEmail simply leaves the FK null. An ownerEmail that was
 * provided but doesn't match any customer surfaces as
 * CUSTOMER_NOT_FOUND — silent FK drops mask data quality problems.
 *
 * Idempotency: the unique (utility_id, account_number) constraint
 * makes re-running an import file produce DUPLICATE_ACCOUNT errors
 * rather than overwriting existing accounts.
 */

const ACCOUNT_TYPES = ["RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", "MUNICIPAL"] as const;
const ACCOUNT_STATUSES = [
  "ACTIVE",
  "INACTIVE",
  "FINAL",
  "CLOSED",
  "SUSPENDED",
] as const;
const CREDIT_RATINGS = ["EXCELLENT", "GOOD", "FAIR", "POOR", "UNRATED"] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];
type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
type CreditRating = (typeof CREDIT_RATINGS)[number];

interface AccountRow {
  accountNumber: string;
  accountType: AccountType;
  status: AccountStatus;
  customerEmail?: string;
  creditRating?: CreditRating;
  depositAmount?: number;
  languagePref?: string;
  paperlessBilling?: boolean;
  budgetBilling?: boolean;
}

interface BatchData {
  /** Lower-cased email → customer id, populated once per batch. */
  customerByEmail: Map<string, string>;
}

function parseBool(s: string | undefined): boolean | undefined {
  if (s === undefined) return undefined;
  const v = s.trim().toLowerCase();
  if (!v) return undefined;
  if (["true", "yes", "y", "1", "t"].includes(v)) return true;
  if (["false", "no", "n", "0", "f"].includes(v)) return false;
  return undefined;
}

const handler: ImportKindHandler<AccountRow, BatchData> = {
  kind: "account",
  label: "Accounts",
  module: "accounts",
  permission: "CREATE",

  canonicalFields: [
    {
      name: "accountNumber",
      label: "Account number",
      required: true,
      example: "ACC-1001",
      aliases: ["^accountnumber$", "^accountid$", "^acctnum$", "^acctid$"],
    },
    {
      name: "accountType",
      label: "Account type",
      required: true,
      description: "RESIDENTIAL, COMMERCIAL, INDUSTRIAL, or MUNICIPAL.",
      example: "RESIDENTIAL",
      aliases: ["^accounttype$", "^type$", "^class$"],
    },
    {
      name: "status",
      label: "Status",
      required: true,
      description: "ACTIVE, INACTIVE, FINAL, CLOSED, or SUSPENDED.",
      example: "ACTIVE",
      aliases: ["^status$", "^state$"],
    },
    {
      name: "customerEmail",
      label: "Customer email",
      required: false,
      description: "Resolves to an existing customer by email. Unmatched → row error.",
      example: "owner@example.com",
      aliases: ["^customeremail$", "^email$", "^owneremail$"],
    },
    {
      name: "creditRating",
      label: "Credit rating",
      required: false,
      description: "EXCELLENT, GOOD, FAIR, POOR, UNRATED (default).",
      example: "GOOD",
      aliases: ["^creditrating$", "^credit$"],
    },
    {
      name: "depositAmount",
      label: "Deposit amount",
      required: false,
      description: "Defaults to 0.",
      example: "150.00",
      aliases: ["^depositamount$", "^deposit$"],
    },
    {
      name: "languagePref",
      label: "Language preference",
      required: false,
      description: "5-char locale, default en-US.",
      example: "en-US",
      aliases: ["^languagepref$", "^language$", "^locale$", "^lang$"],
    },
    {
      name: "paperlessBilling",
      label: "Paperless billing",
      required: false,
      description: "true/false (default false).",
      example: "true",
      aliases: ["^paperlessbilling$", "^paperless$"],
    },
    {
      name: "budgetBilling",
      label: "Budget billing",
      required: false,
      description: "true/false (default false).",
      example: "false",
      aliases: ["^budgetbilling$", "^budget$", "^levelpay$"],
    },
  ],

  templateRows: [
    {
      accountNumber: "ACC-1001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      customerEmail: "jane.doe@example.com",
      creditRating: "GOOD",
      depositAmount: "150.00",
      languagePref: "en-US",
      paperlessBilling: "true",
      budgetBilling: "false",
    },
  ],

  parseRow: (raw) => {
    const accountNumber = (raw.accountNumber ?? "").trim();
    if (!accountNumber) {
      return {
        ok: false,
        code: "MISSING_ACCOUNT_NUMBER",
        message: "account_number is required",
      };
    }

    const atRaw = (raw.accountType ?? "").trim().toUpperCase();
    if (!ACCOUNT_TYPES.includes(atRaw as AccountType)) {
      return {
        ok: false,
        code: "INVALID_ACCOUNT_TYPE",
        message: `account_type "${raw.accountType}" must be one of ${ACCOUNT_TYPES.join(", ")}`,
      };
    }
    const accountType = atRaw as AccountType;

    const stRaw = (raw.status ?? "").trim().toUpperCase();
    if (!ACCOUNT_STATUSES.includes(stRaw as AccountStatus)) {
      return {
        ok: false,
        code: "INVALID_STATUS",
        message: `status "${raw.status}" must be one of ${ACCOUNT_STATUSES.join(", ")}`,
      };
    }
    const status = stRaw as AccountStatus;

    const crRaw = (raw.creditRating ?? "").trim().toUpperCase();
    let creditRating: CreditRating | undefined;
    if (crRaw) {
      if (!CREDIT_RATINGS.includes(crRaw as CreditRating)) {
        return {
          ok: false,
          code: "INVALID_CREDIT_RATING",
          message: `credit_rating "${raw.creditRating}" must be one of ${CREDIT_RATINGS.join(", ")}`,
        };
      }
      creditRating = crRaw as CreditRating;
    }

    let depositAmount: number | undefined;
    if ((raw.depositAmount ?? "").trim()) {
      const n = Number(raw.depositAmount);
      if (!Number.isFinite(n) || n < 0) {
        return {
          ok: false,
          code: "INVALID_DEPOSIT",
          message: `deposit_amount "${raw.depositAmount}" must be a non-negative number`,
        };
      }
      depositAmount = n;
    }

    let languagePref: string | undefined;
    const langRaw = (raw.languagePref ?? "").trim();
    if (langRaw) {
      if (langRaw.length !== 5) {
        return {
          ok: false,
          code: "INVALID_LANGUAGE",
          message: `language_pref "${raw.languagePref}" must be a 5-char locale (e.g., en-US)`,
        };
      }
      languagePref = langRaw;
    }

    return {
      ok: true,
      row: {
        accountNumber,
        accountType,
        status,
        customerEmail: ((raw.customerEmail ?? "").trim().toLowerCase()) || undefined,
        creditRating,
        depositAmount,
        languagePref,
        paperlessBilling: parseBool(raw.paperlessBilling),
        budgetBilling: parseBool(raw.budgetBilling),
      },
    };
  },

  async prepareBatch(ctx, rows) {
    const emails = new Set<string>();
    for (const r of rows) {
      if (r.customerEmail) emails.add(r.customerEmail);
    }
    const customerByEmail = new Map<string, string>();
    if (emails.size > 0) {
      const customers = await prisma.customer.findMany({
        where: { utilityId: ctx.utilityId, email: { in: [...emails] } },
        select: { id: true, email: true },
      });
      for (const c of customers) {
        if (c.email) customerByEmail.set(c.email.toLowerCase(), c.id);
      }
    }
    return { customerByEmail };
  },

  async processRow(ctx, row, batch) {
    let customerId: string | null = null;
    if (row.customerEmail) {
      const id = batch.customerByEmail.get(row.customerEmail);
      if (!id) {
        return {
          ok: false,
          code: "CUSTOMER_NOT_FOUND",
          message: `No customer with email "${row.customerEmail}"`,
        };
      }
      customerId = id;
    }

    try {
      const created = await ctx.tx.account.create({
        data: {
          utilityId: ctx.utilityId,
          accountNumber: row.accountNumber,
          accountType: row.accountType,
          status: row.status,
          customerId,
          creditRating: row.creditRating ?? "UNRATED",
          depositAmount: row.depositAmount ?? 0,
          languagePref: row.languagePref ?? "en-US",
          paperlessBilling: row.paperlessBilling ?? false,
          budgetBilling: row.budgetBilling ?? false,
        },
      });

      await writeAuditRow(
        ctx.tx,
        {
          utilityId: ctx.utilityId,
          actorId: ctx.actorId,
          actorName: ctx.actorName,
          entityType: "Account",
        },
        EVENT_TYPES.ACCOUNT_CREATED,
        created.id,
        null,
        created,
      );

      return { ok: true, entityId: created.id };
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        return {
          ok: false,
          code: "DUPLICATE_ACCOUNT",
          message: `account_number "${row.accountNumber}" already exists`,
        };
      }
      throw err;
    }
  },
};

registerImportKind(handler);
