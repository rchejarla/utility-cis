import { missingIssuerFields, type IssuerSettings } from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";
import { BillPresentationError, type BillPresentationIssuer } from "./document.js";
import { addressLines, cityLine } from "./format.js";

/**
 * Who is sending the bill, and where the money goes.
 *
 * Identity lives in `UtilityConfig.settings.issuer` rather than in
 * columns, so it is read defensively: a tenant that has never opened the
 * settings page has no `issuer` key at all. Incomplete identity refuses
 * the render and names the missing fields — a bill with no remittance
 * address is a bill nobody can pay, and finding that out from a customer
 * is worse than finding it out from an error.
 */

function issuerOf(settings: unknown): IssuerSettings {
  if (settings && typeof settings === "object" && "issuer" in settings) {
    const issuer = (settings as { issuer?: unknown }).issuer;
    if (issuer && typeof issuer === "object") return issuer as IssuerSettings;
  }
  return {};
}

export interface ResolvedIssuer {
  issuer: BillPresentationIssuer;
  /** Who to make it payable to: the legal name if there is one. */
  payTo: string;
}

export async function resolveIssuer(utilityId: string): Promise<ResolvedIssuer> {
  const config = await prisma.utilityConfig.findUnique({ where: { utilityId } });
  const issuer = issuerOf(config?.settings);
  const missing = missingIssuerFields(issuer);
  if (missing.length > 0) {
    throw new BillPresentationError(
      `Issuer identity is incomplete: ${missing.join(", ")}. Set it under Settings before producing bills.`,
      "ISSUER_INCOMPLETE",
      [...missing],
    );
  }

  const lines = addressLines([
    issuer.remittanceAddressLine1,
    issuer.remittanceAddressLine2,
    cityLine(issuer.remittanceCity, issuer.remittanceState, issuer.remittancePostalCode),
  ]);

  return {
    issuer: {
      // `missingIssuerFields` has just proved these two present.
      name: issuer.utilityName as string,
      legalName: issuer.utilityLegalName || null,
      addressLines: lines,
      phone: issuer.billingPhone || null,
      email: issuer.billingEmail || null,
      website: issuer.websiteUrl || null,
    },
    payTo: (issuer.utilityLegalName || issuer.utilityName) as string,
  };
}
