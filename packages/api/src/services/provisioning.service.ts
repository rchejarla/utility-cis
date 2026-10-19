import { MODULES, PRESET_ROLES } from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { invalidateUtilityStatusCache } from "./rbac.service.js";

/**
 * Bringing a tenant into existence.
 *
 * Build-order step 3 of
 * docs/superpowers/specs/2026-10-17-tenancy-and-platform-admin-design.md.
 * Before this there was no way: `utility.create` and
 * `utilityModule.create` appeared nowhere outside tests, so a second
 * utility meant a developer running SQL, and a freshly migrated database
 * answered 403 on every gated route for want of `utility_module` rows.
 *
 * Deliberately narrow, per D1: create the tenant, enable its modules,
 * give it the preset roles and a first admin. Suspending, purging,
 * impersonating and cross-tenant reporting are not here and are not
 * oversights — D6 defers each, and this is the one piece with value in
 * both tenancy modes.
 */

export type ProvisionProfile = "minimal";

const PROFILES: readonly ProvisionProfile[] = ["minimal"];

export interface ProvisionTenantInput {
  utilityId: string;
  name: string;
  firstAdmin?: { email: string; name: string };
  /**
   * Named set of reference configuration. Q4 — who chooses a profile and
   * where the list lives — is unanswered in the spec, so only "minimal"
   * exists and it adds nothing beyond the rest of this function. The
   * parameter is here so the signature survives Q4 being answered, and
   * an unknown value is refused rather than ignored: silently
   * provisioning the wrong configuration is worse than failing.
   */
  profile?: ProvisionProfile;
  /**
   * Do everything, report it, write nothing.
   *
   * Implemented by rolling the transaction back at the end rather than by
   * a second code path that predicts the outcome. A dry run that never
   * reaches the constraints cannot warn about the collision that will
   * stop the real one — which is most of what an operator wants it for.
   */
  dryRun?: boolean;
}

export interface ProvisionTenantResult {
  utilityId: string;
  /** False when the utility row already existed. */
  created: boolean;
  /** Rows created by this call, not rows present. */
  modulesEnabled: number;
  rolesCreated: number;
  adminCreated: boolean;
}

export interface UtilitySummary {
  id: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: Date;
  moduleCount: number;
  roleCount: number;
  userCount: number;
}

/**
 * A refusal, not a fault.
 *
 * `statusCode` is load-bearing: `middleware/error-handler.ts` reads
 * `statusCode` and `code` off the error and sends the message through,
 * and without a status code falls to its final branch — 500, logged as an
 * unexpected failure, message replaced with "An internal server error
 * occurred". The explanation is the whole point of refusing rather than
 * renaming, so losing it loses the feature.
 */
class ProvisioningError extends Error {
  constructor(
    readonly code:
      | "UTILITY_NAME_MISMATCH"
      | "UTILITY_NAME_TAKEN"
      | "UNKNOWN_PROFILE"
      | "UTILITY_NOT_FOUND",
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

/** Thrown to roll a dry run back; never escapes this module. */
class DryRunComplete extends Error {
  constructor(readonly result: ProvisionTenantResult) {
    super("dry run");
  }
}

export async function provisionTenant(
  input: ProvisionTenantInput,
): Promise<ProvisionTenantResult> {
  const profile = input.profile ?? "minimal";
  if (!PROFILES.includes(profile)) {
    throw new ProvisioningError("UNKNOWN_PROFILE", 400, `Unknown profile "${profile}"`);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.utility.findUnique({ where: { id: input.utilityId } });

      if (existing && existing.name !== input.name) {
        // Renaming is its own lifecycle operation. As a side effect of
        // re-provisioning, a typo in a script would rename a live tenant.
        throw new ProvisioningError(
          "UTILITY_NAME_MISMATCH",
          409,
          `Utility ${input.utilityId} is named "${existing.name}", not "${input.name}". ` +
            `Renaming is not part of provisioning.`,
        );
      }

      if (!existing) {
        // Existence is keyed on the id, and a caller that supplies no id
        // gets a fresh one — so without this, clicking Create twice makes
        // two tenants with one name, told apart only by a uuid. Refused
        // rather than adopted: handing back the tenant someone else
        // created would report success for work this call did not do, and
        // a caller who means to re-provision names the id.
        //
        // Case-insensitively, because two casings of one name are one
        // tenant to everybody reading the list.
        const nameHolder = await tx.utility.findFirst({
          where: { name: { equals: input.name, mode: "insensitive" } },
          select: { id: true, name: true },
        });
        if (nameHolder) {
          throw new ProvisioningError(
            "UTILITY_NAME_TAKEN",
            409,
            `Utility ${nameHolder.id} is already named "${nameHolder.name}". ` +
              `Provision a different name, or pass that id to re-provision it.`,
          );
        }

        await tx.utility.create({ data: { id: input.utilityId, name: input.name } });
      }

      // `skipDuplicates` so a re-run adds only what is missing. Rows for
      // keys no longer in MODULES are left alone: removing a module is
      // its own operation, and silently disabling one a tenant is using
      // is worse than leaving a stale row.
      const modules = await tx.utilityModule.createMany({
        data: MODULES.map((moduleKey) => ({
          utilityId: input.utilityId,
          moduleKey,
          isEnabled: true,
        })),
        skipDuplicates: true,
      });

      // Never update an existing role's permissions: a tenant may have
      // edited them, and re-provisioning must not quietly revert that.
      const present = new Set(
        (
          await tx.role.findMany({
            where: { utilityId: input.utilityId },
            select: { name: true },
          })
        ).map((r) => r.name),
      );

      let rolesCreated = 0;
      let systemAdminRoleId: string | null = null;
      for (const preset of PRESET_ROLES) {
        if (present.has(preset.name)) {
          if (preset.name === "System Admin") {
            const found = await tx.role.findFirstOrThrow({
              where: { utilityId: input.utilityId, name: preset.name },
              select: { id: true },
            });
            systemAdminRoleId = found.id;
          }
          continue;
        }
        const role = await tx.role.create({
          data: {
            utilityId: input.utilityId,
            name: preset.name,
            description: preset.description,
            isSystem: preset.isSystem,
            permissions: preset.permissions as object,
          },
          select: { id: true, name: true },
        });
        rolesCreated += 1;
        if (role.name === "System Admin") systemAdminRoleId = role.id;
      }

      let adminCreated = false;
      if (input.firstAdmin) {
        // Lowercased because `routes/auth.ts` looks a user up by
        // `email.toLowerCase()`: an admin stored as `Ops@City.gov` is an
        // admin who cannot log in, and it is the only account the new
        // tenant has. It also makes this existence check — and
        // `@@unique([utilityId, email])` behind it — agree about what the
        // same address is, instead of admitting one user per casing.
        const email = input.firstAdmin.email.trim().toLowerCase();
        const already = await tx.cisUser.findFirst({
          where: { utilityId: input.utilityId, email },
          select: { id: true },
        });
        if (!already) {
          const user = await tx.cisUser.create({
            data: {
              utilityId: input.utilityId,
              email,
              name: input.firstAdmin.name,
              isActive: true,
            },
            select: { id: true },
          });
          if (systemAdminRoleId) {
            await tx.userRole.create({
              data: {
                utilityId: input.utilityId,
                userId: user.id,
                roleId: systemAdminRoleId,
                accountId: null,
              },
            });
          }
          adminCreated = true;
        }
      }

      const result: ProvisionTenantResult = {
        utilityId: input.utilityId,
        created: !existing,
        modulesEnabled: modules.count,
        rolesCreated,
        adminCreated,
      };

      if (input.dryRun) throw new DryRunComplete(result);
      return result;
    }, {
      // Thirteen round trips, a 32-row createMany and six role creates:
      // comfortably inside Prisma's 5s default against a warm database,
      // and not always against a cold container or a loaded one, where
      // it gives up with P2028 having written nothing. The rollback is
      // right; the message is useless — nobody reads "Transaction
      // already closed" as "run it again". This is a one-shot lifecycle
      // operation with nothing waiting on it, so it can afford to wait.
      timeout: 20_000,
    });
  } catch (err) {
    if (err instanceof DryRunComplete) return err.result;
    throw err;
  }
}

/**
 * D6 responsibility 6. Deliberately unscoped by tenant — it is the one
 * read whose whole purpose is to cross tenants, which is why the platform
 * actor at build-order step 5 will be its caller. Writes nothing.
 */
/** One projection, so a list row and a suspend's answer cannot diverge. */
const SUMMARY_SELECT = {
  id: true,
  name: true,
  status: true,
  createdAt: true,
  _count: { select: { utilityModules: true, roles: true, cisUsers: true } },
} as const;

type SummaryRow = {
  id: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: Date;
  _count: { utilityModules: number; roles: number; cisUsers: number };
};

function toSummary(r: SummaryRow): UtilitySummary {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    createdAt: r.createdAt,
    moduleCount: r._count.utilityModules,
    roleCount: r._count.roles,
    userCount: r._count.cisUsers,
  };
}

export async function listUtilities(): Promise<UtilitySummary[]> {
  const rows = await prisma.utility.findMany({
    orderBy: { name: "asc" },
    select: SUMMARY_SELECT,
  });

  return rows.map(toSummary);
}

export interface UtilityDetail extends UtilitySummary {
  modules: { moduleKey: string; isEnabled: boolean }[];
  roles: { id: string; name: string; description: string | null; isSystem: boolean; moduleCount: number }[];
  staff: { id: string; email: string; name: string; isActive: boolean; roleName: string | null }[];
  /** Counted rather than listed — see below. */
  portalUserCount: number;
}

/**
 * What one tenant holds. The other half of D6 responsibility 6: a list
 * of counts you cannot open is a dead end, because "6 roles" raises the
 * question it will not answer.
 *
 * **Staff, not users.** Portal customers are `cis_user` rows too, so
 * returning "the tenant's users" would have a real utility answering
 * with tens of thousands of them. What this screen is asked is whether
 * the tenant can be administered, so it lists the users with no
 * `customer_id` and counts the portal accounts instead. That keeps the
 * payload bounded by staff headcount rather than by customer base.
 *
 * A role's module count is included because the number of roles says
 * nothing about what they can do, and a staff member with no role is
 * listed with `roleName: null` rather than omitted — a user who cannot
 * do anything is precisely what an operator is hunting for when a tenant
 * reports that it cannot work.
 */
export async function getUtilityDetail(utilityId: string): Promise<UtilityDetail> {
  const utility = await prisma.utility.findUnique({
    where: { id: utilityId },
    select: SUMMARY_SELECT,
  });
  if (!utility) {
    throw new ProvisioningError("UTILITY_NOT_FOUND", 404, `No utility with id ${utilityId}.`);
  }

  const [modules, roles, staff, portalUserCount] = await Promise.all([
    prisma.utilityModule.findMany({
      where: { utilityId },
      select: { moduleKey: true, isEnabled: true },
      orderBy: { moduleKey: "asc" },
    }),
    prisma.role.findMany({
      where: { utilityId },
      select: { id: true, name: true, description: true, isSystem: true, permissions: true },
      orderBy: { name: "asc" },
    }),
    prisma.cisUser.findMany({
      where: { utilityId, customerId: null },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        userRoles: {
          where: { accountId: null },
          select: { role: { select: { name: true } } },
          take: 1,
        },
      },
      orderBy: { email: "asc" },
    }),
    prisma.cisUser.count({ where: { utilityId, customerId: { not: null } } }),
  ]);

  return {
    ...toSummary(utility),
    modules,
    roles: roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      moduleCount: Object.keys((r.permissions ?? {}) as Record<string, unknown>).length,
    })),
    staff: staff.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      isActive: u.isActive,
      roleName: u.userRoles[0]?.role.name ?? null,
    })),
    portalUserCount,
  };
}

/**
 * Suspend a tenant, or reactivate it. D6 responsibility 5.
 *
 * Nothing is deleted and nothing cascades: suspension is reversible, and
 * purge is a separate capability D6 defers precisely so the two cannot
 * be reached by one act. What suspension does is stop the tenant's
 * users — enforced per request in `middleware/authorization.ts`, which
 * is why each of these invalidates the cached status rather than waiting
 * out its TTL.
 *
 * Idempotent in both directions, like provisioning: an operator clicking
 * twice, or a script re-running, is not an error. But a utility that
 * does not exist is refused rather than treated as a no-op — an operator
 * who mistypes an id has suspended nothing and needs telling.
 */
async function setUtilityStatus(
  utilityId: string,
  status: "ACTIVE" | "SUSPENDED",
): Promise<UtilitySummary> {
  const existing = await prisma.utility.findUnique({
    where: { id: utilityId },
    select: { id: true },
  });
  if (!existing) {
    throw new ProvisioningError(
      "UTILITY_NOT_FOUND",
      404,
      `No utility with id ${utilityId}.`,
    );
  }

  const row = await prisma.utility.update({
    where: { id: utilityId },
    data: { status },
    select: SUMMARY_SELECT,
  });

  await invalidateUtilityStatusCache(utilityId);
  return toSummary(row);
}

export async function suspendUtility(utilityId: string): Promise<UtilitySummary> {
  return setUtilityStatus(utilityId, "SUSPENDED");
}

export async function reactivateUtility(utilityId: string): Promise<UtilitySummary> {
  return setUtilityStatus(utilityId, "ACTIVE");
}
