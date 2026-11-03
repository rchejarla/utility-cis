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
  /**
   * Billing **work**: the cross-account bill list, posting, delivery,
   * and billing runs. Separate from `accounts`, which is the customer
   * record a CSR maintains.
   *
   * Added 2026-11-03 because they were one key: `POST /billing-runs`,
   * `/:id/post` and `/:id/send` required `accounts:EDIT`, which is the
   * same verb that lets a CSR correct a mailing address. Billing a whole
   * cycle and sending the bills are not counter work, and nothing but
   * this key separates them.
   *
   * An account's *own* bills stay on `accounts` — that is the record in
   * front of the clerk, the same scope rule the audit log uses.
   */
  "billing",
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

/**
 * What each key is for, in one sentence, plus its label and icon.
 *
 * **`covers` is the declaration that was missing.** Until 2026-11-03 a
 * key's meaning lived only in whichever routes happened to name it, so
 * the only way to learn what `settings` authorized was to grep for it —
 * and four things had drifted apart by the time anybody looked:
 * `tenant_users` gated a screen while **no route enforced it at all**,
 * so a Utility Admin could not create a staff user; the custom-fields
 * page gated `tenant_profile` and its API `settings`, so saving 403'd;
 * the audit log was gated on two different keys by the two menus; and
 * billing a whole cycle needed only the verb that edits an address.
 *
 * `module-keys.test.ts` reads these sentences as a contract: every key
 * has to be enforced by real server code, or be listed there as
 * deliberately client-side with a reason.
 */
export const MODULE_META: Record<
  ModuleKey,
  { label: string; icon: string; covers: string }
> = {
  customers: { label: "Customers", icon: "faUsers", covers: "Customer records and their contacts." },
  premises: { label: "Premises", icon: "faLocationDot", covers: "Premise records. Not the premise *type* list, which is tenant configuration." },
  meters: { label: "Meters", icon: "faGauge", covers: "Meter records and the inventory." },
  meter_reads: { label: "Meter Reads", icon: "faBolt", covers: "Readings, their import and their exceptions." },
  meter_events: { label: "Meter Events", icon: "faTriangleExclamation", covers: "Tamper, leak and outage events raised against a meter." },
  accounts: { label: "Accounts", icon: "faUser", covers: "The account record, its balance and its own bills — what a clerk has in front of them." },
  /*
   * "Billing" and not "Bills": the grant covers running a cycle,
   * posting and sending, not only the documents. Someone reading the
   * permission matrix is deciding who may bill, and a label naming the
   * noun would undersell the verb.
   */
  billing: { label: "Billing", icon: "faFileInvoiceDollar", covers: "Billing work: running a cycle, posting, delivery, documents, and the cross-account bill list. Not the account record." },
  payments: { label: "Payments", icon: "faMoneyCheckDollar", covers: "Payments and deposits received, and refunds and deposit returns paid out." },
  ar_adjustments: { label: "AR Adjustments", icon: "faScaleBalanced", covers: "Raising and forgiving a charge on the ledger." },
  agreements: { label: "Agreements", icon: "faFileContract", covers: "Service agreements and their meter assignments." },
  commodities: { label: "Commodities & UOM", icon: "faDroplet", covers: "Commodities and units of measure, which every operational screen reads." },
  rate_schedules: { label: "Rate Schedules", icon: "faMoneyBill", covers: "Tariffs: rate schedules, their components, TOU calendars and season sets." },
  billing_cycles: { label: "Billing Cycles", icon: "faCalendarDays", covers: "Billing cycle definitions." },
  containers: { label: "Containers", icon: "faDumpster", covers: "Solid-waste containers and carts." },
  service_suspensions: { label: "Service Holds", icon: "faPauseCircle", covers: "Holds on an agreement. The only key with a fifth verb, APPROVE." },
  service_events: { label: "RAMS Events", icon: "faTruck", covers: "Field events from solid-waste collection crews (RAMS)." },
  workflows: { label: "Workflows", icon: "faArrowsRotate", covers: "Workflow definitions and their runs." },
  search: { label: "Search", icon: "faMagnifyingGlass", covers: "Global search across entities." },
  audit_log: { label: "Audit Log", icon: "faClipboardList", covers: "One record's history, on an entity's Audit tab. Reading the whole log needs `settings:VIEW` — see `routes/audit-log.ts`." },
  attachments: { label: "Attachments", icon: "faPaperclip", covers: "Files attached to any entity." },
  theme: { label: "Theme Editor", icon: "faPalette", covers: "The tenant's theme editor." },
  settings: { label: "Settings", icon: "faGear", covers: "**System** settings: integrations, API keys, retention, the danger zone, and the whole audit log. The one key Utility Admin holds VIEW-only, so anything a Utility Admin should be able to change does not belong here." },
  tenant_profile: { label: "Tenant Profile", icon: "faBuilding", covers: "The tenant's own configuration: profile, branding, numbering, automation, custom fields, bill messages, suspension types, and the premise/account/measure type lists." },
  tenant_users: { label: "Users & Roles", icon: "faUserShield", covers: "Staff users and roles." },
  notifications: { label: "Notifications", icon: "faEnvelope", covers: "Notification templates and the delivery log." },
  delinquency: { label: "Delinquency", icon: "faExclamationCircle", covers: "Delinquency rules, the queue they produce, and payment plans." },
  service_requests: { label: "Service Requests", icon: "faClipboardCheck", covers: "Service requests and their lifecycle." },
  service_request_slas: { label: "SLAs", icon: "faStopwatch", covers: "SLA definitions for service requests." },
  portal_accounts: { label: "Portal: Accounts", icon: "faUser", covers: "Portal: a customer's own accounts." },
  portal_billing: { label: "Portal: Billing", icon: "faMoneyBill", covers: "Portal: a customer's own bills." },
  portal_usage: { label: "Portal: Usage", icon: "faBolt", covers: "Portal: a customer's own usage." },
  portal_profile: { label: "Portal: Profile", icon: "faUser", covers: "Portal: a customer's own profile." },
  imports: { label: "Imports", icon: "faFileImport", covers: "Import batches and their rows." },
};
