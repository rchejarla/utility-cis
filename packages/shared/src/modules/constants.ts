/**
 * Entity types that can have file attachments associated with them.
 *
 * SINGLE SOURCE OF TRUTH — both the API validator and every web
 * <AttachmentsTab entityType="..."> call MUST use these constants.
 * The casing must match the Prisma model name (PascalCase singular).
 *
 * Regression history: on 2026-04-09 the API route was temporarily
 * hardcoded to a lowercase enum while the web sent PascalCase, silently
 * 400-ing every attachments query. Keeping this in `shared/` makes it
 * impossible for web and API to disagree because TypeScript checks both.
 */
export const ATTACHMENT_ENTITY_TYPES = [
  "Customer",
  "Account",
  "Premise",
  "Meter",
  "ServiceAgreement",
  "RateSchedule",
  "BillingCycle",
] as const;

export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

export const MODULES = [
  "customers",
  "premises",
  "meters",
  "meter_reads",
  "meter_events",
  "accounts",
  "payments",
  "ar_adjustments",
  "agreements",
  "commodities",
  "rate_schedules",
  "billing_cycles",
  "containers",
  "service_suspensions",
  "service_events",
  "workflows",
  "search",
  "audit_log",
  "attachments",
  "theme",
  "settings",
  "tenant_profile",
  "tenant_users",
  "notifications",
  "delinquency",
  "service_requests",
  "service_request_slas",
  "portal_accounts",
  "portal_billing",
  "portal_usage",
  "portal_profile",
  "imports",
] as const;

export type ModuleKey = (typeof MODULES)[number];

// APPROVE is a specialized permission currently used only by the
// service_suspensions module (for the optional "requires approval" flow
// controlled by UtilityConfig.requireHoldApproval). Adding it to the
// global tuple keeps the RBAC check uniform; roles that don't need it
// simply omit it from their module permission list.
export const PERMISSIONS = ["VIEW", "CREATE", "EDIT", "DELETE", "APPROVE"] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type PermissionMap = Partial<Record<ModuleKey, Permission[]>>;

// Module metadata for UI (sidebar labels, icons)
export const MODULE_META: Record<ModuleKey, { label: string; icon: string }> = {
  customers: { label: "Customers", icon: "faUsers" },
  premises: { label: "Premises", icon: "faLocationDot" },
  meters: { label: "Meters", icon: "faGauge" },
  meter_reads: { label: "Meter Reads", icon: "faBolt" },
  meter_events: { label: "Meter Events", icon: "faTriangleExclamation" },
  accounts: { label: "Accounts", icon: "faUser" },
  payments: { label: "Payments", icon: "faMoneyCheckDollar" },
  ar_adjustments: { label: "AR Adjustments", icon: "faScaleBalanced" },
  agreements: { label: "Agreements", icon: "faFileContract" },
  commodities: { label: "Commodities & UOM", icon: "faDroplet" },
  rate_schedules: { label: "Rate Schedules", icon: "faMoneyBill" },
  billing_cycles: { label: "Billing Cycles", icon: "faCalendarDays" },
  containers: { label: "Containers", icon: "faDumpster" },
  service_suspensions: { label: "Service Holds", icon: "faPauseCircle" },
  service_events: { label: "RAMS Events", icon: "faTruck" },
  workflows: { label: "Workflows", icon: "faArrowsRotate" },
  search: { label: "Search", icon: "faMagnifyingGlass" },
  audit_log: { label: "Audit Log", icon: "faClipboardList" },
  attachments: { label: "Attachments", icon: "faPaperclip" },
  theme: { label: "Theme Editor", icon: "faPalette" },
  settings: { label: "Settings", icon: "faGear" },
  tenant_profile: { label: "Tenant Profile", icon: "faBuilding" },
  tenant_users: { label: "Users & Roles", icon: "faUserShield" },
  notifications: { label: "Notifications", icon: "faEnvelope" },
  delinquency: { label: "Delinquency", icon: "faExclamationCircle" },
  service_requests: { label: "Service Requests", icon: "faClipboardCheck" },
  service_request_slas: { label: "SLAs", icon: "faStopwatch" },
  portal_accounts: { label: "Portal: Accounts", icon: "faUser" },
  portal_billing: { label: "Portal: Billing", icon: "faMoneyBill" },
  portal_usage: { label: "Portal: Usage", icon: "faBolt" },
  portal_profile: { label: "Portal: Profile", icon: "faUser" },
  imports: { label: "Imports", icon: "faFileImport" },
};
