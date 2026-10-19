import { MODULES, type PermissionMap, type Permission } from "./constants";

/**
 * The roles every new tenant gets.
 *
 * Transcribed from `seed.js`, which was their only definition between
 * 2026-10-18 and this file. A copy lived here before that, had no
 * consumer, and had drifted four modules apart from the seed's — its
 * Read-Only omitted workflows, notifications, delinquency and imports —
 * so it was deleted rather than reconciled. `provisionTenant` is the
 * consumer that was missing, and the seed now delegates to it, so there
 * is one definition again with nothing to drift against.
 *
 * `role-presets.test.ts` asserts these still agree with `MODULES`, which
 * is the check whose absence let the first copy rot.
 */

const ALL: Permission[] = ["VIEW", "CREATE", "EDIT", "DELETE"];

/** Only `service_suspensions` defines a fifth verb. */
const ALL_WITH_APPROVE: Permission[] = [...ALL, "APPROVE"];

function everyModule(): PermissionMap {
  return Object.fromEntries(MODULES.map((m) => [m, ALL])) as PermissionMap;
}

export interface PresetRole {
  name: string;
  description: string;
  isSystem: true;
  permissions: PermissionMap;
}

export const PRESET_ROLES: readonly PresetRole[] = [
  {
    name: "System Admin",
    description: "Full access to everything including system settings",
    isSystem: true,
    permissions: {
      ...everyModule(),
      service_suspensions: ALL_WITH_APPROVE,
    },
  },
  {
    name: "Utility Admin",
    description: "Full access except system settings modification",
    isSystem: true,
    permissions: {
      ...everyModule(),
      service_suspensions: ALL_WITH_APPROVE,
      // The only thing separating this from System Admin: who may change
      // this tenant's own settings (§1.2 of the tenancy design note).
      settings: ["VIEW"],
    },
  },
  {
    name: "CSR",
    description: "Customer service operations",
    isSystem: true,
    permissions: {
      customers: ["VIEW", "CREATE", "EDIT"],
      premises: ["VIEW", "CREATE", "EDIT"],
      meters: ["VIEW"],
      meter_reads: ["VIEW", "CREATE"],
      accounts: ["VIEW", "CREATE", "EDIT"],
      // A CSR is who takes a payment at the counter and reverses an NSF.
      payments: ["VIEW", "CREATE", "EDIT"],
      // Raising a charge and forgiving one are different authority
      // (design §8); a CSR does both at the counter.
      ar_adjustments: ["VIEW", "CREATE", "EDIT"],
      agreements: ["VIEW", "CREATE", "EDIT"],
      commodities: ["VIEW"],
      rate_schedules: ["VIEW"],
      billing_cycles: ["VIEW"],
      containers: ["VIEW", "CREATE", "EDIT"],
      service_suspensions: ["VIEW", "CREATE", "EDIT"],
      service_requests: ["VIEW", "CREATE", "EDIT"],
      workflows: ["VIEW", "CREATE"],
      search: ["VIEW"],
      // Reading the history of the record in front of you is counter
      // work; the whole log is not (see spec 17).
      audit_log: ["VIEW"],
      attachments: ["VIEW", "CREATE", "EDIT"],
    },
  },
  {
    name: "Field Technician",
    description: "Meter and premise field operations",
    isSystem: true,
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
      service_requests: ["VIEW", "EDIT"],
      workflows: ["VIEW"],
      search: ["VIEW"],
      audit_log: ["VIEW"],
      attachments: ["VIEW", "CREATE", "EDIT"],
    },
  },
  {
    name: "Read-Only",
    description: "View access to all operational data",
    isSystem: true,
    permissions: Object.fromEntries(
      MODULES.filter(
        (m) => m !== "settings" && m !== "theme" && !m.startsWith("portal_"),
      ).map((m) => [m, ["VIEW"]]),
    ) as PermissionMap,
  },
  {
    name: "Portal Customer",
    description: "Self-service portal — view own accounts, bills, usage; edit profile",
    isSystem: true,
    permissions: {
      portal_accounts: ["VIEW"],
      portal_billing: ["VIEW"],
      portal_usage: ["VIEW"],
      portal_profile: ["VIEW", "EDIT"],
    },
  },
];
