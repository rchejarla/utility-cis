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
  "notifications",
  "portal_accounts",
  "portal_billing",
  "portal_usage",
  "portal_profile",
] as const;

export type ModuleKey = (typeof MODULES)[number];

// APPROVE is a specialized permission currently used only by the
// service_suspensions module (for the optional "requires approval" flow
// controlled by TenantConfig.requireHoldApproval). Adding it to the
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
  notifications: { label: "Notifications", icon: "faEnvelope" },
  portal_accounts: { label: "Portal: Accounts", icon: "faUser" },
  portal_billing: { label: "Portal: Billing", icon: "faMoneyBill" },
  portal_usage: { label: "Portal: Usage", icon: "faBolt" },
  portal_profile: { label: "Portal: Profile", icon: "faUser" },
};

// Preset role definitions
export const PRESET_ROLES: Array<{ name: string; description: string; permissions: PermissionMap }> = [
  {
    name: "System Admin",
    description: "Full access to everything including system settings",
    permissions: {
      ...Object.fromEntries(MODULES.map((m) => [m, ["VIEW", "CREATE", "EDIT", "DELETE"]])),
      service_suspensions: ["VIEW", "CREATE", "EDIT", "DELETE", "APPROVE"],
    } as PermissionMap,
  },
  {
    name: "Utility Admin",
    description: "Full access except system settings modification",
    permissions: {
      ...Object.fromEntries(MODULES.map((m) => [m, ["VIEW", "CREATE", "EDIT", "DELETE"]])),
      service_suspensions: ["VIEW", "CREATE", "EDIT", "DELETE", "APPROVE"],
      settings: ["VIEW"],
    } as PermissionMap,
  },
  {
    name: "CSR",
    description: "Customer service — create and edit operational records",
    permissions: {
      customers: ["VIEW", "CREATE", "EDIT"],
      premises: ["VIEW", "CREATE", "EDIT"],
      meters: ["VIEW"],
      meter_reads: ["VIEW", "CREATE"],
      accounts: ["VIEW", "CREATE", "EDIT"],
      agreements: ["VIEW", "CREATE", "EDIT"],
      commodities: ["VIEW"],
      rate_schedules: ["VIEW"],
      billing_cycles: ["VIEW"],
      containers: ["VIEW", "CREATE", "EDIT"],
      service_suspensions: ["VIEW", "CREATE", "EDIT"],
      workflows: ["VIEW", "CREATE"],
      search: ["VIEW"],
      audit_log: ["VIEW"],
      attachments: ["VIEW", "CREATE", "EDIT"],
    },
  },
  {
    name: "Field Technician",
    description: "Meter and premise field operations",
    permissions: {
      customers: ["VIEW"],
      premises: ["VIEW", "EDIT"],
      meters: ["VIEW", "EDIT"],
      meter_reads: ["VIEW", "CREATE", "EDIT"],
      meter_events: ["VIEW", "CREATE", "EDIT"],
      accounts: ["VIEW"],
      agreements: ["VIEW"],
      commodities: ["VIEW"],
      containers: ["VIEW", "EDIT"],
      search: ["VIEW"],
      audit_log: ["VIEW"],
      attachments: ["VIEW", "CREATE", "EDIT"],
    },
  },
  {
    name: "Read-Only",
    description: "View access to all operational data",
    permissions: {
      customers: ["VIEW"],
      premises: ["VIEW"],
      meters: ["VIEW"],
      meter_reads: ["VIEW"],
      meter_events: ["VIEW"],
      accounts: ["VIEW"],
      agreements: ["VIEW"],
      commodities: ["VIEW"],
      rate_schedules: ["VIEW"],
      billing_cycles: ["VIEW"],
      containers: ["VIEW"],
      service_suspensions: ["VIEW"],
      service_events: ["VIEW"],
      search: ["VIEW"],
      audit_log: ["VIEW"],
      attachments: ["VIEW"],
    },
  },
  {
    name: "Portal Customer",
    description: "Self-service portal — view own accounts, bills, usage; edit profile",
    permissions: {
      portal_accounts: ["VIEW"],
      portal_billing: ["VIEW"],
      portal_usage: ["VIEW"],
      portal_profile: ["VIEW", "EDIT"],
    },
  },
];
