/**
 * One name for a customer who is either a person or an organisation.
 *
 * Null rather than an empty string when neither is usable, so the caller
 * decides how to render "unknown" instead of inheriting a blank cell.
 *
 * Its own module because both tenant-wide money lists need it — receipts
 * and disbursements — and the alternative was one list service importing
 * a display helper out of the other, which says something untrue about
 * how they relate.
 */
export function displayCustomerName(
  customer: {
    customerType: string;
    firstName: string | null;
    lastName: string | null;
    organizationName: string | null;
  } | null,
): string | null {
  if (!customer) return null;
  if (customer.customerType === "ORGANIZATION") return customer.organizationName ?? null;
  const name = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim();
  return name === "" ? null : name;
}
