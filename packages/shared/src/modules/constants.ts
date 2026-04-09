export const MODULES = [
  "customers",
  "premises",
  "meters",
  "accounts",
  "agreements",
  "commodities",
  "rate_schedules",
  "billing_cycles",
  "audit_log",
  "attachments",
  "theme",
  "settings",
] as const;

export type ModuleKey = (typeof MODULES)[number];

export const PERMISSIONS = ["VIEW", "CREATE", "EDIT", "DELETE"] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type PermissionMap = Partial<Record<ModuleKey, Permission[]>>;

// Module metadata for UI (sidebar labels, icons)
export const MODULE_META: Record<ModuleKey, { label: string; icon: string }> = {
  customers: { label: "Customers", icon: "faUsers" },
  premises: { label: "Premises", icon: "faLocationDot" },
  meters: { label: "Meters", icon: "faGauge" },
  accounts: { label: "Accounts", icon: "faUser" },
  agreements: { label: "Agreements", icon: "faFileContract" },
  commodities: { label: "Commodities & UOM", icon: "faDroplet" },
  rate_schedules: { label: "Rate Schedules", icon: "faMoneyBill" },
  billing_cycles: { label: "Billing Cycles", icon: "faCalendarDays" },
  audit_log: { label: "Audit Log", icon: "faClipboardList" },
  attachments: { label: "Attachments", icon: "faPaperclip" },
  theme: { label: "Theme Editor", icon: "faPalette" },
  settings: { label: "Settings", icon: "faGear" },
};

// Preset role definitions
export const PRESET_ROLES: Array<{ name: string; description: string; permissions: PermissionMap }> = [
  {
    name: "System Admin",
    description: "Full access to everything including system settings",
    permissions: Object.fromEntries(MODULES.map((m) => [m, ["VIEW", "CREATE", "EDIT", "DELETE"]])) as PermissionMap,
  },
  {
    name: "Utility Admin",
    description: "Full access except system settings modification",
    permissions: {
      ...Object.fromEntries(MODULES.map((m) => [m, ["VIEW", "CREATE", "EDIT", "DELETE"]])),
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
      accounts: ["VIEW", "CREATE", "EDIT"],
      agreements: ["VIEW", "CREATE", "EDIT"],
      commodities: ["VIEW"],
      rate_schedules: ["VIEW"],
      billing_cycles: ["VIEW"],
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
      accounts: ["VIEW"],
      agreements: ["VIEW"],
      commodities: ["VIEW"],
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
      accounts: ["VIEW"],
      agreements: ["VIEW"],
      commodities: ["VIEW"],
      rate_schedules: ["VIEW"],
      billing_cycles: ["VIEW"],
      audit_log: ["VIEW"],
      attachments: ["VIEW"],
    },
  },
];
