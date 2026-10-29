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
      // The counter is where a payment plan is agreed — the customer
      // phones because they cannot pay, and the CSR is already on the
      // account. VIEW reaches the shut-off queue and the account's plan
      // panel, CREATE agrees one.
      //
      // Deliberately not EDIT: waiving a delinquency action, authorising
      // a disconnect and tearing up a live plan are a supervisor's, and
      // all three are gated on that verb. Someone who may offer an
      // arrangement is not thereby someone who may cancel one.
      delinquency: ["VIEW", "CREATE"],
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

/**
 * Whether a utility's role still matches the preset it was copied from.
 *
 * The presets are a template applied once at provisioning, not a
 * definition read afterwards — each utility owns its copies and editing
 * one diverges it permanently, which re-provisioning deliberately will
 * not revert. So a column driven by `isSystem` claims a role is the
 * standard CSR even when its permissions were edited into something
 * else; `isSystem` is set at creation and never changes.
 *
 * This is the derived answer, computed from the permissions actually
 * stored, so it cannot go stale:
 *
 *   - `custom`   — no preset ships under this name
 *   - `preset`   — matches what a new utility would get
 *   - `modified` — shipped under that name, and has since diverged
 *
 * Verb order is ignored, since nothing guarantees it survives a round
 * trip and a re-ordered list grants the same thing. A module whose list
 * is empty counts as absent, because an editor that unchecks every box
 * leaves `[]` rather than removing the key, and both grant nothing.
 */
export function presetDrift(
  name: string,
  permissions: Record<string, string[] | readonly string[]>,
): "custom" | "preset" | "modified" {
  const preset = PRESET_ROLES.find((r) => r.name === name);
  if (!preset) return "custom";

  const normalise = (map: Record<string, string[] | readonly string[]>) => {
    const out: Record<string, string> = {};
    for (const [module, verbs] of Object.entries(map ?? {})) {
      const list = [...(verbs ?? [])].sort();
      if (list.length > 0) out[module] = list.join(",");
    }
    return out;
  };

  const a = normalise(preset.permissions as Record<string, string[]>);
  const b = normalise(permissions);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return "modified";
  }
  return "preset";
}
