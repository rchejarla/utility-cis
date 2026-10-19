import { prisma } from "../lib/prisma.js";
import { invalidatePlatformActorCache } from "./rbac.service.js";

/**
 * The platform's own operators — the people who run tenant lifecycle.
 *
 * Its own service rather than part of provisioning, because it is a
 * different subject: provisioning brings tenants into existence, this
 * manages who may do that. Before it, a platform actor could only be
 * created by SQL or the seed, which is the same gap §1.5 described for
 * tenants — the one identity above tenants had no way to make another.
 *
 * An operator is a `cis_user` with a null `utility_id` (Q2) and **no
 * role**: being the platform actor is the authority, and there is no
 * tenant for it to hold a role in.
 */

export interface PlatformUserSummary {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

class PlatformUserError extends Error {
  constructor(
    readonly code:
      | "PLATFORM_EMAIL_TAKEN"
      | "PLATFORM_USER_NOT_FOUND"
      | "LAST_PLATFORM_OPERATOR",
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "PlatformUserError";
  }
}

const SUMMARY_SELECT = {
  id: true,
  email: true,
  name: true,
  isActive: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

/**
 * Every operator, active or not.
 *
 * `utility_id IS NULL` is the whole filter, and it is what keeps a
 * tenant's users — including its tens of thousands of portal customers —
 * out of this list.
 */
export async function listPlatformUsers(): Promise<PlatformUserSummary[]> {
  return prisma.cisUser.findMany({
    where: { utilityId: null },
    select: SUMMARY_SELECT,
    orderBy: { createdAt: "asc" },
  });
}

export async function createPlatformUser(input: {
  email: string;
  name: string;
}): Promise<PlatformUserSummary> {
  // Lowercased because every lookup normalises — dev-login and
  // `getPlatformActor` included — so an address stored with a capital is
  // an operator who cannot sign in.
  const email = input.email.trim().toLowerCase();

  const existing = await prisma.cisUser.findFirst({
    where: { utilityId: null, email },
    select: { id: true },
  });
  if (existing) {
    throw new PlatformUserError(
      "PLATFORM_EMAIL_TAKEN",
      409,
      `A platform operator already holds ${email}.`,
    );
  }

  try {
    return await prisma.cisUser.create({
      data: { utilityId: null, email, name: input.name.trim(), isActive: true },
      select: SUMMARY_SELECT,
    });
  } catch (err) {
    // The check above is the readable refusal; the partial unique index
    // on `email WHERE utility_id IS NULL` is the actual guarantee, and
    // this is the race between them.
    if ((err as { code?: string }).code === "P2002") {
      throw new PlatformUserError(
        "PLATFORM_EMAIL_TAKEN",
        409,
        `A platform operator already holds ${email}.`,
      );
    }
    throw err;
  }
}

/**
 * Activate or deactivate an operator — which is how one is revoked.
 *
 * Two things this refuses, and both matter:
 *
 *   - **A row with a tenant.** The id is all a caller supplies, so the
 *     lookup insists on `utility_id IS NULL`. Without that, this is a
 *     route to deactivating any user in any tenant.
 *   - **The last active operator.** A deployment with none cannot
 *     appoint another, and the only recovery is SQL.
 *
 * The cached lookup is dropped on the way out, or a revoked operator
 * keeps working for up to the 300s TTL.
 */
export async function setPlatformUserActive(
  userId: string,
  isActive: boolean,
): Promise<PlatformUserSummary> {
  const existing = await prisma.cisUser.findFirst({
    where: { id: userId, utilityId: null },
    select: { id: true, isActive: true },
  });
  if (!existing) {
    throw new PlatformUserError(
      "PLATFORM_USER_NOT_FOUND",
      404,
      `No platform operator with id ${userId}.`,
    );
  }

  if (!isActive) {
    const activeCount = await prisma.cisUser.count({
      where: { utilityId: null, isActive: true },
    });
    const wouldLeaveNone = activeCount <= 1 && existing.isActive;
    if (wouldLeaveNone) {
      throw new PlatformUserError(
        "LAST_PLATFORM_OPERATOR",
        409,
        "This is the last active platform operator. Appoint another before deactivating it.",
      );
    }
  }

  const updated = await prisma.cisUser.update({
    where: { id: userId },
    data: { isActive },
    select: SUMMARY_SELECT,
  });

  await invalidatePlatformActorCache(userId);
  return updated;
}
