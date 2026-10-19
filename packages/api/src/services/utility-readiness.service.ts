import { prisma } from "../lib/prisma.js";
import {
  billDocumentSettingsSchema,
  missingIssuerFields,
  type IssuerSettings,
} from "@utility-cis/shared";
import { assertUtilityExists } from "./provisioning.service.js";

/**
 * Reports what a utility still needs before it can operate.
 *
 * Provisioning creates a tenant, its modules and its roles, and nothing
 * else — no commodity, no unit of measure, no billing cycle, no tariff,
 * no issuer identity. The console showed the counts it had ("32 modules,
 * 6 roles"), which read like readiness, so a tenant that could not bill
 * anything looked finished. This answers the question those counts
 * appeared to answer.
 *
 * Every check restates a constraint the system already enforces
 * somewhere else, and none of them invents one. `missingIssuerFields` is
 * what `loadBillPresentation` refuses over; `billDocumentSettingsSchema`
 * and its integration name are what `bill-document.service` refuses
 * without; settings:EDIT is what the roles and settings routes require.
 * The value is in asking before a bill is attempted rather than after a
 * tenant complains — not in holding an opinion of its own.
 */

/** The authority a tenant needs over itself to stop needing this console. */
const SELF_ADMIN_MODULE = "settings";
const SELF_ADMIN_VERB = "EDIT";

export interface ReadinessCheck {
  key: string;
  /** What is being asked, in the operator's words. */
  label: string;
  ok: boolean;
  /** What was found: the names, the count, or what is absent. */
  detail: string;
  /** What cannot happen while this is unmet. */
  blocks: string;
}

export interface UtilityReadiness {
  ready: boolean;
  checks: ReadinessCheck[];
}

/** The `issuer` namespace, read defensively: `settings` is untyped Json. */
function issuerOf(settings: unknown): IssuerSettings {
  if (settings && typeof settings === "object" && "issuer" in settings) {
    const issuer = (settings as { issuer?: unknown }).issuer;
    if (issuer && typeof issuer === "object") return issuer as IssuerSettings;
  }
  return {};
}

/**
 * The same three outcomes `storageOf` distinguishes — configured,
 * unreadable, absent — without importing it, because that function's job
 * is to throw and this one's is to describe. The two agree on the field
 * that matters: a storage integration name.
 */
function storageState(settings: unknown): { ok: boolean; detail: string } {
  const raw =
    settings && typeof settings === "object" && "billDocuments" in settings
      ? (settings as { billDocuments?: unknown }).billDocuments
      : undefined;

  const parsed = billDocumentSettingsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      detail: `billDocuments cannot be read: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`,
    };
  }
  const integration = parsed.data.storageIntegration?.trim();
  if (!integration) return { ok: false, detail: "no storage integration set" };

  const connection = parsed.data.storageConnection?.trim();
  return {
    ok: true,
    detail: connection ? `${integration} / ${connection}` : integration,
  };
}

/** Up to three names, then a count, so a long list stays one line. */
function naming(names: string[]): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

export async function getUtilityReadiness(utilityId: string): Promise<UtilityReadiness> {
  await assertUtilityExists(utilityId);

  const [config, roles, commodities, unitCount, cycles, publishedTariffs] = await Promise.all([
    prisma.utilityConfig.findUnique({ where: { utilityId }, select: { settings: true } }),
    /*
     * Permissions are Json, and "settings includes EDIT" is a question
     * about an array inside it. Filtering in JS rather than with a
     * jsonb path keeps the rule readable and matches how
     * `authorizationMiddleware` evaluates it; a tenant has a handful of
     * roles, so there is nothing to gain from pushing it down.
     */
    prisma.role.findMany({ where: { utilityId }, select: { id: true, permissions: true } }),
    prisma.commodity.findMany({
      where: { utilityId, isActive: true },
      select: { name: true },
      orderBy: { displayOrder: "asc" },
    }),
    prisma.unitOfMeasure.count({ where: { utilityId, isActive: true } }),
    prisma.billingCycle.findMany({
      where: { utilityId, active: true },
      select: { cycleCode: true },
      orderBy: { cycleCode: "asc" },
    }),
    /*
     * Published only. A draft schedule is a tariff being written, not one
     * that can rate anything: `SAScheduleAssignment` is what bills read,
     * and an unpublished schedule is not meant to be assigned.
     */
    prisma.rateSchedule.count({ where: { utilityId, publishedAt: { not: null } } }),
  ]);

  const selfAdminRoleIds = roles
    .filter((role) => {
      const permissions = role.permissions as Record<string, unknown> | null;
      const verbs = permissions?.[SELF_ADMIN_MODULE];
      return Array.isArray(verbs) && verbs.includes(SELF_ADMIN_VERB);
    })
    .map((role) => role.id);

  /*
   * Staff, not portal users. A `customerId` makes the row a portal
   * login — those hold `portal_*` and could never satisfy this anyway,
   * but excluding them keeps the count honest if a preset ever changes.
   */
  const selfAdmins =
    selfAdminRoleIds.length === 0
      ? 0
      : await prisma.cisUser.count({
          where: {
            utilityId,
            isActive: true,
            customerId: null,
            userRoles: { some: { roleId: { in: selfAdminRoleIds } } },
          },
        });

  const issuerMissing = missingIssuerFields(issuerOf(config?.settings));
  const storage = storageState(config?.settings);

  const checks: ReadinessCheck[] = [
    {
      key: "administrable",
      label: "Someone inside the tenant can administer it",
      ok: selfAdmins > 0,
      detail:
        selfAdmins > 0
          ? `${selfAdmins} active staff ${selfAdmins === 1 ? "member holds" : "members hold"} a role with ${SELF_ADMIN_MODULE}:${SELF_ADMIN_VERB}`
          : selfAdminRoleIds.length === 0
            ? `no role grants ${SELF_ADMIN_MODULE}:${SELF_ADMIN_VERB}`
            : `no active staff member holds a role with ${SELF_ADMIN_MODULE}:${SELF_ADMIN_VERB}`,
      blocks:
        "Nobody in the tenant can change its settings, roles or users — every such change has to come through this console.",
    },
    {
      key: "commodity",
      label: "At least one commodity",
      ok: commodities.length > 0,
      detail:
        commodities.length > 0
          ? naming(commodities.map((commodity) => commodity.name))
          : "none defined",
      blocks:
        "Nothing can be metered, agreed or priced: a meter, a service agreement and a rate schedule each name a commodity.",
    },
    {
      key: "unitOfMeasure",
      label: "Units of measure for them",
      ok: unitCount > 0,
      detail: unitCount > 0 ? `${unitCount} defined` : "none defined",
      blocks: "A meter read has no units, so usage cannot be computed from it.",
    },
    {
      key: "billingCycle",
      label: "At least one billing cycle",
      ok: cycles.length > 0,
      detail:
        cycles.length > 0 ? naming(cycles.map((cycle) => cycle.cycleCode)) : "none defined",
      blocks: "No billing run can be started, since a run bills one cycle.",
    },
    {
      key: "rateSchedule",
      label: "A published rate schedule",
      ok: publishedTariffs > 0,
      detail:
        publishedTariffs > 0 ? `${publishedTariffs} published` : "none published",
      blocks: "Usage cannot be priced, so a billing run would produce a bill with no charges.",
    },
    {
      key: "issuerIdentity",
      label: "Issuer identity on its bills",
      ok: issuerMissing.length === 0,
      detail:
        issuerMissing.length === 0 ? "complete" : `missing: ${issuerMissing.join(", ")}`,
      blocks:
        "Bill production refuses outright (ISSUER_INCOMPLETE) — without a name and remittance address a bill is not a valid document.",
    },
    {
      key: "billStorage",
      label: "Somewhere to store bill documents",
      ok: storage.ok,
      detail: storage.detail,
      blocks: "A rendered bill has nowhere to be written, so no PDF can be issued or re-served.",
    },
  ];

  return { ready: checks.every((check) => check.ok), checks };
}
