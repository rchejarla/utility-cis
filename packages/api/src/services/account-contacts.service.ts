import { prisma } from "../lib/prisma.js";
import { writeAuditRow } from "../lib/audit-wrap.js";
import { invalidateUserRoleCache } from "./rbac.service.js";

/**
 * Unified-list service backing the Contacts tab on an account-detail
 * page. The list is a UNION of:
 *
 *   1. Contact rows for the account — record-only people on file
 *      (next of kin, neighbor with a key, site manager) who have NO
 *      portal access.
 *   2. UserRole rows for the account joined to CisUser + Role —
 *      anyone with portal capabilities on this specific account.
 *
 * The inline role-change UI in the Contacts tab drives state
 * transitions between the two sides:
 *
 *   - Promote contact → role: create/link a CisUser and a UserRole
 *     for this account, then delete the source Contact row.
 *   - Change role on an existing user: update UserRole.roleId.
 *   - Remove role from a user: delete the UserRole row. The CisUser
 *     stays (they may have access to other accounts); they're simply
 *     no longer on this account's list.
 *
 * Slice 2 is "promote = create-and-activate immediately" — the user
 * can dev-log-in by email right after promotion. Slice 3 will replace
 * this with a real email-invite + password-setup flow.
 */

export interface AccountContactRow {
  /** Composite id: "contact:<id>" or "user:<userRoleId>" — gives the
   *  UI a stable key it can hand back to the right endpoint. */
  rowId: string;
  /** Discriminator. UI shows different actions per type. */
  type: "contact" | "user";
  /** Contact.id when type="contact"; null otherwise. */
  contactId: string | null;
  /** UserRole.id when type="user"; null otherwise. */
  userRoleId: string | null;
  /** CisUser.id when type="user"; null otherwise. */
  userId: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  /** Role assignment when type="user". */
  roleId: string | null;
  roleName: string | null;
  /** "pending" if the user was promoted but hasn't logged in yet
   *  (lastLoginAt is null). "active" otherwise. Null for record-only
   *  contacts. */
  inviteStatus: "pending" | "active" | null;
  createdAt: Date;
}

export async function listAccountContacts(
  utilityId: string,
  accountId: string,
): Promise<AccountContactRow[]> {
  // Verify the account exists in the tenant before reading either side.
  await prisma.account.findFirstOrThrow({
    where: { id: accountId, utilityId },
    select: { id: true },
  });

  const [contacts, userRoles] = await Promise.all([
    prisma.contact.findMany({
      where: { utilityId, accountId },
    }),
    prisma.userRole.findMany({
      where: { utilityId, accountId },
      include: {
        user: { select: { id: true, email: true, name: true, lastLoginAt: true } },
        role: { select: { id: true, name: true } },
      },
    }),
  ]);

  // The CisUser model only stores `name` (not first/last). Split on
  // first space for display purposes.
  const splitName = (full: string): { first: string; last: string } => {
    const trimmed = full.trim();
    const idx = trimmed.indexOf(" ");
    if (idx === -1) return { first: trimmed, last: "" };
    return { first: trimmed.slice(0, idx), last: trimmed.slice(idx + 1) };
  };

  const contactRows: AccountContactRow[] = contacts.map((c) => ({
    rowId: `contact:${c.id}`,
    type: "contact",
    contactId: c.id,
    userRoleId: null,
    userId: null,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    notes: c.notes,
    roleId: null,
    roleName: null,
    inviteStatus: null,
    createdAt: c.createdAt,
  }));

  const userRows: AccountContactRow[] = userRoles.map((ur) => {
    const { first, last } = splitName(ur.user.name);
    return {
      rowId: `user:${ur.id}`,
      type: "user",
      contactId: null,
      userRoleId: ur.id,
      userId: ur.user.id,
      firstName: first,
      lastName: last,
      email: ur.user.email,
      phone: null,
      notes: null,
      roleId: ur.roleId,
      roleName: ur.role.name,
      inviteStatus: ur.user.lastLoginAt ? "active" : "pending",
      createdAt: ur.createdAt,
    };
  });

  return [...contactRows, ...userRows].sort((a, b) =>
    `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`),
  );
}

/**
 * Promote a record-only Contact to a portal user with `roleId` on
 * this account. Email-match: if a CisUser with the contact's email
 * already exists in the tenant, reuse that user; otherwise create a
 * new CisUser. Either way, create a UserRole(user, accountId, role)
 * and delete the source Contact.
 */
export async function promoteContact(
  utilityId: string,
  contactId: string,
  roleId: string,
  actor: { id: string; name: string },
): Promise<{
  userRoleId: string;
  userId: string;
  alreadyExisted: boolean;
}> {
  const contact = await prisma.contact.findFirstOrThrow({
    where: { id: contactId, utilityId },
  });
  if (!contact.email) {
    throw Object.assign(
      new Error(
        "Cannot promote a contact without an email — portal access requires a login identity.",
      ),
      { statusCode: 400, code: "EMAIL_REQUIRED" },
    );
  }

  // Verify the role belongs to the same tenant.
  const role = await prisma.role.findFirst({
    where: { id: roleId, utilityId },
    select: { id: true },
  });
  if (!role) {
    throw Object.assign(new Error("Role not found in this tenant"), {
      statusCode: 404,
      code: "ROLE_NOT_FOUND",
    });
  }

  return prisma.$transaction(async (tx) => {
    // Email match: link to an existing user if one is already on file.
    let user = await tx.cisUser.findFirst({
      where: { utilityId, email: contact.email!.toLowerCase() },
    });
    let alreadyExisted = !!user;
    if (!user) {
      user = await tx.cisUser.create({
        data: {
          utilityId,
          email: contact.email!.toLowerCase(),
          name: `${contact.firstName} ${contact.lastName}`.trim(),
          // customerId is left null here; if the contact was associated
          // with a specific customer, the operator can link it later.
          // The existing portal-auth registration flow sets customerId
          // when the customer themselves signs up, but operator-driven
          // promotion of a non-customer contact (e.g. a property
          // manager) should not auto-link.
          customerId: contact.customerId,
          isActive: true,
        },
      });
    }

    // One UserRole per (user, account). If there's an existing row
    // (operator demoted then re-promoted), update it; otherwise create.
    const existingAssignment = await tx.userRole.findFirst({
      where: { userId: user.id, accountId: contact.accountId },
      select: { id: true },
    });
    const userRole = existingAssignment
      ? await tx.userRole.update({
          where: { id: existingAssignment.id },
          data: { roleId },
        })
      : await tx.userRole.create({
          data: {
            utilityId,
            userId: user.id,
            accountId: contact.accountId,
            roleId,
          },
        });

    // Source Contact row is consumed by the promotion.
    await tx.contact.delete({ where: { id: contactId } });

    await writeAuditRow(
      tx,
      { utilityId, actorId: actor.id, actorName: actor.name, entityType: "UserRole" },
      "user_role.promoted_from_contact",
      userRole.id,
      null,
      { userId: user.id, accountId: contact.accountId, roleId, alreadyExisted },
    );

    return { userRoleId: userRole.id, userId: user.id, alreadyExisted };
  });
}

/**
 * Change the role on an existing UserRole assignment. Only updates
 * the per-account row — tenant-wide assignments aren't touched.
 */
export async function changeUserRoleOnAccount(
  utilityId: string,
  userRoleId: string,
  newRoleId: string,
  actor: { id: string; name: string },
): Promise<void> {
  const existing = await prisma.userRole.findFirstOrThrow({
    where: { id: userRoleId, utilityId },
  });
  if (existing.accountId === null) {
    throw Object.assign(
      new Error("Cannot change the role on a tenant-wide assignment via this endpoint"),
      { statusCode: 400, code: "TENANT_WIDE_ASSIGNMENT" },
    );
  }
  const role = await prisma.role.findFirst({
    where: { id: newRoleId, utilityId },
    select: { id: true },
  });
  if (!role) {
    throw Object.assign(new Error("Role not found in this tenant"), {
      statusCode: 404,
      code: "ROLE_NOT_FOUND",
    });
  }
  await prisma.$transaction(async (tx) => {
    await tx.userRole.update({
      where: { id: userRoleId },
      data: { roleId: newRoleId },
    });
    await writeAuditRow(
      tx,
      { utilityId, actorId: actor.id, actorName: actor.name, entityType: "UserRole" },
      "user_role.role_changed",
      userRoleId,
      { roleId: existing.roleId },
      { roleId: newRoleId },
    );
  });
  await invalidateUserRoleCache(existing.userId, utilityId);
}

/**
 * Revoke a user's role on an account. The CisUser stays (they may
 * still have access to other accounts); only their per-account
 * assignment for this account is removed.
 */
export async function revokeUserRoleOnAccount(
  utilityId: string,
  userRoleId: string,
  actor: { id: string; name: string },
): Promise<void> {
  const existing = await prisma.userRole.findFirstOrThrow({
    where: { id: userRoleId, utilityId },
  });
  if (existing.accountId === null) {
    throw Object.assign(
      new Error("Cannot revoke a tenant-wide assignment via this endpoint"),
      { statusCode: 400, code: "TENANT_WIDE_ASSIGNMENT" },
    );
  }
  await prisma.$transaction(async (tx) => {
    await tx.userRole.delete({ where: { id: userRoleId } });
    await writeAuditRow(
      tx,
      { utilityId, actorId: actor.id, actorName: actor.name, entityType: "UserRole" },
      "user_role.revoked",
      userRoleId,
      { roleId: existing.roleId, accountId: existing.accountId },
      null,
    );
  });
  await invalidateUserRoleCache(existing.userId, utilityId);
}
