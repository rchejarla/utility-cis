import { z } from "zod";
import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import type { VariableKey, VariableValue } from "../../rate-engine/types.js";
import type { Loader, LoaderCapability } from "../types.js";

/**
 * Slice 4 task 2 — first concrete variable loader.
 *
 * Capabilities:
 *   - `account:class`            → string | null  (rateServiceClass.code on the SA)
 *   - `account:flag:<name>`      → boolean
 *
 * The Account model has dedicated boolean columns for the well-known
 * flags below; everything else falls through to the JSONB `customFields`
 * map. We keep the column mapping in one place so adding a new
 * first-class flag is a one-line change.
 *
 * Construction: bind to a single (utilityId, saId) at rating-call time
 * — a loader instance is short-lived and aligned to one rating run.
 */
const KNOWN_BOOL_COLUMNS: Record<string, string> = {
  paperless_billing: "paperlessBilling",
  budget_billing: "budgetBilling",
  is_protected: "isProtected",
  deposit_waived: "depositWaived",
};

export class AccountLoader implements Loader {
  constructor(
    private prisma: PrismaClient,
    private utilityId: string,
    private saId: string,
  ) {}

  capabilities(): LoaderCapability[] {
    return [
      {
        pattern: "account:class",
        scope: "per_sa",
        returns: z.string().nullable(),
        description: "Customer service class code for this SA's commodity",
      },
      {
        pattern: "account:flag:<flag_name>",
        paramTypes: { flag_name: z.string() },
        scope: "per_sa",
        returns: z.boolean(),
        description:
          "Boolean flag on the account (paperless_billing, budget_billing, is_protected, deposit_waived, or any custom_fields key)",
      },
    ];
  }

  async load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
    const out = new Map<VariableKey, VariableValue>();
    if (keys.length === 0) return out;

    const needsClass = keys.includes("account:class");
    const flagPrefix = "account:flag:";
    const flagNames = keys
      .filter((k) => k.startsWith(flagPrefix))
      .map((k) => k.slice(flagPrefix.length));

    if (!needsClass && flagNames.length === 0) return out;

    // Single batched fetch — all keys this loader handles for a given
    // SA come from the same row.
    const sa = await this.prisma.serviceAgreement.findUniqueOrThrow({
      where: { id: this.saId, utilityId: this.utilityId },
      include: {
        rateServiceClass: { select: { code: true } },
        account: {
          select: {
            paperlessBilling: true,
            budgetBilling: true,
            isProtected: true,
            depositWaived: true,
            customFields: true,
          },
        },
      },
    });

    if (needsClass) {
      out.set("account:class", sa.rateServiceClass?.code ?? null);
    }

    for (const flag of flagNames) {
      let value: boolean;
      const knownColumn = KNOWN_BOOL_COLUMNS[flag];
      if (knownColumn) {
        value = Boolean((sa.account as Record<string, unknown>)[knownColumn]);
      } else {
        const cf = (sa.account.customFields as Record<string, unknown> | null) ?? {};
        value = Boolean(cf[flag]);
      }
      out.set(`${flagPrefix}${flag}`, value);
    }

    return out;
  }
}
