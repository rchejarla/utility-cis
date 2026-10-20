/**
 * Where a tenant goes to satisfy each readiness check.
 *
 * It lives in the web app rather than coming back from the API, because
 * these are routes in this application: the service's job is to say what
 * is missing, and a service that also named `/settings/bill-production`
 * would be describing a screen it cannot see and could not keep correct.
 * The check's `key` is the contract between them.
 *
 * It is passed to `ReadinessPanel` by the tenant's own pages only. The
 * platform console shows the same checks without it — every one of these
 * screens refuses a platform actor, so offering an operator the link
 * would be an invitation to a 403.
 *
 * The `action` is the imperative, not the destination's name: an admin
 * reading "Water and sewer are not set up" wants to be told to add a
 * commodity, and "Commodities & UOM" is the menu entry they would then
 * have to translate it into.
 */
export interface TenantFix {
  href: string;
  action: string;
}

export const TENANT_FIXES: Record<string, TenantFix> = {
  administrable: {
    href: "/users-roles",
    action: "Give someone a role that can change settings",
  },
  commodity: { href: "/commodities", action: "Add a commodity" },
  // The same screen: units of measure are created against a commodity
  // and are managed beside them.
  unitOfMeasure: { href: "/commodities", action: "Add a unit of measure" },
  billingCycle: { href: "/billing-cycles", action: "Create a billing cycle" },
  rateSchedule: { href: "/rate-schedules", action: "Publish a rate schedule" },
  issuerIdentity: {
    href: "/settings/bill-production",
    action: "Complete the issuer details",
  },
  billStorage: {
    href: "/settings/bill-production",
    action: "Set the bill-document storage",
  },
};
