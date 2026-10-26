import { BillPresentationError } from "./document.js";
import { addressLines, cityLine } from "./format.js";

/**
 * Who the bill is for, and where it goes.
 *
 * The other side of the envelope from `issuer`. An organization name
 * wins over a person's: a bill addressed to the signatory of a company
 * account is addressed to the wrong party.
 */

export interface BillRecipientSource {
  accountNumber: string;
  customer: {
    firstName: string | null;
    lastName: string | null;
    organizationName: string | null;
  } | null;
  /** At most one, already ordered by the query: primary, else oldest. */
  billingAddresses: Array<{
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  }>;
}

/**
 * Refuses an account that cannot say who the bill is for
 * (`RECIPIENT_INCOMPLETE`), naming which of the two is missing and
 * where to fix it — "no name or no address" left an operator to guess
 * which, on an account they then had to go and find.
 */
export function resolveRecipient(account: BillRecipientSource): {
  name: string;
  addressLines: string[];
} {
  const customer = account.customer;
  const name =
    customer?.organizationName?.trim() ||
    [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim();
  const address = account.billingAddresses[0];

  if (!name || !address) {
    const lacks = [
      !name ? "no customer with a name" : null,
      !address ? "no billing address" : null,
    ].filter(Boolean);
    throw new BillPresentationError(
      `Account ${account.accountNumber} has ${lacks.join(" and ")}, so this bill cannot say who it is for. ` +
        `Add ${!name && !address ? "both" : "it"} on the account, then generate the bill again.`,
      "RECIPIENT_INCOMPLETE",
      [!name ? "recipientName" : "", !address ? "billingAddress" : ""].filter(Boolean),
    );
  }

  return {
    name,
    addressLines: addressLines([
      address.addressLine1,
      address.addressLine2,
      cityLine(address.city, address.state, address.zip),
    ]),
  };
}
